import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { getRequestContext, REQUEST_CONTEXT_STORAGE, type RequestContext } from '@wbme/server';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { PrismaService } from '../../../prisma.service';
import { reconcilePermissionCatalog } from '../permission-catalog/permission-catalog.reconcile';
import { AuthorizationService } from '../permission/authorization.service';
import { FunctionPermissionGuard, REQUIRED_FUNCTION_KEY } from '../permission/function-permission.guard';
import { SystemStructureService } from './system-structure.service';

const DATABASE_URL = process.env.DATABASE_URL;

/** 测试数据统一前缀 */
const TEST_NAME_PREFIX = 'T38_';
const TEST_PHONE_PREFIX = '+8613938';
const KEY_PREFIX = 't38-';

/**
 * 系统与业务结构管理集成测试（backstage PRD §6；T3-7；真实 PostgreSQL）。
 * 覆盖：结构树查询、状态调整与守卫联动、backstage 恒开放不可调、
 * description 维护不递增 catalog_version 且对账不覆盖、越权 403。
 * 对真实系统（FIN）状态/说明的修改均在 finally 中还原。
 */
describe.skipIf(!DATABASE_URL)('系统与业务结构管理（T3-7）', () => {
  let prisma: PrismaService;
  let service: SystemStructureService;
  let authorization: AuthorizationService;
  let phoneSeq = 0;
  const testUserIds: number[] = [];

  let superOp: { id: number; name: string };
  let structureAdmin: { id: number; name: string };
  let plain: { id: number; name: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new SystemStructureService(prisma);
    authorization = new AuthorizationService(prisma);
    await cleanupLeftovers();
    superOp = await createUser({ name: `${TEST_NAME_PREFIX}超管`, isSuperAdmin: true });
    structureAdmin = await createUser({ name: `${TEST_NAME_PREFIX}结管` });
    await prisma.client.employeeGrant.create({
      data: { userId: structureAdmin.id, functionCode: 'system_structure_manage', dataScope: 'COMPANY', grantedBy: superOp.id },
    });
    plain = await createUser({ name: `${TEST_NAME_PREFIX}无权` });
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
      await prisma.client.backstageOperationLog.deleteMany({ where: { operatorId: { in: ids } } });
      await prisma.client.user.deleteMany({ where: { id: { in: ids } } });
    }
  }

  async function createUser(options: { name: string; isSuperAdmin?: boolean }): Promise<{ id: number; name: string }> {
    phoneSeq += 1;
    const user = await prisma.client.user.create({
      data: {
        name: options.name,
        gender: 'MALE',
        phone: `${TEST_PHONE_PREFIX}${String(phoneSeq).padStart(6, '0')}`,
        status: 'ACTIVE',
        isSuperAdmin: options.isSuperAdmin ?? false,
        passwordHash: 't38-hash',
      },
    });
    testUserIds.push(user.id);
    return { id: user.id, name: user.name };
  }

  async function catalogVersion(): Promise<number> {
    const meta = await prisma.client.permissionCatalogMeta.findUniqueOrThrow({ where: { id: 1 } });
    return meta.catalogVersion;
  }

  /** 以指定功能编码构造守卫并在请求上下文执行（T3-4 守卫链联动验证） */
  async function runGuard(functionCode: string, userId: number): Promise<boolean> {
    const handler = (): void => undefined;
    const context = { getHandler: () => handler, getClass: () => class {} } as never;
    const reflector = {
      get: (key: string, metaTarget: unknown) => (key === REQUIRED_FUNCTION_KEY && metaTarget === handler ? functionCode : undefined),
    } as unknown as Reflector;
    const guard = new FunctionPermissionGuard(reflector, authorization);
    return REQUEST_CONTEXT_STORAGE.run(
      { requestId: 'r', traceId: 't', startedAt: 0, service: 'test', userId } as RequestContext,
      () => guard.canActivate(context),
    );
  }

  it('结构树查询：四个系统按目录排序，板块/功能齐全，BACKSTAGE 恒 OPEN', async () => {
    const tree = await service.listStructure();
    expect(tree.systems.map((system) => system.code)).toEqual(['BACKSTAGE', 'ASSET', 'HR', 'FIN']);
    const backstage = tree.systems[0];
    expect(backstage?.productStatus).toBe('OPEN');
    expect(backstage?.sections).toHaveLength(4);
    expect(backstage?.sections.reduce((count, section) => count + section.functions.length, 0)).toBe(10);
    const fin = tree.systems.find((system) => system.code === 'FIN');
    expect(fin?.sections.map((section) => section.code)).toEqual(['contract-profit', 'config']);
    expect(fin?.sections[0]?.functions[0]).toMatchObject({ code: 'finance_view', name: '财务数据查看', sort: 0 });
  });

  it('状态调整：FIN 开放后守卫放行该系统功能（超管）；backstage 不可调；BASE 404；不递增目录版本', async () => {
    const fin = await prisma.client.system.findUniqueOrThrow({ where: { code: 'FIN' } });
    const originalStatus = fin.productStatus;
    const versionBefore = await catalogVersion();
    try {
      // COMING_SOON 时：超管也不进入（系统可用性先于功能权限）
      await prisma.client.system.update({ where: { id: fin.id }, data: { productStatus: 'COMING_SOON' } });
      await expect(runGuard('finance_view', superOp.id)).rejects.toMatchObject({ entry: { code: 'SYSTEM_NOT_OPEN' } });
      // 调整为 OPEN：守卫链通过系统可用性（超管豁免功能授权）
      const result = await service.updateSystemStatus(superOp.id, 'FIN', 'OPEN', `${KEY_PREFIX}status-1`);
      expect(result).toEqual({ ok: true });
      expect((await prisma.client.system.findUniqueOrThrow({ where: { code: 'FIN' } })).productStatus).toBe('OPEN');
      await expect(runGuard('finance_view', superOp.id)).resolves.toBe(true);
      const log = await prisma.client.backstageOperationLog.findFirst({
        where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}status-1` },
      });
      expect(log?.feature).toBe('system_structure_manage');
      expect(log?.summary).toContain('COMING_SOON → OPEN');
      // 幂等重放：同键返回原结果，日志不重复
      const replayed = await service.updateSystemStatus(superOp.id, 'FIN', 'OPEN', `${KEY_PREFIX}status-1`);
      expect(replayed).toEqual(result);
      expect(
        await prisma.client.backstageOperationLog.count({ where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}status-1` } }),
      ).toBe(1);
      // 状态调整不递增目录版本
      expect(await catalogVersion()).toBe(versionBefore);
    } finally {
      await prisma.client.system.update({ where: { id: fin.id }, data: { productStatus: originalStatus } });
    }
    // backstage 恒开放不可调；BASE 不在目录返回 404
    await expect(service.updateSystemStatus(superOp.id, 'BACKSTAGE', 'COMING_SOON')).rejects.toMatchObject({
      entry: { code: 'SYSTEM_STATUS_NOT_ADJUSTABLE' },
    });
    await expect(service.updateSystemStatus(superOp.id, 'BASE', 'OPEN')).rejects.toMatchObject({
      entry: { code: 'RESOURCE_NOT_FOUND' },
    });
  });

  it('description 维护：板块/功能说明更新持久化、不递增目录版本、启动对账不覆盖管理员维护值', async () => {
    const versionBefore = await catalogVersion();
    const finConfig = await prisma.client.businessSection.findFirstOrThrow({
      where: { code: 'config', system: { code: 'FIN' } },
    });
    const fnRow = await prisma.client.function.findUniqueOrThrow({ where: { code: 'finance_config' } });
    try {
      await service.updateSectionDescription(superOp.id, 'FIN', 'config', '财务配置板块说明（管理员维护）', `${KEY_PREFIX}sec-1`);
      await service.updateFunctionDescription(superOp.id, 'finance_config', '财务配置功能说明（管理员维护）', `${KEY_PREFIX}fn-1`);
      expect((await prisma.client.businessSection.findUniqueOrThrow({ where: { id: finConfig.id } })).description).toBe(
        '财务配置板块说明（管理员维护）',
      );
      expect((await prisma.client.function.findUniqueOrThrow({ where: { id: fnRow.id } })).description).toBe(
        '财务配置功能说明（管理员维护）',
      );
      // description 变化不改变授权语义：不递增目录版本（主 PRD §3.1）
      expect(await catalogVersion()).toBe(versionBefore);
      // 启动对账不覆盖管理员维护的 description（T3-1 分工）
      const report = await reconcilePermissionCatalog(prisma.client);
      expect(report.semanticChanged).toBe(false);
      expect((await prisma.client.function.findUniqueOrThrow({ where: { id: fnRow.id } })).description).toBe(
        '财务配置功能说明（管理员维护）',
      );
      expect(await catalogVersion()).toBe(versionBefore);
      // 清除为 NULL
      await service.updateFunctionDescription(superOp.id, 'finance_config', '   ');
      expect((await prisma.client.function.findUniqueOrThrow({ where: { id: fnRow.id } })).description).toBeNull();
    } finally {
      await prisma.client.businessSection.update({ where: { id: finConfig.id }, data: { description: finConfig.description } });
      await prisma.client.function.update({ where: { id: fnRow.id }, data: { description: fnRow.description } });
    }
    await expect(service.updateSectionDescription(superOp.id, 'FIN', 'ghost', 'x')).rejects.toMatchObject({
      entry: { code: 'RESOURCE_NOT_FOUND' },
    });
    await expect(service.updateFunctionDescription(superOp.id, 'ghost_function', 'x')).rejects.toMatchObject({
      entry: { code: 'RESOURCE_NOT_FOUND' },
    });
  });

  it('越权：无"系统与业务结构管理"授权 403；持有者放行', async () => {
    await expect(runGuard('system_structure_manage', plain.id)).rejects.toMatchObject({ entry: { code: 'FORBIDDEN' } });
    await expect(runGuard('system_structure_manage', structureAdmin.id)).resolves.toBe(true);
    expect(getRequestContext()?.grantedFunction).toBeUndefined();
  });
});
