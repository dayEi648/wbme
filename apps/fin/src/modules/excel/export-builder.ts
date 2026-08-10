import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import {
  AUTO_CALC_COLUMNS,
  COL,
  COLUMN_COUNT,
  ROW_STYLES,
  SUBTOTAL_MARKER,
  templateFilePath,
  stripDataRowMerges,
  UNCLASSIFIED_GROUP,
  WORKBOOK_SHEET_NAME,
} from './xlsx-template';
import { stripXmlTagPrefixes } from './import-parser';

/**
 * 利润分析 V2 固定模板导出构建（fin PRD §4；在 CPU Worker Threads 中执行）。
 *
 * - 基于空白运行模板（src/assets）加载静态结构（标题/表头/合并/列宽/行高/字体/
 *   底色/边框/数字格式），不复制任何空白项目行样式；
 * - 动态行（绿色业务分类分组行、项目数据行、分类小计行）与语义色（暂定浅黄/
 *   审定浅绿、负数红字）由版本化样式常量生成（ROW_STYLES，与模板版本绑定）；
 * - 排序已由调用方完成（真实业务分类配置顺序 → 未分类最后 → 年度升序 → 项目 ID 升序）；
 * - 金额写两位小数数值 + 数字格式；毛利率写数值比率 + 0.00% 格式；多值单元格
 *   按 LF 换行；用户文本一律普通单元格值，不被解释为公式。
 */

/** 导出数据行（调用方在一致性快照事务内读取并排序） */
export interface ExportProjectRow {
  projectId: number;
  /** 业务分类 id（null=未分类；排序键） */
  bizCategoryId: number | null;
  /** 业务分类名（null=未分类；导出按分组行上下文输出） */
  bizCategoryName: string | null;
  name: string;
  year: number;
  completenessDocs: string;
  regionName: string;
  progressName: string;
  partyA: string;
  generalContractor: string;
  managementFee: string;
  subcontractors: string;
  contractStartDate: string;
  contractEndDate: string;
  contractAmount: string;
  paymentNode: string;
  tentativeAuditedAmount: string;
  semantic: 'TENTATIVE' | 'AUDITED';
  invoices: string;
  receipts: string;
  subcontractPayments: string;
  totalInvoiced: string;
  totalReceived: string;
  remark: string;
  remainingUninvoiced: string;
  remainingUnreceived: string;
  settlement: string;
  miscExpense: string;
  totalSubcontractPaid: string;
  equity: string;
  grossMargin: string | null;
}

/** 分类小计（按分组行汇总；小计只汇总对应范围内数据） */
export interface ExportSubtotal {
  bizCategoryName: string | null;
  totalInvoiced: string;
  totalReceived: string;
  totalSubcontractPaid: string;
  equity: string;
  grossMargin: string | null;
}

/** 按行写入的单元格值（28 列；string 直接写，number 写数值） */
type CellValue = string | number | null;

/** 金额列（写数值 + 千分位两位小数格式） */
const AMOUNT_FORMAT_COLUMNS: ReadonlySet<number> = new Set([
  COL.CONTRACT_AMOUNT,
  COL.TENTATIVE_AUDITED,
  COL.INVOICES,
  COL.RECEIPTS,
  COL.TOTAL_INVOICED,
  COL.TOTAL_RECEIVED,
  COL.REMAINING_UNINVOICED,
  COL.REMAINING_UNRECEIVED,
  COL.SETTLEMENT,
  COL.SUBCONTRACT_PAYMENTS,
  COL.MISC_EXPENSE,
  COL.TOTAL_SUBCONTRACT_PAID,
  COL.EQUITY,
]);

/** 多值换行列（LF → 单元格内换行 + 自动换行） */
const WRAP_COLUMNS: ReadonlySet<number> = new Set([COL.COMPLETENESS, COL.SUBCONTRACTORS, COL.INVOICES, COL.RECEIPTS, COL.SUBCONTRACT_PAYMENTS]);

