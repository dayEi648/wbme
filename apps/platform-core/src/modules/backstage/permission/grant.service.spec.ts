import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { BusinessException } from '@wbme/contracts';
import { buildTablePrismaQuery } from '@wbme/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { PrismaService } from '../../../prisma.service';
import { ensurePermissionCatalog } from '../../../test-support/ensure-permission-catalog';
import { AuthorizationService } from './authorization.service';
import { EMPLOYEE_FILTER_FIELDS, GrantService } from './grant.service';
import { FunctionPermissionGuard, REQUIRED_FUNCTION_KEY } from './function-permission.guard';
import { Reflector } from '@nestjs/core';
import { SessionService, REQUEST_CONTEXT_STORAGE, getRequestContext, type RequestContext } from '@wbme/server';
import Redis from 'ioredis';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

/** 测试账号统一前缀（姓名/手机号），便于隔离与清理 */
const TEST_NAME_PREFIX = 'T32_';
const TEST_PHONE_PREFIX = '+8613932';
/** 幂等键统一前缀 */
const KEY_PREFIX = 't32-';

/**
 * 员工授权 CRUD 集成测试（实现规划 T3-2、主 PRD §3.1、backstage PRD §4；真实 PostgreSQL）。
 *
 * 测试账号使用统一姓名/手机号前缀，afterAll 统一清理授权行、操作日志与账号；
 * 不触碰真实目录与既有账号。
 */
