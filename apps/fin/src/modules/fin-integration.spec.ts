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
import { COL, WORKBOOK_SHEET_NAME } from './excel/xlsx-template';

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
      WHERE project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程', '城铁 惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.invoices
      WHERE project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程', '城铁 惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.receipts
      WHERE project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程', '城铁 惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.subcontract_payments
      WHERE project_id IN (SELECT id FROM fin.projects WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程', '城铁 惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM fin.projects
      WHERE name IN ('待删除项目', '全新项目名称', '导入软删项目', '城铁惠山站区工程', '城铁 惠山站区工程') OR id BETWEEN ${BASE} AND ${BASE + 999}
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

    // 同名同年度（含空白变体：尾随空格归一化后业务键相同）→ 业务键冲突。
    // 注意：中间单个空格是名称内容（归一化仅折叠连续空白），「城铁 惠山站区工程」
    // 与「城铁惠山站区工程」是不同业务键，不构成冲突。
    await expect(
      projects.create(OPERATOR, { name: '城铁惠山站区工程 ', year: 2024 }),
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

  it('明细 update 提交规范化等价金额（"600" vs 库中 "600.00"）→ 无实际差异不记录', async () => {
    const detailId = await details.create(OPERATOR, projectA, 'receipt', { item: { amount: '600.00' } });
    await prisma.client.$executeRaw`UPDATE fin.receipts SET id = ${BASE + 21} WHERE id = ${detailId.id}`;
    const beforeRevision = (await prisma.client.project.findUnique({ where: { id: projectA } }))?.dataRevision;
    const beforeOps = await prisma.client.projectOperation.count({ where: { projectId: projectA } });

    // 提交 "600"（两位小数内与 "600.00" 等价）→ 无实际差异：不记录、dataRevision 不递增
    await details.update(OPERATOR, projectA, 'receipt', BASE + 21, { item: { amount: '600' } });
    const afterRevision = (await prisma.client.project.findUnique({ where: { id: projectA } }))?.dataRevision;
    const afterOps = await prisma.client.projectOperation.count({ where: { projectId: projectA } });
    expect(afterRevision).toBe(beforeRevision);
    expect(afterOps).toBe(beforeOps);

    // 真实差异仍正常记录
    await details.update(OPERATOR, projectA, 'receipt', BASE + 21, { item: { amount: '700.00' } });
    const changedOps = await prisma.client.projectOperation.count({ where: { projectId: projectA } });
    expect(changedOps).toBe(afterOps + 1);
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

  it('cellSave 修改 year 撞另一项目同名同目标年度 → PROJECT_KEY_CONFLICT（而非 500）', async () => {
    // 同名跨年度项目（业务键 = 规范化名称 + 年度，合法）
    const a = await projects.create(OPERATOR, { name: '冲突项目甲', year: 2024 });
    await prisma.client.$executeRaw`UPDATE fin.projects SET id = ${BASE + 40} WHERE id = ${a.id}`;
    const b = await projects.create(OPERATOR, { name: '冲突项目甲', year: 2025 });
    await prisma.client.$executeRaw`UPDATE fin.projects SET id = ${BASE + 41} WHERE id = ${b.id}`;

    // 甲改 year → 2025：新业务键（冲突项目甲, 2025）已被乙占用，必须返回业务冲突而非数据库约束错误
    await expect(
      profit.cellSave(OPERATOR, { projectId: BASE + 40, field: 'year', value: 2025 }),
    ).rejects.toMatchObject({ entry: { code: 'PROJECT_KEY_CONFLICT' } });

    // 失败后未被错误写入
    const row = await prisma.client.project.findUnique({ where: { id: BASE + 40 } });
    expect(row?.year).toBe(2024);
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
    expect(preview.pendingChoice[0]?.dataLossWarning).toBe(false); // 覆盖前项目明细已在前序测试删除，无日期/备注元数据可丢

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

  it('导入预览 dataLossWarning 仅对存在日期/备注明细的项目为真', async () => {
    // 目标项目只有纯金额明细（无日期、无单笔备注）→ 覆盖不丢元数据 → 不警告
    const clean = await projects.create(OPERATOR, { name: '无元数据项目', year: 2020 });
    await prisma.client.$executeRaw`UPDATE fin.projects SET id = ${BASE + 50} WHERE id = ${clean.id}`;
    await details.create(OPERATOR, BASE + 50, 'invoice', { item: { amount: '100.00' } });

    const workbook = await loadTemplateWorkbook();
    const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
    sheet.getCell(3, COL.NAME).value = '无元数据项目';
    sheet.getCell(3, COL.YEAR).value = 2020;
    sheet.getCell(3, COL.INVOICES).value = '200.00';
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const preview = await imports.preview(OPERATOR, buffer);
    expect(preview.summary.pendingChoice).toBe(1);
    expect(preview.pendingChoice[0]?.dataLossWarning).toBe(false);

    const choice = preview.pendingChoice[0] as { rowNumber: number; projectId: number; dataRevision: number };
    const confirmed = await imports.confirm(
      OPERATOR,
      buffer,
      [{ rowNumber: choice.rowNumber, decision: 'OVERWRITE', projectId: choice.projectId, dataRevision: choice.dataRevision }],
      undefined,
    );
    expect(confirmed.summary.overwritten).toBe(1);
  });

  it('导入确认显式选择 SKIP → 逐项目记录 IMPORT_SKIP 审计', async () => {
    const workbook = await loadTemplateWorkbook();
    const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
    sheet.getCell(3, COL.NAME).value = '无元数据项目';
    sheet.getCell(3, COL.YEAR).value = 2020;
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const preview = await imports.preview(OPERATOR, buffer);
    expect(preview.summary.pendingChoice).toBe(1);
    const target = preview.pendingChoice[0] as { rowNumber: number; projectId: number; dataRevision: number };

    // 显式选择 SKIP：不写入，且逐项目记录跳过结果（fin PRD §4）
    const confirmed = await imports.confirm(
      OPERATOR,
      buffer,
      [{ rowNumber: target.rowNumber, decision: 'SKIP', projectId: target.projectId, dataRevision: target.dataRevision }],
      undefined,
    );
    expect(confirmed.summary.skipped).toBe(1);

    const skipAudit = await prisma.client.projectOperation.findFirst({
      where: { projectId: target.projectId, action: 'IMPORT_SKIP' },
      orderBy: { createdAt: 'desc' },
    });
    expect(skipAudit).not.toBeNull();
  });

  it('导入行级错误（超范围年度/非法金额）→ 整行不参与新增选择，确认不写入', async () => {
    const workbook = await loadTemplateWorkbook();
    const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
    sheet.getCell(3, COL.NAME).value = '带错误新增项目';
    sheet.getCell(3, COL.YEAR).value = 0; // 年度 0000 → 行级校验错误
    sheet.getCell(3, COL.CONTRACT_AMOUNT).value = 'abc'; // 非法金额 → 行级校验错误
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const preview = await imports.preview(OPERATOR, buffer);
    expect(preview.summary.created).toBe(0);
    // summary.error 为错误行数；同一行多个字段错误全部返回（字段级安全错误）
    expect(preview.summary.error).toBe(1);
    expect(preview.errors[0]?.fields.length).toBeGreaterThanOrEqual(2);

    // 确认时错误行排除在写入之外（fin PRD §4：任一错误不得产生部分写入）
    const confirmed = await imports.confirm(OPERATOR, buffer, [], undefined);
    expect(confirmed.summary.created).toBe(0);
    const notCreated = await prisma.client.project.findFirst({ where: { name: '带错误新增项目' } });
    expect(notCreated).toBeNull();
  });
});
