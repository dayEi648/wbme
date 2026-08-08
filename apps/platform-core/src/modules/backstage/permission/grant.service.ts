import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  accountErrors,
  BusinessException,
  frameworkErrors,
  maskPhone,
  PERMISSION_MANAGE_FUNCTION_CODE,
  permissionErrors,
  type DataScope,
  type UserStatus,
} from '@wbme/contracts';
import { getRequestContext } from '@wbme/server';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import type { BatchGrantDto, BatchRevokeDto, GrantItemDto, SaveEmployeeGrantsDto, SearchEmployeesDto } from './permission.dto';

/**
 * 员工授权管理服务（backstage PRD §4、主 PRD §3.1/§3.3/§9.5；实现规划 T3-2）。
 *
 * - 操作人资格（持有"权限管理"功能或超管）由 FunctionPermissionGuard 在控制器层保证；
 *   本服务负责委派规则（自我修改禁止、"权限管理"功能仅超管可授予/撤销、超管目标保护）；
 * - 可管理范围：超管 = 目录全部功能；权限管理员 = 目录全部普通功能（不含"权限管理"本身）；
 * - 单人保存携带授权版本做乐观并发控制（事务内条件更新）；批量操作不携带版本，
 *   以用户行锁（按 id 有序，防死锁）串行化并发写入，逐人递增 permission_version；
 * - 幂等（主 PRD §3.3）：重要写操作携带幂等键，以 backstage.operation_logs 的
 *   「操作者 + 系统 + 幂等作用域 + 幂等键」部分唯一约束为唯一事实；同键同指纹返回原结果，
 *   同键不同指纹 409；校验失败或事务回滚不留成功日志，修正后可重试；
 * - 目录中已移除功能的授权行不生效、不参与"完整状态"替换（保留为审计数据）。
 */

/** 操作日志幂等作用域（同一操作者 + 作用域 + 幂等键唯一，主 PRD §3.3） */
const IDEMPOTENCY_SCOPE = {
  GRANTS_SAVE: 'permission.grants.save',
  BATCH_GRANT: 'permission.grants.batch-grant',
  BATCH_REVOKE: 'permission.grants.batch-revoke',
} as const;

/** 数据范围展示标注（授权摘要形如"固定资产维护（部门）"，backstage PRD §4） */
const DATA_SCOPE_LABELS: Record<DataScope, string> = {
  SELF: '本人',
  DEPARTMENT: '部门',
  COMPANY: '公司',
};

/** 批量校验逐人阻塞原因编码（写入 GRANT_BATCH_BLOCKED 的 details.failures[].code；API 文档同步） */
const BATCH_FAILURE = {
  TARGET_NOT_FOUND: '目标账号不存在',
  TARGET_DEACTIVATED: '目标账号已注销',
  SELF_MODIFICATION: '不能修改自己的权限',
  SUPER_ADMIN_TARGET: '超级管理员账号仅可由超级管理员管理',
} as const;

type BatchFailureCode = keyof typeof BATCH_FAILURE;

/** 目录功能元数据（来自数据库注册表，启动对账保证与代码目录一致） */
interface FunctionMeta {
  code: string;
  name: string;
  dataScopeOptions: string[];
  sort: number;
  system: { code: string; name: string; sort: number };
  section: { code: string; name: string; sort: number };
}

/** 操作人上下文（操作日志快照 + 站点角色） */
interface OperatorContext {
  id: number;
  name: string;
  isSuperAdmin: boolean;
}

/** 授权目标账号（批量校验通过） */
interface GrantTarget {
  id: number;
  name: string;
  phone: string;
}

/** 授权行（读取形态） */
interface GrantRow {
  id: number;
  userId: number;
  functionCode: string;
  dataScope: DataScope;
}

/** 幂等执行的业务产物：业务结果 + 操作日志内容 */
interface IdempotentOutcome<T> {
  result: T;
  actionType: 'CREATE' | 'UPDATE' | 'DELETE';
  summary: string;
}

/** 授权（功能编码, 数据范围）对键 */
function grantKey(functionCode: string, dataScope: string): string {
  return `${functionCode}${dataScope}`;
}

/**
 * 规范化请求指纹负载：对象键排序、数组逐项规范化后按序列化结果排序。
 * 同一用户意图的请求即使字段/元素顺序不同也产生相同指纹，避免伪冲突（主 PRD §3.3）。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, canonicalize(item)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

/** 计算规范化请求指纹（SHA-256 十六进制；不含密码/凭证等敏感字段——负载由 DTO 校验后构造） */
function fingerprintPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

