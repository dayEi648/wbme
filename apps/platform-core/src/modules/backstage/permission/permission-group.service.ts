import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors, PaginationQueryDto, permissionErrors } from '@wbme/contracts';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import { grantLabel, loadCatalogMap, validateGrantItems, type FunctionMeta, type GrantItem } from './catalog-registry.util';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  writeBackstageOperationLog,
  type OperationLogOperator,
} from './operation-log.util';
import type { BatchDeleteGroupsDto, CreatePermissionGroupDto, UpdatePermissionGroupDto } from './permission-group.dto';

/**
 * 权限组维护服务（backstage PRD §4、主 PRD §3.1；表设计 S-6/S-7；实现规划 T3-3）。
 *
 * - 权限组是命名的授权预设（可跨系统），不是授权单位：授予员工时展开为员工功能
 *   授权快照，之后修改/删除权限组不影响已授权员工（快照语义，组与员工无关联）；
 * - 维护边界：持有"权限管理"功能者（含超管）可维护全部权限组（控制器层守卫保证）；
 *   组明细与授权项同规则校验（目录注册 + 档位合法 + "权限管理"功能仅超管可入组，
 *   防止权限管理员借组展开间接授予该功能）；
 * - 组编辑 = 事务内全量替换明细（S-7）；删除 = 软删除（S-6 名称唯一约束覆盖已软删除组，
 *   已删组的名称仍被占用）；已软删除组不再可展开；
 * - 组变更写入 backstage 操作日志（含变更前后内容，主 PRD §3.3）。
 */

/** 操作日志幂等作用域 */
const IDEMPOTENCY_SCOPE = {
  GROUP_CREATE: 'permission.groups.create',
  GROUP_UPDATE: 'permission.groups.update',
  GROUP_BATCH_DELETE: 'permission.groups.batch-delete',
} as const;

/** 权限组明细展示项（含目录有效性标记） */
interface GroupItemView {
  functionCode: string;
  dataScope: string;
  name: string;
  systemCode: string;
  sectionCode: string;
  /** 是否仍可从组内展开（功能已移除或档位已失效时为 false，展开时跳过） */
  valid: boolean;
}