describe.skipIf(!DATABASE_URL || !REDIS_URL)('员工授权 CRUD（T3-2 版本/整批/幂等/委派）', () => {
  let prisma: PrismaService;
  let service: GrantService;
  let authorization: AuthorizationService;
  let redis: Redis;
  let phoneSeq = 0;
  const testUserIds: number[] = [];

  /** 超级管理员操作人 */
  let superOp: { id: number; name: string };
  /** 权限管理员操作人（持有 permission_manage 授权，非超管） */
  let permAdmin: { id: number; name: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    redis = new Redis(REDIS_URL ?? 'redis://localhost:6379');
    service = new GrantService(prisma, new SessionService(redis));
    authorization = new AuthorizationService(prisma);
    // CI 全新库只有迁移没有 seed：目录注册由本规格幂等保证，不依赖执行顺序
    await ensurePermissionCatalog(prisma);
    await cleanupLeftovers();
    superOp = await createUser({ name: `${TEST_NAME_PREFIX}超管`, isSuperAdmin: true });
    permAdmin = await createUser({ name: `${TEST_NAME_PREFIX}权管` });
    await prisma.client.employeeGrant.create({
      data: { userId: permAdmin.id, functionCode: 'permission_manage', dataScope: 'COMPANY', grantedBy: superOp.id },
    });
  });

  afterAll(async () => {
    await cleanupLeftovers();
    await prisma.client.$disconnect();
    await redis.quit();
  });

  /** 清理本规格产生的授权行、操作日志与测试账号（按前缀识别），以及提权旋转标记 */
  async function cleanupLeftovers(): Promise<void> {
    const legacy = await prisma.client.user.findMany({
      where: { phone: { startsWith: TEST_PHONE_PREFIX } },
      select: { id: true },
    });
    const ids = legacy.map((row) => row.id);
    if (ids.length > 0) {
      await prisma.client.employeeGrant.deleteMany({ where: { OR: [{ userId: { in: ids } }, { grantedBy: { in: ids } }] } });
      await prisma.client.backstageOperationLog.deleteMany({ where: { operatorId: { in: ids } } });
      await prisma.client.user.deleteMany({ where: { id: { in: ids } } });
      await redis.del(...ids.map((id) => elevationKey(id)));
    }
  }

  /** 提权旋转标记键（与 SessionService.markElevation 一致） */
  function elevationKey(userId: number): string {
    return `session:elevate:${userId}`;
  }

  /** 读取提权旋转标记（不存在返回 null） */
  async function elevationMarkedAt(userId: number): Promise<string | null> {
    return redis.get(elevationKey(userId));
  }

  /** 创建测试账号（ACTIVE 默认；CHECK 约束要求 ACTIVE 必须有密码哈希） */
  async function createUser(options: {
    name: string;
    status?: 'PENDING_ACTIVATION' | 'ACTIVE' | 'DEACTIVATED';
    isSuperAdmin?: boolean;
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
        passwordHash: status === 'PENDING_ACTIVATION' ? null : 't32-hash',
      },
    });
    testUserIds.push(user.id);
    return { id: user.id, name: user.name };
  }

  /** 读取目标当前授权（功能编码 + 数据范围，无序） */
  async function currentGrants(userId: number): Promise<Array<{ functionCode: string; dataScope: string }>> {
    const rows = await prisma.client.employeeGrant.findMany({
      where: { userId },
      select: { functionCode: true, dataScope: true },
    });
    return rows.sort((a, b) => a.functionCode.localeCompare(b.functionCode));
  }

  async function permissionVersion(userId: number): Promise<number> {
    const user = await prisma.client.user.findUniqueOrThrow({ where: { id: userId } });
    return user.permissionVersion;
  }

  it('保存单人权限：创建授权行、递增版本、同事务写操作日志（含幂等键与前后摘要）', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}保存` });
    const result = await service.saveEmployeeGrants(superOp.id, target.id, {
      permissionVersion: 0,
      grants: [
        { functionCode: 'fixed_asset_maintain', dataScope: 'DEPARTMENT' },
        { functionCode: 'my_assets', dataScope: 'SELF' },
      ],
      idempotencyKey: `${KEY_PREFIX}save-1`,
    });
    expect(result).toEqual({ permissionVersion: 1 });
    expect(await permissionVersion(target.id)).toBe(1);
    expect(await currentGrants(target.id)).toEqual([
      { functionCode: 'fixed_asset_maintain', dataScope: 'DEPARTMENT' },
      { functionCode: 'my_assets', dataScope: 'SELF' },
    ]);
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}save-1` },
    });
    expect(log).not.toBeNull();
    expect(log?.actionType).toBe('UPDATE');
    expect(log?.feature).toBe('permission_manage');
    expect(log?.summary).toContain('变更前 []');
    expect(log?.summary).toContain('固定资产维护（部门）');
    expect(log?.summary).toContain('我的资产（本人）');
    expect(log?.requestFingerprint).toHaveLength(64);
    expect(log?.resultReference).toEqual({ permissionVersion: 1 });
  });

  it('幂等重放：同键同体返回原结果且不重复生效；同键不同体返回 409', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}幂等` });
    const body = {
      permissionVersion: 0,
      grants: [{ functionCode: 'my_assets', dataScope: 'SELF' as const }],
      idempotencyKey: `${KEY_PREFIX}save-replay`,
    };
    const first = await service.saveEmployeeGrants(superOp.id, target.id, body);
    const replayed = await service.saveEmployeeGrants(superOp.id, target.id, body);
    expect(replayed).toEqual(first);
    expect(await permissionVersion(target.id)).toBe(1);
    expect(await currentGrants(target.id)).toHaveLength(1);
    const logs = await prisma.client.backstageOperationLog.count({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}save-replay` },
    });
    expect(logs).toBe(1);

    await expect(
      service.saveEmployeeGrants(superOp.id, target.id, {
        permissionVersion: 0,
        grants: [{ functionCode: 'consumable_apply', dataScope: 'SELF' }],
        idempotencyKey: `${KEY_PREFIX}save-replay`,
      }),
    ).rejects.toMatchObject({ entry: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('并发修改冲突：两个携带同一版本的保存只有一个成功，另一个返回 GRANT_VERSION_CONFLICT', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}并发` });
    const [first, second] = await Promise.allSettled([
      service.saveEmployeeGrants(superOp.id, target.id, {
        permissionVersion: 0,
        grants: [{ functionCode: 'my_assets', dataScope: 'SELF' }],
      }),
      service.saveEmployeeGrants(permAdmin.id, target.id, {
        permissionVersion: 0,
        grants: [{ functionCode: 'consumable_apply', dataScope: 'SELF' }],
      }),
    ]);
    const fulfilled = [first, second].filter((outcome) => outcome.status === 'fulfilled');
    const rejected = [first, second].filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BusinessException);
    expect(((rejected[0] as PromiseRejectedResult).reason as BusinessException).entry.code).toBe('GRANT_VERSION_CONFLICT');
    // 最终版本只递增一次，授权为胜出方的完整状态
    expect(await permissionVersion(target.id)).toBe(1);
    const grants = await currentGrants(target.id);
    expect(grants).toHaveLength(1);
  });

  it('保存替换语义：可管理范围内整体替换；非超管操作时"权限管理"授权行保留不动', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}替换` });
    await prisma.client.employeeGrant.createMany({
      data: [
        { userId: target.id, functionCode: 'fixed_asset_view', dataScope: 'COMPANY', grantedBy: superOp.id },
        { userId: target.id, functionCode: 'permission_manage', dataScope: 'COMPANY', grantedBy: superOp.id },
      ],
    });
    const result = await service.saveEmployeeGrants(permAdmin.id, target.id, {
      permissionVersion: 0,
      grants: [{ functionCode: 'consumable_apply', dataScope: 'SELF' }],
    });
    expect(result).toEqual({ permissionVersion: 1 });
    // fixed_asset_view 被移除、consumable_apply 新增；permission_manage 超出权限管理员可管理范围，保持不动
    expect(await currentGrants(target.id)).toEqual([
      { functionCode: 'consumable_apply', dataScope: 'SELF' },
      { functionCode: 'permission_manage', dataScope: 'COMPANY' },
    ]);
  });

  it('委派规则：自我修改拒绝、权限管理员不能授予"权限管理"、非超管不能操作超管目标', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}委派` });
    await expect(
      service.saveEmployeeGrants(permAdmin.id, permAdmin.id, { permissionVersion: 0, grants: [] }),
    ).rejects.toMatchObject({ entry: { code: 'GRANT_SELF_FORBIDDEN' } });
    await expect(
      service.saveEmployeeGrants(permAdmin.id, target.id, {
        permissionVersion: 0,
        grants: [{ functionCode: 'permission_manage', dataScope: 'COMPANY' }],
      }),
    ).rejects.toMatchObject({ entry: { code: 'PERMISSION_MANAGEMENT_GRANT_FORBIDDEN' } });
    // 超管可以授予"权限管理"功能
    const granted = await service.saveEmployeeGrants(superOp.id, target.id, {
      permissionVersion: 0,
      grants: [{ functionCode: 'permission_manage', dataScope: 'COMPANY' }],
    });
    expect(granted).toEqual({ permissionVersion: 1 });
    const anotherSuper = await createUser({ name: `${TEST_NAME_PREFIX}超管乙`, isSuperAdmin: true });
    await expect(
      service.saveEmployeeGrants(permAdmin.id, anotherSuper.id, { permissionVersion: 0, grants: [] }),
    ).rejects.toMatchObject({ entry: { code: 'SUPER_ADMIN_TARGET_ONLY' } });
    const deactivated = await createUser({ name: `${TEST_NAME_PREFIX}注销`, status: 'DEACTIVATED' });
    await expect(
      service.saveEmployeeGrants(superOp.id, deactivated.id, { permissionVersion: 0, grants: [] }),
    ).rejects.toMatchObject({ entry: { code: 'ACCOUNT_DEACTIVATED' } });
  });

  it('授权项校验：目录外功能 / 非法数据范围 / 重复功能编码拒绝', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}校验` });
    await expect(
      service.saveEmployeeGrants(superOp.id, target.id, {
        permissionVersion: 0,
        grants: [{ functionCode: 'ghost_function', dataScope: 'COMPANY' }],
      }),
    ).rejects.toMatchObject({ entry: { code: 'FUNCTION_NOT_REGISTERED' } });
    await expect(
      service.saveEmployeeGrants(superOp.id, target.id, {
        permissionVersion: 0,
        grants: [{ functionCode: 'my_assets', dataScope: 'COMPANY' }],
      }),
    ).rejects.toMatchObject({ entry: { code: 'SCOPE_NOT_SUPPORTED' } });
    await expect(
      service.saveEmployeeGrants(superOp.id, target.id, {
        permissionVersion: 0,
        grants: [
          { functionCode: 'my_assets', dataScope: 'SELF' },
          { functionCode: 'my_assets', dataScope: 'SELF' },
        ],
      }),
    ).rejects.toMatchObject({ entry: { code: 'VALIDATION_FAILED' } });
    // 校验失败不产生任何写入
    expect(await permissionVersion(target.id)).toBe(0);
    expect(await currentGrants(target.id)).toHaveLength(0);
  });

  it('批量授权整批回滚：任一目标失败则全部不变更，并逐人返回阻塞原因', async () => {
    const okTarget = await createUser({ name: `${TEST_NAME_PREFIX}整批正常` });
    const deactivated = await createUser({ name: `${TEST_NAME_PREFIX}整批注销`, status: 'DEACTIVATED' });
    const error = await service
      .batchGrant(superOp.id, {
        userIds: [okTarget.id, deactivated.id, superOp.id],
        grants: [{ functionCode: 'my_assets', dataScope: 'SELF' }],
        idempotencyKey: `${KEY_PREFIX}batch-blocked`,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BusinessException);
    const exception = error as BusinessException;
    expect(exception.entry.code).toBe('GRANT_BATCH_BLOCKED');
    const failures = exception.details?.failures as Array<{ userId: number; code: string }>;
    expect(failures).toHaveLength(2);
    expect(failures).toContainEqual({ userId: deactivated.id, code: 'TARGET_DEACTIVATED', message: '目标账号已注销' });
    expect(failures).toContainEqual({ userId: superOp.id, code: 'SELF_MODIFICATION', message: '不能修改自己的权限' });
    // 整批不变更：正常目标无授权行、版本不变、无日志
    expect(await currentGrants(okTarget.id)).toHaveLength(0);
    expect(await permissionVersion(okTarget.id)).toBe(0);
    const logs = await prisma.client.backstageOperationLog.count({
      where: { operatorId: superOp.id, idempotencyScope: 'permission.grants.batch-grant' },
    });
    expect(logs).toBe(0);
  });

  it('批量授权成功：增量追加、逐人递增版本与写日志；幂等重放不重复；无变化目标跳过', async () => {
    const userA = await createUser({ name: `${TEST_NAME_PREFIX}批量甲` });
    const userB = await createUser({ name: `${TEST_NAME_PREFIX}批量乙` });
    // userB 预先持有 my_assets（本人）：增量授权只追加缺失项
    await prisma.client.employeeGrant.create({
      data: { userId: userB.id, functionCode: 'my_assets', dataScope: 'SELF', grantedBy: superOp.id },
    });
    const body = {
      userIds: [userA.id, userB.id],
      grants: [
        { functionCode: 'my_assets', dataScope: 'SELF' as const },
        { functionCode: 'consumable_apply', dataScope: 'SELF' as const },
      ],
      idempotencyKey: `${KEY_PREFIX}batch-1`,
    };
    const result = await service.batchGrant(superOp.id, body);
    expect(result).toEqual({ ok: true, userIds: [userA.id, userB.id] });
    expect(await currentGrants(userA.id)).toHaveLength(2);
    expect(await currentGrants(userB.id)).toHaveLength(2);
    expect(await permissionVersion(userA.id)).toBe(1);
    expect(await permissionVersion(userB.id)).toBe(1);
    // 逐人明细日志 + 一条携带幂等键的批次日志
    const detailLogs = await prisma.client.backstageOperationLog.count({
      where: { operatorId: superOp.id, idempotencyKey: null, summary: { startsWith: '批量授权：为 T32_' } },
    });
    expect(detailLogs).toBe(2);
    const summaryLogs = await prisma.client.backstageOperationLog.count({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}batch-1` },
    });
    expect(summaryLogs).toBe(1);

    // 同键重放：结果一致，不产生重复授权/版本递增/日志
    const replayed = await service.batchGrant(superOp.id, body);
    expect(replayed).toEqual(result);
    expect(await permissionVersion(userA.id)).toBe(1);
    expect(await prisma.client.employeeGrant.count({ where: { userId: { in: [userA.id, userB.id] } } })).toBe(4);

    // 新键相同内容：两人均已持有全部授权项 → 无变化目标跳过（版本不变、不写明细日志）
    await service.batchGrant(superOp.id, { ...body, idempotencyKey: `${KEY_PREFIX}batch-1b` });
    expect(await permissionVersion(userA.id)).toBe(1);
    expect(await permissionVersion(userB.id)).toBe(1);
    const moreDetailLogs = await prisma.client.backstageOperationLog.count({
      where: { operatorId: superOp.id, idempotencyKey: null, summary: { startsWith: '批量授权：为 T32_' } },
    });
    expect(moreDetailLogs).toBe(2);
  });

  it('批量撤销：撤销可管理范围全部授权；范围外授权行与无授权目标不受影响', async () => {
    const userC = await createUser({ name: `${TEST_NAME_PREFIX}撤销丙` });
    const userD = await createUser({ name: `${TEST_NAME_PREFIX}撤销丁` });
    const userE = await createUser({ name: `${TEST_NAME_PREFIX}撤销戊` });
    await prisma.client.employeeGrant.createMany({
      data: [
        { userId: userC.id, functionCode: 'my_assets', dataScope: 'SELF', grantedBy: superOp.id },
        { userId: userC.id, functionCode: 'consumable_apply', dataScope: 'SELF', grantedBy: superOp.id },
        { userId: userD.id, functionCode: 'permission_manage', dataScope: 'COMPANY', grantedBy: superOp.id },
      ],
    });
    const result = await service.batchRevoke(permAdmin.id, {
      userIds: [userC.id, userD.id, userE.id],
      idempotencyKey: `${KEY_PREFIX}revoke-1`,
    });
    expect(result).toEqual({ ok: true, userIds: [userC.id, userD.id, userE.id] });
    // userC 两项全部撤销并递增版本；userD 的"权限管理"超出权限管理员可管理范围保持不动；userE 无授权跳过
    expect(await currentGrants(userC.id)).toHaveLength(0);
    expect(await permissionVersion(userC.id)).toBe(1);
    expect(await currentGrants(userD.id)).toEqual([{ functionCode: 'permission_manage', dataScope: 'COMPANY' }]);
    expect(await permissionVersion(userD.id)).toBe(0);
    expect(await permissionVersion(userE.id)).toBe(0);
    // 超管可撤销"权限管理"功能
    await service.batchRevoke(superOp.id, { userIds: [userD.id], idempotencyKey: `${KEY_PREFIX}revoke-2` });
    expect(await currentGrants(userD.id)).toHaveLength(0);
    expect(await permissionVersion(userD.id)).toBe(1);
  });

  it('员工检索：姓名/手机号模糊匹配、已注销排除、分页结构与授权摘要', async () => {
    const found = await createUser({ name: `${TEST_NAME_PREFIX}检索命中` });
    await prisma.client.employeeGrant.create({
      data: { userId: found.id, functionCode: 'fixed_asset_maintain', dataScope: 'DEPARTMENT', grantedBy: superOp.id },
    });
    const missed = await createUser({ name: `${TEST_NAME_PREFIX}检索排除`, status: 'DEACTIVATED' });

    // 检索词不含数字时只按姓名模糊匹配（避免命中测试手机号段的数字片段）
    const byName = await service.searchEmployees({ keyword: '检索命中', page: 1, pageSize: 20 });
    expect(byName.pagination).toMatchObject({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
    expect(byName.data).toHaveLength(1);
    expect(byName.data[0]).toMatchObject({
      id: found.id,
      name: `${TEST_NAME_PREFIX}检索命中`,
      status: 'ACTIVE',
      isSuperAdmin: false,
      departments: [],
      grantsSummary: ['固定资产维护（部门）'],
      systems: ['资产系统'],
    });
    expect(byName.data[0]?.phoneMasked).toContain('****');

    const foundUser = await prisma.client.user.findUniqueOrThrow({ where: { id: found.id } });
    const byPhone = await service.searchEmployees({ keyword: foundUser.phone.slice(-8), page: 1, pageSize: 20 });
    expect(byPhone.data.map((item) => item.id)).toContain(found.id);

    const all = await service.searchEmployees({ keyword: TEST_NAME_PREFIX, page: 1, pageSize: 100 });
    expect(all.data.map((item) => item.id)).toContain(found.id);
    expect(all.data.map((item) => item.id)).not.toContain(missed.id);
  });

  it('员工检索结构化筛选：keyword contains 姓名/手机号、具名参数让位、无 filters 时向后兼容', async () => {
    const found = await createUser({ name: `${TEST_NAME_PREFIX}筛选命中` });
    const missed = await createUser({ name: `${TEST_NAME_PREFIX}筛选排除` });

    // keyword contains 姓名
    const byName = await service.searchEmployees({
      page: 1,
      pageSize: 100,
      filters: JSON.stringify({
        logic: 'AND',
        conditions: [{ field: 'keyword', operator: 'CONTAINS', value: '筛选命中' }],
      }),
    });
    expect(byName.data.map((item) => item.id)).toContain(found.id);
    expect(byName.data.map((item) => item.id)).not.toContain(missed.id);

    // keyword contains 手机号片段
    const foundUser = await prisma.client.user.findUniqueOrThrow({ where: { id: found.id } });
    const byPhone = await service.searchEmployees({
      page: 1,
      pageSize: 100,
      filters: JSON.stringify({
        logic: 'AND',
        conditions: [{ field: 'keyword', operator: 'CONTAINS', value: foundUser.phone.slice(-8) }],
      }),
    });
    expect(byPhone.data.map((item) => item.id)).toContain(found.id);
    expect(byPhone.data.map((item) => item.id)).not.toContain(missed.id);

    // 具名参数让位：filters 含 keyword 时具名 keyword 被忽略
    const yielded = await service.searchEmployees({
      page: 1,
      pageSize: 100,
      keyword: missed.name,
      filters: JSON.stringify({
        logic: 'AND',
        conditions: [{ field: 'keyword', operator: 'CONTAINS', value: found.name }],
      }),
    });
    expect(yielded.data.map((item) => item.id)).toContain(found.id);
    expect(yielded.data.map((item) => item.id)).not.toContain(missed.id);

    // 无 filters 时具名 keyword 行为不变
    const namedOnly = await service.searchEmployees({ keyword: found.name, page: 1, pageSize: 100 });
    expect(namedOnly.data.map((item) => item.id)).toContain(found.id);
  });

  it('员工检索 systems：授权涉及系统按目录顺序去重，目录外授权不归纳，无授权为空数组', async () => {
    const multi = await createUser({ name: `${TEST_NAME_PREFIX}多系统` });
    await prisma.client.employeeGrant.createMany({
      data: [
        // 乱序写入 + 同系统多项授权：验证按目录系统顺序（管理后台 → 资产 → 财务）去重
        { userId: multi.id, functionCode: 'finance_view', dataScope: 'COMPANY', grantedBy: superOp.id },
        { userId: multi.id, functionCode: 'fixed_asset_maintain', dataScope: 'COMPANY', grantedBy: superOp.id },
        { userId: multi.id, functionCode: 'my_assets', dataScope: 'SELF', grantedBy: superOp.id },
        { userId: multi.id, functionCode: 'user_manage', dataScope: 'COMPANY', grantedBy: superOp.id },
        // 目录外（已移除功能）历史授权行：不参与系统归纳
        { userId: multi.id, functionCode: 'ghost_function', dataScope: 'COMPANY', grantedBy: superOp.id },
      ],
    });
    const noGrants = await createUser({ name: `${TEST_NAME_PREFIX}无授权` });

    const result = await service.searchEmployees({ keyword: TEST_NAME_PREFIX, page: 1, pageSize: 100 });
    const multiItem = result.data.find((item) => item.id === multi.id);
    expect(multiItem?.systems).toEqual(['管理后台', '资产系统', '财务系统']);
    const noGrantsItem = result.data.find((item) => item.id === noGrants.id);
    expect(noGrantsItem?.systems).toEqual([]);
  });

  it('查看目标员工当前授权：返回版本与目录过滤后的授权列表；不存在返回 404', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}查看` });
    await prisma.client.employeeGrant.createMany({
      data: [
        { userId: target.id, functionCode: 'my_assets', dataScope: 'SELF', grantedBy: superOp.id },
        // 目录外（已移除功能）历史授权行：保留为审计但不生效、不返回
        { userId: target.id, functionCode: 'ghost_function', dataScope: 'COMPANY', grantedBy: superOp.id },
      ],
    });
    const detail = await service.getEmployeeGrants(target.id);
    expect(detail.permissionVersion).toBe(0);
    expect(detail.target).toMatchObject({ id: target.id, isSuperAdmin: false });
    expect(detail.grants).toEqual([
      { functionCode: 'my_assets', dataScope: 'SELF', name: '我的资产', systemCode: 'ASSET', sectionCode: 'fixed-asset' },
    ]);
    await expect(service.getEmployeeGrants(999999999)).rejects.toMatchObject({ entry: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('授权生效判断：目录外授权行不生效、超管豁免、普通持有生效（AuthorizationService）', async () => {
    const ghost = await createUser({ name: `${TEST_NAME_PREFIX}幽灵` });
    await prisma.client.employeeGrant.create({
      data: { userId: ghost.id, functionCode: 'ghost_function', dataScope: 'COMPANY', grantedBy: superOp.id },
    });
    expect(await authorization.hasFunction(ghost.id, 'ghost_function')).toBe(false);
    const effective = await authorization.getEffectiveGrants(ghost.id);
    expect(effective.isSuperAdmin).toBe(false);
    expect(effective.grants).toHaveLength(0);

    // 超管豁免针对"仍注册的功能"的授权约束：未授予但生效
    expect(await authorization.hasFunction(superOp.id, 'permission_manage')).toBe(true);
    // 目录外（未注册/已移除）功能不参与守卫判断：任何人（含超管）不可用
    expect(await authorization.hasFunction(superOp.id, 'ghost_function')).toBe(false);
    expect(await authorization.hasFunction(permAdmin.id, 'permission_manage')).toBe(true);
    expect(await authorization.hasFunction(ghost.id, 'permission_manage')).toBe(false);
  });

  it('守卫链即时生效：授予→放行（注入数据范围）→撤销→同用户下一请求 403（T3-4）', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}即时` });
    const handler = (): void => undefined;
    const context = { getHandler: () => handler, getClass: () => class {} } as never;
    // 用 BACKSTAGE（恒 OPEN）的功能做链路验证：ASSET/HR/FIN 未开放时守卫按系统可用性拦截
    const reflector = {
      get: (key: string, metaTarget: unknown) =>
        key === REQUIRED_FUNCTION_KEY && metaTarget === handler ? 'operation_log_view' : undefined,
    } as unknown as Reflector;
    const guard = new FunctionPermissionGuard(reflector, authorization);
    const runGuard = (userId: number): Promise<{ allowed: boolean; granted: unknown }> =>
      REQUEST_CONTEXT_STORAGE.run(
        { requestId: 'r', traceId: 't', startedAt: 0, service: 'test', userId } as RequestContext,
        async () => {
          const allowed = await guard.canActivate(context);
          return { allowed, granted: getRequestContext()?.grantedFunction };
        },
      );

    // 授予前：403
    await expect(runGuard(target.id)).rejects.toMatchObject({ entry: { code: 'FORBIDDEN' } });
    // 授予后：放行并注入有效数据范围（无授权缓存，实时读取）
    await service.batchGrant(superOp.id, {
      userIds: [target.id],
      grants: [{ functionCode: 'operation_log_view', dataScope: 'DEPARTMENT' }],
    });
    await expect(runGuard(target.id)).resolves.toEqual({
      allowed: true,
      granted: { code: 'operation_log_view', dataScope: 'DEPARTMENT' },
    });
    // 撤销后：同一用户下一次守卫校验立即 403（撤权即时生效，不等待会话/缓存过期）
    await service.batchRevoke(superOp.id, { userIds: [target.id] });
    await expect(runGuard(target.id)).rejects.toMatchObject({ entry: { code: 'FORBIDDEN' } });
    // 超管豁免：数据范围上下文为 null（不受限，仅针对访问控制）
    await expect(runGuard(superOp.id)).resolves.toEqual({ allowed: true, granted: { code: 'operation_log_view', dataScope: null } });
  });

  it('提权旋转接线：新授予"权限管理"功能标记会话旋转；普通授予与撤销不标记（base PRD §3）', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}提权` });
    // 普通功能授予：不标记（不过度旋转）
    await service.batchGrant(superOp.id, { userIds: [target.id], grants: [{ functionCode: 'my_assets', dataScope: 'SELF' }] });
    expect(await elevationMarkedAt(target.id)).toBeNull();
    // 保存新获得"权限管理"功能（进入委派链）：标记
    await service.saveEmployeeGrants(superOp.id, target.id, {
      permissionVersion: 1,
      grants: [
        { functionCode: 'my_assets', dataScope: 'SELF' },
        { functionCode: 'permission_manage', dataScope: 'COMPANY' },
      ],
    });
    expect(await elevationMarkedAt(target.id)).not.toBeNull();
    // 撤销（含权限管理）：不新增标记
    await redis.del(elevationKey(target.id));
    await service.batchRevoke(superOp.id, { userIds: [target.id] });
    expect(await elevationMarkedAt(target.id)).toBeNull();
    // 批量授予含"权限管理"：逐人标记
    const targetB = await createUser({ name: `${TEST_NAME_PREFIX}提权乙` });
    await service.batchGrant(superOp.id, {
      userIds: [targetB.id],
      grants: [{ functionCode: 'permission_manage', dataScope: 'COMPANY' }],
    });
    expect(await elevationMarkedAt(targetB.id)).not.toBeNull();
    // 已持有者再次经批量授权获得同一功能（无变化跳过）：不重复标记
    await redis.del(elevationKey(targetB.id));
    await service.batchGrant(superOp.id, {
      userIds: [targetB.id],
      grants: [{ functionCode: 'permission_manage', dataScope: 'COMPANY' }],
    });
    expect(await elevationMarkedAt(targetB.id)).toBeNull();
  });
});

describe('人员权限员工列表结构化查询白名单（单元）', () => {
  it('name 筛选与排序正确编译', () => {
    const query = buildTablePrismaQuery(
      {
        filters: JSON.stringify({
          logic: 'AND',
          conditions: [{ field: 'name', operator: 'CONTAINS', value: '张' }],
        }),
        sorts: JSON.stringify([{ field: 'name', direction: 'ASC' }]),
      },
      EMPLOYEE_FILTER_FIELDS,
    );
    expect(query.orderBy).toEqual([{ name: 'asc' }, { id: 'desc' }]);
    expect(query.where).toEqual({ AND: [{ name: { contains: '张', mode: 'insensitive' } }] });
  });
});
