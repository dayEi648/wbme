/**
 * 权限目录启动对账核心逻辑（实现规划 T3-1、主 PRD §3.1、backstage PRD §1）。
 *
 * 以稳定功能编码把代码目录（@wbme/contracts 的 PERMISSION_CATALOG）与数据库注册表
 * （S-1 systems / S-2 business_sections / S-3 functions）幂等对账，全部变更与
 * 全局权限目录版本（S-4 permission_catalog_meta.catalog_version）递增在同一事务内完成。
 *
 * 对账规则（主 PRD §3.1、表设计 backstage.md §1）：
 * - 系统：由代码注册，只注册/修正名称与排序，**不删除**；product_status 仅首次注册
 *   取代码初始值，之后由管理员在界面维护（backstage PRD §6），对账不覆盖；
 * - 板块：归属/名称/排序由代码定义；description 初值来自代码，管理员可维护，对账不覆盖；
 *   代码目录移除且已不承载任何功能的板块属目录漂移，物理删除；
 * - 功能：新增=按代码目录插入（description 取代码初值）；移除=物理删除行，
 *   历史 employee_grants 授权行保留为审计数据，但生效判断以目录中存在为准（主 PRD §3.1）；
 *   名称/排序漂移按代码修正；description 不覆盖（管理员可维护）；
 * - 版本：仅「功能新增/移除、系统/板块归属变化、可选数据范围变化」递增 catalog_version；
 *   名称/排序等纯展示变化与 description 变化不改变授权语义，不递增版本；
 *   无任何变化时不产生任何写入（幂等：重复启动不递增版本、不更新行）。
 *
 * 缓存失效联动（base PRD §3）：守卫的 Redis 授权上下文快照包含
 * 「账号授权版本 users.permission_version + 权限目录版本 catalog_version +
 * 用户组织版本 + 组织树版本」，四项均一致才复用缓存。授权缓存由 T3-4 守卫实现；
 * 本对账只需在目录语义变化时递增 catalog_version，旧授权缓存即自然失效，
 * **不需要**联动递增 users.permission_version（该版本只随 T3-2 员工授权事务递增）。
 */
import { PERMISSION_CATALOG, type CatalogSystemDefinition } from '@wbme/contracts';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client';

/** 对账事务客户端（交互式事务） */
type ReconcileTx = Prisma.TransactionClient;

/** 权限目录版本单行 id（S-4 CHECK id = 1） */
const CATALOG_META_ID = 1;

/** 对账结果报告（启动日志与种子输出使用） */
export interface PermissionCatalogReconcileReport {
  /** 新注册系统数 */
  systemsCreated: number;
  /** 名称/排序修正的系统数（不含 product_status，该字段对账不触碰） */
  systemsUpdated: number;
  /** 新注册板块数 */
  sectionsCreated: number;
  /** 名称/排序修正的板块数（不含 description） */
  sectionsUpdated: number;
  /** 物理删除的空壳板块数（代码目录已移除且不再承载功能） */
  sectionsRemoved: number;
  /** 新增功能数 */
  functionsCreated: number;
  /** 修正功能数（名称/排序/归属/可选范围；不含 description） */
  functionsUpdated: number;
  /** 物理删除功能数（代码目录已移除） */
  functionsRemoved: number;
  /** 本次是否发生目录语义变化（功能新增/移除/归属/可选范围），决定版本是否递增 */
  semanticChanged: boolean;
  /** 对账后的全局权限目录版本 */
  catalogVersion: number;
}

/**
 * 比较数据库已存可选数据范围与代码定义是否一致（顺序敏感：代码目录是唯一来源，
 * 顺序不一致同样视为漂移并修正）。
 *
 * @param dbOptions 数据库 functions.data_scope_options 当前值
 * @param definedOptions 代码目录定义值
 * @returns 完全一致返回 true
 */
function sameScopeOptions(dbOptions: string[], definedOptions: readonly string[]): boolean {
  return dbOptions.length === definedOptions.length && dbOptions.every((value, index) => value === definedOptions[index]);
}

/**
 * 确保权限目录版本单行存在并施加行锁（序列化并发对账，保证版本只按批递增）。
 *
 * @param tx 对账事务
 */