@Injectable()
export class PermissionGroupService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 权限组列表（分页遵循主 PRD §9.5；不含已软删除）。
   *
   * @param query 分页参数
   * @returns data（含明细条数）与 pagination
   */
  async listGroups(query: PaginationQueryDto): Promise<{
    data: Array<{ id: number; name: string; description: string | null; itemCount: number; createdAt: Date; updatedAt: Date }>;
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const where: Prisma.PermissionGroupWhereInput = { deletedAt: null };
    const [totalItems, groups] = await Promise.all([
      this.prisma.client.permissionGroup.count({ where }),
      this.prisma.client.permissionGroup.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { items: true } },
        },
      }),
    ]);
    return {
      data: groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        itemCount: group._count.items,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  /**
   * 查看组内权限：明细按目录排序并标记有效性（失效项保留在组内但不再可展开）。
   *
   * @param groupId 组 id
   * @returns 组信息与明细（含 valid 标记）
   * @throws RESOURCE_NOT_FOUND 组不存在或已软删除
   */
  async getGroup(groupId: number): Promise<{
    id: number;
    name: string;
    description: string | null;
    items: GroupItemView[];
  }> {
    const group = await this.prisma.client.permissionGroup.findFirst({
      where: { id: groupId, deletedAt: null },
      include: { items: true },
    });
    if (!group) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const catalog = await loadCatalogMap(this.prisma.client);
    const items = group.items
      .map((item): GroupItemView => {
        const fn = catalog.get(item.functionCode);
        const valid = fn !== undefined && fn.dataScopeOptions.includes(item.dataScope);
        return {
          functionCode: item.functionCode,
          dataScope: item.dataScope,
          name: fn?.name ?? item.functionCode,
          systemCode: fn?.system.code ?? item.systemCode,
          sectionCode: fn?.section.code ?? '',
          valid,
        };
      })
      .sort((a, b) => {
        const left = catalog.get(a.functionCode);
        const right = catalog.get(b.functionCode);
        return (
          (left?.system.sort ?? 0) - (right?.system.sort ?? 0) ||
          (left?.section.sort ?? 0) - (right?.section.sort ?? 0) ||
          (left?.sort ?? 0) - (right?.sort ?? 0) ||
          a.functionCode.localeCompare(b.functionCode)
        );
      });
    return { id: group.id, name: group.name, description: group.description, items };
  }

  /**
   * 创建权限组（命名 + 描述 + 明细；明细按目录校验）。
   *
   * @param operatorId 操作人 id
   * @param dto 组定义 + 可选幂等键
   * @returns 新组 id（重放返回首次创建结果）
   * @throws GROUP_NAME_CONFLICT 名称已被使用（含已软删除组）；
   *         FUNCTION_NOT_REGISTERED / SCOPE_NOT_SUPPORTED / PERMISSION_MANAGEMENT_GRANT_FORBIDDEN 明细非法
   */
  async createGroup(operatorId: number, dto: CreatePermissionGroupDto): Promise<{ id: number }> {
    const operator = await this.loadOperator(operatorId);
    const catalog = await loadCatalogMap(this.prisma.client);
    const name = dto.name.trim();

    const fingerprint = fingerprintPayload({ name, description: dto.description, items: dto.items });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      scope: IDEMPOTENCY_SCOPE.GROUP_CREATE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 依赖数据库状态（目录注册表）的校验在幂等预检查之后执行：同键重放直接返回首次结果
        this.validateGroupItems(dto.items, operator.isSuperAdmin, catalog, name);
        const group = await this.createGroupRows(tx, operator.id, name, dto.description ?? null, dto.items, catalog);
        const labels = this.itemLabels(catalog, dto.items);
        return {
          result: { id: group.id },
          actionType: 'CREATE',
          summary: `创建权限组「${name}」：明细 [${labels.join('、')}]`,
        };
      },
    });
  }

  /**
   * 编辑权限组：名称/描述更新 + 明细事务内全量替换（S-7）。
   * 不影响已按该组展开授权的员工（快照语义）。
   *
   * @param operatorId 操作人 id
   * @param groupId 组 id
   * @param dto 新组定义 + 可选幂等键
   * @returns ok（重放返回首次编辑结果）
   * @throws RESOURCE_NOT_FOUND 组不存在或已软删除；GROUP_NAME_CONFLICT 名称冲突；明细非法同创建
   */
  async updateGroup(operatorId: number, groupId: number, dto: UpdatePermissionGroupDto): Promise<{ ok: true }> {
    const operator = await this.loadOperator(operatorId);
    const catalog = await loadCatalogMap(this.prisma.client);
    const name = dto.name.trim();

    const fingerprint = fingerprintPayload({ groupId, name, description: dto.description, items: dto.items });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      scope: IDEMPOTENCY_SCOPE.GROUP_UPDATE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 组存在性与明细校验在幂等预检查之后执行：同键重放直接返回首次结果
        const group = await tx.permissionGroup.findFirst({
          where: { id: groupId, deletedAt: null },
          include: { items: true },
        });
        if (!group) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        this.validateGroupItems(dto.items, operator.isSuperAdmin, catalog, name);
        const beforeLabels = this.itemLabels(catalog, group.items);
        await this.replaceGroupRows(tx, operator.id, group.id, name, dto.description ?? null, dto.items, catalog);
        const afterLabels = this.itemLabels(catalog, dto.items);
        return {
          result: { ok: true as const },
          actionType: 'UPDATE',
          summary:
            `编辑权限组「${name}」（id=${group.id}）：名称/描述变更前 [${group.name} / ${group.description ?? ''}]，` +
            `变更后 [${name} / ${dto.description ?? ''}]；明细变更前 [${beforeLabels.join('、')}]，变更后 [${afterLabels.join('、')}]`,
        };
      },
    });
  }

  /**
   * 批量删除权限组（软删除；全有或全无，主 PRD §2.6）。
   * 不影响已按组展开授权的员工（快照语义）；已软删除组不再可展开、名称仍被占用（S-6）。
   *
   * @param operatorId 操作人 id
   * @param dto 目标组标识 + 可选幂等键
   * @returns ok 与处理的目标标识（重放返回原结果）
   * @throws GROUP_BATCH_BLOCKED 任一目标不存在/已删除（details.failures 逐项原因，整批不变更）
   */
  async batchDeleteGroups(operatorId: number, dto: BatchDeleteGroupsDto): Promise<{ ok: true; groupIds: number[] }> {
    const operator = await this.loadOperator(operatorId);

    const fingerprint = fingerprintPayload({ groupIds: dto.groupIds });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      scope: IDEMPOTENCY_SCOPE.GROUP_BATCH_DELETE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 整批校验在幂等预检查之后执行：同键重放返回首次结果（目标已删也返回原成功结果，
        // 主 PRD §9.5）；新意图删除不存在的目标才逐项返回原因（§2.6 删除幂等语义）
        const groups = await tx.permissionGroup.findMany({
          where: { id: { in: dto.groupIds }, deletedAt: null },
          select: { id: true, name: true },
        });
        const foundIds = new Set(groups.map((group) => group.id));
        const failures = dto.groupIds
          .filter((id) => !foundIds.has(id))
          .map((groupId) => ({ groupId, code: 'GROUP_NOT_FOUND', message: '权限组不存在或已删除' }));
        if (failures.length > 0) {
          throw new BusinessException(permissionErrors.GROUP_BATCH_BLOCKED, { failures });
        }
        const names = new Map(groups.map((group) => [group.id, group.name]));
        // 软删除（基线 deleted_by/deleted_at；updateMany 不自动维护 @updatedAt，显式写入）
        await tx.permissionGroup.updateMany({
          where: { id: { in: dto.groupIds }, deletedAt: null },
          data: { deletedAt: new Date(), deletedBy: operator.id, updatedBy: operator.id, updatedAt: new Date() },
        });
        for (const groupId of [...dto.groupIds].sort((a, b) => a - b)) {
          await writeBackstageOperationLog(tx, {
            operator,
            actionType: 'DELETE',
            summary: `删除权限组「${names.get(groupId) ?? groupId}」（id=${groupId}）`,
          });
        }
        return {
          result: { ok: true as const, groupIds: dto.groupIds },
          actionType: 'DELETE',
          summary: `批量删除权限组：${dto.groupIds.length} 个（${[...names.values()].map((name) => `「${name}」`).join('')}）`,
        };
      },
    });
  }

  /**
   * 校验组明细：功能编码+数据范围不重复、目录注册、档位合法、"权限管理"功能仅超管可入组。
   * 允许同一功能携带多个不同档位（S-7 唯一键允许；展开授权时按最宽范围合并生效）。
   *
   * @param items 组明细
   * @param operatorIsSuperAdmin 操作人是否超管
   * @param catalog 目录功能元数据
   * @param name 组名（仅用于空名称校验的调用方语义；此处保证组名非空）
   */
  private validateGroupItems(
    items: readonly GrantItem[],
    operatorIsSuperAdmin: boolean,
    catalog: Map<string, FunctionMeta>,
    name: string,
  ): void {
    if (name.length === 0) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: { name: '组名不能为空' } });
    }
    const keys = items.map((item) => `${item.functionCode} ${item.dataScope}`);
    if (new Set(keys).size !== keys.length) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: { items: '同一功能编码与数据范围不可重复' } });
    }
    // 复用授权项校验（目录注册/档位/委派）；组明细允许同一功能多档位，先按"功能编码不可重复"豁免：
    // 逐项校验目录与档位，委派规则（permission_manage 仅超管）在组上同样强制
    for (const item of items) {
      validateGrantItems([item], operatorIsSuperAdmin, catalog);
    }
  }

  /** 明细展示标签列表（目录外功能按编码兜底） */
  private itemLabels(catalog: Map<string, FunctionMeta>, items: readonly GrantItem[]): string[] {
    return items.map((item) => grantLabel(catalog, item.functionCode, item.dataScope));
  }

  /**
   * 创建组与明细行（同事务）；名称撞唯一索引转 GROUP_NAME_CONFLICT。
   *
   * @returns 新建组行
   */
  private async createGroupRows(
    tx: Prisma.TransactionClient,
    operatorId: number,
    name: string,
    description: string | null,
    items: readonly GrantItem[],
    catalog: Map<string, FunctionMeta>,
  ): Promise<{ id: number }> {
    try {
      const group = await tx.permissionGroup.create({
        data: { name, description, createdBy: operatorId, updatedBy: operatorId },
      });
      if (items.length > 0) {
        await tx.permissionGroupItem.createMany({
          data: items.map((item) => ({
            groupId: group.id,
            systemCode: catalog.get(item.functionCode)?.system.code ?? '',
            functionCode: item.functionCode,
            dataScope: item.dataScope,
          })),
        });
      }
      return group;
    } catch (error) {
      throw this.mapNameConflict(error);
    }
  }

  /** 编辑组：名称/描述更新 + 明细全量替换（S-7）；名称撞唯一索引转 GROUP_NAME_CONFLICT */
  private async replaceGroupRows(
    tx: Prisma.TransactionClient,
    operatorId: number,
    groupId: number,
    name: string,
    description: string | null,
    items: readonly GrantItem[],
    catalog: Map<string, FunctionMeta>,
  ): Promise<void> {
    try {
      await tx.permissionGroup.update({
        where: { id: groupId },
        data: { name, description, updatedBy: operatorId },
      });
      await tx.permissionGroupItem.deleteMany({ where: { groupId } });
      if (items.length > 0) {
        await tx.permissionGroupItem.createMany({
          data: items.map((item) => ({
            groupId,
            systemCode: catalog.get(item.functionCode)?.system.code ?? '',
            functionCode: item.functionCode,
            dataScope: item.dataScope,
          })),
        });
      }
    } catch (error) {
      throw this.mapNameConflict(error);
    }
  }

  /** 唯一约束冲突（S-6 组名）映射为 GROUP_NAME_CONFLICT；组明细唯一键不会触发（先删后建/新组） */
  private mapNameConflict(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new BusinessException(permissionErrors.GROUP_NAME_CONFLICT);
    }
    return error;
  }

  /**
   * 加载操作人上下文（守卫已保证账号存在且 ACTIVE，此处兜底并发删除/注销场景）。
   *
   * @param operatorId 操作人 id
   * @throws UNAUTHORIZED 操作人不存在或已删除
   */
  private async loadOperator(operatorId: number): Promise<OperationLogOperator> {
    const operator = await this.prisma.client.user.findUnique({
      where: { id: operatorId },
      select: { id: true, name: true, isSuperAdmin: true, deletedAt: true },
    });
    if (!operator || operator.deletedAt !== null) {
      throw new BusinessException(frameworkErrors.UNAUTHORIZED);
    }
    return { id: operator.id, name: operator.name, isSuperAdmin: operator.isSuperAdmin };
  }
}
