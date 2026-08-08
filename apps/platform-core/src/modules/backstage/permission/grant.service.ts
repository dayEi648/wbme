import { Inject, Injectable } from '@nestjs/common';
import {
  accountErrors,
  BusinessException,
  frameworkErrors,
  maskPhone,
  PERMISSION_MANAGE_FUNCTION_CODE,
  permissionErrors,
  type UserStatus,
} from '@wbme/contracts';
import { SessionService } from '@wbme/server';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import {
  grantKey,
  grantLabel,
  loadCatalogMap,
  mergeWidestScope,
  sortGrantRows,
  validateGrantItems,
  type FunctionMeta,
  type GrantItem,
  type GrantRow,
} from './catalog-registry.util';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  writeBackstageOperationLog,
  type OperationLogOperator,
} from './operation-log.util';
import type { BatchGrantDto, BatchRevokeDto, SaveEmployeeGrantsDto, SearchEmployeesDto } from './permission.dto';

/**
 * 员工授权管理服务（backstage PRD §4、主 PRD §3.1/§3.3/§9.5；实现规划 T3-2/T3-3）。
 *
 * - 操作人资格（持有"权限管理"功能或超管）由 FunctionPermissionGuard 在控制器层保证；
 *   本服务负责委派规则（自我修改禁止、"权限管理"功能仅超管可授予/撤销、超管目标保护）；
 * - 可管理范围：超管 = 目录全部功能；权限管理员 = 目录全部普通功能（不含"权限管理"本身）；
 * - 单人保存携带授权版本做乐观并发控制（事务内条件更新）；批量操作不携带版本，
 *   以用户行锁（按 id 有序，防死锁）串行化并发写入，逐人递增 permission_version；
 * - 幂等（主 PRD §3.3）：重要写操作携带幂等键，以 backstage.operation_logs 的
 *   「操作者 + 系统 + 幂等作用域 + 幂等键」部分唯一约束为唯一事实（见 operation-log.util.ts）；
 * - 目录中已移除功能的授权行不生效、不参与"完整状态"替换（保留为审计数据）；
 * - 批量授权支持权限组展开（T3-3）：组内失效项（功能已移除/档位已失效）跳过不计入授权，
 *   展开结果为员工功能授权快照，与组不产生关联（之后改组/删组不影响已授权员工）；
 * - 提权旋转（base PRD §3）：员工新获得"权限管理"功能（含组展开获得）时在授权事务提交后
 *   调用 SessionService.markElevation，其各会话下次请求由守卫透明旋转标识；
 *   站点角色提升（任命超管，T3-6）复用同一标记。普通功能授权的授予/撤销不旋转——
 *   防固定针对的是进入委派链/站点角色的特权等级变化，且守卫每次请求实时读取授权，
 *   撤权无需旋转即即时生效。
 */

/** 操作日志幂等作用域（同一操作者 + 作用域 + 幂等键唯一，主 PRD §3.3） */
const IDEMPOTENCY_SCOPE = {
  GRANTS_SAVE: 'permission.grants.save',
  BATCH_GRANT: 'permission.grants.batch-grant',
  BATCH_REVOKE: 'permission.grants.batch-revoke',
} as const;

/** 批量校验逐人阻塞原因编码（写入 GRANT_BATCH_BLOCKED 的 details.failures[].code；API 文档同步） */
const BATCH_FAILURE = {
  TARGET_NOT_FOUND: '目标账号不存在',
  TARGET_DEACTIVATED: '目标账号已注销',
  SELF_MODIFICATION: '不能修改自己的权限',
  SUPER_ADMIN_TARGET: '超级管理员账号仅可由超级管理员管理',
} as const;

type BatchFailureCode = keyof typeof BATCH_FAILURE;

/** 授权目标账号（批量校验通过） */
interface GrantTarget {
  id: number;
  name: string;
  phone: string;
}

/** 组展开时被目录过滤的失效明细 */
interface SkippedGroupItem {
  groupId: number;
  functionCode: string;
  dataScope: string;
}

/** 组展开结果 */
interface GroupExpansion {
  /** 展开后的有效授权项（目录过滤后） */
  items: GrantItem[];
  /** 失效跳过的组明细 */
  skipped: SkippedGroupItem[];
  /** 展开的组名（日志摘要） */
  groupNames: string[];
}