@Injectable()
export class GrantService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 员工检索（backstage PRD §4）：姓名/手机号模糊搜索，分页遵循主 PRD §9.5。
   *
   * 范围：正常（ACTIVE）与待激活（PENDING_ACTIVATION）账号——待激活账号允许提前授权
   * （激活即生效）；已注销/已删除账号不出现在检索与授权选择器（主 PRD §2.6）。
   * 所属部门：hr 未上线，本期恒为空数组（hr 组织视图接入后填充真实部门快照）。
   *
   * @param query 检索词 + 分页参数
   * @returns data（员工摘要 + 有效授权摘要）与 pagination
   */
  async searchEmployees(query: SearchEmployeesDto): Promise<{
    data: Array<{
      id: number;
      name: string;
      phoneMasked: string;
      status: UserStatus;
      isSuperAdmin: boolean;
      departments: string[];
      grantsSummary: string[];
    }>;
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const where: Prisma.UserWhereInput = { deletedAt: null, status: { in: ['ACTIVE', 'PENDING_ACTIVATION'] } };
    const keyword = query.keyword?.trim();
    if (keyword) {
      const conditions: Prisma.UserWhereInput[] = [{ name: { contains: keyword, mode: 'insensitive' } }];
      const digits = keyword.replace(/\D/g, '');
      if (digits.length > 0) {
        conditions.push({ phone: { contains: digits } });
      }
      where.OR = conditions;
    }
    const [totalItems, users] = await Promise.all([
      this.prisma.client.user.count({ where }),
      this.prisma.client.user.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: { id: true, name: true, phone: true, status: true, isSuperAdmin: true },
      }),
    ]);

    // 当前页员工的授权摘要（仅目录中仍注册的功能生效；超管视为拥有全部，不展开）
    const catalog = await this.loadCatalogMap();
    const grantsByUser = await this.loadGrantsByUser(users.map((user) => user.id));
    const data = users.map((user) => {
      const grants = (grantsByUser.get(user.id) ?? []).filter((row) => catalog.has(row.functionCode));
      return {
        id: user.id,
        name: user.name,
        phoneMasked: maskPhone(user.phone),
        status: user.status,
        isSuperAdmin: user.isSuperAdmin,
        departments: [] as string[],
        grantsSummary: this.sortGrantRows(grants, catalog).map((row) => this.grantLabel(catalog, row.functionCode, row.dataScope)),
      };
    });
    return {
      data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  /**
   * 查看目标员工当前授权（backstage PRD §4"修改权限"打开时调用）。
   *
   * @param targetUserId 目标员工 id
   * @returns 目标摘要、当前授权版本（保存时须原样携带）与有效授权列表（目录过滤后，按目录排序）
   * @throws RESOURCE_NOT_FOUND 目标不存在或已删除
   */
  async getEmployeeGrants(targetUserId: number): Promise<{
    target: { id: number; name: string; phoneMasked: string; status: string; isSuperAdmin: boolean };
    permissionVersion: number;
    grants: Array<{ functionCode: string; dataScope: DataScope; name: string; systemCode: string; sectionCode: string }>;
  }> {
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, phone: true, status: true, isSuperAdmin: true, deletedAt: true, permissionVersion: true },
    });
    if (!target || target.deletedAt !== null) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const catalog = await this.loadCatalogMap();
    const rows = await this.prisma.client.employeeGrant.findMany({ where: { userId: targetUserId } });
    const effective = this.sortGrantRows(rows.filter((row) => catalog.has(row.functionCode)), catalog);
    return {
      target: {
        id: target.id,
        name: target.name,
        phoneMasked: maskPhone(target.phone),
        status: target.status,
        isSuperAdmin: target.isSuperAdmin,
      },
      permissionVersion: target.permissionVersion,
      grants: effective.map((row) => {
        const fn = catalog.get(row.functionCode);
        return {
          functionCode: row.functionCode,
          dataScope: row.dataScope,
          name: fn?.name ?? row.functionCode,
          systemCode: fn?.system.code ?? '',
          sectionCode: fn?.section.code ?? '',
        };
      }),
    };
  }

  /**
   * 保存单人权限（backstage PRD §4"修改权限"）：一次性提交目标员工在操作人可管理范围内的
   * 完整功能状态；携带打开时取得的授权版本，事务内按版本条件更新（乐观并发控制）。
   *
   * @param operatorId 操作人 id
   * @param targetUserId 目标员工 id
   * @param dto 完整功能状态 + 授权版本 + 可选幂等键
   * @returns 保存后的授权版本（重放时返回首次保存的结果）
   * @throws GRANT_VERSION_CONFLICT 版本已被他人更新；GRANT_SELF_FORBIDDEN 自我修改；
   *         SUPER_ADMIN_TARGET_ONLY 非超管操作超管目标；PERMISSION_MANAGEMENT_GRANT_FORBIDDEN /
   *         FUNCTION_NOT_REGISTERED / SCOPE_NOT_SUPPORTED 授权项非法
   */
  async saveEmployeeGrants(
    operatorId: number,
    targetUserId: number,
    dto: SaveEmployeeGrantsDto,
  ): Promise<{ permissionVersion: number }> {
    const operator = await this.loadOperator(operatorId);
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, phone: true, status: true, isSuperAdmin: true, deletedAt: true },
    });
    if (!target || target.deletedAt !== null) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    if (target.status === 'DEACTIVATED') {
      throw new BusinessException(accountErrors.ACCOUNT_DEACTIVATED);
    }
    if (target.id === operator.id) {
      throw new BusinessException(permissionErrors.GRANT_SELF_FORBIDDEN);
    }
    if (target.isSuperAdmin && !operator.isSuperAdmin) {
      throw new BusinessException(permissionErrors.SUPER_ADMIN_TARGET_ONLY);
    }
    const catalog = await this.loadCatalogMap();
    this.validateGrantItems(dto.grants, operator.isSuperAdmin, catalog);

    const fingerprint = fingerprintPayload({
      targetUserId,
      permissionVersion: dto.permissionVersion,
      grants: dto.grants,
    });
    return this.executeIdempotent({
      operator,
      scope: IDEMPOTENCY_SCOPE.GRANTS_SAVE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 版本条件更新先行：兼作行锁与并发校验——版本不符即时 CONFLICT，后续写入不会执行
        //（updateMany 不自动维护 @updatedAt，显式写入）
        const versioned = await tx.user.updateMany({
          where: { id: target.id, permissionVersion: dto.permissionVersion },
          data: { permissionVersion: { increment: 1 }, updatedBy: operator.id, updatedAt: new Date() },
        });
        if (versioned.count === 0) {
          throw new BusinessException(permissionErrors.GRANT_VERSION_CONFLICT);
        }
        const current = await tx.employeeGrant.findMany({ where: { userId: target.id } });
        const requested = new Set(dto.grants.map((item) => grantKey(item.functionCode, item.dataScope)));
        // 替换范围 = 目录内且在操作人可管理范围内的授权行；目录外（已移除功能）与
        // 范围外（非超管时的"权限管理"）授权行保持不动
        const inScope = (row: GrantRow): boolean =>
          catalog.has(row.functionCode) && (operator.isSuperAdmin || row.functionCode !== PERMISSION_MANAGE_FUNCTION_CODE);
        const currentKeys = new Set(current.map((row) => grantKey(row.functionCode, row.dataScope)));
        const toDelete = current.filter((row) => inScope(row) && !requested.has(grantKey(row.functionCode, row.dataScope)));
        const toCreate = dto.grants.filter((item) => !currentKeys.has(grantKey(item.functionCode, item.dataScope)));
        if (toDelete.length > 0) {
          await tx.employeeGrant.deleteMany({ where: { id: { in: toDelete.map((row) => row.id) } } });
        }
        if (toCreate.length > 0) {
          await tx.employeeGrant.createMany({
            data: toCreate.map((item) => ({
              userId: target.id,
              functionCode: item.functionCode,
              dataScope: item.dataScope,
              grantedBy: operator.id,
            })),
          });
        }
        const before = this.sortGrantRows(current.filter(inScope), catalog).map((row) =>
          this.grantLabel(catalog, row.functionCode, row.dataScope),
        );
        const after = dto.grants.map((item) => this.grantLabel(catalog, item.functionCode, item.dataScope));
        return {
          result: { permissionVersion: dto.permissionVersion + 1 },
          actionType: 'UPDATE',
          summary: `修改权限：${target.name}（${maskPhone(target.phone)}）变更前 [${before.join('、')}]，变更后 [${after.join('、')}]`,
        };
      },
    });
  }

  /**
   * 批量授权（增量，backstage PRD §4、主 PRD §3.1）：为所选员工追加功能授权，不改动已有授权。
   * 先整批校验（目标状态/超管保护/自我修改），任一失败整批回滚并逐人返回阻塞原因；
   * 全部通过后单事务完成：用户行锁串行化 + 逐人递增授权版本 + 逐人操作日志。
   *
   * @param operatorId 操作人 id
   * @param dto 目标员工 + 逐项功能授权（groupIds 预留给 T3-3 权限组展开）
   * @returns 处理完成的目标标识（重放返回原结果）
   * @throws GRANT_BATCH_BLOCKED 任一目标校验失败（details.failures 逐人原因）
   */
  async batchGrant(operatorId: number, dto: BatchGrantDto): Promise<{ ok: true; userIds: number[] }> {
    if (dto.groupIds && dto.groupIds.length > 0) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: { groupIds: '权限组展开暂未开放（T3-3 提供）' },
      });
    }
    const operator = await this.loadOperator(operatorId);
    const catalog = await this.loadCatalogMap();
    this.validateGrantItems(dto.grants, operator.isSuperAdmin, catalog);
    const targets = await this.loadBatchTargets(dto.userIds, operator);
    const itemLabels = dto.grants.map((item) => this.grantLabel(catalog, item.functionCode, item.dataScope));

    const fingerprint = fingerprintPayload({ userIds: dto.userIds, grants: dto.grants });
    return this.executeIdempotent({
      operator,
      scope: IDEMPOTENCY_SCOPE.BATCH_GRANT,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        await this.lockUserRows(tx, dto.userIds);
        const grantsByUser = await this.loadGrantsByUser(dto.userIds, tx);
        let changed = 0;
        for (const target of targets) {
          const existing = new Set((grantsByUser.get(target.id) ?? []).map((row) => grantKey(row.functionCode, row.dataScope)));
          const additions = dto.grants.filter((item) => !existing.has(grantKey(item.functionCode, item.dataScope)));
          if (additions.length === 0) {
            // 增量授权对该目标无变化：不递增版本、不写日志（不制造空变更）
            continue;
          }
          await tx.employeeGrant.createMany({
            data: additions.map((item) => ({
              userId: target.id,
              functionCode: item.functionCode,
              dataScope: item.dataScope,
              grantedBy: operator.id,
            })),
          });
          await tx.user.update({
            where: { id: target.id },
            data: { permissionVersion: { increment: 1 }, updatedBy: operator.id },
          });
          const added = additions.map((item) => this.grantLabel(catalog, item.functionCode, item.dataScope));
          await this.writeOperationLog(tx, {
            operator,
            actionType: 'CREATE',
            summary: `批量授权：为 ${target.name}（${maskPhone(target.phone)}）追加 [${added.join('、')}]`,
          });
          changed += 1;
        }
        return {
          result: { ok: true as const, userIds: dto.userIds },
          actionType: 'CREATE',
          summary: `批量授权：目标 ${targets.length} 人，追加 [${itemLabels.join('、')}]，实际变更 ${changed} 人`,
        };
      },
    });
  }

  /**
   * 批量撤销（backstage PRD §4）：撤销所选员工在操作人可管理范围内的全部功能授权。
   * 整批语义与批量授权一致；范围外授权行（如非超管操作时的"权限管理"）与目录外
   * 历史授权行不受影响。目标在范围内无授权时跳过（不递增版本、不写日志）。
   *
   * @param operatorId 操作人 id
   * @param dto 目标员工 + 可选幂等键
   * @returns 处理完成的目标标识（重放返回原结果）
   * @throws GRANT_BATCH_BLOCKED 任一目标校验失败（details.failures 逐人原因）
   */
  async batchRevoke(operatorId: number, dto: BatchRevokeDto): Promise<{ ok: true; userIds: number[] }> {
    const operator = await this.loadOperator(operatorId);
    const catalog = await this.loadCatalogMap();
    const targets = await this.loadBatchTargets(dto.userIds, operator);

    const fingerprint = fingerprintPayload({ userIds: dto.userIds });
    return this.executeIdempotent({
      operator,
      scope: IDEMPOTENCY_SCOPE.BATCH_REVOKE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        await this.lockUserRows(tx, dto.userIds);
        const grantsByUser = await this.loadGrantsByUser(dto.userIds, tx);
        const inScope = (row: GrantRow): boolean =>
          catalog.has(row.functionCode) && (operator.isSuperAdmin || row.functionCode !== PERMISSION_MANAGE_FUNCTION_CODE);
        let changed = 0;
        for (const target of targets) {
          const revocable = (grantsByUser.get(target.id) ?? []).filter(inScope);
          if (revocable.length === 0) {
            continue;
          }
          await tx.employeeGrant.deleteMany({ where: { id: { in: revocable.map((row) => row.id) } } });
          await tx.user.update({
            where: { id: target.id },
            data: { permissionVersion: { increment: 1 }, updatedBy: operator.id },
          });
          const revoked = this.sortGrantRows(revocable, catalog).map((row) =>
            this.grantLabel(catalog, row.functionCode, row.dataScope),
          );
          await this.writeOperationLog(tx, {
            operator,
            actionType: 'DELETE',
            summary: `批量撤销：撤销 ${target.name}（${maskPhone(target.phone)}）的 [${revoked.join('、')}]`,
          });
          changed += 1;
        }
        return {
          result: { ok: true as const, userIds: dto.userIds },
          actionType: 'DELETE',
          summary: `批量撤销：目标 ${targets.length} 人，实际撤销 ${changed} 人`,
        };
      },
    });
  }

  /**
   * 加载操作人上下文（守卫已保证账号存在且 ACTIVE，此处兜底并发删除/注销场景）。
   *
   * @param operatorId 操作人 id
   * @returns 操作人上下文
   * @throws UNAUTHORIZED 操作人不存在或已删除
   */
  private async loadOperator(operatorId: number): Promise<OperatorContext> {
    const operator = await this.prisma.client.user.findUnique({
      where: { id: operatorId },
      select: { id: true, name: true, isSuperAdmin: true, deletedAt: true },
    });
    if (!operator || operator.deletedAt !== null) {
      throw new BusinessException(frameworkErrors.UNAUTHORIZED);
    }
    return { id: operator.id, name: operator.name, isSuperAdmin: operator.isSuperAdmin };
  }

  /**
   * 校验授权项：功能编码不重复、仍注册于目录、数据范围在可选档位内、
   * "权限管理"功能仅超级管理员可授予/撤销（主 PRD §3.1 委派规则）。
   *
   * @param items 授权项（校验后的 DTO）
   * @param operatorIsSuperAdmin 操作人是否超管
   * @param catalog 目录功能元数据
   * @throws VALIDATION_FAILED / FUNCTION_NOT_REGISTERED / PERMISSION_MANAGEMENT_GRANT_FORBIDDEN / SCOPE_NOT_SUPPORTED
   */
  private validateGrantItems(
    items: readonly GrantItemDto[],
    operatorIsSuperAdmin: boolean,
    catalog: Map<string, FunctionMeta>,
  ): void {
    const codes = items.map((item) => item.functionCode);
    if (new Set(codes).size !== codes.length) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: { grants: '功能编码不可重复' } });
    }
    for (const item of items) {
      const fn = catalog.get(item.functionCode);
      if (!fn) {
        throw new BusinessException(permissionErrors.FUNCTION_NOT_REGISTERED);
      }
      if (fn.code === PERMISSION_MANAGE_FUNCTION_CODE && !operatorIsSuperAdmin) {
        throw new BusinessException(permissionErrors.PERMISSION_MANAGEMENT_GRANT_FORBIDDEN);
      }
      if (!fn.dataScopeOptions.includes(item.dataScope)) {
        throw new BusinessException(permissionErrors.SCOPE_NOT_SUPPORTED);
      }
    }
  }

  /**
   * 批量目标整批校验：存在性/账号状态/自我修改/超管保护；任一失败抛 GRANT_BATCH_BLOCKED
   * 并逐人携带阻塞原因（不产生任何写入）。
   *
   * @param userIds 目标员工标识（DTO 已保证非空、≤100、不重复）
   * @param operator 操作人上下文
   * @returns 校验通过的目标（按 id 升序，与行锁顺序一致）
   */
  private async loadBatchTargets(userIds: readonly number[], operator: OperatorContext): Promise<GrantTarget[]> {
    const rows = await this.prisma.client.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, name: true, phone: true, status: true, isSuperAdmin: true, deletedAt: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const failures: Array<{ userId: number; code: BatchFailureCode; message: string }> = [];
    const targets: GrantTarget[] = [];
    for (const userId of userIds) {
      const target = byId.get(userId);
      if (!target || target.deletedAt !== null) {
        failures.push({ userId, code: 'TARGET_NOT_FOUND', message: BATCH_FAILURE.TARGET_NOT_FOUND });
        continue;
      }
      if (target.status === 'DEACTIVATED') {
        failures.push({ userId, code: 'TARGET_DEACTIVATED', message: BATCH_FAILURE.TARGET_DEACTIVATED });
        continue;
      }
      if (target.id === operator.id) {
        failures.push({ userId, code: 'SELF_MODIFICATION', message: BATCH_FAILURE.SELF_MODIFICATION });
        continue;
      }
      if (target.isSuperAdmin && !operator.isSuperAdmin) {
        failures.push({ userId, code: 'SUPER_ADMIN_TARGET', message: BATCH_FAILURE.SUPER_ADMIN_TARGET });
        continue;
      }
      targets.push({ id: target.id, name: target.name, phone: target.phone });
    }
    if (failures.length > 0) {
      throw new BusinessException(permissionErrors.GRANT_BATCH_BLOCKED, { failures });
    }
    return targets.sort((a, b) => a.id - b.id);
  }

  /** 加载目录功能元数据（数据库注册表；启动对账保证与代码目录一致） */
  private async loadCatalogMap(): Promise<Map<string, FunctionMeta>> {
    const rows = await this.prisma.client.function.findMany({
      select: {
        code: true,
        name: true,
        dataScopeOptions: true,
        sort: true,
        system: { select: { code: true, name: true, sort: true } },
        section: { select: { code: true, name: true, sort: true } },
      },
    });
    return new Map(rows.map((row) => [row.code, row]));
  }

  /** 按用户分组加载授权行（事务内外均可调用） */
  private async loadGrantsByUser(userIds: readonly number[], tx?: Prisma.TransactionClient): Promise<Map<number, GrantRow[]>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const client = tx ?? this.prisma.client;
    const rows = await client.employeeGrant.findMany({ where: { userId: { in: [...userIds] } } });
    const byUser = new Map<number, GrantRow[]>();
    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }
    return byUser;
  }

  /** 授权展示标签："功能名称（数据范围）"；目录外功能按编码兜底展示 */
  private grantLabel(catalog: Map<string, FunctionMeta>, functionCode: string, dataScope: string): string {
    const fn = catalog.get(functionCode);
    const scope = DATA_SCOPE_LABELS[dataScope as DataScope] ?? dataScope;
    return `${fn?.name ?? functionCode}（${scope}）`;
  }

  /** 授权行按目录排序（系统 sort → 板块 sort → 功能 sort → 编码） */
  private sortGrantRows(rows: readonly GrantRow[], catalog: Map<string, FunctionMeta>): GrantRow[] {
    const order = (row: GrantRow): [number, number, number, string] => {
      const fn = catalog.get(row.functionCode);
      return [fn?.system.sort ?? 0, fn?.section.sort ?? 0, fn?.sort ?? 0, row.functionCode];
    };
    return [...rows].sort((a, b) => {
      const left = order(a);
      const right = order(b);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || left[3].localeCompare(right[3]);
    });
  }

  /**
   * 批量写事务的用户行锁：按 id 升序 SELECT ... FOR UPDATE，串行化并发授权写入并防死锁
   * （与单人保存的版本条件更新互斥：后者在锁释放后因版本不符返回 CONFLICT）。
   *
   * @param tx 事务客户端
   * @param userIds 目标用户标识
   */
  private async lockUserRows(tx: Prisma.TransactionClient, userIds: readonly number[]): Promise<void> {
    await tx.$queryRaw`SELECT id FROM base.users WHERE id = ANY(${[...userIds]}::int[]) ORDER BY id FOR UPDATE`;
  }

  /**
   * 幂等执行（主 PRD §3.3）： backstage.operation_logs 的「操作者 + 系统 + 幂等作用域 + 幂等键」
   * 部分唯一约束为唯一事实；业务写入与日志同事务。
   *
   * @param options.operator 操作人上下文（日志快照）
   * @param options.scope 幂等作用域
   * @param options.idempotencyKey 客户端幂等键（缺省则不记录幂等、直接执行）
   * @param options.fingerprint 规范化请求指纹
   * @param options.run 业务写入：返回业务结果与日志内容；日志行由本方法写入
   *   （批量场景的逐人明细日志由 run 内部另行写入，仅本行携带幂等键与结果引用）
   * @returns 业务结果；同键同指纹返回首次执行的结果引用，同键不同指纹抛 IDEMPOTENCY_KEY_REUSED
   */
  private async executeIdempotent<T>(options: {
    operator: OperatorContext;
    scope: string;
    idempotencyKey?: string;
    fingerprint: string;
    run: (tx: Prisma.TransactionClient) => Promise<IdempotentOutcome<T>>;
  }): Promise<T> {
    const { operator, scope, idempotencyKey, fingerprint, run } = options;
    if (!idempotencyKey) {
      return this.prisma.client.$transaction(async (tx) => {
        const outcome = await run(tx);
        await this.writeOperationLog(tx, { operator, actionType: outcome.actionType, summary: outcome.summary });
        return outcome.result;
      });
    }
    const existing = await this.findIdempotencyRecord(operator.id, scope, idempotencyKey);
    if (existing) {
      return this.replayIdempotencyRecord<T>(existing, fingerprint);
    }
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const outcome = await run(tx);
        await this.writeOperationLog(tx, {
          operator,
          actionType: outcome.actionType,
          summary: outcome.summary,
          idempotencyScope: scope,
          idempotencyKey,
          requestFingerprint: fingerprint,
          resultReference: outcome.result as unknown as Prisma.InputJsonValue,
        });
        return outcome.result;
      });
    } catch (error) {
      // 并发重复请求撞幂等唯一约束：取回先提交事务的结果（指纹不同则 409）；
      // 授权行写入在本设计中不可能产生 P2002（版本门/行锁已串行化），故 P2002 必为幂等冲突
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.findIdempotencyRecord(operator.id, scope, idempotencyKey);
        if (concurrent) {
          return this.replayIdempotencyRecord<T>(concurrent, fingerprint);
        }
      }
      throw error;
    }
  }

  /** 查询幂等记录（backstage 日志表；操作者非空时 COALESCE 与精确匹配等价） */
  private async findIdempotencyRecord(
    operatorId: number,
    scope: string,
    key: string,
  ): Promise<{ requestFingerprint: string | null; resultReference: Prisma.JsonValue } | null> {
    return this.prisma.client.backstageOperationLog.findFirst({
      where: { operatorId, system: 'BACKSTAGE', idempotencyScope: scope, idempotencyKey: key },
      select: { requestFingerprint: true, resultReference: true },
    });
  }

  /** 重放幂等记录：指纹一致返回原结果引用，不一致抛 409（主 PRD §3.3） */
  private replayIdempotencyRecord<T>(
    record: { requestFingerprint: string | null; resultReference: Prisma.JsonValue },
    fingerprint: string,
  ): T {
    if (record.requestFingerprint !== fingerprint) {
      throw new BusinessException(frameworkErrors.IDEMPOTENCY_KEY_REUSED);
    }
    // 结果引用由本服务同事务写入，结构受控
    return record.resultReference as T;
  }

  /** 写入 backstage 操作日志（只追加；operator_departments 待 hr 组织视图接入后填充快照） */
  private async writeOperationLog(
    tx: Prisma.TransactionClient,
    entry: {
      operator: OperatorContext;
      actionType: 'CREATE' | 'UPDATE' | 'DELETE';
      summary: string;
      idempotencyScope?: string;
      idempotencyKey?: string;
      requestFingerprint?: string;
      resultReference?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.backstageOperationLog.create({
      data: {
        operatorId: entry.operator.id,
        operatorName: entry.operator.name,
        system: 'BACKSTAGE',
        feature: PERMISSION_MANAGE_FUNCTION_CODE,
        actionType: entry.actionType,
        summary: entry.summary,
        idempotencyScope: entry.idempotencyScope ?? null,
        idempotencyKey: entry.idempotencyKey ?? null,
        requestFingerprint: entry.requestFingerprint ?? null,
        resultReference: entry.resultReference,
        requestId: getRequestContext()?.requestId ?? null,
      },
    });
  }
}
