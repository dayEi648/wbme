import { describe, expect, it, vi } from 'vitest';
import type { RawSqlClient } from './raw-sql-client';
import { insertSecurityLog } from './security-log';

describe('insertSecurityLog', () => {
  it('写入成功返回 true', async () => {
    const client: RawSqlClient = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
      $queryRawUnsafe: vi.fn(),
    };
    const ok = await insertSecurityLog(client, {
      eventType: 'LOGIN_SUCCESS',
      result: 'SUCCESS',
      actorId: 1,
    });
    expect(ok).toBe(true);
  });

  it('写入失败返回 false 不抛错', async () => {
    const client: RawSqlClient = {
      $executeRawUnsafe: vi.fn().mockRejectedValue(new Error('db down')),
      $queryRawUnsafe: vi.fn(),
    };
    const ok = await insertSecurityLog(client, {
      eventType: 'LOGIN_FAILURE',
      result: 'FAILURE',
    });
    expect(ok).toBe(false);
  });
});
