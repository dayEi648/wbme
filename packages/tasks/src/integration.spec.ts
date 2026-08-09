import { describe, expect, it } from 'vitest';
import {
  claimOutboxBatch,
  insertPendingTaskSql,
  loadTaskByUuid,
  markQueued,
  TASK_TYPE_SCHEDULED_BACKUP,
  stableTaskUuid,
} from './index';
import type { SqlClient } from './sql-client';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);

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
});

describe.runIf(!hasIntegrationEnv)('tasks integration', () => {
  it('跳过：未配置 DATABASE_URL', () => {
    expect(true).toBe(true);
  });
});
