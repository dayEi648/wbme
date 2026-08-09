import { resolve } from 'node:path';
import type ExcelJS from 'exceljs';

/**
 * 利润分析 V2 运行模板契约（fin PRD §4）。
 *
 * - 运行模板：`docs/references/工程合同与利润分析.xlsx` 的空白运行副本（提交在
 *   `src/assets/`，构建复制到 dist/assets），负责标题、表头、合并、列宽、行高、
 *   字体、底色、边框和数字格式等静态结构；
 * - 绿色业务分类行、项目数据行、分类小计行及语义色由本文件的集中、版本化样式常量
 *   生成（不从不存在的空白项目行复制样式），样式常量版本与模板版本绑定；
 * - 模板识别签名：仅一个工作表 + 第 2 行 28 列有序表头（空白/换行归一化比较）+
 *   关键合并结构 A1:AB1；第 1 行标题文字与工作表名称不参与签名。
 */

/** 模板文件名（与 docs/references/工程合同与利润分析.xlsx 同一版本） */
export const TEMPLATE_FILENAME = '工程合同与利润分析.xlsx';

/** 运行时模板路径（dist/assets；nest-cli assets 复制） */
export function templateFilePath(): string {
  return resolve(__dirname, '../../assets', TEMPLATE_FILENAME);
}

/** 工作表名称（固定；不参与模板识别） */
export const WORKBOOK_SHEET_NAME = '利润分析汇总';

/** 标题行文本（固定写“工程合同结算情况及利润分析汇总表”；导入不参与识别） */
export const TITLE_TEXT = '工程合同结算情况及利润分析汇总表';

/** 第 1 行标题跨列合并范围（模板关键合并结构；参与签名） */
export const TITLE_MERGE = 'A1:AB1';

/** 固定 28 列有序表头（fin PRD §4；表头单元格含换行的按空白归一化比较） */
export const TEMPLATE_HEADERS: readonly string[] = [
  '序号',
  '项目名称',
  '资料齐全度',
  '年度',
  '地区',
  '项目进度',
  '甲方',
  '总包方',
  '管理费',
  '分包方',
  '合同开始日期',
  '合同完工日期',
  '合同金额（元）',
  '主合同付款节点',
  '暂定审定金额',
  '开票金额（元）',
  '已收回款（元）',
  '累计开票（元）',
  '累计收款（元）',
  '备注',
  '剩余未开票（元）',
  '剩余未收款（元）',
  '分包结算（元）',
  '已付分包款（元）',
  '零星费用',
  '累计分包付款（元）',
  '暂定保通权益',
  '毛利率',
];

/** 列索引（1 起；与 TEMPLATE_HEADERS 一一对应） */
export const COL = {
  SEQ: 1,
  NAME: 2,
  COMPLETENESS: 3,
  YEAR: 4,
  REGION: 5,
  PROGRESS: 6,
  PARTY_A: 7,
  GENERAL_CONTRACTOR: 8,
  MANAGEMENT_FEE: 9,
  SUBCONTRACTORS: 10,
  CONTRACT_START: 11,
  CONTRACT_END: 12,
  CONTRACT_AMOUNT: 13,
  PAYMENT_NODE: 14,
  TENTATIVE_AUDITED: 15,
  INVOICES: 16,
  RECEIPTS: 17,
  TOTAL_INVOICED: 18,
  TOTAL_RECEIVED: 19,
  REMARK: 20,
  REMAINING_UNINVOICED: 21,
  REMAINING_UNRECEIVED: 22,
  SETTLEMENT: 23,
  SUBCONTRACT_PAYMENTS: 24,
  MISC_EXPENSE: 25,
  TOTAL_SUBCONTRACT_PAID: 26,
  EQUITY: 27,
  GROSS_MARGIN: 28,
} as const;

/** 列总数 */
export const COLUMN_COUNT = 28;

/** 自动计算列（公式白名单：导入只允许这些列出现公式，且导入端忽略不信任） */
export const AUTO_CALC_COLUMNS: readonly number[] = [
  COL.TOTAL_INVOICED,
  COL.TOTAL_RECEIVED,
  COL.REMAINING_UNINVOICED,
  COL.REMAINING_UNRECEIVED,
  COL.TOTAL_SUBCONTRACT_PAID,
  COL.EQUITY,
  COL.GROSS_MARGIN,
];

