import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import {
  PERMISSION_CATALOG,
  type CatalogFunctionDefinition,
  type CatalogSectionDefinition,
  type CatalogSystemDefinition,
} from '@wbme/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import { reconcilePermissionCatalog } from './permission-catalog.reconcile';

const DATABASE_URL = process.env.DATABASE_URL;

/** 测试功能编码前缀（真实目录不使用，便于隔离与清理） */
const TEST_FUNCTION_PREFIX = 'test_reconcile_';
/** 测试板块编码前缀（真实目录不使用） */
const TEST_SECTION_PREFIX = 'test-';
/** 测试专用系统编码（验证「系统不删除」规则） */
const TEST_SYSTEM_CODE = 'TEST_SYS';
/** 测试授权行使用的伪用户 id（employee_grants 不建外键，仅验证历史行保留语义） */
const TEST_GRANT_USER_ID = 2000000001;

/** 构造测试功能定义（默认值可被 overrides 覆盖） */
function testFunction(overrides: Partial<CatalogFunctionDefinition> & { code: string }): CatalogFunctionDefinition {
  return { name: '对账测试功能', description: '对账测试功能说明', dataScopeOptions: ['COMPANY'], ...overrides };
}

/** 构造测试板块定义 */
function testSection(code: string, functions: readonly CatalogFunctionDefinition[]): CatalogSectionDefinition {
  return { code, name: '对账测试板块', description: '对账测试板块说明', functions };
}

/**
 * 构造测试目录：真实目录基础上在 FIN 系统末尾追加测试板块（不修改共享常量）。
 * 测试板块/功能始终挂在真实系统下且使用 test 前缀编码，对账只增删测试行，
 * 不触碰真实目录行（真实行全部在目录中，对账对它们是幂等空操作）。
 */
function catalogWithTestSections(...sections: CatalogSectionDefinition[]): readonly CatalogSystemDefinition[] {
  return PERMISSION_CATALOG.map((system) =>
    system.code === 'FIN' ? { ...system, sections: [...system.sections, ...sections] } : system,
  );
}

/**
 * 权限目录启动对账集成测试（实现规划 T3-1、主 PRD §3.1；真实 PostgreSQL，测试数据即建即清）。
 *
 * 每个用例先对账回真实目录作为基线（幂等，顺带清理上一个用例的测试行），
 * 再以「真实目录 + 测试板块/功能」的变体目录触发对账，全部断言相对基线版本。
 */
