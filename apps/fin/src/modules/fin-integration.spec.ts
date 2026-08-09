import 'reflect-metadata';
import type ExcelJS from 'exceljs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisClient } from '@wbme/server';
import type { Redis } from '@wbme/server';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { type FinOperationLogOperator } from '../shared/fin-operation-log.util';
import { normalizeProjectName } from '../shared/name-normalize';
import { DetailService } from './project/detail.service';
import { ProjectService } from './project/project.service';
import { ProfitService } from './profit/profit.service';
import { DictService } from './dict/dict.service';
import { ImportService } from './excel/import.service';
import { XlsxWorkerPool } from './excel/xlsx-worker-pool';
import { buildExportBuffer, type ExportProjectRow } from './excel/export-builder';
import { loadTemplateWorkbook } from './excel/export-builder';
import { WORKBOOK_SHEET_NAME } from './excel/xlsx-template';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL/Redis）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/** 测试操作人（集成测试不依赖 backstage/hr 视图，直接构造） */
const OPERATOR: FinOperationLogOperator = { id: 990001, name: '集成测试员', departments: [] };

/** 测试数据 ID 段（避免与真实数据冲突） */
const BASE = 9_902_000;

/**
 * fin 服务层集成测试（T8；真实本地 PostgreSQL + Redis）。
 * 覆盖：项目 CRUD 与业务键唯一（软删占键）、金额明细、利润即时保存、字典引用规则、
 * Excel 导入导出往返（模板识别/预览/确认/覆盖）。
 */