/** 可导入手工列（其余自动列/序号列导入忽略） */
export const IMPORTABLE_COLUMNS: readonly number[] = [
  COL.NAME,
  COL.COMPLETENESS,
  COL.YEAR,
  COL.REGION,
  COL.PROGRESS,
  COL.PARTY_A,
  COL.GENERAL_CONTRACTOR,
  COL.MANAGEMENT_FEE,
  COL.SUBCONTRACTORS,
  COL.CONTRACT_START,
  COL.CONTRACT_END,
  COL.CONTRACT_AMOUNT,
  COL.PAYMENT_NODE,
  COL.TENTATIVE_AUDITED,
  COL.INVOICES,
  COL.RECEIPTS,
  COL.REMARK,
  COL.SETTLEMENT,
  COL.SUBCONTRACT_PAYMENTS,
  COL.MISC_EXPENSE,
];

/** 多值单元格（数组明细）列：LF 分隔 */
export const MULTI_VALUE_COLUMNS: readonly number[] = [COL.COMPLETENESS, COL.SUBCONTRACTORS, COL.INVOICES, COL.RECEIPTS, COL.SUBCONTRACT_PAYMENTS];

/** 金额列（单元格值必须是非负十进制金额文本） */
export const AMOUNT_COLUMNS: readonly number[] = [
  COL.CONTRACT_AMOUNT,
  COL.TENTATIVE_AUDITED,
  COL.INVOICES,
  COL.RECEIPTS,
  COL.SETTLEMENT,
  COL.SUBCONTRACT_PAYMENTS,
  COL.MISC_EXPENSE,
];

/** 日期列（YYYY-MM-DD） */
export const DATE_COLUMNS: readonly number[] = [COL.CONTRACT_START, COL.CONTRACT_END];

/** 系统虚拟分组“未分类”（Excel 空分类分组；导入映射为空分类） */
export const UNCLASSIFIED_GROUP = '未分类';

/** 小计行标记（A 列文本） */
export const SUBTOTAL_MARKER = '小计';

/**
 * 表头文本归一化（换行/连续空白归一化；导入签名与导出表头共用）。
 *
 * @param text 单元格文本
 * @returns 归一化文本（无换行、连续空白合并）
 */
export function normalizeHeaderText(text: string): string {
  return text.replace(/\s+/g, '').trim();
}

/**
 * 校验工作表是否符合 V2 模板签名。
 *
 * @param sheetName 工作表名称
 * @param headerRow 第 2 行 28 列表头文本（已按单元格取值）
 * @param titleMerge 第 1 行合并范围（如 'A1:AB1'）
 * @returns true=签名通过
 */
export function matchesTemplateSignature(sheetName: string, headerRow: readonly (string | null)[], titleMerge: string | null): boolean {
  if (headerRow.length < COLUMN_COUNT) {
    return false;
  }
  for (let i = 0; i < COLUMN_COUNT; i++) {
    if (normalizeHeaderText(headerRow[i] ?? '') !== normalizeHeaderText(TEMPLATE_HEADERS[i] as string)) {
      return false;
    }
  }
  return titleMerge === TITLE_MERGE;
}

/**
 * 取消数据区合并（保留 A1:AB1 标题合并）。
 *
 * exceljs 对合并区域非锚点单元格读取时返回锚点值；空白模板的 B3:AB3/B4:AB4
 * 说明行合并与导出生成的分组行合并都会污染数据行读写，导入解析与导出构建
 * 在签名校验（读标题合并）后统一调用本函数清除。
 *
 * @param workbook 已加载的工作簿
 */
export function stripDataRowMerges(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return;
  }
  for (const merge of [...(sheet.model.merges ?? [])]) {
    if (merge !== TITLE_MERGE) {
      sheet.unMergeCells(merge);
    }
  }
}

/**
 * 集中版本化动态行样式常量（与模板版本绑定；fin PRD §4）。
 * 不从不存在的空白项目行复制样式：分组行/小计行/语义色全部在此声明。
 */
export const ROW_STYLES = {
  /** 业务分类分组行：浅绿底色、粗体、跨列合并 */
  group: { fill: 'FFE2EFDA', bold: true },
  /** 分类小计行：浅灰底色、粗体、顶部细边框 */
  subtotal: { fill: 'FFF2F2F2', bold: true },
  /** 暂定金额语义单元格：浅黄色 */
  tentative: { fill: 'FFFFF2CC' },
  /** 审定金额语义单元格：浅绿色 */
  audited: { fill: 'FFD9EAD3' },
  /** 负数文字（剩余未开票/未收款）：红色 */
  negative: { font: { color: 'FFFF0000' } },
} as const;
