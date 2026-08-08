import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  accountErrors,
  BusinessException,
  frameworkErrors,
  maskPhone,
  USER_MANAGE_FUNCTION_CODE,
} from '@wbme/contracts';
import { stableTaskUuid, TASK_TYPE_ACCOUNT_LIFECYCLE, type AccountLifecycleTaskRef } from '@wbme/tasks';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import { grantLabel, loadCatalogMap } from '../permission/catalog-registry.util';
import {
  commitIdempotentOperation,
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
  tryReplayIdempotentResult,
  writeBackstageOperationLog,
  type OperationLogOperator,
} from '../permission/operation-log.util';
import { lockUserRowsForUpdate } from '../user-lock.util';
import type { BatchDeactivateDto, RestoreConfirmDto, RestorePreviewDto } from './user-admin.dto';
import type { HrLifecycleGateway, HrRestorePreviewItem, HrRestoreTarget } from './hr-lifecycle.client';
import { HrLifecycleClient } from './hr-lifecycle.client';

/** 操作日志幂等作用域 */
const IDEMPOTENCY_SCOPE = {
  BATCH_DEACTIVATE: 'users.batch-deactivate',
  BATCH_RESTORE: 'users.batch-restore',
} as const;

/** 注销整批校验逐目标阻塞原因（USER_BATCH_BLOCKED details.failures[].code，API 文档同步） */
const DEACTIVATE_FAILURE = {
  TARGET_NOT_FOUND: '目标账号不存在',
  TARGET_DEACTIVATED: '目标账号已注销',
  SELF_MODIFICATION: '不能注销自己的账号',
  SUPER_ADMIN_TARGET: '超级管理员账号仅可由超级管理员管理',
  LAST_SUPER_ADMIN: '系统必须保留至少一名超级管理员',
} as const;

/** 恢复整批校验逐目标阻塞原因 */
const RESTORE_FAILURE = {
  TARGET_NOT_FOUND: '目标账号不存在',
  TARGET_NOT_DEACTIVATED: '目标账号未处于已注销状态',
  SUPER_ADMIN_TARGET: '超级管理员账号仅可由超级管理员管理',
  PHONE_OCCUPIED: '手机号已被其他待激活/正常账号占用',
  VERSION_CONFLICT: '账号状态已变化，请重新预览',
} as const;

/** 注销目标（校验通过） */
interface DeactivationTarget {
  id: number;
  name: string;
  phone: string;
  status: 'PENDING_ACTIVATION' | 'ACTIVE';
  lifecycleVersion: number;
}

/** 恢复预览的逐目标展示项 */
export interface RestorePreviewItem {
  userId: number;
  name: string;
  phoneMasked: string;
  lifecycleVersion: number;
  restoreStatus: 'PENDING_ACTIVATION' | 'ACTIVE';
  restorable: boolean;
  blockedReason?: string;
  /** 恢复时将被移除的功能授权（目录未注册或数据范围失效） */
  revokedGrants: Array<{ functionCode: string; dataScope: string; name: string }>;
  /** hr 侧：将被清除的部门名称快照 */
  removedDepartmentNames?: string[];
  /** hr 侧：岗位将被置空 */
  positionCleared?: boolean;
}

/**
 * 账号生命周期编排服务（backstage PRD §3、主 PRD §2.6/§9.4；实现规划 T3-5）。
 *
 * 批量注销（单一本地事务三件套）：
 * ① base 注销——status=DEACTIVATED + 注销时间/操作人 + session_version 递增（全部会话下次请求即失效）
 *    + lifecycle_version 递增 + 目标全部未使用邀请立即失效；
 * ② backstage 取消该批用户全部待审批资料修改申请（账号资料型，cancel_source=ACCOUNT_DEACTIVATED；
 *    加班/库存等业务型待审批记录不受影响，仍按原规则处理）；
 * ③ 每名用户一条"账号生命周期处理"任务（PENDING_ENQUEUE，stableTaskUuid 稳定业务键——
 *    hr 消费按业务键幂等；hr 下线不阻塞注销，恢复后继续处理，T4-2/T6-8 消费）。
 * 任一部分失败整批回滚。
 *
 * 批量恢复（两阶段安全顺序）：预览与确认都必须实际调用 hr 受保护内部接口——hr 未就绪/超时/
 * 无效响应 → HR_SERVICE_UNAVAILABLE，任何账号不发生变更；确认先由 hr 整批幂等应用
 * （稳定恢复请求 ID），成功后 platform-core 才在本地事务清除注销标记、写恢复人/时间并做
 * 权限兼容性清理；hr 成功而本地失败时，同 restoreRequestId 重试：hr 返回原幂等结果，
 * 本地再完成恢复（不要求人工补偿、不跨服务直写 hr schema）。
 */