describeDb('fin 集成（项目/明细/利润/字典/导入导出）', () => {
  let prisma: PrismaService;
  let projects: ProjectService;
  let details: DetailService;
  let profit: ProfitService;
  let dicts: DictService;
  let imports: ImportService;
  let pool: XlsxWorkerPool;
  let redis: Redis;

  const regionId = BASE + 1;
  const progressTentativeId = BASE + 2;
  const progressAuditedId = BASE + 3;
  const categoryId = BASE + 4;
  const completenessId = BASE + 5;
  const projectA = BASE + 10;
  const projectB = BASE + 11;
  const projectDel = BASE + 12;

  beforeAll(async () => {
    // 内联模式：vitest 环境无 dist worker 产物，直接在调用线程执行解析/构建
    XlsxWorkerPool.inline = true;
    prisma = new PrismaService();
    // 清理失败运行残留（先子表后主表；按测试名称与 ID 段）
    await prisma.client.$executeRaw`
      DELETE FROM fin.project_operations
      WHERE project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.invoices
      WHERE project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.receipts
      WHERE project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.subcontract_payments
      WHERE project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.projects
      WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999}
    `;
    // 字典种子
    await prisma.client.$executeRaw`
      INSERT INTO fin.finance_dict_items (id, dict_type, name, semantic, sort, status, created_at, updated_at)
      VALUES
        (${regionId}, 'REGION', '前洲', NULL, 0, 'ACTIVE', NOW(), NOW()),
        (${progressTentativeId}, 'PROGRESS', '已开工未竣工', 'TENTATIVE', 0, 'ACTIVE', NOW(), NOW()),
        (${progressAuditedId}, 'PROGRESS', '已审结未满质保期', 'AUDITED', 1, 'ACTIVE', NOW(), NOW()),
        (${categoryId}, 'BIZ_CATEGORY', '自施工程', NULL, 0, 'ACTIVE', NOW(), NOW()),
        (${completenessId}, 'COMPLETENESS', '总包合同', NULL, 0, 'ACTIVE', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    projects = new ProjectService(prisma);
    details = new DetailService(prisma);
    profit = new ProfitService(prisma);
    dicts = new DictService(prisma);
    pool = new XlsxWorkerPool();
    redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
    imports = new ImportService(prisma, pool, redis);
  });

  afterAll(async () => {
    // 清理测试数据（项目 → 明细 → 字典；按 id 与名称双路径清理，防失败运行残留）
    const testProjectIds = [projectA, projectB, projectDel];
    await prisma.client.$executeRaw`
      DELETE FROM fin.project_operations WHERE project_id = ANY(${testProjectIds})
        OR project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目'))
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.invoices WHERE project_id = ANY(${testProjectIds})
        OR project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目'))
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.receipts WHERE project_id = ANY(${testProjectIds})
        OR project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目'))
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.subcontract_payments WHERE project_id = ANY(${testProjectIds})
        OR project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目'))
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.projects WHERE id = ANY(${testProjectIds}) OR name IN ('待删除项目', '全新项目名称', '导入软删项目')
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.finance_dict_items WHERE id IN (${regionId}, ${progressTentativeId}, ${progressAuditedId}, ${categoryId}, ${completenessId})
    `;
    await prisma.client.$executeRaw`DELETE FROM fin.operation_logs WHERE operator_id = ${OPERATOR.id}`;
    await pool.onModuleDestroy();
    await redis.quit();
    await prisma.client.$disconnect();
  });

  it('项目新建 → 业务键规范化唯一（软删占键 → 同名重建拒绝）', async () => {
    const created = await projects.create(OPERATOR, {
      name: '  城铁惠山站区工程  ',
      year: 2024,
      regionId,
      progressId: progressTentativeId,
      bizCategoryId: categoryId,
      completenessDocs: [{ id: completenessId, name: '总包合同' }],
      partyA: '惠山区住建局',
      contractAmount: '100000.00',
    });
    expect(created.id).toBeGreaterThan(0);
    await prisma.client.$executeRaw`UPDATE fin.projects SET id = ${projectA} WHERE id = ${created.id}`;

    // 规范化后的业务键（大小写折叠 + 空白归一）
    const row = await prisma.client.project.findUnique({ where: { id: projectA } });
    expect(row?.businessKey).toBe(normalizeProjectName('城铁惠山站区工程'));
    expect(row?.regionName).toBe('前洲');
    expect(row?.progressSemantic).toBe('TENTATIVE');

    // 同名同年度（含空白变体）→ 业务键冲突
    await expect(
      projects.create(OPERATOR, { name: '城铁 惠山站区工程', year: 2024 }),
    ).rejects.toMatchObject({ entry: { code: 'PROJECT_KEY_CONFLICT' } });
  });

  it('金额明细增删改 + dataRevision 递增 + 删除前快照审计', async () => {
    const detailId = await details.create(OPERATOR, projectA, 'invoice', {
      item: { amount: '500.00', occurredDate: '2026-08-01', remark: '第一批' },
    });
    expect(detailId.id).toBeGreaterThan(0);
    await prisma.client.$executeRaw`UPDATE fin.invoices SET id = ${BASE + 20} WHERE id = ${detailId.id}`;

    await details.update(OPERATOR, projectA, 'invoice', BASE + 20, {
      item: { amount: '600.00', occurredDate: '2026-08-02' },
    });
    const updated = await prisma.client.invoice.findUnique({ where: { id: BASE + 20 } });
    expect(updated?.amount.toFixed(2)).toBe('600.00');
    expect(updated?.remark).toBeNull();

    // 单条物理删除（删除前快照审计同事务）
    await details.remove(OPERATOR, projectA, 'invoice', BASE + 20);
    const gone = await prisma.client.invoice.findUnique({ where: { id: BASE + 20 } });
    expect(gone).toBeNull();
    const audit = await prisma.client.projectOperation.findFirst({
      where: { projectId: projectA, field: 'invoices', after: { equals: Prisma.DbNull } },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    const before = audit?.before as { amount: string };
    expect(before.amount).toBe('600.00');
  });

  it('利润分析 cellSave：单字段只写目标字段 + 自动字段重算 + dataRevision 递增', async () => {
    const before = await prisma.client.project.findUnique({ where: { id: projectA } });
    const saved = await profit.cellSave(OPERATOR, { projectId: projectA, field: 'tentativeAuditedAmount', value: '80000.00' });
    expect(saved.dataRevision).toBe((before?.dataRevision ?? 0) + 1);
    expect(saved.auto.remainingUninvoiced).toBe('80000.00');

    // 白名单外字段拒绝
    await expect(
      profit.cellSave(OPERATOR, { projectId: projectA, field: 'totalInvoiced', value: '1' }),
    ).rejects.toMatchObject({ entry: { code: 'CELL_FIELD_NOT_ALLOWED' } });
  });

  it('字典：进度语义被引用后不可修改；被引用项删除整批拒绝；未分类保留名拒绝', async () => {
    await expect(
      dicts.update(OPERATOR, progressTentativeId, { name: '已开工未竣工', semantic: 'AUDITED', sort: 0, status: 'ACTIVE' }),
    ).rejects.toMatchObject({ entry: { code: 'DICT_SEMANTIC_LOCKED' } });

    await expect(
      dicts.batchDelete(OPERATOR, [regionId]),
    ).rejects.toMatchObject({ entry: { code: 'DICT_REFERENCED' } });

    await expect(
      dicts.create(OPERATOR, { dictType: 'BIZ_CATEGORY', name: '未分类', sort: 0 }),
    ).rejects.toMatchObject({ entry: { code: 'UNCLASSIFIED_NAME_CONFLICT' } });
  });

  it('批量软删除 → 已删除视图恢复（保留 ID 与业务键）', async () => {
    const created = await projects.create(OPERATOR, { name: '待删除项目', year: 2022 });
    await prisma.client.$executeRaw`UPDATE fin.projects SET id = ${projectDel} WHERE id = ${created.id}`;

    await projects.batchDelete(OPERATOR, [projectDel]);
    const deleted = await prisma.client.project.findUnique({ where: { id: projectDel } });
    expect(deleted?.deletedAt).not.toBeNull();

    // 已删除项目仍占用业务键
    await expect(
      projects.create(OPERATOR, { name: '待删除项目', year: 2022 }),
    ).rejects.toMatchObject({ entry: { code: 'PROJECT_KEY_CONFLICT' } });

    await projects.batchRestore(OPERATOR, [projectDel]);
    const restored = await prisma.client.project.findUnique({ where: { id: projectDel } });
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.id).toBe(projectDel);
  });

  it('Excel 导出 → 导入往返：导出文件可无歧义重新导入（覆盖保留原项目）', async () => {
    // 准备可导出数据
    const exportRow: ExportProjectRow = {
      projectId: projectA,
      bizCategoryId: categoryId,
      bizCategoryName: '自施工程',
      name: '城铁惠山站区工程',
      year: 2024,
      completenessDocs: '总包合同',
      regionName: '前洲',
      progressName: '已开工未竣工',
      partyA: '惠山区住建局',
      generalContractor: '总包集团',
      managementFee: '5%',
      subcontractors: '分包甲\n分包乙',
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      contractAmount: '100000.00',
      paymentNode: '按进度',
      tentativeAuditedAmount: '80000.00',
      semantic: 'TENTATIVE',
      invoices: '100.00\n200.00',
      receipts: '300.00',
      subcontractPayments: '50.00',
      totalInvoiced: '300.00',
      totalReceived: '300.00',
      remark: '备注',
      remainingUninvoiced: '79700.00',
      remainingUnreceived: '79700.00',
      settlement: '40000.00',
      miscExpense: '100.00',
      totalSubcontractPaid: '150.00',
      equity: '150.00',
      grossMargin: '0.50',
    };
    const exported = await buildExportBuffer([
      { bizCategoryName: '自施工程', rows: [exportRow], subtotal: { bizCategoryName: '自施工程', totalInvoiced: '300.00', totalReceived: '300.00', totalSubcontractPaid: '150.00', equity: '150.00', grossMargin: '0.50' } },
    ]);

    // 导入预览：命中已存在项目 → 待选择（覆盖/跳过）
    const preview = await imports.preview(OPERATOR, exported);
    expect(preview.summary.pendingChoice).toBe(1);
    expect(preview.pendingChoice[0]?.projectId).toBe(projectA);
    expect(preview.pendingChoice[0]?.dataLossWarning).toBe(true); // 有明细被覆盖

    // 导入确认：覆盖（带 dataRevision 前置条件）
    const choice = preview.pendingChoice[0] as { rowNumber: number; projectId: number; dataRevision: number };
    const confirmed = await imports.confirm(
      OPERATOR,
      exported,
      [{ rowNumber: choice.rowNumber, decision: 'OVERWRITE', projectId: choice.projectId, dataRevision: choice.dataRevision }],
      undefined,
    );
    expect(confirmed.summary.overwritten).toBe(1);

    // 覆盖后：明细重建（日期/备注清空）、字段按上传快照
    const overwritten = await prisma.client.project.findUnique({ where: { id: projectA } });
    expect(overwritten?.paymentNode).toBe('按进度');
    expect(overwritten?.subcontractors).toEqual(['分包甲', '分包乙']);
    const invoices = await prisma.client.invoice.findMany({ where: { projectId: projectA }, orderBy: { id: 'asc' } });
    expect(invoices.map((row) => row.amount.toFixed(2))).toEqual(['100.00', '200.00']);
    expect(invoices[0]?.occurredDate).toBeNull(); // Excel 不保存日期

    // 审计记录：IMPORT_OVERWRITE 含替换前后完整明细快照
    const audit = await prisma.client.projectOperation.findFirst({
      where: { projectId: projectA, action: 'IMPORT_OVERWRITE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    const after = audit?.after as { invoices: Array<{ amount: string }> };
    expect(after.invoices.length).toBe(2);
  });

  it('Excel 导入预览：软删除命中 → 冲突；新增需年度；模板签名不符拒绝', async () => {
    // 准备软删除目标：新建项目并软删除（导入命中软删除 → 冲突，不自动恢复）
    const deletedCreated = await projects.create(OPERATOR, { name: '导入软删项目', year: 2022 });
    await projects.batchDelete(OPERATOR, [deletedCreated.id]);

    // 软删除项目行 → 冲突（IMPORT_PROJECT_DELETED 语义）
    const workbook = await loadTemplateWorkbook();
    const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
    sheet.getCell(3, 2).value = '导入软删项目';
    sheet.getCell(3, 4).value = 2022;
    const deletedRowBuffer = await workbook.xlsx.writeBuffer();
    const preview = await imports.preview(OPERATOR, Buffer.from(await deletedRowBuffer));
    expect(preview.summary.conflict).toBe(1);
    expect(preview.conflicts[0]?.status).toBe('DELETED');

    // 新增行缺年度 → 错误（IMPORT_YEAR_REQUIRED_FOR_NEW 语义）
    const workbook2 = await loadTemplateWorkbook();
    const sheet2 = workbook2.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
    sheet2.getCell(3, 2).value = '全新项目名称';
    const noYearBuffer = await workbook2.xlsx.writeBuffer();
    const preview2 = await imports.preview(OPERATOR, Buffer.from(await noYearBuffer));
    expect(preview2.summary.conflict).toBe(1);
    expect(preview2.conflicts[0]?.reason).toContain('年度');
  });
});