describe.skipIf(!DATABASE_URL)('权限目录启动对账（T3-1 幂等/版本/事务）', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await resetToRealCatalog();
  });

  afterAll(async () => {
    // 清理测试数据：对账回真实目录移除测试功能/板块，测试授权行与测试系统直接删除
    await resetToRealCatalog();
    await prisma.client.employeeGrant.deleteMany({ where: { functionCode: { startsWith: TEST_FUNCTION_PREFIX } } });
    await prisma.client.businessSection.deleteMany({ where: { code: { startsWith: TEST_SECTION_PREFIX } } });
    await prisma.client.system.deleteMany({ where: { code: TEST_SYSTEM_CODE } });
    const leftoverFunctions = await prisma.client.function.count({ where: { code: { startsWith: TEST_FUNCTION_PREFIX } } });
    const leftoverSections = await prisma.client.businessSection.count({ where: { code: { startsWith: TEST_SECTION_PREFIX } } });
    expect(leftoverFunctions).toBe(0);
    expect(leftoverSections).toBe(0);
    await prisma.client.$disconnect();
  });

  /** 基线重置：对账回真实目录（移除本规格遗留的测试功能/板块，幂等） */
  async function resetToRealCatalog(): Promise<void> {
    await reconcilePermissionCatalog(prisma.client);
  }

  /** 读取当前全局权限目录版本（S-4 单行） */
  async function catalogVersion(): Promise<number> {
    const meta = await prisma.client.permissionCatalogMeta.findUniqueOrThrow({ where: { id: 1 } });
    return meta.catalogVersion;
  }

  it('首次注册：按代码目录创建板块/功能（含 description 初值与排序）并递增目录版本', async () => {
    await resetToRealCatalog();
    const before = await catalogVersion();
    const report = await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(testSection('test-register', [testFunction({ code: 'test_reconcile_register' })])),
    );
    expect(report.systemsCreated).toBe(0);
    expect(report.sectionsCreated).toBe(1);
    expect(report.functionsCreated).toBe(1);
    expect(report.semanticChanged).toBe(true);
    expect(report.catalogVersion).toBe(before + 1);

    const fin = await prisma.client.system.findUniqueOrThrow({ where: { code: 'FIN' } });
    const section = await prisma.client.businessSection.findUniqueOrThrow({
      where: { systemId_code: { systemId: fin.id, code: 'test-register' } },
    });
    expect(section.name).toBe('对账测试板块');
    expect(section.description).toBe('对账测试板块说明');
    expect(section.sort).toBe(2); // FIN 两个真实板块之后
    const row = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_register' } });
    expect(row.systemId).toBe(fin.id);
    expect(row.sectionId).toBe(section.id);
    expect(row.name).toBe('对账测试功能');
    expect(row.description).toBe('对账测试功能说明');
    expect(row.dataScopeOptions).toEqual(['COMPANY']);
    expect(row.sort).toBe(0);
  });

  it('无变化幂等：不递增版本、不产生写入（行 updatedAt 不变）', async () => {
    const catalog = catalogWithTestSections(
      testSection('test-idle', [testFunction({ code: 'test_reconcile_idle_a' }), testFunction({ code: 'test_reconcile_idle_b' })]),
    );
    await reconcilePermissionCatalog(prisma.client, catalog);
    const before = await catalogVersion();
    const rowBefore = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_idle_a' } });
    const finBefore = await prisma.client.system.findUniqueOrThrow({ where: { code: 'FIN' } });

    const report = await reconcilePermissionCatalog(prisma.client, catalog);
    expect(report).toMatchObject({
      systemsCreated: 0,
      systemsUpdated: 0,
      sectionsCreated: 0,
      sectionsUpdated: 0,
      sectionsRemoved: 0,
      functionsCreated: 0,
      functionsUpdated: 0,
      functionsRemoved: 0,
      semanticChanged: false,
      catalogVersion: before,
    });
    expect(await catalogVersion()).toBe(before);
    // 不产生写入：@updatedAt 字段在任何 update 时都会变化，不变即无写入
    const rowAfter = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_idle_a' } });
    const finAfter = await prisma.client.system.findUniqueOrThrow({ where: { code: 'FIN' } });
    expect(rowAfter.updatedAt.getTime()).toBe(rowBefore.updatedAt.getTime());
    expect(finAfter.updatedAt.getTime()).toBe(finBefore.updatedAt.getTime());
  });

  it('新增功能：创建行并递增版本', async () => {
    await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(testSection('test-add', [testFunction({ code: 'test_reconcile_add_a' })])),
    );
    const before = await catalogVersion();
    const report = await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(
        testSection('test-add', [
          testFunction({ code: 'test_reconcile_add_a' }),
          testFunction({ code: 'test_reconcile_add_b', description: '新增功能说明' }),
        ]),
      ),
    );
    expect(report.functionsCreated).toBe(1);
    expect(report.semanticChanged).toBe(true);
    expect(report.catalogVersion).toBe(before + 1);
    const row = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_add_b' } });
    expect(row.description).toBe('新增功能说明');
    expect(row.sort).toBe(1);
  });

  it('移除功能：物理删除功能行并递增版本，历史授权行保留为审计数据', async () => {
    await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(
        testSection('test-remove', [testFunction({ code: 'test_reconcile_remove_a' }), testFunction({ code: 'test_reconcile_remove_b' })]),
      ),
    );
    // 历史授权行（审计）：功能移除后保留但不得继续生效（生效判断以目录存在为准，主 PRD §3.1）
    await prisma.client.employeeGrant.create({
      data: { userId: TEST_GRANT_USER_ID, functionCode: 'test_reconcile_remove_b', dataScope: 'COMPANY', grantedBy: TEST_GRANT_USER_ID },
    });
    const before = await catalogVersion();
    const report = await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(testSection('test-remove', [testFunction({ code: 'test_reconcile_remove_a' })])),
    );
    expect(report.functionsRemoved).toBe(1);
    expect(report.semanticChanged).toBe(true);
    expect(report.catalogVersion).toBe(before + 1);
    expect(await prisma.client.function.findUnique({ where: { code: 'test_reconcile_remove_b' } })).toBeNull();
    const grant = await prisma.client.employeeGrant.findFirst({
      where: { userId: TEST_GRANT_USER_ID, functionCode: 'test_reconcile_remove_b' },
    });
    expect(grant).not.toBeNull();
    await prisma.client.employeeGrant.deleteMany({ where: { functionCode: 'test_reconcile_remove_b' } });
  });

  it('可选数据范围变化：更新档位并递增版本', async () => {
    await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(testSection('test-scope', [testFunction({ code: 'test_reconcile_scope' })])),
    );
    const before = await catalogVersion();
    const report = await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(
        testSection('test-scope', [testFunction({ code: 'test_reconcile_scope', dataScopeOptions: ['DEPARTMENT', 'COMPANY'] })]),
      ),
    );
    expect(report.functionsUpdated).toBe(1);
    expect(report.semanticChanged).toBe(true);
    expect(report.catalogVersion).toBe(before + 1);
    const row = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_scope' } });
    expect(row.dataScopeOptions).toEqual(['DEPARTMENT', 'COMPANY']);
  });

  it('板块归属变化：功能划入新板块并递增版本', async () => {
    await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(
        testSection('test-move-from', [testFunction({ code: 'test_reconcile_move' })]),
        testSection('test-move-to', []),
      ),
    );
    const before = await catalogVersion();
    const report = await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(
        testSection('test-move-from', []),
        testSection('test-move-to', [testFunction({ code: 'test_reconcile_move' })]),
      ),
    );
    expect(report.functionsUpdated).toBe(1);
    expect(report.semanticChanged).toBe(true);
    expect(report.catalogVersion).toBe(before + 1);
    const fin = await prisma.client.system.findUniqueOrThrow({ where: { code: 'FIN' } });
    const target = await prisma.client.businessSection.findUniqueOrThrow({
      where: { systemId_code: { systemId: fin.id, code: 'test-move-to' } },
    });
    const row = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_move' } });
    expect(row.sectionId).toBe(target.id);
  });

  it('description 变化：不覆盖已入库说明、不递增版本（管理员可在界面维护，主 PRD §3.1）', async () => {
    await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(
        testSection('test-desc', [testFunction({ code: 'test_reconcile_desc', description: '初始说明' })]),
      ),
    );
    const before = await catalogVersion();
    const report = await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(
        testSection('test-desc', [testFunction({ code: 'test_reconcile_desc', description: '代码侧已改写说明' })]),
      ),
    );
    expect(report.functionsUpdated).toBe(0);
    expect(report.semanticChanged).toBe(false);
    expect(report.catalogVersion).toBe(before);
    const row = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_desc' } });
    expect(row.description).toBe('初始说明');
  });

  it('名称/排序纯展示变化：修正行但不递增版本（主 PRD §3.1）', async () => {
    await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(
        testSection('test-display', [
          testFunction({ code: 'test_reconcile_display_a', name: '展示名称甲' }),
          testFunction({ code: 'test_reconcile_display_b' }),
        ]),
      ),
    );
    const before = await catalogVersion();
    // 名称变化 + 两功能排序互换（数组顺序即排序）
    const report = await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(
        testSection('test-display', [
          testFunction({ code: 'test_reconcile_display_b' }),
          testFunction({ code: 'test_reconcile_display_a', name: '展示名称丙' }),
        ]),
      ),
    );
    expect(report.functionsUpdated).toBe(2);
    expect(report.semanticChanged).toBe(false);
    expect(report.catalogVersion).toBe(before);
    const renamed = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_display_a' } });
    expect(renamed.name).toBe('展示名称丙');
    expect(renamed.sort).toBe(1);
    const moved = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_display_b' } });
    expect(moved.sort).toBe(0);
  });

  it('系统只注册不删除，product_status 由管理员维护、对账不覆盖（backstage PRD §6）', async () => {
    await resetToRealCatalog();
    // product_status 界面维护值不被对账重置
    const fin = await prisma.client.system.findUniqueOrThrow({ where: { code: 'FIN' } });
    await prisma.client.system.update({ where: { id: fin.id }, data: { productStatus: fin.productStatus === 'OPEN' ? 'COMING_SOON' : 'OPEN' } });
    const flipped = await prisma.client.system.findUniqueOrThrow({ where: { code: 'FIN' } });
    try {
      const before = await catalogVersion();
      const report = await reconcilePermissionCatalog(prisma.client);
      expect(report.semanticChanged).toBe(false);
      expect(report.catalogVersion).toBe(before);
      const after = await prisma.client.system.findUniqueOrThrow({ where: { code: 'FIN' } });
      expect(after.productStatus).toBe(flipped.productStatus);
    } finally {
      await prisma.client.system.update({ where: { id: fin.id }, data: { productStatus: fin.productStatus } });
    }

    // 代码目录外的系统行不被删除（系统由代码注册，只调整状态，表设计 S-1）
    await prisma.client.system.deleteMany({ where: { code: TEST_SYSTEM_CODE } });
    await prisma.client.system.create({ data: { code: TEST_SYSTEM_CODE, name: '对账测试系统', sort: 99 } });
    try {
      await reconcilePermissionCatalog(prisma.client);
      expect(await prisma.client.system.findUnique({ where: { code: TEST_SYSTEM_CODE } })).not.toBeNull();
    } finally {
      await prisma.client.system.deleteMany({ where: { code: TEST_SYSTEM_CODE } });
    }
  });

  it('事务性：版本递增失败时目录变更整体回滚（无部分写入）', async () => {
    await reconcilePermissionCatalog(
      prisma.client,
      catalogWithTestSections(testSection('test-tx', [testFunction({ code: 'test_reconcile_tx_a', name: '事务前名称' })])),
    );
    const before = await catalogVersion();
    // 目录变更 = 功能改名（展示）+ 新增功能（语义）；注入故障点 = 事务末尾的版本递增
    const failing = clientFailingOnVersionBump(prisma.client);
    await expect(
      reconcilePermissionCatalog(
        failing,
        catalogWithTestSections(
          testSection('test-tx', [
            testFunction({ code: 'test_reconcile_tx_a', name: '事务后名称' }),
            testFunction({ code: 'test_reconcile_tx_b' }),
          ]),
        ),
      ),
    ).rejects.toThrow('注入故障');
    // 整体回滚：新增功能不存在、改名未生效、版本未递增
    expect(await prisma.client.function.findUnique({ where: { code: 'test_reconcile_tx_b' } })).toBeNull();
    const row = await prisma.client.function.findUniqueOrThrow({ where: { code: 'test_reconcile_tx_a' } });
    expect(row.name).toBe('事务前名称');
    expect(await catalogVersion()).toBe(before);
  });
});