@Injectable()
export class UserLifecycleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HrLifecycleClient) private readonly hr: HrLifecycleGateway,
  ) {}

  /**
   * 批量注销（整批全有或全无，主 PRD §2.6）。
   *
   * @param operatorId 操作人 id
   * @param dto 目标用户（≤100 不重复）+ 可选幂等键
   * @returns 处理完成的目标标识（重放返回原结果）
   * @throws USER_BATCH_BLOCKED 任一目标校验失败（details.failures 逐目标原因，整批不变更）
   */
  async batchDeactivate(operatorId: number, dto: BatchDeactivateDto): Promise<{ ok: true; userIds: number[] }> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload({ userIds: dto.userIds });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: USER_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.BATCH_DEACTIVATE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        await lockUserRowsForUpdate(tx, dto.userIds);
        const targets = await this.loadDeactivationTargets(tx, dto.userIds, operator);
        const now = new Date();
        for (const target of targets) {
          const lifecycleVersion = target.lifecycleVersion + 1;
          // ① base 注销：注销标记 + 撤销全部会话（session_version 递增）+ 生命周期版本递增
          await tx.user.update({
            where: { id: target.id },
            data: {
              status: 'DEACTIVATED',
              deletedAt: now,
              deletedBy: operator.id,
              sessionVersion: { increment: 1 },
              lifecycleVersion: { increment: 1 },
              updatedBy: operator.id,
            },
          });
          // 目标全部未使用邀请立即失效（含激活与密码重置凭证）
          await tx.activationInvitation.updateMany({
            where: { userId: target.id, status: 'VALID' },
            data: { status: 'REVOKED', revokedAt: now },
          });
          // ② 取消待审批资料修改申请（账号资料型审批，cancel_source=ACCOUNT_DEACTIVATED）
          await this.cancelPendingProfileChanges(tx, target.id, operator, now);
          // ③ 账号生命周期处理任务（稳定业务键：注销同一生命周期版本只产生同一 UUID）
          const ref: AccountLifecycleTaskRef = {
            event: 'DEACTIVATED',
            userId: target.id,
            deactivatedAt: now.toISOString(),
            lifecycleVersion,
          };
          await tx.backgroundTask.create({
            data: {
              taskUuid: stableTaskUuid(`${TASK_TYPE_ACCOUNT_LIFECYCLE}:DEACTIVATED:${target.id}:${lifecycleVersion}`),
              taskType: TASK_TYPE_ACCOUNT_LIFECYCLE,
              module: 'backstage',
              initiatorId: operator.id,
              initiatorType: 'USER',
              // ref 结构由 @wbme/tasks 契约定义（JSON 列）
              ref: ref as unknown as Prisma.InputJsonValue,
            },
          });
          await writeBackstageOperationLog(tx, {
            operator,
            feature: USER_MANAGE_FUNCTION_CODE,
            actionType: 'DELETE',
            summary: `注销用户：${target.name}（${maskPhone(target.phone)}，${target.status === 'PENDING_ACTIVATION' ? '待激活' : '正常'}→已注销）`,
          });
        }
        return {
          result: { ok: true as const, userIds: dto.userIds },
          actionType: 'DELETE',
          summary: `批量注销：${targets.length} 人（${targets.map((target) => target.name).join('、')}）`,
        };
      },
    });
  }

  /**
   * 恢复预览：逐目标差异（恢复后状态/手机号占用/将被移除的授权/组织侧清理项）。
   * 实际调用 hr 内部接口（就绪检查）；hr 不可用 → HR_SERVICE_UNAVAILABLE（零变更）。
   *
   * @param operatorId 操作人 id
   * @param dto 目标用户（已注销账号）
   * @returns 稳定恢复请求 ID + 逐目标预览项
   * @throws HR_SERVICE_UNAVAILABLE hr 停止/未就绪/超时/无效响应
   */
  async previewRestore(operatorId: number, dto: RestorePreviewDto): Promise<{ restoreRequestId: string; items: RestorePreviewItem[] }> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const catalog = await loadCatalogMap(this.prisma.client);
    const users = await this.prisma.client.user.findMany({ where: { id: { in: dto.userIds } } });
    const byId = new Map(users.map((user) => [user.id, user]));
    const occupiedPhones = await this.loadOccupiedPhones(
      users.map((user) => user.phone),
      dto.userIds,
    );
    const grantsByUser = await this.loadGrantsByUser(dto.userIds);

    const restoreRequestId = randomUUID();
    // hr 就绪检查 + 组织兼容性预览（实际调用受保护内部接口，只针对已注销目标）
    const hrTargets: HrRestoreTarget[] = users
      .filter((user) => user.deletedAt !== null)
      .map((user) => ({
        userId: user.id,
        deactivatedAt: (user.deletedAt as Date).toISOString(),
        lifecycleVersion: user.lifecycleVersion,
      }));
    const hrPreview = await this.hr.restorePreview(restoreRequestId, hrTargets);
    const hrByUser = new Map(hrPreview.targets.map((item) => [item.userId, item]));

    const items = dto.userIds.map((userId): RestorePreviewItem => {
      const user = byId.get(userId);
      if (!user) {
        return {
          userId,
          name: '',
          phoneMasked: '',
          lifecycleVersion: 0,
          restoreStatus: 'PENDING_ACTIVATION',
          restorable: false,
          blockedReason: 'TARGET_NOT_FOUND',
          revokedGrants: [],
        };
      }
      const hrItem = hrByUser.get(userId);
      const revokedGrants = (grantsByUser.get(userId) ?? [])
        .filter((row) => {
          const fn = catalog.get(row.functionCode);
          return !fn || !fn.dataScopeOptions.includes(row.dataScope);
        })
        .map((row) => ({ functionCode: row.functionCode, dataScope: row.dataScope, name: grantLabel(catalog, row.functionCode, row.dataScope) }));
      const blockedReason = this.restoreBlockReason(user, operator, occupiedPhones, hrItem);
      return {
        userId: user.id,
        name: user.name,
        phoneMasked: maskPhone(user.phone),
        lifecycleVersion: user.lifecycleVersion,
        // 恢复后状态推导：无密码账号只能是注销前的待激活（CHECK 约束 ACTIVE 必有密码，激活事务必然写密码）
        restoreStatus: user.passwordHash === null ? 'PENDING_ACTIVATION' : 'ACTIVE',
        restorable: blockedReason === undefined && hrItem?.restorable === true,
        ...(blockedReason ? { blockedReason } : {}),
        revokedGrants,
        ...(hrItem?.removedDepartmentNames ? { removedDepartmentNames: hrItem.removedDepartmentNames } : {}),
        ...(hrItem?.positionCleared !== undefined ? { positionCleared: hrItem.positionCleared } : {}),
      };
    });
    return { restoreRequestId, items };
  }

  /**
   * 恢复确认（两阶段安全顺序，backstage PRD §3）：
   * 幂等预检查 → 本地预校验（零变更快速失败，不调 hr）→ hr 整批幂等应用 → 本地事务完成恢复。
   * 本地事务失败时同 restoreRequestId 重试：hr 幂等返回原结果，本地再完成。
   *
   * @param operatorId 操作人 id
   * @param dto 稳定恢复请求 ID + 各账号生命周期版本 + 可选幂等键
   * @returns 恢复完成的目标标识（重放返回原结果）
   * @throws USER_BATCH_BLOCKED 本地预校验失败；HR_SERVICE_UNAVAILABLE hr 不可用；CONFLICT hr 整批拒绝或版本漂移
   */
  async confirmRestore(operatorId: number, dto: RestoreConfirmDto): Promise<{ ok: true; userIds: number[] }> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload({ restoreRequestId: dto.restoreRequestId, targets: dto.targets });
    if (dto.idempotencyKey) {
      const replayed = await tryReplayIdempotentResult<{ ok: true; userIds: number[] }>(this.prisma.client, {
        operatorId: operator.id,
        scope: IDEMPOTENCY_SCOPE.BATCH_RESTORE,
        idempotencyKey: dto.idempotencyKey,
        fingerprint,
      });
      if (replayed.found) {
        return replayed.result;
      }
    }
    const targetIds = dto.targets.map((target) => target.userId);
    const users = await this.prisma.client.user.findMany({ where: { id: { in: targetIds } } });
    const occupiedPhones = await this.loadOccupiedPhones(
      users.map((user) => user.phone),
      targetIds,
    );
    this.assertRestorable(users, dto, operator, occupiedPhones);

    // 阶段一：hr 整批幂等应用（稳定恢复请求 ID；此调用即 hr 就绪检查）
    const byId = new Map(users.map((user) => [user.id, user]));
    const hrTargets: HrRestoreTarget[] = dto.targets.map((target) => ({
      userId: target.userId,
      deactivatedAt: (byId.get(target.userId)?.deletedAt as Date).toISOString(),
      lifecycleVersion: target.lifecycleVersion,
    }));
    await this.hr.restoreApply(dto.restoreRequestId, hrTargets);

    // 阶段二：本地事务（行锁 → 版本条件复核 → 恢复 + 权限兼容性清理 + 逐人日志）
    const catalog = await loadCatalogMap(this.prisma.client);
    return commitIdempotentOperation(this.prisma.client, {
      operator,
      feature: USER_MANAGE_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.BATCH_RESTORE,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        await lockUserRowsForUpdate(tx, targetIds);
        const now = new Date();
        const sorted = [...dto.targets].sort((a, b) => a.userId - b.userId);
        for (const target of sorted) {
          const user = byId.get(target.userId);
          if (!user) {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
          // 版本条件复核：预览后账号被变更/已恢复则冲突回滚（hr 已成功时客户端同 ID 重试完成本地恢复）
          const restored = await tx.user.updateMany({
            where: { id: target.userId, lifecycleVersion: target.lifecycleVersion, deletedAt: { not: null } },
            data: {
              status: user.passwordHash === null ? 'PENDING_ACTIVATION' : 'ACTIVE',
              deletedAt: null,
              deletedBy: null,
              restoredBy: operator.id,
              restoredAt: now,
              lifecycleVersion: { increment: 1 },
              permissionVersion: { increment: 1 },
              updatedBy: operator.id,
              updatedAt: now,
            },
          });
          if (restored.count === 0) {
            throw new BusinessException(frameworkErrors.CONFLICT);
          }
          // 权限兼容性清理：物理删除失效授权行（目录未注册或数据范围失效），明细入操作日志
          const grants = await tx.employeeGrant.findMany({ where: { userId: target.userId } });
          const invalid = grants.filter((row) => {
            const fn = catalog.get(row.functionCode);
            return !fn || !fn.dataScopeOptions.includes(row.dataScope);
          });
          if (invalid.length > 0) {
            await tx.employeeGrant.deleteMany({ where: { id: { in: invalid.map((row) => row.id) } } });
          }
          const revoked = invalid.map((row) => grantLabel(catalog, row.functionCode, row.dataScope));
          await writeBackstageOperationLog(tx, {
            operator,
            feature: USER_MANAGE_FUNCTION_CODE,
            actionType: 'UPDATE',
            summary:
              `恢复用户：${user.name}（${maskPhone(user.phone)}，恢复为${user.passwordHash === null ? '待激活' : '正常'}）` +
              (revoked.length > 0 ? `，移除失效授权 [${revoked.join('、')}]` : ''),
          });
        }
        return {
          result: { ok: true as const, userIds: targetIds },
          actionType: 'UPDATE',
          summary: `批量恢复：${sorted.length} 人（恢复请求 ${dto.restoreRequestId}）`,
        };
      },
    });
  }

  /**
   * 注销整批校验（行锁后执行）：存在性/状态/自我注销/超管保护/最后一名可用超管保护。
   *
   * @returns 校验通过的目标（含当前生命周期版本，按 id 升序）
   * @throws USER_BATCH_BLOCKED 任一目标失败（details.failures 逐目标原因）
   */
  private async loadDeactivationTargets(
    tx: Prisma.TransactionClient,
    userIds: readonly number[],
    operator: OperationLogOperator,
  ): Promise<DeactivationTarget[]> {
    const rows = await tx.user.findMany({ where: { id: { in: [...userIds] } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    // 可用超管 = ACTIVE 且未注销（待激活超管尚不可登录，不计入"可用"）
    const activeSuperCount = await tx.user.count({ where: { isSuperAdmin: true, status: 'ACTIVE', deletedAt: null } });
    const failures: Array<{ userId: number; code: string; message: string }> = [];
    const targets: DeactivationTarget[] = [];
    let activeSuperInBatch = 0;
    for (const userId of userIds) {
      const target = byId.get(userId);
      if (!target) {
        failures.push({ userId, code: 'TARGET_NOT_FOUND', message: DEACTIVATE_FAILURE.TARGET_NOT_FOUND });
        continue;
      }
      if (target.deletedAt !== null || target.status === 'DEACTIVATED') {
        failures.push({ userId, code: 'TARGET_DEACTIVATED', message: DEACTIVATE_FAILURE.TARGET_DEACTIVATED });
        continue;
      }
      if (target.id === operator.id) {
        failures.push({ userId, code: 'SELF_MODIFICATION', message: DEACTIVATE_FAILURE.SELF_MODIFICATION });
        continue;
      }
      if (target.isSuperAdmin && !operator.isSuperAdmin) {
        failures.push({ userId, code: 'SUPER_ADMIN_TARGET', message: DEACTIVATE_FAILURE.SUPER_ADMIN_TARGET });
        continue;
      }
      if (target.isSuperAdmin && target.status === 'ACTIVE') {
        activeSuperInBatch += 1;
      }
      targets.push({
        id: target.id,
        name: target.name,
        phone: target.phone,
        status: target.status as 'PENDING_ACTIVATION' | 'ACTIVE',
        lifecycleVersion: target.lifecycleVersion,
      });
    }
    // 本批包含全部可用超管 → 逐项标记（最后一名超管保护，主 PRD §3.1）
    if (activeSuperInBatch > 0 && activeSuperCount - activeSuperInBatch < 1) {
      for (const target of targets) {
        const row = byId.get(target.id);
        if (row?.isSuperAdmin && row.status === 'ACTIVE') {
          failures.push({ userId: target.id, code: 'LAST_SUPER_ADMIN', message: DEACTIVATE_FAILURE.LAST_SUPER_ADMIN });
        }
      }
    }
    if (failures.length > 0) {
      throw new BusinessException(accountErrors.USER_BATCH_BLOCKED, { failures });
    }
    return targets.sort((a, b) => a.id - b.id);
  }

  /** 取消目标全部待审批资料修改申请（账号资料型；状态+版本条件更新，与审批处理并发必有一方失败） */
  private async cancelPendingProfileChanges(
    tx: Prisma.TransactionClient,
    userId: number,
    operator: OperationLogOperator,
    now: Date,
  ): Promise<void> {
    const pending = await tx.approvalRequest.findMany({
      where: { applicantId: userId, requestType: 'PROFILE_CHANGE', status: 'PENDING' },
      select: { id: true, version: true },
    });
    for (const request of pending) {
      const cancelled = await tx.approvalRequest.updateMany({
        where: { id: request.id, status: 'PENDING', version: request.version },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledBy: operator.id,
          cancelSource: 'ACCOUNT_DEACTIVATED',
          version: { increment: 1 },
        },
      });
      if (cancelled.count === 0) {
        throw new BusinessException(frameworkErrors.CONFLICT);
      }
      await tx.approvalActionRecord.create({
        data: {
          requestId: request.id,
          action: 'CANCEL',
          actorId: operator.id,
          actorName: operator.name,
          cancelSource: 'ACCOUNT_DEACTIVATED',
        },
      });
    }
  }

  /** 恢复预校验（只读）：存在/已注销/版本匹配/超管目标/手机号未占用；失败抛 USER_BATCH_BLOCKED（整批不变更、不调 hr） */
  private assertRestorable(
    users: Array<{
      id: number;
      phone: string;
      isSuperAdmin: boolean;
      deletedAt: Date | null;
      lifecycleVersion: number;
    }>,
    dto: RestoreConfirmDto,
    operator: OperationLogOperator,
    occupiedPhones: Set<string>,
  ): void {
    const byId = new Map(users.map((user) => [user.id, user]));
    const failures: Array<{ userId: number; code: string; message: string }> = [];
    for (const target of dto.targets) {
      const user = byId.get(target.userId);
      if (!user) {
        failures.push({ userId: target.userId, code: 'TARGET_NOT_FOUND', message: RESTORE_FAILURE.TARGET_NOT_FOUND });
        continue;
      }
      if (user.deletedAt === null) {
        failures.push({ userId: target.userId, code: 'TARGET_NOT_DEACTIVATED', message: RESTORE_FAILURE.TARGET_NOT_DEACTIVATED });
        continue;
      }
      if (user.lifecycleVersion !== target.lifecycleVersion) {
        failures.push({ userId: target.userId, code: 'VERSION_CONFLICT', message: RESTORE_FAILURE.VERSION_CONFLICT });
        continue;
      }
      if (user.isSuperAdmin && !operator.isSuperAdmin) {
        failures.push({ userId: target.userId, code: 'SUPER_ADMIN_TARGET', message: RESTORE_FAILURE.SUPER_ADMIN_TARGET });
        continue;
      }
      if (occupiedPhones.has(user.phone)) {
        failures.push({ userId: target.userId, code: 'PHONE_OCCUPIED', message: RESTORE_FAILURE.PHONE_OCCUPIED });
      }
    }
    if (failures.length > 0) {
      throw new BusinessException(accountErrors.USER_BATCH_BLOCKED, { failures });
    }
  }

  /** 手机号被其他待激活/正常账号占用的号码集合（排除本批目标自身） */
  private async loadOccupiedPhones(phones: readonly string[], excludeUserIds: readonly number[]): Promise<Set<string>> {
    if (phones.length === 0) {
      return new Set();
    }
    const rows = await this.prisma.client.user.findMany({
      where: {
        phone: { in: [...phones] },
        id: { notIn: [...excludeUserIds] },
        status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] },
        deletedAt: null,
      },
      select: { phone: true },
    });
    return new Set(rows.map((row) => row.phone));
  }

  /** 预览的逐目标阻塞原因（本地事实 + hr 侧原因码透传） */
  private restoreBlockReason(
    user: { id: number; phone: string; isSuperAdmin: boolean; deletedAt: Date | null },
    operator: OperationLogOperator,
    occupiedPhones: Set<string>,
    hrItem: HrRestorePreviewItem | undefined,
  ): string | undefined {
    if (user.deletedAt === null) {
      return 'TARGET_NOT_DEACTIVATED';
    }
    if (user.isSuperAdmin && !operator.isSuperAdmin) {
      return 'SUPER_ADMIN_TARGET';
    }
    if (occupiedPhones.has(user.phone)) {
      return 'PHONE_OCCUPIED';
    }
    if (hrItem && !hrItem.restorable) {
      return hrItem.blockedReasonCode ?? 'HR_BLOCKED';
    }
    return undefined;
  }

  /** 按用户分组加载授权行 */
  private async loadGrantsByUser(
    userIds: readonly number[],
  ): Promise<Map<number, Array<{ id: number; userId: number; functionCode: string; dataScope: 'SELF' | 'DEPARTMENT' | 'COMPANY' }>>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.client.employeeGrant.findMany({ where: { userId: { in: [...userIds] } } });
    const byUser = new Map<number, typeof rows>();
    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }
    return byUser;
  }
}