@Injectable()
export class GrantService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly session: SessionService,
  ) {}

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
    const catalog = await loadCatalogMap(this.prisma.client);
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
        grantsSummary: sortGrantRows(grants, catalog).map((row) => grantLabel(catalog, row.functionCode, row.dataScope)),
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
    grants: Array<{ functionCode: string; dataScope: string; name: string; systemCode: string; sectionCode: string }>;
  }> {
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, phone: true, status: true, isSuperAdmin: true, deletedAt: true, permissionVersion: true },
    });
    if (!target || target.deletedAt !== null) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const catalog = await loadCatalogMap(this.prisma.client);
    const rows = await this.prisma.client.employeeGrant.findMany({ where: { userId: targetUserId } });
    const effective = sortGrantRows(rows.filter((row) => catalog.has(row.functionCode)), catalog);
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
   * 权限组填充由前端展开合并进完整状态后提交，服务端无需特殊处理（ backstage PRD §4）。
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
    const catalog = await loadCatalogMap(this.prisma.client);

    const fingerprint = fingerprintPayload({
      targetUserId,
      permissionVersion: dto.permissionVersion,
      grants: dto.grants,
    });
    // 提权标记：目标新获得"权限管理"功能时置位（授权事务提交后标记会话旋转；重放不进入 run，不重复标记）
    let elevated = false;
    const result = await executeIdempotentOperation(this.prisma.client, {
      operator,
      scope: IDEMPOTENCY_SCOPE.GRANTS_SAVE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 依赖数据库状态的校验一律在事务内（幂等预检查之后）执行：重放直接返回首次结果，
        // 不因目标状态在首次成功后被改变而误判（主 PRD §9.5：同键重试返回原结果）
        const target = await tx.user.findUnique({
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
        validateGrantItems(dto.grants, operator.isSuperAdmin, catalog);
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
        // 新获得"权限管理"功能 = 进入委派链（提权），提交后标记会话旋转（base PRD §3）
        elevated = toCreate.some((item) => item.functionCode === PERMISSION_MANAGE_FUNCTION_CODE);
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
        const before = sortGrantRows(current.filter(inScope), catalog).map((row) =>
          grantLabel(catalog, row.functionCode, row.dataScope),
        );
        const after = dto.grants.map((item) => grantLabel(catalog, item.functionCode, item.dataScope));
        return {
          result: { permissionVersion: dto.permissionVersion + 1 },
          actionType: 'UPDATE',
          summary: `修改权限：${target.name}（${maskPhone(target.phone)}）变更前 [${before.join('、')}]，变更后 [${after.join('、')}]`,
        };
      },
    });
    // 授权事务已提交：提权标记（目标会话下次请求由守卫透明旋转标识）
    if (elevated) {
      await this.session.markElevation(targetUserId);
    }
    return result;
  }

  /**
   * 批量授权（增量，backstage PRD §4、主 PRD §3.1）：为所选员工追加功能授权，不改动已有授权。
   * 授权内容 = 逐项功能（grants）∪ 权限组展开（groupIds，T3-3）：
   * - 组内失效项（功能已从目录移除或数据范围档位已失效）跳过且不计入授权，其余正常展开
   *   （主 PRD §3.1「该功能不再可从组内展开」）；展开为员工授权快照，不产生员工与组的关联；
   * - 逐项与组展开合并时同一功能按最宽数据范围生效；
   * - 先整批校验（目标状态/超管保护/自我修改），任一失败整批回滚并逐人返回阻塞原因；
   *   全部通过后单事务完成：用户行锁串行化 + 逐人递增授权版本 + 逐人操作日志。
   *
   * @param operatorId 操作人 id
   * @param dto 目标员工 + 逐项功能授权/权限组
   * @returns 处理完成的目标标识；携带 groupIds 时附 skippedGroupItems（失效跳过明细）
   * @throws GRANT_BATCH_BLOCKED 任一目标校验失败（details.failures 逐人原因）；
   *         RESOURCE_NOT_FOUND 权限组不存在或已删除（已软删除组不再可展开）
   */
  async batchGrant(
    operatorId: number,
    dto: BatchGrantDto,
  ): Promise<{ ok: true; userIds: number[]; skippedGroupItems?: SkippedGroupItem[] }> {
    if (dto.grants.length === 0 && (!dto.groupIds || dto.groupIds.length === 0)) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: { grants: '授权内容不能为空（逐项功能或权限组至少一项）' },
      });
    }
    const operator = await this.loadOperator(operatorId);
    const catalog = await loadCatalogMap(this.prisma.client);

    const fingerprint = fingerprintPayload({ userIds: dto.userIds, grants: dto.grants, groupIds: dto.groupIds });
    // 提权标记：新获得"权限管理"功能的目标（提交后统一标记会话旋转；重放不进入 run，不重复标记）
    const elevatedUserIds: number[] = [];
    const result = await executeIdempotentOperation(this.prisma.client, {
      operator,
      scope: IDEMPOTENCY_SCOPE.BATCH_GRANT,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        // 用户行锁先行（按 id 有序），随后所有依赖数据库状态的校验在锁内完成（重放由幂等预检查短路）
        await this.lockUserRows(tx, dto.userIds);
        validateGrantItems(dto.grants, operator.isSuperAdmin, catalog);
        const expansion = await this.expandGroups(dto.groupIds ?? [], catalog, tx);
        // 逐项功能与组展开项合并：同一功能按最宽范围生效（主 PRD §3.1）
        const items = mergeWidestScope([...dto.grants, ...expansion.items]);
        // 合并后再过一次委派校验：超管创建的组可能含"权限管理"功能，权限管理员不得借此授予
        validateGrantItems(items, operator.isSuperAdmin, catalog);
        const targets = await this.loadBatchTargets(dto.userIds, operator, tx);
        const itemLabels = items.map((item) => grantLabel(catalog, item.functionCode, item.dataScope));
        const grantsByUser = await this.loadGrantsByUser(dto.userIds, tx);
        let changed = 0;
        for (const target of targets) {
          const existing = new Set((grantsByUser.get(target.id) ?? []).map((row) => grantKey(row.functionCode, row.dataScope)));
          const additions = items.filter((item) => !existing.has(grantKey(item.functionCode, item.dataScope)));
          if (additions.length === 0) {
            // 增量授权对该目标无变化：不递增版本、不写日志（不制造空变更）
            continue;
          }
          // 新获得"权限管理"功能 = 进入委派链（提权），提交后标记会话旋转（base PRD §3）
          if (additions.some((item) => item.functionCode === PERMISSION_MANAGE_FUNCTION_CODE)) {
            elevatedUserIds.push(target.id);
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
          const added = additions.map((item) => grantLabel(catalog, item.functionCode, item.dataScope));
          await writeBackstageOperationLog(tx, {
            operator,
            actionType: 'CREATE',
            summary: `批量授权：为 ${target.name}（${maskPhone(target.phone)}）追加 [${added.join('、')}]`,
          });
          changed += 1;
        }
        const groupNote =
          expansion.groupNames.length > 0
            ? `（权限组 ${expansion.groupNames.map((name) => `「${name}」`).join('')} 展开${
                expansion.skipped.length > 0 ? `，失效跳过 ${expansion.skipped.length} 项` : ''
              }）`
            : '';
        const result =
          (dto.groupIds?.length ?? 0) > 0
            ? { ok: true as const, userIds: dto.userIds, skippedGroupItems: expansion.skipped }
            : { ok: true as const, userIds: dto.userIds };
        return {
          result,
          actionType: 'CREATE',
          summary: `批量授权：目标 ${targets.length} 人，追加 [${itemLabels.join('、')}]${groupNote}，实际变更 ${changed} 人`,
        };
      },
    });
    // 授权事务已提交：逐人提权标记（目标会话下次请求由守卫透明旋转标识）
    for (const userId of elevatedUserIds) {
      await this.session.markElevation(userId);
    }
    return result;
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
    const catalog = await loadCatalogMap(this.prisma.client);

    const fingerprint = fingerprintPayload({ userIds: dto.userIds });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      scope: IDEMPOTENCY_SCOPE.BATCH_REVOKE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        await this.lockUserRows(tx, dto.userIds);
        const targets = await this.loadBatchTargets(dto.userIds, operator, tx);
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
          const revoked = sortGrantRows(revocable, catalog).map((row) => grantLabel(catalog, row.functionCode, row.dataScope));
          await writeBackstageOperationLog(tx, {
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
   * 权限组展开（主 PRD §3.1）：读取未删除组的明细，按当前目录过滤失效项。
   *
   * @param groupIds 组标识（DTO 已去重）
   * @param catalog 目录功能元数据
   * @returns 有效授权项 + 失效跳过明细 + 组名
   * @throws RESOURCE_NOT_FOUND 任一组不存在或已软删除（不再可展开）
   */
  private async expandGroups(
    groupIds: readonly number[],
    catalog: Map<string, FunctionMeta>,
    tx: Prisma.TransactionClient,
  ): Promise<GroupExpansion> {
    if (groupIds.length === 0) {
      return { items: [], skipped: [], groupNames: [] };
    }
    const groups = await tx.permissionGroup.findMany({
      where: { id: { in: [...groupIds] }, deletedAt: null },
      include: { items: true },
      orderBy: { id: 'asc' },
    });
    if (groups.length !== new Set(groupIds).size) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const items: GrantItem[] = [];
    const skipped: SkippedGroupItem[] = [];
    for (const group of groups) {
      for (const item of group.items) {
        const fn = catalog.get(item.functionCode);
        if (!fn || !fn.dataScopeOptions.includes(item.dataScope)) {
          skipped.push({ groupId: group.id, functionCode: item.functionCode, dataScope: item.dataScope });
          continue;
        }
        items.push({ functionCode: item.functionCode, dataScope: item.dataScope });
      }
    }
    return { items, skipped, groupNames: groups.map((group) => group.name) };
  }

  /**
   * 加载操作人上下文（守卫已保证账号存在且 ACTIVE，此处兜底并发删除/注销场景）。
   *
   * @param operatorId 操作人 id
   * @returns 操作人上下文
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

  /**
   * 批量目标整批校验：存在性/账号状态/自我修改/超管保护；任一失败抛 GRANT_BATCH_BLOCKED
   * 并逐人携带阻塞原因（不产生任何写入）。
   *
   * @param userIds 目标员工标识（DTO 已保证非空、≤100、不重复）
   * @param operator 操作人上下文
   * @param tx 事务客户端（批量写事务内在行锁后调用，保证整批读取一致）
   * @returns 校验通过的目标（按 id 升序，与行锁顺序一致）
   */
  private async loadBatchTargets(
    userIds: readonly number[],
    operator: OperationLogOperator,
    tx: Prisma.TransactionClient,
  ): Promise<GrantTarget[]> {
    const rows = await tx.user.findMany({
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
}