/** 加载并规范化运行模板（读取 → XML 前缀兼容 → exceljs） */
export async function loadTemplateWorkbook(): Promise<ExcelJS.Workbook> {
  const raw = readFileSync(templateFilePath());
  const zip = await JSZip.loadAsync(raw);
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (!entry || entry.dir) {
      continue;
    }
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) {
      continue;
    }
    const text = await entry.async('string');
    zip.file(name, stripXmlTagPrefixes(text));
  }
  const normalized = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const workbook = new ExcelJS.Workbook();
  // exceljs 4.4.0 类型声明与 @types/node 24 Buffer 泛型不兼容：显式断言到最小加载面
  await (workbook.xlsx.load as unknown as (data: Buffer) => Promise<ExcelJS.Workbook>)(normalized);
  // 取消数据区说明行合并（仅保留 A1:AB1 标题合并；合并非锚点单元格读取会污染数据行）
  stripDataRowMerges(workbook);
  return workbook;
}

/** 行数据 → 28 列单元格值（seq 为按导出结果重排的序号，写入首列） */
function rowCells(row: ExportProjectRow, seq: number): CellValue[] {
  const money = (value: string): number => Number(value);
  const cells: CellValue[] = [
    seq,
    row.name,
    row.completenessDocs || null,
    row.year,
    row.regionName || null,
    row.progressName || null,
    row.partyA || null,
    row.generalContractor || null,
    row.managementFee || null,
    row.subcontractors || null,
    row.contractStartDate || null,
    row.contractEndDate || null,
    row.contractAmount === '' ? null : money(row.contractAmount),
    row.paymentNode || null,
    row.tentativeAuditedAmount === '' ? null : money(row.tentativeAuditedAmount),
    row.invoices || null,
    row.receipts || null,
    money(row.totalInvoiced),
    money(row.totalReceived),
    row.remark || null,
    money(row.remainingUninvoiced),
    money(row.remainingUnreceived),
    row.settlement === '' ? null : money(row.settlement),
    row.subcontractPayments || null,
    row.miscExpense === '' ? null : money(row.miscExpense),
    money(row.totalSubcontractPaid),
    money(row.equity),
    row.grossMargin === null ? null : Number(row.grossMargin),
  ];
  return cells;
}

/** 应用数据行样式（语义色/负数红字/金额格式/换行） */
function applyDataRowStyle(sheet: ExcelJS.Worksheet, rowNumber: number, row: ExportProjectRow): void {
  for (let c = 1; c <= COLUMN_COUNT; c++) {
    const cell = sheet.getCell(rowNumber, c);
    if (AMOUNT_FORMAT_COLUMNS.has(c)) {
      cell.numFmt = '#,##0.00';
    }
    if (c === COL.GROSS_MARGIN) {
      cell.numFmt = '0.00%';
    }
    if (WRAP_COLUMNS.has(c)) {
      cell.alignment = { wrapText: true, vertical: 'top' };
    }
  }
  // 暂定/审定金额语义色（fin PRD §4：颜色 + 同列项目进度文字共同表达语义）
  const semanticCell = sheet.getCell(rowNumber, COL.TENTATIVE_AUDITED);
  if (semanticCell.value !== null && semanticCell.value !== '') {
    semanticCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: row.semantic === 'AUDITED' ? ROW_STYLES.audited.fill : ROW_STYLES.tentative.fill },
    };
  }
  // 剩余未开票/未收款负数红色文字
  for (const c of [COL.REMAINING_UNINVOICED, COL.REMAINING_UNRECEIVED]) {
    const cell = sheet.getCell(rowNumber, c);
    if (typeof cell.value === 'number' && cell.value < 0) {
      cell.font = { color: { argb: ROW_STYLES.negative.font.color }, name: '等线' };
    }
  }
}

