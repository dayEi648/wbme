import { describe, expect, it, vi } from 'vitest';
import type { SqlClient } from './sql-client';
import { overdueCutoff, scanAndAutoCancelOverdue } from './timeout';

describe('overdueCutoff', () => {
  it('按天数回推截止点；非法天数回退 30', () => {
    const now = new Date('2026-08-09T00:00:00.000Z');
    expect(overdueCutoff(now, 30).toISOString()).toBe('2026-07-10T00:00:00.000Z');
    expect(overdueCutoff(now, 0).toISOString()).toBe(overdueCutoff(now, 30).toISOString());
  });
});

describe('scanAndAutoCancelOverdue', () => {
  it('三 schema 扫描并条件取消', async () => {
    const queryRows: SqlClient['queryRows'] = async (sql) => {
      if (sql.includes('backstage.approval_requests') && sql.includes('SELECT')) {
        return [{ id: 1, version: 1, requestType: 'PROFILE_CHANGE' }] as never;
      }
      return [] as never;
    };
    const query = vi.fn(async () => ({ rowCount: 1 }));
    const client: SqlClient = { query, queryRows };

    const result = await scanAndAutoCancelOverdue(client, 30, new Date('2026-08-09T00:00:00.000Z'));
    expect(result).toEqual({ backstage: 1, hr: 0, asset: 0 });
    expect(query).toHaveBeenCalled();
  });

  it('条件更新未命中时不计取消数', async () => {
    const queryRows: SqlClient['queryRows'] = async () =>
      [{ id: 2, version: 3, requestType: 'OVERTIME' }] as never;
    const query = vi.fn(async () => ({ rowCount: 0 }));
    const client: SqlClient = { query, queryRows };
    const result = await scanAndAutoCancelOverdue(client, 7, new Date());
    expect(result).toEqual({ backstage: 0, hr: 0, asset: 0 });
  });
});
