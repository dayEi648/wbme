import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@wbme/tasks';
import type { ProcessorContext } from './types';
import { processBackupTask } from './backup-task.processor';
import { runImmediateBackup } from './backup.processor';

/** 备份执行器打桩：processBackupTask 仅验证编排（ref 补齐/类型映射），pg_dump 执行由集成环境覆盖 */
vi.mock('./backup.processor', () => ({ runImmediateBackup: vi.fn().mockResolvedValue(undefined) }));

const mockedRun = vi.mocked(runImmediateBackup);

function sqlMock(overrides: Partial<SqlClient> = {}): SqlClient {
  return {
    query: vi.fn().mockResolvedValue(undefined),
    queryRows: vi.fn(),
    ...overrides,
  } as unknown as SqlClient;
}

const ctx = {
  sql: null as unknown as SqlClient,
  leaseOwner: 'test',
  deployCommit: 'test',
  storage: null as never,
} as ProcessorContext;

function taskRow(taskType: string, ref: unknown): { taskType: string; taskUuid: string; initiatorId: number | null; ref: unknown } {
  return { taskType, taskUuid: '11111111-2222-3333-4444-555555555555', initiatorId: 1, ref };
}

describe('processBackupTask（T4-7 备份任务编排）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('ref 已含 backupId 时直接执行（IMMEDIATE 类型映射）', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
    ctx.sql = sqlMock();
    await processBackupTask(taskRow('IMMEDIATE_BACKUP', { backupId: 3 }) as never, ctx);

    expect(mockedRun).toHaveBeenCalledOnce();
    expect(mockedRun.mock.calls[0]![0]).toEqual({ backupId: 3 });
    expect(mockedRun.mock.calls[0]![2]).toBe('IMMEDIATE');
  });

  it('SCHEDULED / EMERGENCY 类型映射正确', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
    ctx.sql = sqlMock();
    await processBackupTask(taskRow('SCHEDULED_BACKUP', { backupId: 4 }) as never, ctx);
    expect(mockedRun.mock.calls[0]![2]).toBe('SCHEDULED');

    await processBackupTask(taskRow('EMERGENCY_BACKUP', { backupId: 5 }) as never, ctx);
    expect(mockedRun.mock.calls[1]![2]).toBe('EMERGENCY');
  });

  it('ref 缺 backupId 时按 taskUuid 幂等补齐备份行（先查后插）', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
    const rows = vi.fn()
      // 首次查询无既有备份行 → 执行 INSERT
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 9 }]);
    ctx.sql = sqlMock({ queryRows: rows });

    await processBackupTask(taskRow('SCHEDULED_BACKUP', {}) as never, ctx);

    // 补行后以补齐的 backupId 执行备份
    expect(mockedRun.mock.calls[0]![0]).toEqual({ backupId: 9 });
    expect(rows).toHaveBeenCalledTimes(2);
    const [selectSql, selectParams] = rows.mock.calls[0] as [string, unknown[]];
    expect(selectSql).toContain('task_uuid = $1');
    expect(selectParams[0]).toBe('11111111-2222-3333-4444-555555555555');
    const [insertSql, insertParams] = rows.mock.calls[1] as [string, unknown[]];
    expect(insertSql).toContain('INSERT INTO backstage.backups');
    // 备份类型经 $2::backstage."BackupType" 参数传入
    expect(insertParams[1]).toBe('SCHEDULED');
  });

  it('已存在备份行时复用不重复插入（崩溃恢复幂等）', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
    const rows = vi.fn().mockResolvedValueOnce([{ id: 9 }]);
    ctx.sql = sqlMock({ queryRows: rows });

    await processBackupTask(taskRow('IMMEDIATE_BACKUP', {}) as never, ctx);

    expect(rows).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0]![0]).toEqual({ backupId: 9 });
  });
});