/** 分组行（绿色底 + 跨列合并 + 粗体） */
function writeGroupRow(sheet: ExcelJS.Worksheet, rowNumber: number, groupName: string): void {
  const cell = sheet.getCell(rowNumber, COL.NAME);
  cell.value = groupName;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_STYLES.group.fill } };
  cell.font = { bold: true, name: '等线' };
  const merge = `${excelColumn(COL.NAME)}${rowNumber}:${excelColumn(COLUMN_COUNT)}${rowNumber}`;
  sheet.mergeCells(merge);
  sheet.getRow(rowNumber).height = 20;
}

/** 分类小计行（A 列“小计”+ 关键列小计值；浅灰底 + 粗体） */
function writeSubtotalRow(sheet: ExcelJS.Worksheet, rowNumber: number, subtotal: ExportSubtotal): void {
  const cells: CellValue[] = [SUBTOTAL_MARKER];
  for (let c = 2; c <= COLUMN_COUNT; c++) {
    cells.push(null);
  }
  cells[COL.TOTAL_INVOICED - 1] = Number(subtotal.totalInvoiced);
  cells[COL.TOTAL_RECEIVED - 1] = Number(subtotal.totalReceived);
  cells[COL.TOTAL_SUBCONTRACT_PAID - 1] = Number(subtotal.totalSubcontractPaid);
  cells[COL.EQUITY - 1] = Number(subtotal.equity);
  cells[COL.GROSS_MARGIN - 1] = subtotal.grossMargin === null ? null : Number(subtotal.grossMargin);
  for (let c = 1; c <= COLUMN_COUNT; c++) {
    const cell = sheet.getCell(rowNumber, c);
    cell.value = cells[c - 1];
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_STYLES.subtotal.fill } };
    cell.font = { bold: true, name: '等线' };
    if (AMOUNT_FORMAT_COLUMNS.has(c)) {
      cell.numFmt = '#,##0.00';
    }
    if (c === COL.GROSS_MARGIN) {
      cell.numFmt = '0.00%';
    }
  }
}

/** 数字列号 → Excel 列字母（仅 1..28） */
function excelColumn(column: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  if (column <= 26) {
    return letters[column - 1] as string;
  }
  return `A${letters[column - 27] as string}`;
}

/**
 * 构建导出工作簿（模板加载 + 数据填充 + 样式应用 + 序列化）。
 *
 * @param groups 按导出排序后的分组数据（真实业务分类配置顺序 → 未分类最后）
 * @returns 工作簿 Buffer（直接响应附件）
 */
export async function buildExportBuffer(
  groups: Array<{ bizCategoryName: string | null; rows: ExportProjectRow[]; subtotal: ExportSubtotal }>,
): Promise<Buffer> {
  const workbook = await loadTemplateWorkbook();
  const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME);
  if (!sheet) {
    throw new Error('运行模板缺少工作表“利润分析汇总”');
  }

  let rowNumber = 3;
  let seq = 0;
  for (const group of groups) {
    const groupName = group.bizCategoryName ?? UNCLASSIFIED_GROUP;
    writeGroupRow(sheet, rowNumber, groupName);
    rowNumber += 1;
    for (const row of group.rows) {
      seq += 1;
      const cells = rowCells(row, seq);
      for (let c = 1; c <= COLUMN_COUNT; c++) {
        sheet.getCell(rowNumber, c).value = cells[c - 1] ?? null;
      }
      applyDataRowStyle(sheet, rowNumber, row);
      rowNumber += 1;
    }
    if (group.rows.length > 0) {
      writeSubtotalRow(sheet, rowNumber, group.subtotal);
      rowNumber += 1;
    }
  }

  // 序列化（CPU 密集；调用方保证在 Worker 线程内）
  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/** 自动计算列清单导出（供测试/文档核对；自动列以数值写入，导入端忽略重算） */
export const EXPORT_AUTO_COLUMNS: readonly number[] = AUTO_CALC_COLUMNS;
