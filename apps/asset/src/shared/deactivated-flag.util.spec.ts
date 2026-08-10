import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client';
import { attachDeactivatedFlags } from './deactivated-flag.util';

describe('attachDeactivatedFlags', () => {
  it('按 user_accounts.deleted_at 就地补已注销标记', async () => {
    const prisma = {
      $queryRaw: async () => [
        { user_id: 1, deleted_at: null },
        { user_id: 2, deleted_at: new Date('2026-08-01') },
      ],
    } as unknown as PrismaClient;
    const items = [
      { id: 10, applicantId: 1 },
      { id: 11, applicantId: 2 },
      { id: 12, applicantId: 3 },
    ] as Array<Record<string, unknown>>;
    await attachDeactivatedFlags(prisma, items, 'applicantId', 'applicantDeactivated');
    expect(items[0]?.applicantDeactivated).toBe(false);
    expect(items[1]?.applicantDeactivated).toBe(true);
    // 查询结果外的 id 按未注销处理
    expect(items[2]?.applicantDeactivated).toBe(false);
  });

  it('id 列表为空时不发查询', async () => {
    let called = false;
    const prisma = {
      $queryRaw: async () => {
        called = true;
        return [];
      },
    } as unknown as PrismaClient;
    const items = [{ id: 1 }] as Array<Record<string, unknown>>;
    await attachDeactivatedFlags(prisma, items, 'applicantId', 'applicantDeactivated');
    expect(called).toBe(false);
  });

  it('支持借还系 userId 键与 userDeactivated 标记', async () => {
    const prisma = {
      $queryRaw: async () => [{ user_id: 5, deleted_at: new Date('2026-07-01') }],
    } as unknown as PrismaClient;
    const items = [{ id: 1, userId: 5 }] as Array<Record<string, unknown>>;
    await attachDeactivatedFlags(prisma, items, 'userId', 'userDeactivated');
    expect(items[0]?.userDeactivated).toBe(true);
  });
});
