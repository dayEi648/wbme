import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupErrors, DATA_BACKUP_FUNCTION_CODE, frameworkErrors } from '@wbme/contracts';
import { BackupService } from './backup.service';
import { executeIdempotentOperation } from '../permission/operation-log.util';

/** 幂等操作直通 run；任务创建与 stable uuid 打桩（任务事实表语义由 packages/tasks 集成测试覆盖） */
vi.mock('../permission/operation-log.util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../permission/operation-log.util')>();
  return {
    ...actual,
    loadOperationLogOperator: vi.fn().mockResolvedValue({ id: 1, name: '超管' }),
    // 直通 run 并把调用方的 client 作为事务客户端传入（run 内使用 tx.backup/restore 等）
    executeIdempotentOperation: vi.fn(async (client: unknown, options: { run: (tx: unknown) => Promise<unknown> }) =>
      options.run(client),
    ),
  };
});

vi.mock('@wbme/tasks', () => ({
  createPendingTask: vi.fn().mockResolvedValue(undefined),
  stableTaskUuid: vi.fn((key: string) => `stable:${key}`),
  prismaTaskWriter: vi.fn(() => ({})),
  TASK_TYPE_IMMEDIATE_BACKUP: 'IMMEDIATE_BACKUP',
  TASK_TYPE_EMERGENCY_BACKUP: 'EMERGENCY_BACKUP',
  TASK_TYPE_RESTORE_DELIVERY: 'RESTORE_DELIVERY',
  TASK_TYPE_SCHEDULED_BACKUP: 'SCHEDULED_BACKUP',
}));

import { createPendingTask, stableTaskUuid } from '@wbme/tasks';
const mockedCreateTask = vi.mocked(createPendingTask);
const mockedStableUuid = vi.mocked(stableTaskUuid);
const mockedExec = vi.mocked(executeIdempotentOperation);

const succeededBackup = { id: 1, taskType: 'SCHEDULED', status: 'SUCCEEDED', backupTime: new Date(), fileSize: 1024n, checksum: 'abc', pgVersion: '18' };
const superAdminUser = { id: 1, isSuperAdmin: true, deletedAt: null };

type MockFn = ReturnType<typeof vi.fn>;

function prismaMock(txOverrides: Record<string, unknown> = {}): {
  client: {
    backup: { findMany: MockFn; count: MockFn; findUnique: MockFn; findFirst: MockFn; create: MockFn; update: MockFn };
    restore: { findMany: MockFn; count: MockFn; findFirst: MockFn; create: MockFn };
    user: { findUnique: MockFn };
    $transaction: MockFn;
  };
} {
  const client = {
    backup: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    restore: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    // 事务回调收到 client 自身（与生产语义一致：tx 与 client 同构）
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    ...txOverrides,
  };
  return { client };
}

function makeService(prisma: unknown): BackupService {
  return new BackupService(prisma as never);
}

