import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { PrismaService } from '../../../prisma.service';
import { ensurePermissionCatalog } from '../../../test-support/ensure-permission-catalog';
import { ApprovalCenterService } from '../approval-proxy/approval-center.service';
import { PendingBadgeClient } from './pending-badge.client';
import { PortalService } from './portal.service';

const DATABASE_URL = process.env.DATABASE_URL;

/** 测试数据统一前缀 */
const TEST_NAME_PREFIX = 'T34_';
const TEST_PHONE_PREFIX = '+8613934';

/**
 * 门户入口推导集成测试（base PRD §5、主 PRD §3.1；T3-4 核对真实授权接线）。
 *
 * 入口可见 = 拥有该系统至少一项**有效**授权（目录中仍注册的功能）；超管视为拥有全部；
 * product_status 透传（入口可见 ≠ 可进入，未开放系统由前端展示状态、守卫拦截）。
 */
describe.skipIf(!DATABASE_URL)('门户入口推导（T3-4 真实授权核对）', () => {
  let prisma: PrismaService;
  let portal: PortalService;
  let phoneSeq = 0;
  const testUserIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    const approvalCenter = new ApprovalCenterService(prisma);
    // 门户角标远程依赖注入空客户端（本规格不测 hr/asset 联调）
    const pendingBadge = new PendingBadgeClient(null, null);
    portal = new PortalService(prisma, approvalCenter, pendingBadge);
    // CI 全新库只有迁移没有 seed：目录注册由本规格幂等保证，不依赖执行顺序
    await ensurePermissionCatalog(prisma);
    await cleanupLeftovers();
  });

  afterAll(async () => {
    await cleanupLeftovers();
    await prisma.client.$disconnect();
  });

  async function cleanupLeftovers(): Promise<void> {
    const legacy = await prisma.client.user.findMany({
      where: { phone: { startsWith: TEST_PHONE_PREFIX } },
      select: { id: true },
    });
    const ids = legacy.map((row) => row.id);
    if (ids.length > 0) {
      await prisma.client.employeeGrant.deleteMany({ where: { OR: [{ userId: { in: ids } }, { grantedBy: { in: ids } }] } });
      await prisma.client.user.deleteMany({ where: { id: { in: ids } } });
    }
  }

  async function createUser(options: { name: string; isSuperAdmin?: boolean }): Promise<{ id: number }> {
    phoneSeq += 1;
    const user = await prisma.client.user.create({
      data: {
        name: options.name,
        gender: 'MALE',
        phone: `${TEST_PHONE_PREFIX}${String(phoneSeq).padStart(6, '0')}`,
        status: 'ACTIVE',
        isSuperAdmin: options.isSuperAdmin ?? false,
        passwordHash: 't34-hash',
      },
    });
    testUserIds.push(user.id);
    return { id: user.id };
  }

  it('拥有某系统有效授权才可见该系统入口；撤销后入口消失；目录外授权不产生入口', async () => {
    const user = await createUser({ name: `${TEST_NAME_PREFIX}入口` });
    const operator = await createUser({ name: `${TEST_NAME_PREFIX}操作` });

    // 无授权：所有入口不可见
    const empty = await portal.getPortal(user.id, false);
    expect(empty.systems.every((system) => !system.hasPermission)).toBe(true);

    // 目录外（已移除功能）授权行：不生效、不产生入口
    await prisma.client.employeeGrant.create({
      data: { userId: user.id, functionCode: 'ghost_function', dataScope: 'COMPANY', grantedBy: operator.id },
    });
    const ghost = await portal.getPortal(user.id, false);
    expect(ghost.systems.every((system) => !system.hasPermission)).toBe(true);

    // 授予 ASSET 功能：仅 ASSET 入口可见，productStatus 透传数据库当前值
    // （入口可见 ≠ 可进入，未开放系统由前端展示状态、守卫拦截；不绑定具体状态值，
    //   避免与并发修改系统状态的集成测试互相踩踏）
    await prisma.client.employeeGrant.create({
      data: { userId: user.id, functionCode: 'my_assets', dataScope: 'SELF', grantedBy: operator.id },
    });
    const assetStatusRows = await prisma.client.$queryRaw<Array<{ product_status: string }>>`
      SELECT product_status::text AS product_status
      FROM backstage.systems
      WHERE code = 'ASSET'
      LIMIT 1
    `;
    const granted = await portal.getPortal(user.id, false);
    const asset = granted.systems.find((system) => system.code === 'ASSET');
    expect(asset).toMatchObject({
      hasPermission: true,
      productStatus: assetStatusRows[0]?.product_status ?? 'COMING_SOON',
    });
    expect(granted.systems.find((system) => system.code === 'HR')?.hasPermission).toBe(false);
    expect(granted.systems.find((system) => system.code === 'BACKSTAGE')?.hasPermission).toBe(false);

    // 撤销最后一个 ASSET 功能：入口立即消失（实时读取授权，无缓存窗口）
    await prisma.client.employeeGrant.deleteMany({ where: { userId: user.id, functionCode: 'my_assets' } });
    const revoked = await portal.getPortal(user.id, false);
    expect(revoked.systems.find((system) => system.code === 'ASSET')?.hasPermission).toBe(false);
  });

  it('超级管理员视为拥有全部系统入口', async () => {
    const superAdmin = await createUser({ name: `${TEST_NAME_PREFIX}超管`, isSuperAdmin: true });
    const result = await portal.getPortal(superAdmin.id, true);
    expect(result.systems.length).toBeGreaterThanOrEqual(4);
    expect(result.systems.every((system) => system.hasPermission)).toBe(true);
    expect(result.systems.find((system) => system.code === 'BACKSTAGE')?.productStatus).toBe('OPEN');
  });
});
