import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { BusinessException } from '@wbme/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { PrismaService } from '../../../prisma.service';
import { ensurePermissionCatalog } from '../../../test-support/ensure-permission-catalog';
import { GrantService } from './grant.service';
import { PermissionGroupService } from './permission-group.service';
import { SessionService } from '@wbme/server';
import Redis from 'ioredis';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

/** 测试数据统一前缀（账号姓名/手机号、组名），便于隔离与清理 */
const TEST_NAME_PREFIX = 'T33_';
const TEST_PHONE_PREFIX = '+8613933';
const TEST_GROUP_PREFIX = 'T33组_';
const KEY_PREFIX = 't33-';

/**
 * 权限组集成测试（实现规划 T3-3、主 PRD §3.1、backstage PRD §4；真实 PostgreSQL）。
 *
 * 验收核心 = 快照语义：组展开授权后修改/删除组，员工授权不受影响。
 * 测试组与账号使用统一前缀，结束后统一清理（含软删除组的物理清理）。
 */
describe.skipIf(!DATABASE_URL || !REDIS_URL)('权限组（T3-3 CRUD/展开/快照语义）', () => {
  let prisma: PrismaService;
  let groups: PermissionGroupService;
  let grants: GrantService;
  let redis: Redis;
  let phoneSeq = 0;

  let superOp: { id: number; name: string };
  let permAdmin: { id: number; name: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    groups = new PermissionGroupService(prisma);
    redis = new Redis(REDIS_URL ?? 'redis://localhost:6379');
    grants = new GrantService(prisma, new SessionService(redis));
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

  /** 清理本规格产生的组（含软删除）、授权行、操作日志与测试账号 */
  async function cleanupLeftovers(): Promise<void> {
    const legacyUsers = await prisma.client.user.findMany({
      where: { phone: { startsWith: TEST_PHONE_PREFIX } },
      select: { id: true },
    });
    const userIds = legacyUsers.map((row) => row.id);
    if (userIds.length > 0) {
      await prisma.client.employeeGrant.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { grantedBy: { in: userIds } }] } });
      await prisma.client.backstageOperationLog.deleteMany({ where: { operatorId: { in: userIds } } });
      await prisma.client.user.deleteMany({ where: { id: { in: userIds } } });
    }
    const legacyGroups = await prisma.client.permissionGroup.findMany({
      where: { name: { startsWith: TEST_GROUP_PREFIX } },
      select: { id: true },
    });
    const groupIds = legacyGroups.map((row) => row.id);
    if (groupIds.length > 0) {
      await prisma.client.permissionGroupItem.deleteMany({ where: { groupId: { in: groupIds } } });
      await prisma.client.permissionGroup.deleteMany({ where: { id: { in: groupIds } } });
    }
  }

  async function createUser(options: { name: string; isSuperAdmin?: boolean }): Promise<{ id: number; name: string }> {
    phoneSeq += 1;
    const user = await prisma.client.user.create({
      data: {
        name: options.name,
        gender: 'FEMALE',
        phone: `${TEST_PHONE_PREFIX}${String(phoneSeq).padStart(6, '0')}`,
        status: 'ACTIVE',
        isSuperAdmin: options.isSuperAdmin ?? false,
        passwordHash: 't33-hash',
      },
    });
    return { id: user.id, name: user.name };
  }

  async function currentGrants(userId: number): Promise<Array<{ functionCode: string; dataScope: string }>> {
    const rows = await prisma.client.employeeGrant.findMany({
      where: { userId },
      select: { functionCode: true, dataScope: true },
    });
    return rows.sort((a, b) => a.functionCode.localeCompare(b.functionCode) || a.dataScope.localeCompare(b.dataScope));
  }

  it('创建/查看/列表：明细按目录排序且标记有效；创建幂等重放返回原组', async () => {
    const created = await groups.createGroup(superOp.id, {
      name: `${TEST_GROUP_PREFIX}基础`,
      description: '测试组',
      items: [
        { functionCode: 'consumable_apply', dataScope: 'SELF' },
        { functionCode: 'my_assets', dataScope: 'SELF' },
      ],
      idempotencyKey: `${KEY_PREFIX}create-1`,
    });
    const detail = await groups.getGroup(created.id);
    expect(detail.name).toBe(`${TEST_GROUP_PREFIX}基础`);
    expect(detail.items).toHaveLength(2);
    // 按目录排序：ASSET fixed-asset 板块（my_assets）先于 consumable 板块（consumable_apply）
    expect(detail.items[0]).toMatchObject({ functionCode: 'my_assets', dataScope: 'SELF', name: '我的资产', systemCode: 'ASSET', valid: true });
    expect(detail.items[1]).toMatchObject({ functionCode: 'consumable_apply', valid: true });

    const list = await groups.listGroups({ page: 1, pageSize: 20 });
    const row = list.data.find((item) => item.id === created.id);
    expect(row).toMatchObject({ name: `${TEST_GROUP_PREFIX}基础`, description: '测试组', itemCount: 2 });
    expect(list.pagination.totalItems).toBeGreaterThanOrEqual(1);

    // 幂等重放：同键同体返回原组 id，不重复建组
    const replayed = await groups.createGroup(superOp.id, {
      name: `${TEST_GROUP_PREFIX}基础`,
      description: '测试组',
      items: [
        { functionCode: 'consumable_apply', dataScope: 'SELF' },
        { functionCode: 'my_assets', dataScope: 'SELF' },
      ],
      idempotencyKey: `${KEY_PREFIX}create-1`,
    });
    expect(replayed).toEqual(created);
    const count = await prisma.client.permissionGroup.count({ where: { name: `${TEST_GROUP_PREFIX}基础` } });
    expect(count).toBe(1);
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}create-1` },
    });
    expect(log?.actionType).toBe('CREATE');
    expect(log?.summary).toContain('创建权限组');
    expect(log?.summary).toContain('我的资产（本人）');
  });

  it('名称唯一：重名创建 409；已软删除组的名称仍被占用（S-6）', async () => {
    const created = await groups.createGroup(superOp.id, {
      name: `${TEST_GROUP_PREFIX}唯一`,
      items: [],
    });
    await expect(groups.createGroup(superOp.id, { name: `${TEST_GROUP_PREFIX}唯一`, items: [] })).rejects.toMatchObject({
      entry: { code: 'GROUP_NAME_CONFLICT' },
    });
    // 软删除后名称仍被唯一约束占用
    await groups.batchDeleteGroups(superOp.id, { groupIds: [created.id], idempotencyKey: `${KEY_PREFIX}del-uniq` });
    await expect(groups.createGroup(superOp.id, { name: `${TEST_GROUP_PREFIX}唯一`, items: [] })).rejects.toMatchObject({
      entry: { code: 'GROUP_NAME_CONFLICT' },
    });
  });

  it('明细校验：未注册功能 / 非法档位 / 权限管理员不能将"权限管理"入组 / 完全重复明细', async () => {
    await expect(
      groups.createGroup(superOp.id, { name: `${TEST_GROUP_PREFIX}坏1`, items: [{ functionCode: 'ghost_function', dataScope: 'COMPANY' }] }),
    ).rejects.toMatchObject({ entry: { code: 'FUNCTION_NOT_REGISTERED' } });
    await expect(
      groups.createGroup(superOp.id, { name: `${TEST_GROUP_PREFIX}坏2`, items: [{ functionCode: 'my_assets', dataScope: 'COMPANY' }] }),
    ).rejects.toMatchObject({ entry: { code: 'SCOPE_NOT_SUPPORTED' } });
    // 委派约束对组同样强制：否则权限管理员可借组展开间接授予"权限管理"
    await expect(
      groups.createGroup(permAdmin.id, { name: `${TEST_GROUP_PREFIX}坏3`, items: [{ functionCode: 'permission_manage', dataScope: 'COMPANY' }] }),
    ).rejects.toMatchObject({ entry: { code: 'PERMISSION_MANAGEMENT_GRANT_FORBIDDEN' } });
    await expect(
      groups.createGroup(superOp.id, {
        name: `${TEST_GROUP_PREFIX}坏4`,
        items: [
          { functionCode: 'my_assets', dataScope: 'SELF' },
          { functionCode: 'my_assets', dataScope: 'SELF' },
        ],
      }),
    ).rejects.toMatchObject({ entry: { code: 'VALIDATION_FAILED' } });
  });

  it('编辑：事务内全量替换明细、更新名称描述、写变更前后日志；组不存在 404；重名 409', async () => {
    const created = await groups.createGroup(superOp.id, {
      name: `${TEST_GROUP_PREFIX}编辑`,
      description: '旧描述',
      items: [{ functionCode: 'my_assets', dataScope: 'SELF' }],
    });
    await groups.createGroup(superOp.id, { name: `${TEST_GROUP_PREFIX}占位`, items: [] });
    const result = await groups.updateGroup(superOp.id, created.id, {
      name: `${TEST_GROUP_PREFIX}编辑后`,
      description: '新描述',
      items: [
        { functionCode: 'fixed_asset_view', dataScope: 'COMPANY' },
        { functionCode: 'consumable_apply', dataScope: 'SELF' },
      ],
      idempotencyKey: `${KEY_PREFIX}update-1`,
    });
    expect(result).toEqual({ ok: true });
    const detail = await groups.getGroup(created.id);
    expect(detail.name).toBe(`${TEST_GROUP_PREFIX}编辑后`);
    expect(detail.description).toBe('新描述');
    expect(detail.items.map((item) => item.functionCode)).toEqual(['fixed_asset_view', 'consumable_apply']);
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}update-1` },
    });
    expect(log?.actionType).toBe('UPDATE');
    expect(log?.summary).toContain('变更前 [我的资产（本人）]');
    expect(log?.summary).toContain('固定资产查看（公司）');

    await expect(groups.getGroup(999999999)).rejects.toMatchObject({ entry: { code: 'RESOURCE_NOT_FOUND' } });
    await expect(groups.updateGroup(superOp.id, 999999999, { name: `${TEST_GROUP_PREFIX}无`, items: [] })).rejects.toMatchObject({
      entry: { code: 'RESOURCE_NOT_FOUND' },
    });
    await expect(
      groups.updateGroup(superOp.id, created.id, { name: `${TEST_GROUP_PREFIX}占位`, items: [] }),
    ).rejects.toMatchObject({ entry: { code: 'GROUP_NAME_CONFLICT' } });
  });

  it('批量删除：软删除生效、整批语义（任一不存在则全不删）、幂等重放', async () => {
    const first = await groups.createGroup(superOp.id, { name: `${TEST_GROUP_PREFIX}删1`, items: [] });
    const second = await groups.createGroup(superOp.id, { name: `${TEST_GROUP_PREFIX}删2`, items: [] });
    const error = await groups
      .batchDeleteGroups(superOp.id, { groupIds: [first.id, 999999999], idempotencyKey: `${KEY_PREFIX}del-blocked` })
      .catch((caught: unknown) => caught);
    expect((error as BusinessException).entry.code).toBe('GROUP_BATCH_BLOCKED');
    const failures = (error as BusinessException).details?.failures as Array<{ groupId: number; code: string }>;
    expect(failures).toEqual([{ groupId: 999999999, code: 'GROUP_NOT_FOUND', message: '权限组不存在或已删除' }]);
    // 整批不变更：first 仍未删除
    expect((await groups.getGroup(first.id)).name).toBe(`${TEST_GROUP_PREFIX}删1`);

    const deleted = await groups.batchDeleteGroups(superOp.id, {
      groupIds: [first.id, second.id],
      idempotencyKey: `${KEY_PREFIX}del-ok`,
    });
    expect(deleted).toEqual({ ok: true, groupIds: [first.id, second.id] });
    await expect(groups.getGroup(first.id)).rejects.toMatchObject({ entry: { code: 'RESOURCE_NOT_FOUND' } });
    const row = await prisma.client.permissionGroup.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(superOp.id);
    // 重放：同键返回原结果，不重复删/写日志
    const replayed = await groups.batchDeleteGroups(superOp.id, {
      groupIds: [first.id, second.id],
      idempotencyKey: `${KEY_PREFIX}del-ok`,
    });
    expect(replayed).toEqual(deleted);
    const logs = await prisma.client.backstageOperationLog.count({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}del-ok` },
    });
    expect(logs).toBe(1);
  });

  it('快照语义（验收核心）：组展开授权后，修改/删除组不影响员工已授权；已删组不再可展开', async () => {
    const group = await groups.createGroup(superOp.id, {
      name: `${TEST_GROUP_PREFIX}快照`,
      items: [
        { functionCode: 'my_assets', dataScope: 'SELF' },
        { functionCode: 'fixed_asset_view', dataScope: 'COMPANY' },
      ],
    });
    const target = await createUser({ name: `${TEST_NAME_PREFIX}快照员工` });
    const granted = await grants.batchGrant(superOp.id, {
      userIds: [target.id],
      grants: [],
      groupIds: [group.id],
      idempotencyKey: `${KEY_PREFIX}expand-1`,
    });
    expect(granted).toEqual({ ok: true, userIds: [target.id], skippedGroupItems: [] });
    expect(await currentGrants(target.id)).toEqual([
      { functionCode: 'fixed_asset_view', dataScope: 'COMPANY' },
      { functionCode: 'my_assets', dataScope: 'SELF' },
    ]);
    expect((await prisma.client.user.findUniqueOrThrow({ where: { id: target.id } })).permissionVersion).toBe(1);
    // 组与员工无关联：员工授权行是展开快照
    const summaryLog = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}expand-1` },
    });
    expect(summaryLog?.summary).toContain(`权限组 「${TEST_GROUP_PREFIX}快照」 展开`);

    // 修改组（移除 my_assets）→ 员工授权不变
    await groups.updateGroup(superOp.id, group.id, {
      name: `${TEST_GROUP_PREFIX}快照`,
      items: [{ functionCode: 'fixed_asset_view', dataScope: 'COMPANY' }],
    });
    expect(await currentGrants(target.id)).toEqual([
      { functionCode: 'fixed_asset_view', dataScope: 'COMPANY' },
      { functionCode: 'my_assets', dataScope: 'SELF' },
    ]);
    // 删除组 → 员工授权仍不变；已删组不再可展开
    await groups.batchDeleteGroups(superOp.id, { groupIds: [group.id] });
    expect(await currentGrants(target.id)).toEqual([
      { functionCode: 'fixed_asset_view', dataScope: 'COMPANY' },
      { functionCode: 'my_assets', dataScope: 'SELF' },
    ]);
    await expect(
      grants.batchGrant(superOp.id, { userIds: [target.id], grants: [], groupIds: [group.id] }),
    ).rejects.toMatchObject({ entry: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('失效项跳过：目录外/档位失效的组明细不展开、不计入授权，其余正常展开', async () => {
    const group = await groups.createGroup(superOp.id, {
      name: `${TEST_GROUP_PREFIX}失效`,
      items: [{ functionCode: 'my_assets', dataScope: 'SELF' }],
    });
    // 直接插入两类失效明细（绕过服务校验，模拟目录后续变化）：功能已移除 / 数据范围已失效
    await prisma.client.permissionGroupItem.createMany({
      data: [
        { groupId: group.id, systemCode: 'ASSET', functionCode: 'ghost_function', dataScope: 'COMPANY' },
        { groupId: group.id, systemCode: 'ASSET', functionCode: 'my_assets', dataScope: 'COMPANY' },
      ],
    });
    // 组详情标记失效项
    const detail = await groups.getGroup(group.id);
    expect(detail.items.filter((item) => !item.valid)).toHaveLength(2);

    const target = await createUser({ name: `${TEST_NAME_PREFIX}失效员工` });
    const result = await grants.batchGrant(superOp.id, {
      userIds: [target.id],
      grants: [],
      groupIds: [group.id],
      idempotencyKey: `${KEY_PREFIX}expand-2`,
    });
    expect(result.ok).toBe(true);
    expect(result.skippedGroupItems).toHaveLength(2);
    expect(result.skippedGroupItems).toContainEqual({ groupId: group.id, functionCode: 'ghost_function', dataScope: 'COMPANY' });
    expect(result.skippedGroupItems).toContainEqual({ groupId: group.id, functionCode: 'my_assets', dataScope: 'COMPANY' });
    // 仅有效项被展开
    expect(await currentGrants(target.id)).toEqual([{ functionCode: 'my_assets', dataScope: 'SELF' }]);
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}expand-2` },
    });
    expect(log?.summary).toContain('失效跳过 2 项');
  });

  it('逐项与组展开合并：同一功能按最宽数据范围生效；权限管理员不得展开含"权限管理"的组', async () => {
    const group = await groups.createGroup(superOp.id, {
      name: `${TEST_GROUP_PREFIX}合并`,
      items: [{ functionCode: 'fixed_asset_view', dataScope: 'COMPANY' }],
    });
    const target = await createUser({ name: `${TEST_NAME_PREFIX}合并员工` });
    await grants.batchGrant(superOp.id, {
      userIds: [target.id],
      grants: [{ functionCode: 'fixed_asset_view', dataScope: 'DEPARTMENT' }],
      groupIds: [group.id],
    });
    // 同一功能只保留最宽（公司 > 部门）
    expect(await currentGrants(target.id)).toEqual([{ functionCode: 'fixed_asset_view', dataScope: 'COMPANY' }]);

    const manageGroup = await groups.createGroup(superOp.id, {
      name: `${TEST_GROUP_PREFIX}权管组`,
      items: [{ functionCode: 'permission_manage', dataScope: 'COMPANY' }],
    });
    const another = await createUser({ name: `${TEST_NAME_PREFIX}越权员工` });
    await expect(
      grants.batchGrant(permAdmin.id, { userIds: [another.id], grants: [], groupIds: [manageGroup.id] }),
    ).rejects.toMatchObject({ entry: { code: 'PERMISSION_MANAGEMENT_GRANT_FORBIDDEN' } });
    expect(await currentGrants(another.id)).toHaveLength(0);
  });

  it('空授权内容拒绝：逐项功能与权限组至少一项', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}空内容` });
    await expect(grants.batchGrant(superOp.id, { userIds: [target.id], grants: [] })).rejects.toMatchObject({
      entry: { code: 'VALIDATION_FAILED' },
    });
  });
});
