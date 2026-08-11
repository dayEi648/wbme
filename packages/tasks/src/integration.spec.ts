import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimOutboxBatch,
  claimRunning,
  failTimedOutTasks,
  insertPendingTaskSql,
  loadTaskByUuid,
  markQueued,
  renewRunningLease,
  TASK_RUNNING_LEASE_SECONDS,
  TASK_TYPE_SCHEDULED_BACKUP,
  stableTaskUuid,
} from './index';
import type { SqlClient } from './sql-client';

// 加载仓库根 .env（与 worker/platform-core 规格一致：本地集成测试默认可跑；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);

async function createPooledClient(): Promise<{ client: SqlClient; close: () => Promise<void> }> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return {
    client: {
      query: async (text, values) => {
        const result = await pool.query(text, values as unknown[] | undefined);
        return { rowCount: result.rowCount };
      },
      queryRows: async (text, values) => {
        const result = await pool.query(text, values as unknown[] | undefined);
        return result.rows as never[];
      },
    },
    close: () => pool.end(),
  };
}

describe.runIf(hasIntegrationEnv)('tasks integration', () => {
  it('插入并加载 PENDING_ENQUEUE 任务', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client: SqlClient = {
      query: async (text, values) => {
        const result = await pool.query(text, values as unknown[] | undefined);
        return { rowCount: result.rowCount };
      },
      queryRows: async (text, values) => {
        const result = await pool.query(text, values as unknown[] | undefined);
        return result.rows as never[];
      },
    };

    const taskUuid = stableTaskUuid(`integration-test:${Date.now()}`);
    const created = await insertPendingTaskSql(client, {
      taskUuid,
      taskType: TASK_TYPE_SCHEDULED_BACKUP,
      module: 'backstage',
      initiatorType: 'SCHEDULER',
      ref: { cycleDate: '2026-08-09' },
    });
    expect(created.created).toBe(true);

    const row = await loadTaskByUuid(client, taskUuid);
    expect(row?.status).toBe('PENDING_ENQUEUE');

    const claimed = await claimOutboxBatch(client, 'integration-scheduler', [TASK_TYPE_SCHEDULED_BACKUP]);
    expect(claimed.some((c) => c.taskUuid === taskUuid)).toBe(true);

    const queued = await markQueued(client, taskUuid, 'integration-scheduler');
    expect(queued).toBe(true);

    await pool.query('DELETE FROM backstage.background_tasks WHERE task_uuid = $1', [taskUuid]);
    await pool.end();
  });

  it('RUNNING 租约过期被重领后 markQueued 归队，Worker 可重新领取（批次8复核修复）', async () => {
    const { client, close } = await createPooledClient();
    const taskUuid = stableTaskUuid(`integration-reclaim:${Date.now()}`);
    const t0 = new Date('2026-08-11T00:00:00.000Z');
    try {
      await insertPendingTaskSql(client, {
        taskUuid,
        taskType: TASK_TYPE_SCHEDULED_BACKUP,
        module: 'backstage',
        initiatorType: 'SCHEDULER',
        ref: { cycleDate: '2026-08-11' },
      }, t0);
      // 首投：调度器1 领取 → markQueued → QUEUED；Worker A 领取执行（RUNNING，租约 t0+600s）
      const first = await claimOutboxBatch(client, 'scheduler-1', [TASK_TYPE_SCHEDULED_BACKUP], t0);
      expect(first.some((c) => c.taskUuid === taskUuid)).toBe(true);
      expect(await markQueued(client, taskUuid, 'scheduler-1')).toBe(true);
      expect(await claimRunning(client, taskUuid, 'worker-a', t0)).toBe(true);
      // Worker A 崩溃：租约过期后调度器2 重领（可重放类型 RUNNING 行）
      const afterLease = new Date(t0.getTime() + TASK_RUNNING_LEASE_SECONDS * 1_000 + 1_000);
      const reclaimed = await claimOutboxBatch(client, 'scheduler-2', [TASK_TYPE_SCHEDULED_BACKUP], afterLease);
      expect(reclaimed.some((c) => c.taskUuid === taskUuid && c.status === 'RUNNING')).toBe(true);
      // 重投成功 → markQueued 必须覆盖重领行：归队并清空投递租约（否则 Worker B 领取被挡）
      expect(await markQueued(client, taskUuid, 'scheduler-2')).toBe(true);
      expect((await loadTaskByUuid(client, taskUuid))?.status).toBe('QUEUED');
      expect(await claimRunning(client, taskUuid, 'worker-b', afterLease)).toBe(true);
    } finally {
      await client.query('DELETE FROM backstage.background_tasks WHERE task_uuid = $1', [taskUuid]);
      await close();
    }
  });

  it('renewRunningLease 心跳续期与 failTimedOutTasks 超时终态化', async () => {
    const { client, close } = await createPooledClient();
    const taskUuid = stableTaskUuid(`integration-lease:${Date.now()}`);
    const t0 = new Date('2026-08-11T00:00:00.000Z');
    try {
      await insertPendingTaskSql(client, {
        taskUuid,
        taskType: TASK_TYPE_SCHEDULED_BACKUP,
        module: 'backstage',
        initiatorType: 'SCHEDULER',
        ref: { cycleDate: '2026-08-11' },
      }, t0);
      await claimOutboxBatch(client, 'scheduler-1', [TASK_TYPE_SCHEDULED_BACKUP], t0);
      await markQueued(client, taskUuid, 'scheduler-1');
      expect(await claimRunning(client, taskUuid, 'worker-a', t0)).toBe(true);
      // 非持有者不得续期；持有者续期成功且 timeout_at 顺延（续期时刻 + 2 倍租约）
      expect(await renewRunningLease(client, taskUuid, 'worker-b', t0)).toBe(false);
      const renewAt = new Date(t0.getTime() + 300_000);
      expect(await renewRunningLease(client, taskUuid, 'worker-a', renewAt)).toBe(true);
      // 续期后 timeout_at = renewAt + 1200s：此前本行不被终态化，过期后终态化为 FAILED。
      // （failTimedOutTasks 全表生效，计数含无关残留行，故按本行状态断言）
      const beforeTimeout = new Date(renewAt.getTime() + TASK_RUNNING_LEASE_SECONDS * 2 * 1_000 - 1_000);
      await failTimedOutTasks(client, beforeTimeout);
      expect((await loadTaskByUuid(client, taskUuid))?.status).toBe('RUNNING');
      const afterTimeout = new Date(renewAt.getTime() + TASK_RUNNING_LEASE_SECONDS * 2 * 1_000 + 1_000);
      expect(await failTimedOutTasks(client, afterTimeout)).toBeGreaterThanOrEqual(1);
      expect((await loadTaskByUuid(client, taskUuid))?.status).toBe('FAILED');
    } finally {
      await client.query('DELETE FROM backstage.background_tasks WHERE task_uuid = $1', [taskUuid]);
      await close();
    }
  });
});

describe.runIf(!hasIntegrationEnv)('tasks integration', () => {
  it('跳过：未配置 DATABASE_URL', () => {
    expect(true).toBe(true);
  });
});
