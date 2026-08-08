import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL/Redis；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { SessionService } from '@wbme/server';
import Redis from 'ioredis';
import { PrismaService } from '../../../prisma.service';
import { SuperAdminService } from './super-admin.service';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

/** 测试数据统一前缀（姓名/手机号），便于隔离与清理 */
const TEST_NAME_PREFIX = 'T37_';
const TEST_PHONE_PREFIX = '+8613937';
const KEY_PREFIX = 't37-';

/**
 * 超级管理员任免集成测试（主 PRD §3.1、backstage PRD §3；T3-6；真实 PG + Redis）。
 *
 * vitest fileParallelism=false 串行执行：本规格内对"全部可用超管"的操作不与其他规格并发冲突。
 * 涉及本机开发库种子超管的降级会在 finally 中恢复（串行下无交叉干扰）。
 */
describe.skipIf(!DATABASE_URL || !REDIS_URL)('超级管理员任免（T3-6）', () => {
  let prisma: PrismaService;
  let service: SuperAdminService;
  let redis: Redis;
  let phoneSeq = 0;
  const testUserIds: number[] = [];

  let superOp: { id: number; name: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    redis = new Redis(REDIS_URL ?? 'redis://localhost:6379');
    service = new SuperAdminService(prisma, new SessionService(redis));
    await cleanupLeftovers();
    superOp = await createUser({ name: `${TEST_NAME_PREFIX}超管`, isSuperAdmin: true });
  });

  afterAll(async () => {
    await cleanupLeftovers();
    await prisma.client.$disconnect();
    await redis.quit();
  });

  async function cleanupLeftovers(): Promise<void> {
    const legacy = await prisma.client.user.findMany({
      where: { phone: { startsWith: TEST_PHONE_PREFIX } },
      select: { id: true },
    });
    const ids = legacy.map((row) => row.id);
    if (ids.length > 0) {
      await prisma.client.backstageOperationLog.deleteMany({ where: { operatorId: { in: ids } } });
      await redis.del(...ids.map((id) => `session:elevate:${id}`));
      await prisma.client.user.deleteMany({ where: { id: { in: ids } } });
    }
  }

  async function createUser(options: {
    name: string;
    isSuperAdmin?: boolean;
    status?: 'PENDING_ACTIVATION' | 'ACTIVE' | 'DEACTIVATED';
  }): Promise<{ id: number; name: string }> {
    phoneSeq += 1;
    const status = options.status ?? 'ACTIVE';
    const user = await prisma.client.user.create({
      data: {
        name: options.name,
        gender: 'MALE',
        phone: `${TEST_PHONE_PREFIX}${String(phoneSeq).padStart(6, '0')}`,
        status,
        isSuperAdmin: options.isSuperAdmin ?? false,
        passwordHash: status === 'PENDING_ACTIVATION' ? null : 't37-hash',
      },
    });
    testUserIds.push(user.id);
    return { id: user.id, name: user.name };
  }

  async function activeSuperIds(): Promise<number[]> {
    const rows = await prisma.client.user.findMany({
      where: { isSuperAdmin: true, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  it('任命：普通员工成为超管、授权版本递增、提权标记写入、前后值日志；幂等重放不重复', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}任命` });
    const result = await service.appoint(superOp.id, target.id, { idempotencyKey: `${KEY_PREFIX}appoint-1` });
    expect(result).toEqual({ ok: true });
    const after = await prisma.client.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.isSuperAdmin).toBe(true);
    expect(after.permissionVersion).toBe(1);
    // 站点角色提升 = 提权：标记会话旋转
    expect(await redis.get(`session:elevate:${target.id}`)).not.toBeNull();
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}appoint-1` },
    });
    expect(log?.summary).toContain('站点角色 员工 → 超级管理员');
    expect(log?.feature).toBe('user_manage');

    const replayed = await service.appoint(superOp.id, target.id, { idempotencyKey: `${KEY_PREFIX}appoint-1` });
    expect(replayed).toEqual(result);
    expect((await prisma.client.user.findUniqueOrThrow({ where: { id: target.id } })).permissionVersion).toBe(1);
  });

  it('任命校验：非超管操作 403、待激活目标拒绝、已是超管拒绝、已注销拒绝', async () => {
    const plain = await createUser({ name: `${TEST_NAME_PREFIX}无权操作` });
    const target = await createUser({ name: `${TEST_NAME_PREFIX}任命校验` });
    await expect(service.appoint(plain.id, target.id, {})).rejects.toMatchObject({ entry: { code: 'FORBIDDEN' } });
    const pending = await createUser({ name: `${TEST_NAME_PREFIX}待激活`, status: 'PENDING_ACTIVATION' });
    await expect(service.appoint(superOp.id, pending.id, {})).rejects.toMatchObject({ entry: { code: 'USER_NOT_ACTIVE' } });
    await expect(service.appoint(superOp.id, superOp.id, {})).rejects.toMatchObject({ entry: { code: 'ALREADY_SUPER_ADMIN' } });
    const deactivated = await createUser({ name: `${TEST_NAME_PREFIX}已注销`, status: 'DEACTIVATED' });
    await prisma.client.user.update({ where: { id: deactivated.id }, data: { deletedAt: new Date(), deletedBy: superOp.id } });
    await expect(service.appoint(superOp.id, deactivated.id, {})).rejects.toMatchObject({ entry: { code: 'ACCOUNT_DEACTIVATED' } });
    await expect(service.appoint(superOp.id, 999999999, {})).rejects.toMatchObject({ entry: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('降级：超管变员工、不写入提权标记、前后值日志；非超管目标拒绝', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}降级`, isSuperAdmin: true });
    const result = await service.demote(superOp.id, target.id, { idempotencyKey: `${KEY_PREFIX}demote-1` });
    expect(result).toEqual({ ok: true });
    const after = await prisma.client.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.isSuperAdmin).toBe(false);
    expect(after.permissionVersion).toBe(1);
    // 降级不是提权：不标记会话旋转（即时生效由守卫实时读取保证）
    expect(await redis.get(`session:elevate:${target.id}`)).toBeNull();
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}demote-1` },
    });
    expect(log?.summary).toContain('站点角色 超级管理员 → 员工');

    const plain = await createUser({ name: `${TEST_NAME_PREFIX}非超管` });
    await expect(service.demote(superOp.id, plain.id, {})).rejects.toMatchObject({ entry: { code: 'NOT_SUPER_ADMIN' } });
  });

  it('最后一名可用超管保护：仅剩一名时自我降级拒绝；并发卸任恰一个成功', async () => {
    const demotedForTest: number[] = [];
    try {
      // 把除操作人外的可用超管逐个降级（含本机开发库种子超管；finally 统一恢复），使操作人成为唯一可用超管
      for (const id of await activeSuperIds()) {
        if (id !== superOp.id) {
          await service.demote(superOp.id, id, {});
          demotedForTest.push(id);
        }
      }
      // 仅剩操作人一名可用超管：自我降级被最后超管保护拒绝（零写入）
      await expect(service.demote(superOp.id, superOp.id, {})).rejects.toMatchObject({ entry: { code: 'LAST_SUPER_ADMIN' } });
      expect((await prisma.client.user.findUniqueOrThrow({ where: { id: superOp.id } })).isSuperAdmin).toBe(true);

      // 并发卸任：新任命两名超管 C1/C2（当前可用 = superOp + C1 + C2），先由 C1 降级 superOp 使可用 = {C1, C2}，
      // 随后两人并发自我降级——行锁串行化，恰一个成功，另一个 LAST_SUPER_ADMIN
      const c1 = await createUser({ name: `${TEST_NAME_PREFIX}并发甲`, isSuperAdmin: true });
      const c2 = await createUser({ name: `${TEST_NAME_PREFIX}并发乙`, isSuperAdmin: true });
      await service.demote(c1.id, superOp.id, {});
      demotedForTest.push(superOp.id);
      const outcomes = await Promise.allSettled([service.demote(c1.id, c1.id, {}), service.demote(c2.id, c2.id, {})]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ entry: { code: 'LAST_SUPER_ADMIN' } });
      // 最终恰好剩一名可用超管（胜出者已被降级）
      const remaining = await activeSuperIds();
      expect(remaining).toHaveLength(1);
      demotedForTest.push(...(remaining.includes(c1.id) ? [c2.id] : [c1.id]));
    } finally {
      // 恢复本测试降级的全部账号角色（含种子超管与操作人）
      if (demotedForTest.length > 0) {
        await prisma.client.user.updateMany({ where: { id: { in: demotedForTest } }, data: { isSuperAdmin: true } });
      }
    }
  });
});
