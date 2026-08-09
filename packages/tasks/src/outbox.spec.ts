import { describe, expect, it } from 'vitest';
import { claimOutboxBatch } from './outbox';
import { TASK_TYPE_ACCOUNT_LIFECYCLE, TASK_TYPE_SCHEDULED_BACKUP } from './constants';
import type { SqlClient } from './sql-client';

describe('claimOutboxBatch', () => {
  it('将 replayableTypes 与 leaseOwner 传入 SQL', async () => {
    let capturedValues: readonly unknown[] | undefined;
    const client: SqlClient = {
      query: async () => ({ rowCount: 0 }),
      queryRows: async <T>(_text: string, values?: readonly unknown[]) => {
        capturedValues = values;
        return [{ taskUuid: 'u1', taskType: TASK_TYPE_ACCOUNT_LIFECYCLE, status: 'PENDING_ENQUEUE' }] as T[];
      },
    };
    const now = new Date('2026-08-09T10:00:00.000Z');
    const rows = await claimOutboxBatch(
      client,
      'scheduler-1',
      [TASK_TYPE_ACCOUNT_LIFECYCLE, TASK_TYPE_SCHEDULED_BACKUP],
      now,
      10,
    );
    expect(rows).toHaveLength(1);
    expect(capturedValues?.[0]).toBe(now);
    expect(capturedValues?.[1]).toEqual([TASK_TYPE_ACCOUNT_LIFECYCLE, TASK_TYPE_SCHEDULED_BACKUP]);
    expect(capturedValues?.[3]).toBe('scheduler-1');
  });
});
