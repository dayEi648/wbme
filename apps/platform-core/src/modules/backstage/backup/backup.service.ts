import { Injectable } from '@nestjs/common';
import { backupErrors, BusinessException, createPaginationResponse, DATA_BACKUP_FUNCTION_CODE } from '@wbme/contracts';
import { assertDiskAcceptsCapacityWrites } from '@wbme/server';
import {
  createPendingTask,
  prismaTaskWriter,
  stableTaskUuid,
  TASK_TYPE_EMERGENCY_BACKUP,
  TASK_TYPE_IMMEDIATE_BACKUP,
  TASK_TYPE_RESTORE_DELIVERY,
  type ImmediateBackupTaskRef,
  type RestoreDeliveryTaskRef,
  type TaskInitiatorType,
} from '@wbme/tasks';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
  type OperationLogOperator,
} from '../permission/operation-log.util';
import type { ImmediateBackupDto, RestoreConfirmDto } from './backup.dto';

const IDEMPOTENCY_SCOPE = {
  IMMEDIATE_BACKUP: 'backups.immediate',
  RESTORE_CONFIRM: 'restores.confirm',
} as const;

/** 未完成恢复状态 */
const ACTIVE_RESTORE_STATUSES = ['PENDING', 'PRECHECK', 'MAINTENANCE', 'RESTORING'] as const;

/** 紧急备份终态轮询间隔（毫秒） */
const EMERGENCY_BACKUP_POLL_INTERVAL_MS = 2_000;

/** 紧急备份等待上限（毫秒；超时按失败处理，任务仍在执行时用户可重试继续等待） */
const EMERGENCY_BACKUP_WAIT_MS = 300_000;

/** 复用本流程紧急备份的时间窗口（重试/幂等场景识别；backstage PRD §10 同一恢复流程只创建一个回退副本） */
const EMERGENCY_BACKUP_RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * 备份与恢复编排（创建任务行 + backups/restores 事实；实际 pg_dump 由 Worker 执行）。
 */
@Injectable()
export class BackupService {
  constructor(private readonly prisma: PrismaService) {}

  /** 按 id 查询备份（内部接口用） */
  async findBackupById(backupId: number): Promise<{ status: string } | null> {
    const backup = await this.prisma.client.backup.findUnique({ where: { id: backupId } });
    return backup ? { status: backup.status } : null;
  }

  /** 备份列表 */
  async listBackups(dto: { page: number; pageSize: number }): Promise<unknown> {
    const skip = (dto.page - 1) * dto.pageSize;
    const [items, total] = await Promise.all([
      // 次级 id 兜底：同秒备份时分页边界稳定（主 PRD §9.5）
      this.prisma.client.backup.findMany({ orderBy: [{ backupTime: 'desc' }, { id: 'desc' }], skip, take: dto.pageSize }),
      this.prisma.client.backup.count(),
    ]);
    return createPaginationResponse(items, total, dto.page, dto.pageSize);
  }

  /** 恢复记录列表 */
  async listRestores(dto: { page: number; pageSize: number }): Promise<unknown> {
    const skip = (dto.page - 1) * dto.pageSize;
    const [items, total] = await Promise.all([
      // 次级 id 兜底：同秒发起时分页边界稳定（主 PRD §9.5）
      this.prisma.client.restore.findMany({ orderBy: [{ initiatedAt: 'desc' }, { id: 'desc' }], skip, take: dto.pageSize }),
      this.prisma.client.restore.count(),
    ]);
    return createPaginationResponse(items, total, dto.page, dto.pageSize);
  }

