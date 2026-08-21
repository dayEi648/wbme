import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { BusinessException, frameworkErrors, permissionErrors } from '@wbme/contracts';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { PrismaService } from '../../../prisma.service';
import type { SystemMenuGroup, SystemMenuItem } from '../../../generated/prisma/client';
import { ensurePermissionCatalog } from '../../../test-support/ensure-permission-catalog';
import { AuthorizationService } from '../permission/authorization.service';
import type { SaveSystemMenuConfigDto } from './menu-config.dto';
import { MenuConfigService, normalizeAndValidateMenuConfig } from './menu-config.service';

/** 构造保存载荷（纯数据，service 层不依赖 class-transformer 实例化） */
function dto(partial: Partial<SaveSystemMenuConfigDto>): SaveSystemMenuConfigDto {
  return { groups: [], items: [], ...partial } as SaveSystemMenuConfigDto;
}

/** 断言同步函数抛出指定目录编码的 BusinessException（含 reason 详情时一并断言） */
function expectInvalidStructure(fn: () => unknown, reasonIncludes?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessException);
    const businessError = error as BusinessException;
    expect(businessError.entry.code).toBe(permissionErrors.MENU_CONFIG_STRUCTURE_INVALID.code);
    if (reasonIncludes !== undefined) {
      expect(String(businessError.details?.['reason'])).toContain(reasonIncludes);
    }
    return;
  }
  expect.unreachable('应当抛出菜单配置结构不合法错误');
}