async function lockCatalogMeta(tx: ReconcileTx): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO backstage.permission_catalog_meta (id, catalog_version, updated_at)
    VALUES (${CATALOG_META_ID}, 0, now())
    ON CONFLICT (id) DO NOTHING
  `;
  await tx.$queryRaw`
    SELECT id FROM backstage.permission_catalog_meta WHERE id = ${CATALOG_META_ID} FOR UPDATE
  `;
}

/**
 * 对账系统层：代码注册缺失系统、修正名称/排序漂移；不删除系统、不触碰 product_status。
 *
 * @param tx 对账事务
 * @param catalog 代码目录
 * @param report 对账报告（就地累计）
 * @returns 系统编码 → 系统行 id
 */
async function reconcileSystems(
  tx: ReconcileTx,
  catalog: readonly CatalogSystemDefinition[],
  report: PermissionCatalogReconcileReport,
): Promise<Map<string, number>> {
  const dbSystems = await tx.system.findMany();
  const systemByCode = new Map(dbSystems.map((row) => [row.code, row]));
  const systemIds = new Map<string, number>();
  for (const [systemSort, definition] of catalog.entries()) {
    const existing = systemByCode.get(definition.code);
    if (!existing) {
      const created = await tx.system.create({
        data: {
          code: definition.code,
          name: definition.name,
          productStatus: definition.productStatus,
          sort: systemSort,
        },
      });
      report.systemsCreated += 1;
      systemIds.set(definition.code, created.id);
      continue;
    }
    if (existing.name !== definition.name || existing.sort !== systemSort) {
      await tx.system.update({ where: { id: existing.id }, data: { name: definition.name, sort: systemSort } });
      report.systemsUpdated += 1;
    }
    systemIds.set(definition.code, existing.id);
  }
  return systemIds;
}

/**
 * 对账板块层：按 (system_id, code) 注册/修正板块；description 仅初始注册写入。
 *
 * @param tx 对账事务
 * @param catalog 代码目录
 * @param systemIds 系统编码 → 系统行 id（reconcileSystems 产物）
 * @param report 对账报告（就地累计）
 * @returns 板块键（`${systemCode}:${sectionCode}`）→ 板块行 id
 */
async function reconcileSections(
  tx: ReconcileTx,
  catalog: readonly CatalogSystemDefinition[],
  systemIds: Map<string, number>,
  report: PermissionCatalogReconcileReport,
): Promise<Map<string, number>> {
  const dbSections = await tx.businessSection.findMany();
  const sectionByKey = new Map(dbSections.map((row) => [`${row.systemId}:${row.code}`, row]));
  const sectionIds = new Map<string, number>();
  for (const definition of catalog) {
    const systemId = systemIds.get(definition.code);
    if (systemId === undefined) {
      throw new Error(`权限目录对账内部错误：系统 ${definition.code} 未注册`);
    }
    for (const [sectionSort, section] of definition.sections.entries()) {
      const existing = sectionByKey.get(`${systemId}:${section.code}`);
      if (!existing) {
        const created = await tx.businessSection.create({
          data: {
            systemId,
            code: section.code,
            name: section.name,
            description: section.description ?? null,
            sort: sectionSort,
          },
        });
        report.sectionsCreated += 1;
        sectionIds.set(`${definition.code}:${section.code}`, created.id);
        continue;
      }
      if (existing.name !== section.name || existing.sort !== sectionSort) {
        await tx.businessSection.update({ where: { id: existing.id }, data: { name: section.name, sort: sectionSort } });
        report.sectionsUpdated += 1;
      }
      sectionIds.set(`${definition.code}:${section.code}`, existing.id);
    }
  }
  return sectionIds;
}

/**
 * 对账功能层：新增/修正/物理删除功能；description 仅初始注册写入、对账不覆盖。
 *
 * @param tx 对账事务
 * @param catalog 代码目录
 * @param systemIds 系统编码 → 系统行 id
 * @param sectionIds 板块键 → 板块行 id
 * @param report 对账报告（就地累计；语义变化置 semanticChanged）
 */
async function reconcileFunctions(
  tx: ReconcileTx,
  catalog: readonly CatalogSystemDefinition[],
  systemIds: Map<string, number>,
  sectionIds: Map<string, number>,
  report: PermissionCatalogReconcileReport,
): Promise<void> {
  const dbFunctions = await tx.function.findMany();
  const functionByCode = new Map(dbFunctions.map((row) => [row.code, row]));
  const keptCodes = new Set<string>();
  for (const definition of catalog) {
    const systemId = systemIds.get(definition.code);
    if (systemId === undefined) {
      throw new Error(`权限目录对账内部错误：系统 ${definition.code} 未注册`);
    }
    for (const section of definition.sections) {
      const sectionId = sectionIds.get(`${definition.code}:${section.code}`);
      if (sectionId === undefined) {
        throw new Error(`权限目录对账内部错误：板块 ${definition.code}:${section.code} 未注册`);
      }
      for (const [functionSort, fn] of section.functions.entries()) {
        keptCodes.add(fn.code);
        const existing = functionByCode.get(fn.code);
        if (!existing) {
          await tx.function.create({
            data: {
              systemId,
              sectionId,
              code: fn.code,
              name: fn.name,
              dataScopeOptions: [...fn.dataScopeOptions],
              sort: functionSort,
              description: fn.description,
            },
          });
          report.functionsCreated += 1;
          report.semanticChanged = true;
          continue;
        }
        // 归属或可选范围变化改变授权语义（递增版本）；名称/排序为纯展示修正（不递增版本）
        const semanticChanged =
          existing.systemId !== systemId ||
          existing.sectionId !== sectionId ||
          !sameScopeOptions(existing.dataScopeOptions, fn.dataScopeOptions);
        const displayChanged = existing.name !== fn.name || existing.sort !== functionSort;
        if (semanticChanged || displayChanged) {
          await tx.function.update({
            where: { id: existing.id },
            data: {
              systemId,
              sectionId,
              name: fn.name,
              dataScopeOptions: [...fn.dataScopeOptions],
              sort: functionSort,
            },
          });
          report.functionsUpdated += 1;
          report.semanticChanged = report.semanticChanged || semanticChanged;
        }
      }
    }
  }
  // 移除：代码目录已不存在的功能物理删除（历史授权行保留为审计，生效判断以目录存在为准）
  for (const row of dbFunctions) {
    if (!keptCodes.has(row.code)) {
      await tx.function.delete({ where: { id: row.id } });
      report.functionsRemoved += 1;
      report.semanticChanged = true;
    }
  }
}

/**
 * 清理空壳板块：代码目录已移除且不再承载任何功能的板块属目录漂移，物理删除。
 * 板块变化本身不改变授权语义（功能已先行对账），不递增版本。
 *
 * @param tx 对账事务
 * @param catalog 代码目录
 * @param report 对账报告（就地累计）
 */
async function removeStaleSections(
  tx: ReconcileTx,
  catalog: readonly CatalogSystemDefinition[],
  report: PermissionCatalogReconcileReport,
): Promise<void> {
  const dbSections = await tx.businessSection.findMany({ include: { system: { select: { code: true } } } });
  const definedKeys = new Set(
    catalog.flatMap((definition) => definition.sections.map((section) => `${definition.code}:${section.code}`)),
  );
  for (const row of dbSections) {
    if (definedKeys.has(`${row.system.code}:${row.code}`)) {
      continue;
    }
    // 仅删除已无功能的空壳板块；仍承载功能的异常状态保留，避免误删（功能对账已保证不会发生）
    const removed = await tx.businessSection.deleteMany({ where: { id: row.id, functions: { none: {} } } });
    report.sectionsRemoved += removed.count;
  }
}

/**
 * 权限目录幂等对账：把代码目录与数据库注册表对齐，必要时在同一事务递增目录版本。
 *
 * 供 platform-core 启动钩子（PermissionCatalogService）与种子脚本（prisma/seed.ts）共用；
 * 全过程单事务：任一步骤失败整体回滚，不产生半对账状态。
 *
 * @param prisma platform-core Prisma 客户端（base + backstage 同一 Client）
 * @param catalog 代码目录定义，默认全平台权威目录 PERMISSION_CATALOG（测试可注入变体）
 * @returns 对账结果报告（变更计数、是否语义变化、对账后目录版本）
 * @throws 数据库不可用或约束冲突时抛出底层异常（调用方应使启动/种子失败）
 */
export async function reconcilePermissionCatalog(
  prisma: PrismaClient,
  catalog: readonly CatalogSystemDefinition[] = PERMISSION_CATALOG,
): Promise<PermissionCatalogReconcileReport> {
  return prisma.$transaction(async (tx) => {
    await lockCatalogMeta(tx);
    const report: PermissionCatalogReconcileReport = {
      systemsCreated: 0,
      systemsUpdated: 0,
      sectionsCreated: 0,
      sectionsUpdated: 0,
      sectionsRemoved: 0,
      functionsCreated: 0,
      functionsUpdated: 0,
      functionsRemoved: 0,
      semanticChanged: false,
      catalogVersion: 0,
    };
    const systemIds = await reconcileSystems(tx, catalog, report);
    const sectionIds = await reconcileSections(tx, catalog, systemIds, report);
    await reconcileFunctions(tx, catalog, systemIds, sectionIds, report);
    await removeStaleSections(tx, catalog, report);
    // 目录语义变化在同一事务递增全局权限目录版本（base PRD §3：守卫授权缓存快照
    // 含该版本，递增即令旧授权缓存失效；users.permission_version 只随员工授权事务
    // 递增，目录变化不联动）
    if (report.semanticChanged) {
      const meta = await tx.permissionCatalogMeta.update({
        where: { id: CATALOG_META_ID },
        data: { catalogVersion: { increment: 1 } },
      });
      report.catalogVersion = meta.catalogVersion;
    } else {
      const meta = await tx.permissionCatalogMeta.findUniqueOrThrow({ where: { id: CATALOG_META_ID } });
      report.catalogVersion = meta.catalogVersion;
    }
    return report;
  });
}