  /**
   * 创建立即备份任务（内部共用逻辑）。
   *
   * @param tx 事务客户端
   * @param initiatorId 发起人标识（用户 id 或系统调用方标识）
   * @param initiatorType 发起人类型
   * @returns 备份 id 与任务 uuid
   */
  private async createImmediateBackupTask(
    tx: Prisma.TransactionClient,
    initiatorId: number,
    initiatorType: TaskInitiatorType,
  ): Promise<{ backupId: number; taskUuid: string }> {
    // 任意运行中的备份（定时/立即）都互斥：备份按创建时间串行（backstage PRD §10）
    const running = await tx.backup.findFirst({ where: { status: 'RUNNING' } });
    if (running) {
      throw new BusinessException(backupErrors.BACKUP_LOCK_BUSY);
    }
    const backup = await tx.backup.create({
      data: {
        taskType: 'IMMEDIATE',
        status: 'RUNNING',
        backupTime: new Date(),
        startedAt: new Date(),
        createdBy: initiatorId,
      },
    });
    const businessKey = `IMMEDIATE_BACKUP:${backup.id}`;
    const taskUuid = stableTaskUuid(businessKey);
    const ref: ImmediateBackupTaskRef = { backupId: backup.id };
    await tx.backup.update({ where: { id: backup.id }, data: { taskUuid } });
    await createPendingTask(prismaTaskWriter(tx), {
      taskUuid,
      taskType: TASK_TYPE_IMMEDIATE_BACKUP,
      module: 'backstage',
      initiatorId,
      initiatorType,
      ref,
    });
    return { backupId: backup.id, taskUuid };
  }