describe('菜单配置结构校验（normalizeAndValidateMenuConfig，纯函数）', () => {
  it('规整：nameOverride 空白串视为未覆盖（恢复默认名），非空串去首尾空白', () => {
    const config = normalizeAndValidateMenuConfig(dto({
      groups: [
        { nodeKey: '固定资产', sortOrder: 0, nameOverride: '  ' },
        { nodeKey: '消耗品', sortOrder: 1 },
        { nodeKey: '消耗品/消耗品管理', parentKey: '消耗品', sortOrder: 0, nameOverride: ' 品类与库存 ' },
      ],
      items: [
        { itemKey: 'my-assets', parentKey: '固定资产', sortOrder: 0 },
        { itemKey: 'consumables', parentKey: '消耗品/消耗品管理', sortOrder: 0, nameOverride: null },
      ],
    }));
    expect(config.groups[0]?.nameOverride).toBeNull();
    expect(config.groups[2]?.nameOverride).toBe('品类与库存');
    expect(config.items[1]?.nameOverride).toBeNull();
  });

  it('拒绝重复的分组标识与菜单项标识', () => {
    expectInvalidStructure(() => normalizeAndValidateMenuConfig(dto({
      groups: [
        { nodeKey: '固定资产', sortOrder: 0 },
        { nodeKey: '固定资产', sortOrder: 1 },
      ],
    })), '分组标识重复');
    expectInvalidStructure(() => normalizeAndValidateMenuConfig(dto({
      items: [
        { itemKey: 'assets', sortOrder: 0 },
        { itemKey: 'assets', sortOrder: 1 },
      ],
    })), '菜单项标识重复');
  });

  it('拒绝悬空引用：分组父分组不存在 / 菜单项所属分组不存在', () => {
    expectInvalidStructure(() => normalizeAndValidateMenuConfig(dto({
      groups: [{ nodeKey: '消耗品/消耗品管理', parentKey: '消耗品', sortOrder: 0 }],
    })), '父分组不存在');

    expectInvalidStructure(() => normalizeAndValidateMenuConfig(dto({
      groups: [{ nodeKey: '固定资产', sortOrder: 0 }],
      items: [{ itemKey: 'assets', parentKey: '不存在的分组', sortOrder: 0 }],
    })), '所属分组不存在');
  });

  it('拒绝分组自引用与层级循环', () => {
    expectInvalidStructure(() => normalizeAndValidateMenuConfig(dto({
      groups: [{ nodeKey: '固定资产', parentKey: '固定资产', sortOrder: 0 }],
    })), '自己的父分组');

    expectInvalidStructure(() => normalizeAndValidateMenuConfig(dto({
      groups: [
        { nodeKey: 'A', parentKey: 'B', sortOrder: 0 },
        { nodeKey: 'B', parentKey: 'A', sortOrder: 1 },
      ],
    })), '循环');

    // 三节点环同样拒绝
    expectInvalidStructure(() => normalizeAndValidateMenuConfig(dto({
      groups: [
        { nodeKey: 'A', parentKey: 'C', sortOrder: 0 },
        { nodeKey: 'B', parentKey: 'A', sortOrder: 1 },
        { nodeKey: 'C', parentKey: 'B', sortOrder: 2 },
      ],
    })), '循环');
  });

  it('任意层级嵌套载荷通过校验：三级分组、菜单项挂在深层分组、顶层叶子并存', () => {
    const config = normalizeAndValidateMenuConfig(dto({
      groups: [
        { nodeKey: 'A', sortOrder: 0 },
        { nodeKey: 'A/B', parentKey: 'A', sortOrder: 0 },
        { nodeKey: 'A/B/C', parentKey: 'A/B', sortOrder: 0 },
      ],
      items: [
        { itemKey: 'x', parentKey: 'A/B/C', sortOrder: 0 },
        { itemKey: 'y', parentKey: 'A', sortOrder: 0 },
        { itemKey: 'z', sortOrder: 1 },
      ],
    }));
    expect(config.groups).toHaveLength(3);
    expect(config.groups[2]?.parentKey).toBe('A/B');
    expect(config.items[0]?.parentKey).toBe('A/B/C');
    expect(config.items[2]?.parentKey).toBeNull();
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

/** 测试数据统一前缀（账号姓名/手机号），便于隔离与清理 */
const TEST_NAME_PREFIX = 'T33菜单_';
const TEST_PHONE_PREFIX = '+8613944';
const KEY_PREFIX = 't33-menu-';
/** 集成测试占用的系统编码；前后快照恢复，避免污染开发库中该系统的既有配置 */
const TEST_SYSTEM = 'FIN';

/**
 * 菜单配置集成测试（主 PRD §2.1 菜单管理；真实 PostgreSQL + Redis）。
 *
 * 验收核心 = 整树替换语义 + 动态功能码鉴权 + 幂等重放。
 * 占用 TEST_SYSTEM 的配置行：开始前快照、结束后恢复。
 */
describe.skipIf(!DATABASE_URL || !REDIS_URL)('菜单配置（保存/读取/恢复默认/鉴权/幂等）', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let service: MenuConfigService;
  let phoneSeq = 0;

  let superOp: { id: number; name: string };
  let outsider: { id: number; name: string };
  let snapshotGroups: SystemMenuGroup[];
  let snapshotItems: SystemMenuItem[];

  beforeAll(async () => {
    prisma = new PrismaService();
    redis = new Redis(REDIS_URL ?? 'redis://localhost:6379');
    service = new MenuConfigService(prisma, new AuthorizationService(prisma, redis));
    // CI 全新库只有迁移没有 seed：目录注册由本规格幂等保证，不依赖执行顺序
    await ensurePermissionCatalog(prisma);
    await cleanupUsers();
    snapshotGroups = await prisma.client.systemMenuGroup.findMany({ where: { systemCode: TEST_SYSTEM } });
    snapshotItems = await prisma.client.systemMenuItem.findMany({ where: { systemCode: TEST_SYSTEM } });
    superOp = await createUser({ name: `${TEST_NAME_PREFIX}超管`, isSuperAdmin: true });
    outsider = await createUser({ name: `${TEST_NAME_PREFIX}无权限` });
  });

  afterAll(async () => {
    // 恢复 TEST_SYSTEM 既有配置行，再清理测试账号及其操作日志
    await prisma.client.systemMenuItem.deleteMany({ where: { systemCode: TEST_SYSTEM } });
    await prisma.client.systemMenuGroup.deleteMany({ where: { systemCode: TEST_SYSTEM } });
    if (snapshotGroups.length > 0) {
      await prisma.client.systemMenuGroup.createMany({ data: snapshotGroups });
    }
    if (snapshotItems.length > 0) {
      await prisma.client.systemMenuItem.createMany({ data: snapshotItems });
    }
    await cleanupUsers();
    await prisma.client.$disconnect();
    await redis.quit();
  });

  async function cleanupUsers(): Promise<void> {
    const legacyUsers = await prisma.client.user.findMany({
      where: { phone: { startsWith: TEST_PHONE_PREFIX } },
      select: { id: true },
    });
    const userIds = legacyUsers.map((row) => row.id);
    if (userIds.length > 0) {
      await prisma.client.backstageOperationLog.deleteMany({ where: { operatorId: { in: userIds } } });
      await prisma.client.user.deleteMany({ where: { id: { in: userIds } } });
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
        passwordHash: 't33-menu-hash',
      },
    });
    return { id: user.id, name: user.name };
  }

  it('保存 → 读取回环；再次保存整树替换不累积', async () => {
    const first = await service.save(superOp.id, TEST_SYSTEM, dto({
      groups: [
        { nodeKey: '业务', sortOrder: 0, nameOverride: '核心业务' },
        { nodeKey: '业务/明细', parentKey: '业务', sortOrder: 0 },
      ],
      items: [
        { itemKey: 'projects', parentKey: '业务', sortOrder: 0 },
        { itemKey: 'profit', parentKey: '业务/明细', sortOrder: 0, nameOverride: '利润洞察' },
        { itemKey: 'config', sortOrder: 0 },
      ],
      idempotencyKey: `${KEY_PREFIX}save-1`,
    }));
    expect(first.groups).toHaveLength(2);
    expect(first.items).toHaveLength(3);

    const listed = await service.list(TEST_SYSTEM);
    expect(listed).toEqual(first);

    // 幂等重放：同键同体返回原结果，不重复写行
    const replayed = await service.save(superOp.id, TEST_SYSTEM, dto({
      groups: [
        { nodeKey: '业务', sortOrder: 0, nameOverride: '核心业务' },
        { nodeKey: '业务/明细', parentKey: '业务', sortOrder: 0 },
      ],
      items: [
        { itemKey: 'projects', parentKey: '业务', sortOrder: 0 },
        { itemKey: 'profit', parentKey: '业务/明细', sortOrder: 0, nameOverride: '利润洞察' },
        { itemKey: 'config', sortOrder: 0 },
      ],
      idempotencyKey: `${KEY_PREFIX}save-1`,
    }));
    expect(replayed).toEqual(first);
    expect(await prisma.client.systemMenuItem.count({ where: { systemCode: TEST_SYSTEM } })).toBe(3);

    // 同键不同体 → 409
    await expect(service.save(superOp.id, TEST_SYSTEM, dto({
      items: [{ itemKey: 'projects', sortOrder: 0 }],
      idempotencyKey: `${KEY_PREFIX}save-1`,
    }))).rejects.toMatchObject({ entry: { code: frameworkErrors.IDEMPOTENCY_KEY_REUSED.code } });

    // 再次保存：整树替换（只保留新载荷的 1 行）
    await service.save(superOp.id, TEST_SYSTEM, dto({
      items: [{ itemKey: 'projects', sortOrder: 0 }],
    }));
    expect(await prisma.client.systemMenuItem.count({ where: { systemCode: TEST_SYSTEM } })).toBe(1);
    expect(await prisma.client.systemMenuGroup.count({ where: { systemCode: TEST_SYSTEM } })).toBe(0);

    // 操作日志已落（save-1 行含幂等键与功能编码）
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}save-1` },
    });
    expect(log?.feature).toBe('finance_config');
    expect(log?.actionType).toBe('UPDATE');
    expect(log?.summary).toContain('菜单配置');
  });

  it('恢复默认：清空该系统配置行', async () => {
    await service.save(superOp.id, TEST_SYSTEM, dto({
      items: [{ itemKey: 'projects', sortOrder: 0 }],
    }));
    const result = await service.reset(superOp.id, TEST_SYSTEM, `${KEY_PREFIX}reset-1`);
    expect(result).toEqual({ groups: [], items: [] });
    expect(await prisma.client.systemMenuItem.count({ where: { systemCode: TEST_SYSTEM } })).toBe(0);

    // 恢复默认幂等重放：同键返回原结果
    const replayed = await service.reset(superOp.id, TEST_SYSTEM, `${KEY_PREFIX}reset-1`);
    expect(replayed).toEqual({ groups: [], items: [] });
  });

  it('鉴权：无配置功能授权的用户写操作 403；读取不受限', async () => {
    await expect(service.save(outsider.id, TEST_SYSTEM, dto({
      items: [{ itemKey: 'projects', sortOrder: 0 }],
    }))).rejects.toMatchObject({ entry: { code: frameworkErrors.FORBIDDEN.code } });
    await expect(service.reset(outsider.id, TEST_SYSTEM)).rejects.toMatchObject({
      entry: { code: frameworkErrors.FORBIDDEN.code },
    });
    await expect(service.list(TEST_SYSTEM)).resolves.toEqual({ groups: [], items: [] });
  });

  it('非法系统编码：读/写一律 404', async () => {
    await expect(service.list('UNKNOWN')).rejects.toMatchObject({
      entry: { code: frameworkErrors.RESOURCE_NOT_FOUND.code },
    });
    await expect(service.save(superOp.id, 'UNKNOWN', dto({}))).rejects.toMatchObject({
      entry: { code: frameworkErrors.RESOURCE_NOT_FOUND.code },
    });
  });
});
