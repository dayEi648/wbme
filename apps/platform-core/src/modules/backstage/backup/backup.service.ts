import { Injectable } from '@nestjs/common';
import { backupErrors, BusinessException, DATA_BACKUP_FUNCTION_CODE } from '@wbme/contracts';
import {
  createPendingTask,
  prismaTaskWriter,
  stableTaskUuid,
  TASK_TYPE_IMMEDIATE_BACKUP,
  TASK_TYPE_RESTORE_DELIVERY,
  type ImmediateBackupTaskRef,
  type RestoreDeliveryTaskRef,
} from '@wbme/tasks';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../permission/operation-log.util';
import type { ImmediateBackupDto, RestoreConfirmDto } from './backup.dto';

const IDEMPOTENCY_SCOPE = {
  IMMEDIATE_BACKUP: 'backups.immediate',
  RESTORE_CONFIRM: 'restores.confirm',
} as const;

/** 未完成恢复状态 */
const ACTIVE_RESTORE_STATUSES = ['PENDING', 'PRECHECK', 'MAINTENANCE', 'RESTORING'] as const;

/**
 * 备份与恢复编排（创建任务行 + backups/restores 事实；实际 pg_dump 由 Worker 执行）。
 */
@Injectable()
export class BackupService {
  constructor(private readonly prisma: PrismaService) {}

  /** 备份列表 */
  async listBackups(dto: { page: number; pageSize: number }): Promise<unknown> {
    const skip = (dto.page - 1) * dto.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.backup.findMany({ orderBy: { backupTime: 'desc' }, skip, take: dto.pageSize }),
      this.prisma.client.backup.count(),
    ]);
    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }

  /** 恢复记录列表 */
  async listRestores(dto: { page: number; pageSize: number }): Promise<unknown> {
    const skip = (dto.page - 1) * dto.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.restore.findMany({ orderBy: { initiatedAt: 'desc' }, skip, take: dto.pageSize }),
      this.prisma.client.restore.count(),
    ]);
    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }

  /**
   * 发起立即备份（幂等：同用户同分钟窗口稳定 taskUuid）。
   */
  async triggerImmediateBackup(operatorId: number, dto: ImmediateBackupDto): Promise<unknown> {
    await this.assertNoActiveRestore();
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const windowKey = new Date().toISOString().slice(0, 16);
    const fingerprint = fingerprintPayload({ windowKey });
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: DATA_BACKUP_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE.IMMEDIATE_BACKUP,
      idempotencyKey: dto.idempotencyKey ?? `immediate:${operatorId}:${windowKey}`,
      fingerprint,
      run: async (tx) => {
        const running = await tx.backup.findFirst({ where: { status: 'RUNNING', taskType: 'IMMEDIATE' } });
        if (running) {
          throw new BusinessException(backupErrors.BACKUP_LOCK_BUSY);
        }
        const backup = await tx.backup.create({
          data: {
            taskType: 'IMMEDIATE',
            status: 'RUNNING',
            backupTime: new Date(),
            startedAt: new Date(),
            createdBy: operatorId,
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
          initiatorId: operatorId,
          initiatorType: 'USER',
          ref,
        });
        return {
          result: { backupId: backup.id, taskUuid },
          actionType: 'CREATE',
          summary: '发起立即备份',
        };
      },
    });
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

  /** 恢复确认：创建 restore 行 + RESTORE_DELIVERY 任务 */
  async confirmRestore(operatorId: number, dto: RestoreConfirmDto): Promise<unknown> {
    await this.assertSuperAdmin(operatorId);
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

  private async assertNoActiveRestore(): Promise<void> {
    const active = await this.prisma.client.restore.findFirst({
      where: { status: { in: [...ACTIVE_RESTORE_STATUSES] } },
    });
    if (active) {
      throw new BusinessException(backupErrors.RESTORE_IN_PROGRESS);
    }
  }

  private async assertSuperAdmin(operatorId: number): Promise<void> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: operatorId },
      select: { isSuperAdmin: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null || !user.isSuperAdmin) {
      throw new BusinessException(backupErrors.RESTORE_SUPER_ADMIN_ONLY);
    }
  }
}