  /**
   * 发起立即备份。
   *
   * 幂等语义：显式幂等键重试返回原结果；未传键时自动键为随机 UUID（每次触发都是新操作）。
   * "重复点击不得重复创建同一任务"由 RUNNING 互斥锁兜底（backstage PRD §10）；
   * 不用分钟窗口作为自动键，否则"触发成功后异步任务失败"时同分钟重试被重放阻塞、
   * 无法重新触发（L3）。
   */
  async triggerImmediateBackup(operatorId: number, dto: ImmediateBackupDto): Promise<unknown> {
    await assertDiskAcceptsCapacityWrites();
    await this.assertNoActiveRestore();
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload({ operatorId });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: DATA_BACKUP_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.IMMEDIATE_BACKUP,
      idempotencyKey: dto.idempotencyKey ?? `immediate:${operatorId}:${randomUUID()}`,
      fingerprint,
      run: async (tx) => {
        const { backupId, taskUuid } = await this.createImmediateBackupTask(tx, operatorId, 'USER');
        return {
          result: { backupId, taskUuid },
          actionType: 'CREATE',
          summary: '发起立即备份',
        };
      },
    });
  }

  /**
   * 内部调用发起立即备份（迁移前钩子；不走用户会话，主 PRD §9.4）。
   *
   * @param caller 调用方服务名（如 migration-runner）
   * @param dto 幂等键等请求参数
   * @returns 备份 id 与任务 uuid
   */
  async triggerImmediateBackupInternal(caller: string, dto: ImmediateBackupDto): Promise<{ backupId: number; taskUuid: string }> {
    await assertDiskAcceptsCapacityWrites();
    await this.assertNoActiveRestore();
    // 系统调用方使用固定 operatorId = 0（operation_logs_idempotency_unique 中 COALESCE(operator_id, 0) 与显式 0 同桶；auto-increment 从 1 开始，0 保留给系统）
    const systemOperatorId = 0;
    const operator: OperationLogOperator = { id: systemOperatorId, name: `system:${caller}`, isSuperAdmin: true };
    const windowKey = new Date().toISOString().slice(0, 16);
    const fingerprint = fingerprintPayload({ caller, windowKey });
    const result = await executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: DATA_BACKUP_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.IMMEDIATE_BACKUP,
      idempotencyKey: dto.idempotencyKey ?? `internal:${caller}:${windowKey}`,
      fingerprint,
      run: async (tx) => {
        const { backupId, taskUuid } = await this.createImmediateBackupTask(tx, systemOperatorId, 'SCHEDULER');
        return {
          result: { backupId, taskUuid },
          actionType: 'CREATE',
          summary: `系统调用方 ${caller} 发起立即备份`,
        };
      },
    });
    return result as { backupId: number; taskUuid: string };
  }

  /** 恢复预检（超管） */
  async precheckRestore(operatorId: number, backupId: number): Promise<unknown> {
    await this.assertSuperAdmin(operatorId);
    const backup = await this.prisma.client.backup.findUnique({ where: { id: backupId } });
    if (!backup || backup.status !== 'SUCCEEDED') {
      throw new BusinessException(backupErrors.BACKUP_UNVERIFIED);
    }
    await this.assertNoActiveRestore();
    return {
      backupId: backup.id,
      backupTime: backup.backupTime,
      fileSize: backup.fileSize?.toString() ?? null,
      checksum: backup.checksum,
      pgVersion: backup.pgVersion,
      ready: true,
    };
  }

  /**
   * 恢复确认：先完成恢复前紧急备份并验证，再创建 restore 行 + RESTORE_DELIVERY 任务。
   *
   * 紧急备份失败且未人工确认风险（proceedWithoutEmergency）时拒绝进入恢复，
   * 不得伪装为已有回退副本（backstage PRD §10）。
   */
  async confirmRestore(operatorId: number, dto: RestoreConfirmDto): Promise<unknown> {
    await this.assertSuperAdmin(operatorId);
    // 目标备份校验与互斥前置（避免无谓创建紧急备份任务）
    const target = await this.prisma.client.backup.findUnique({ where: { id: dto.backupId } });
    if (!target || target.status !== 'SUCCEEDED') {
      throw new BusinessException(backupErrors.BACKUP_UNVERIFIED);
    }
    await this.assertNoActiveRestore();
    // 运行中的普通备份必须先行结束（backstage PRD §10：普通备份仍在运行时，
    // 整库恢复停留在预检等待，不得并发 pg_dump）
    const runningBackup = await this.prisma.client.backup.findFirst({ where: { status: 'RUNNING' } });
    if (runningBackup) {
      throw new BusinessException(backupErrors.BACKUP_LOCK_BUSY, { backupId: runningBackup.id });
    }
    // 恢复前紧急备份：创建（或复用窗口内进行中的）并等待终态
    const emergencyBackupId = await this.ensureEmergencyBackup(operatorId);
    const emergencySucceeded = await this.waitForEmergencyBackup(emergencyBackupId);
    if (!emergencySucceeded && !dto.proceedWithoutEmergency) {
      throw new BusinessException(backupErrors.EMERGENCY_BACKUP_FAILED, {
        emergencyBackupId,
      });
    }
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload({ backupId: dto.backupId });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: DATA_BACKUP_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.RESTORE_CONFIRM,
      idempotencyKey: dto.idempotencyKey,
      fingerprint,
      run: async (tx) => {
        const backup = await tx.backup.findUnique({ where: { id: dto.backupId } });
        if (!backup || backup.status !== 'SUCCEEDED') {
          throw new BusinessException(backupErrors.BACKUP_UNVERIFIED);
        }
        const active = await tx.restore.findFirst({
          where: { status: { in: [...ACTIVE_RESTORE_STATUSES] } },
        });
        if (active) {
          throw new BusinessException(backupErrors.RESTORE_IN_PROGRESS);
        }
        const restoreUuid = randomUUID();
        const restore = await tx.restore.create({
          data: {
            restoreUuid,
            backupId: backup.id,
            status: 'PENDING',
            stage: 'PRECHECK',
            initiatedBy: operatorId,
            initiatedAt: new Date(),
          },
        });
        const taskUuid = stableTaskUuid(`RESTORE_DELIVERY:${restoreUuid}`);
        const ref: RestoreDeliveryTaskRef = { restoreUuid, backupId: backup.id };
        await createPendingTask(prismaTaskWriter(tx), {
          taskUuid,
          taskType: TASK_TYPE_RESTORE_DELIVERY,
          module: 'backstage',
          initiatorId: operatorId,
          initiatorType: 'USER',
          ref,
        });
        return {
          result: { restoreUuid, restoreId: restore.id, taskUuid },
          actionType: 'CREATE',
          summary: `确认整库恢复（备份 #${backup.id}）`,
        };
      },
    });
  }

  /**
   * 创建恢复前紧急备份（backstage PRD §10 回退副本）。
   *
   * 重试/幂等场景下复用窗口内进行中或已成功的紧急备份，不重复创建；
   * 失败或过期记录不阻塞新建。
   *
   * 磁盘门禁口径（2026-08-11 决策）：本路径**故意不过** `assertDiskAcceptsCapacityWrites`——
   * 紧急备份是整库恢复前最后的安全网，磁盘达严重阈值时恰恰是最需要执行恢复的时刻，
   * 拦截会把恢复路径彻底堵死；磁盘不足导致紧急备份失败时，由超管经
   * `proceedWithoutEmergency` 人工确认风险后继续（双重确认，主 PRD §10.3）。
   *
   * @param operatorId 发起人（超管）id
   * @returns 紧急备份记录 id
   */
  private async ensureEmergencyBackup(operatorId: number): Promise<number> {
    const since = new Date(Date.now() - EMERGENCY_BACKUP_RECENT_WINDOW_MS);
    const existing = await this.prisma.client.backup.findFirst({
      where: {
        taskType: 'EMERGENCY',
        status: { in: ['RUNNING', 'SUCCEEDED'] },
        createdAt: { gte: since },
      },
      orderBy: { id: 'desc' },
    });
    if (existing) {
      return existing.id;
    }
    // 单事务创建备份行 + 任务行：任务创建失败整体回滚，
    // 不留永挂 RUNNING 的紧急备份行阻塞后续备份/恢复（与 triggerImmediateBackup 同语义）
    return this.prisma.client.$transaction(async (tx) => {
      const emergency = await tx.backup.create({
        data: {
          taskType: 'EMERGENCY',
          status: 'RUNNING',
          backupTime: new Date(),
          startedAt: new Date(),
          createdBy: operatorId,
        },
      });
      const businessKey = `EMERGENCY_BACKUP:${emergency.id}`;
      const taskUuid = stableTaskUuid(businessKey);
      const ref: ImmediateBackupTaskRef = { backupId: emergency.id };
      await tx.backup.update({
        where: { id: emergency.id },
        data: { taskUuid },
      });
      await createPendingTask(prismaTaskWriter(tx), {
        taskUuid,
        taskType: TASK_TYPE_EMERGENCY_BACKUP,
        module: 'backstage',
        initiatorId: operatorId,
        initiatorType: 'USER',
        ref,
      });
      return emergency.id;
    });
  }

  /**
   * 轮询等待紧急备份达到终态。
   *
   * @param backupId 紧急备份记录 id
   * @returns true=成功；false=失败或超时（任务仍在执行时用户可重试继续等待）
   */
  private async waitForEmergencyBackup(backupId: number): Promise<boolean> {
    const deadline = Date.now() + EMERGENCY_BACKUP_WAIT_MS;
    while (Date.now() < deadline) {
      const row = await this.prisma.client.backup.findUnique({
        where: { id: backupId },
        select: { status: true },
      });
      if (!row) {
        return false;
      }
      if (row.status === 'SUCCEEDED') {
        return true;
      }
      if (row.status === 'FAILED') {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, EMERGENCY_BACKUP_POLL_INTERVAL_MS));
    }
    return false;
  }

  private async assertNoActiveRestore(): Promise<void> {
    const active = await this.prisma.client.restore.findFirst({
      where: { status: { in: [...ACTIVE_RESTORE_STATUSES] } },
    });
    if (active) {
      throw new BusinessException(backupErrors.RESTORE_IN_PROGRESS);
    }
  }

  /** 超管校验（恢复操作与恢复控制会话签发共用；RESTORE_SUPER_ADMIN_ONLY） */
  async assertSuperAdmin(operatorId: number): Promise<void> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: operatorId },
      select: { isSuperAdmin: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null || !user.isSuperAdmin) {
      throw new BusinessException(backupErrors.RESTORE_SUPER_ADMIN_ONLY);
    }
  }
}