describe('BackupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStableUuid.mockImplementation((key: string) => `stable:${key}`);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('triggerImmediateBackup', () => {
    it('任意运行中备份存在时抛 BACKUP_LOCK_BUSY', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.backup.findFirst).mockResolvedValue({ id: 9, status: 'RUNNING' });
      await expect(makeService(prisma).triggerImmediateBackup(1, {})).rejects.toMatchObject({
        entry: expect.objectContaining({ code: backupErrors.BACKUP_LOCK_BUSY.code }),
      });
    });

    it('创建 IMMEDIATE 备份行 + 稳定 taskUuid 任务，自动幂等键为随机 UUID（L3，非分钟窗口）', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.backup.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.client.backup.create).mockResolvedValue({ id: 7, taskType: 'IMMEDIATE', status: 'RUNNING' });
      vi.mocked(prisma.client.backup.update).mockResolvedValue({ id: 7 });
      const result = (await makeService(prisma).triggerImmediateBackup(1, {})) as { result: { backupId: number; taskUuid: string } };
      expect(result.result.backupId).toBe(7);
      // L3：未传幂等键时自动键为随机 UUID，同分钟重试不被重放阻塞（"触发成功后异步任务失败"可重新触发）
      expect(mockedExec.mock.calls[0]![1].idempotencyKey).toMatch(/^immediate:1:[0-9a-f-]{36}$/);
      expect(mockedStableUuid).toHaveBeenCalledWith('IMMEDIATE_BACKUP:7');
      expect(mockedCreateTask).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          taskType: 'IMMEDIATE_BACKUP',
          module: 'backstage',
          initiatorId: 1,
          initiatorType: 'USER',
          ref: { backupId: 7 },
        }),
      );
      expect(mockedExec.mock.calls[0]![1]).toMatchObject({
        scope: 'backups.immediate',
        feature: DATA_BACKUP_FUNCTION_CODE,
      });
    });
  });

  describe('triggerImmediateBackupInternal', () => {
    it('系统调用方创建 SCHEDULER 类型任务并绕过用户会话加载', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.backup.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.client.backup.create).mockResolvedValue({ id: 8, taskType: 'IMMEDIATE', status: 'RUNNING' });
      vi.mocked(prisma.client.backup.update).mockResolvedValue({ id: 8 });
      const result = (await makeService(prisma).triggerImmediateBackupInternal('migration-runner', {
        idempotencyKey: 'pre-migration:2026-08-09',
      })) as unknown as { result: { backupId: number; taskUuid: string } };
      expect(result.result.backupId).toBe(8);
      expect(mockedStableUuid).toHaveBeenCalledWith('IMMEDIATE_BACKUP:8');
      expect(mockedCreateTask).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          taskType: 'IMMEDIATE_BACKUP',
          module: 'backstage',
          initiatorId: 0,
          initiatorType: 'SCHEDULER',
          ref: { backupId: 8 },
        }),
      );
      expect(mockedExec.mock.calls[0]![1]).toMatchObject({
        scope: 'backups.immediate',
        idempotencyKey: 'pre-migration:2026-08-09',
      });
    });
  });

  describe('precheckRestore', () => {
    it('非超管抛 RESTORE_SUPER_ADMIN_ONLY', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue({ id: 1, isSuperAdmin: false, deletedAt: null });
      await expect(makeService(prisma).precheckRestore(1, 1)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: backupErrors.RESTORE_SUPER_ADMIN_ONLY.code }),
      });
    });

    it('备份不存在或非 SUCCEEDED 抛 BACKUP_UNVERIFIED', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue(superAdminUser);
      vi.mocked(prisma.client.backup.findUnique).mockResolvedValue(null);
      await expect(makeService(prisma).precheckRestore(1, 99)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: backupErrors.BACKUP_UNVERIFIED.code }),
      });
      vi.mocked(prisma.client.backup.findUnique).mockResolvedValue({ ...succeededBackup, status: 'FAILED' });
      await expect(makeService(prisma).precheckRestore(1, 1)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: backupErrors.BACKUP_UNVERIFIED.code }),
      });
    });

    it('恢复进行中抛 RESTORE_IN_PROGRESS', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue(superAdminUser);
      vi.mocked(prisma.client.backup.findUnique).mockResolvedValue(succeededBackup);
      vi.mocked(prisma.client.restore.findFirst).mockResolvedValue({ id: 5, status: 'RESTORING' });
      await expect(makeService(prisma).precheckRestore(1, 1)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: backupErrors.RESTORE_IN_PROGRESS.code }),
      });
    });

    it('校验通过返回预检结果', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue(superAdminUser);
      vi.mocked(prisma.client.backup.findUnique).mockResolvedValue(succeededBackup);
      vi.mocked(prisma.client.restore.findFirst).mockResolvedValue(null);
      const result = (await makeService(prisma).precheckRestore(1, 1)) as { ready: boolean; checksum: string };
      expect(result).toMatchObject({ ready: true, checksum: 'abc' });
    });
  });

  describe('confirmRestore', () => {
    it('普通备份运行中抛 BACKUP_LOCK_BUSY（并发 pg_dump 互斥）', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue(superAdminUser);
      vi.mocked(prisma.client.backup.findUnique).mockResolvedValue(succeededBackup);
      vi.mocked(prisma.client.restore.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.client.backup.findFirst).mockResolvedValueOnce({ id: 3, status: 'RUNNING' });
      await expect(makeService(prisma).confirmRestore(1, { backupId: 1, idempotencyKey: 'k' })).rejects.toMatchObject({
        entry: expect.objectContaining({ code: backupErrors.BACKUP_LOCK_BUSY.code }),
      });
    });

    it('紧急备份失败且未确认风险时抛 EMERGENCY_BACKUP_FAILED', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue(superAdminUser);
      // findUnique 序列：目标备份校验（SUCCEEDED）→ 紧急备份轮询（FAILED）
      vi.mocked(prisma.client.backup.findUnique)
        .mockResolvedValueOnce(succeededBackup)
        .mockResolvedValueOnce({ status: 'FAILED' });
      vi.mocked(prisma.client.restore.findFirst).mockResolvedValue(null);
      // findFirst 序列：运行中普通备份检查（null）→ 窗口内紧急备份复用查询（FAILED 不命中 → 新建）
      vi.mocked(prisma.client.backup.findFirst).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 8, status: 'FAILED' });
      vi.mocked(prisma.client.backup.create).mockResolvedValue({ id: 8, taskType: 'EMERGENCY', status: 'RUNNING' });
      await expect(
        makeService(prisma).confirmRestore(1, { backupId: 1, idempotencyKey: 'k' }),
      ).rejects.toMatchObject({
        entry: expect.objectContaining({ code: backupErrors.EMERGENCY_BACKUP_FAILED.code }),
      });
    });

    it('紧急备份失败但 proceedWithoutEmergency 时继续（人工确认风险）', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue(superAdminUser);
      // findUnique 序列：目标备份校验 → 紧急备份轮询（FAILED）→ run 内重校验（默认 SUCCEEDED）
      vi.mocked(prisma.client.backup.findUnique)
        .mockResolvedValueOnce(succeededBackup)
        .mockResolvedValueOnce({ status: 'FAILED' })
        .mockResolvedValue(succeededBackup);
      vi.mocked(prisma.client.restore.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.client.backup.findFirst).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 8, status: 'FAILED' });
      vi.mocked(prisma.client.backup.create).mockResolvedValue({ id: 8, taskType: 'EMERGENCY', status: 'RUNNING' });
      vi.mocked(prisma.client.restore.create).mockResolvedValue({ id: 10, restoreUuid: 'r-1', status: 'PENDING', stage: 'PRECHECK' });
      const result = (await makeService(prisma).confirmRestore(1, {
        backupId: 1,
        idempotencyKey: 'k',
        proceedWithoutEmergency: true,
      })) as { result: { restoreUuid: string } };
      // restoreUuid 由服务端 randomUUID 生成，不取自 mock 返回
      expect(result.result.restoreUuid).toEqual(expect.any(String));
      expect(prisma.client.restore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ backupId: 1, status: 'PENDING', initiatedBy: 1 }),
        }),
      );
      expect(mockedCreateTask).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ taskType: 'RESTORE_DELIVERY', ref: expect.objectContaining({ backupId: 1 }) }),
      );
    });

    it('正常路径：复用窗口内紧急备份并创建 restore 行 + RESTORE_DELIVERY 任务', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue(superAdminUser);
      // findUnique 序列：目标备份校验 → 紧急备份轮询（SUCCEEDED）→ run 内重校验（默认 SUCCEEDED）
      vi.mocked(prisma.client.backup.findUnique)
        .mockResolvedValueOnce(succeededBackup)
        .mockResolvedValueOnce({ status: 'SUCCEEDED' })
        .mockResolvedValue(succeededBackup);
      vi.mocked(prisma.client.restore.findFirst).mockResolvedValue(null);
      // findFirst 序列：运行中普通备份检查（null）→ 窗口内复用查询命中 SUCCEEDED 紧急备份
      vi.mocked(prisma.client.backup.findFirst).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 8, taskType: 'EMERGENCY', status: 'SUCCEEDED' });
      vi.mocked(prisma.client.restore.create).mockResolvedValue({ id: 10, restoreUuid: 'r-2', status: 'PENDING', stage: 'PRECHECK' });
      const result = (await makeService(prisma).confirmRestore(1, { backupId: 1, idempotencyKey: 'k' })) as {
        result: { restoreId: number; taskUuid: string };
      };
      expect(result.result.restoreId).toBe(10);
      expect(prisma.client.backup.create).not.toHaveBeenCalled();
      expect(prisma.client.restore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ backupId: 1, status: 'PENDING', initiatedBy: 1 }),
        }),
      );
      // 任务唯一标识按恢复 uuid 稳定派生（参数断言，不受 mock 前缀影响）
      expect(mockedStableUuid).toHaveBeenCalledWith(expect.stringContaining('RESTORE_DELIVERY:'));
    });
  });

  describe('waitForEmergencyBackup（轮询）', () => {
    it('达到 SUCCEEDED 立即返回 true', async () => {
      vi.useFakeTimers();
      const prisma = prismaMock();
      vi.mocked(prisma.client.backup.findUnique).mockResolvedValueOnce({ status: 'RUNNING' }).mockResolvedValueOnce({ status: 'SUCCEEDED' });
      const service = makeService(prisma) as unknown as { waitForEmergencyBackup(id: number): Promise<boolean> };
      const pending = service.waitForEmergencyBackup(8);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBe(true);
    });

    it('FAILED 返回 false', async () => {
      vi.useFakeTimers();
      const prisma = prismaMock();
      vi.mocked(prisma.client.backup.findUnique).mockResolvedValue({ status: 'FAILED' });
      const service = makeService(prisma) as unknown as { waitForEmergencyBackup(id: number): Promise<boolean> };
      await expect(service.waitForEmergencyBackup(8)).resolves.toBe(false);
    });

    it('超时窗口后仍未终态返回 false', async () => {
      vi.useFakeTimers();
      const prisma = prismaMock();
      vi.mocked(prisma.client.backup.findUnique).mockResolvedValue({ status: 'RUNNING' });
      const service = makeService(prisma) as unknown as { waitForEmergencyBackup(id: number): Promise<boolean> };
      const pending = service.waitForEmergencyBackup(8);
      // 推进超过 300s 上限（轮询间隔 2s，推进 310s）
      await vi.advanceTimersByTimeAsync(310_000);
      await expect(pending).resolves.toBe(false);
    });
  });

  describe('assertSuperAdmin', () => {
    it('已注销超管不可恢复操作（deletedAt 非空拒绝）', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue({ id: 1, isSuperAdmin: true, deletedAt: new Date() });
      await expect(makeService(prisma).assertSuperAdmin(1)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: backupErrors.RESTORE_SUPER_ADMIN_ONLY.code }),
      });
    });

    it('普通员工拒绝', async () => {
      const prisma = prismaMock();
      vi.mocked(prisma.client.user.findUnique).mockResolvedValue({ id: 2, isSuperAdmin: false, deletedAt: null });
      await expect(makeService(prisma).assertSuperAdmin(2)).rejects.toMatchObject({
        entry: expect.objectContaining({ code: backupErrors.RESTORE_SUPER_ADMIN_ONLY.code }),
      });
    });
  });

  describe('错误码存在性（契约守卫）', () => {
    it('使用的错误码在目录中定义', () => {
      for (const code of [
        backupErrors.BACKUP_LOCK_BUSY.code,
        backupErrors.BACKUP_UNVERIFIED.code,
        backupErrors.EMERGENCY_BACKUP_FAILED.code,
        backupErrors.RESTORE_IN_PROGRESS.code,
        backupErrors.RESTORE_SUPER_ADMIN_ONLY.code,
        frameworkErrors.RESOURCE_NOT_FOUND.code,
      ]) {
        expect(code.length).toBeGreaterThan(0);
      }
    });
  });
});