/**
 * 构造一个 Prisma 客户端包装：真实事务内仅在「递增目录版本」时抛出注入故障，
 * 用于验证对账事务失败时整体回滚（之前的目录写入一并撤销）。
 *
 * @param client 真实 Prisma 客户端
 * @returns 代理客户端（仅 $transaction 行为不同：回调内 permissionCatalogMeta.update 必失败）
 */
function clientFailingOnVersionBump(client: PrismaClient): PrismaClient {
  const transaction = client.$transaction.bind(client) as (
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>;
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== '$transaction') {
        return Reflect.get(target, property, receiver) as unknown;
      }
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        transaction((tx) => {
          const patchedTx = new Proxy(tx, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty !== 'permissionCatalogMeta') {
                return Reflect.get(txTarget, txProperty, txReceiver) as unknown;
              }
              const delegate = Reflect.get(txTarget, txProperty, txReceiver) as object;
              return new Proxy(delegate, {
                get(metaTarget, metaProperty, metaReceiver) {
                  if (metaProperty === 'update') {
                    return (): Promise<never> => Promise.reject(new Error('注入故障：目录版本递增失败'));
                  }
                  return Reflect.get(metaTarget, metaProperty, metaReceiver);
                },
              });
            },
          });
          return callback(patchedTx);
        });
    },
  });
}
