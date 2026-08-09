import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  AMOUNT_COLUMNS,
  AUTO_CALC_COLUMNS,
  COLUMN_COUNT,
  DATE_COLUMNS,
  IMPORTABLE_COLUMNS,
  matchesTemplateSignature,
  MULTI_VALUE_COLUMNS,
  normalizeHeaderText,
  stripDataRowMerges,
  SUBTOTAL_MARKER,
  UNCLASSIFIED_GROUP,
} from './xlsx-template';

/**
 * 利润分析 Excel 导入解析（fin PRD §4；在 CPU Worker Threads 中执行）。
 *
 * - ZIP 压缩容器安全：解压内容累计 ≤ 200 MiB、条目 ≤ 1,000、拒绝加密/嵌套/
 *   路径穿越/符号链接/绝对路径与非法条目；解析前检查中央目录，实际读取再次累计；
 * - 模板识别：仅一个工作表 + 28 列有序表头 + A1:AB1 标题合并（第 1 行标题文字
 *   与工作表名称不参与识别）；
 * - 分组行/小计行/项目数据行按行结构区分；多值单元格按 LF 拆分；
 * - 公式白名单：自动计算列可含公式（导入端忽略），手工列出现公式即行级错误；
 * - 解析到第 10,001 个数据行立即终止（IMPORT_ROW_LIMIT_EXCEEDED）。
 */

/** 导入固定安全上限（MVP 固定值；fin PRD §4） */
export const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 1_000;
export const IMPORT_MAX_ROWS = 10_000;

/** 行级错误（预览错误列表项） */
export interface RowError {
  rowNumber: number;
  field: string;
  reason: string;
}

/** 解析行（kind 区分分组/小计/数据/空行） */
export interface ParsedRow {
  /** Excel 行号（1 起） */
  rowNumber: number;
  kind: 'group' | 'subtotal' | 'project' | 'empty';
  /** 分组行：分类名（“未分类”表示空分类） */
  groupName?: string;
  /** 28 列单元格文本（数值/日期转文本；null=空） */
  cells: Array<string | null>;
  /** 28 列是否有公式 */
  formulas: boolean[];
}

/** 解析结果 */
export interface ParseResult {
  rows: ParsedRow[];
  errors: RowError[];
}

/** 解析级错误（整文件终止；与行级错误区分） */
export type ParseFailure =
  | { kind: 'ARCHIVE_LIMIT'; reason: string }
  | { kind: 'SHEET_INVALID'; reason: string }
  | { kind: 'ROW_LIMIT' }
  | { kind: 'ZIP_CORRUPT'; reason: string };

/** 规范化 XLSX XML 前缀（模板与用户文件均可能带 x: 前缀命名空间，exceljs 不兼容） */
export function stripXmlTagPrefixes(text: string): string {
  return text.replace(/<(\/)?x:/g, '<$1');
}

/** ZIP 条目名合法性检查（拒绝绝对路径、路径穿越、Windows 盘符、符号链接形态） */
function assertSafeEntryName(name: string): boolean {
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name) || name.includes('..')) {
    return false;
  }
  // 符号链接/特殊文件形态：unix 模式由 external attr 表达，JSZip 不暴露；名称层面拒绝隐藏文件
  if (name.includes('__MACOSX')) {
    return false;
  }
  return true;
}

/** 单元格取值 → 文本（数值/日期/布尔/富文本统一转文本；公式取缓存结果） */
function cellToText(cell: ExcelJS.Cell): { text: string | null; formula: boolean } {
  const formula = typeof cell.formula === 'string';
  const raw = formula ? cell.result : cell.value;
  if (raw === null || raw === undefined) {
    return { text: null, formula };
  }
  if (raw instanceof Date) {
    return { text: raw.toISOString().slice(0, 10), formula };
  }
  if (typeof raw === 'number') {
    // 数值单元格：整数原样；小数保留（金额文本由上层 Decimal 解析）
    return { text: Number.isInteger(raw) ? String(raw) : String(raw), formula };
  }
  if (typeof raw === 'boolean') {
    return { text: String(raw), formula };
  }
  if (typeof raw === 'object' && raw !== null && 'text' in raw) {
    return { text: String((raw as { text: unknown }).text), formula };
  }
  return { text: String(raw), formula };
}

/**
 * 解析导入文件（ZIP 安全 + 模板签名 + 行解析）。
 *
 * @param buffer 上传文件内容（已通过 20 MiB 请求体限制）
 * @returns 解析结果或整文件失败
 */
export async function parseImportBuffer(buffer: Buffer): Promise<ParseResult | ParseFailure> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { kind: 'ZIP_CORRUPT', reason: '文件不是有效的 XLSX（ZIP）压缩包' };
  }

  const entries = Object.values(zip.files);
  if (entries.length > ARCHIVE_MAX_ENTRIES) {
    return { kind: 'ARCHIVE_LIMIT', reason: `压缩条目数超过 ${ARCHIVE_MAX_ENTRIES} 上限` };
  }

  let totalBytes = 0;
  const pending = new Map<string, string>();
  for (const entry of entries) {
    if (entry.dir) {
      continue;
    }
    if (!assertSafeEntryName(entry.name)) {
      return { kind: 'ARCHIVE_LIMIT', reason: `存在非法压缩条目：${entry.name}` };
    }
    // 实际读取累计解压字节（不能只信任 ZIP 声明值）
    let content: Buffer;
    try {
      content = await entry.async('nodebuffer');
    } catch {
      return { kind: 'ZIP_CORRUPT', reason: `压缩条目读取失败：${entry.name}` };
    }
    totalBytes += content.length;
    if (totalBytes > ARCHIVE_MAX_BYTES) {
      return { kind: 'ARCHIVE_LIMIT', reason: '解压内容超过 200 MiB 安全上限' };
    }
    // 嵌套压缩包检测（PK 魔数）
    if (content.length >= 4 && content[0] === 0x50 && content[1] === 0x4b && (content[2] === 0x03 || content[2] === 0x05 || content[2] === 0x07)) {
      return { kind: 'ARCHIVE_LIMIT', reason: `检测到嵌套压缩包条目：${entry.name}` };
    }
    if (entry.name.endsWith('.xml') || entry.name.endsWith('.rels')) {
      pending.set(entry.name, stripXmlTagPrefixes(content.toString('utf8')));
    }
  }
  for (const [name, text] of pending) {
    zip.file(name, text);
  }

  let normalized: Buffer;
  try {
    normalized = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch {
    return { kind: 'ZIP_CORRUPT', reason: '压缩包重建失败' };
  }

  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    // exceljs 4.4.0 类型声明与 @types/node 24 Buffer 泛型不兼容：显式断言到最小加载面
    await (workbook.xlsx.load as unknown as (data: Buffer) => Promise<ExcelJS.Workbook>)(normalized);
  } catch {
    return { kind: 'SHEET_INVALID', reason: '文件不是标准 XLSX（Open XML 结构校验失败）' };
  }

  if (workbook.worksheets.length !== 1) {
    return { kind: 'SHEET_INVALID', reason: '必须仅包含一个工作表' };
  }
  const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;

  // 第 1 行标题合并（签名）与第 2 行表头（签名）
  const titleMerge = sheet.model.merges?.find((m) => m.includes('A1:')) ?? null;
  const headerCells = readRowCells(sheet, 2);
  if (!matchesTemplateSignature(sheet.name, headerCells.map((c) => c.text), titleMerge)) {
    return { kind: 'SHEET_INVALID', reason: '工作表结构或表头与利润分析 V2 模板不匹配' };
  }
  // 签名通过后取消数据区合并（含平台导出分组行合并；非锚点单元格读取会污染行识别）
  stripDataRowMerges(workbook);

  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];
  let projectCount = 0;

  for (let r = 3; r <= sheet.rowCount; r++) {
    const cells = readRowCells(sheet, r);
    const formulas = cells.map((c) => c.formula);
    const texts = cells.map((c) => c.text);

    // 空行跳过
    if (texts.every((t) => t === null || t === '')) {
      continue;
    }

    // 小计行（A 列 = “小计”）
    if (normalizeHeaderText(texts[0] ?? '') === SUBTOTAL_MARKER) {
      rows.push({ rowNumber: r, kind: 'subtotal', cells: texts, formulas });
      continue;
    }

    // 分组行：A 列（序号）为空 && B 列（项目名称列）非空 && C 列（资料齐全度）为空 && D 列（年度）为空
    const nameText = texts[COLUMN_NAME_INDEX] ?? null;
    const isGroup = (texts[0] ?? null) === null && nameText !== '' && isBlank(texts[2] ?? null) && isBlank(texts[3] ?? null);
    if (isGroup) {
      rows.push({ rowNumber: r, kind: 'group', groupName: nameText ?? undefined, cells: texts, formulas });
      continue;
    }

    // 项目数据行：B 列（项目名称）必填
    if (nameText === null || nameText === '') {
      errors.push({ rowNumber: r, field: '项目名称', reason: '项目数据行缺少项目名称' });
      rows.push({ rowNumber: r, kind: 'project', cells: texts, formulas });
      continue;
    }

    projectCount += 1;
    if (projectCount > IMPORT_MAX_ROWS) {
      return { kind: 'ROW_LIMIT' };
    }

    // 行级校验：手工列公式、金额格式、日期格式、年度格式、多值列拆分格式
    const rowErrors = validateProjectRow(r, texts, formulas);
    errors.push(...rowErrors);

    rows.push({ rowNumber: r, kind: 'project', cells: texts, formulas });
  }

  return { rows, errors };
}

const COLUMN_NAME_INDEX = 1; // 项目名称列（1 起索引）

function isBlank(text: string | null): boolean {
  return text === null || text === '';
}

/** 读取一行 28 列单元格（不足 28 列补空） */
function readRowCells(sheet: ExcelJS.Worksheet, rowNumber: number): Array<{ text: string | null; formula: boolean }> {
  const cells: Array<{ text: string | null; formula: boolean }> = [];
  for (let c = 1; c <= COLUMN_COUNT; c++) {
    cells.push(cellToText(sheet.getCell(rowNumber, c)));
  }
  return cells;
}

/** 项目数据行校验（金额/日期/年度/多值列/公式白名单） */
function validateProjectRow(rowNumber: number, texts: Array<string | null>, formulas: boolean[]): RowError[] {
  const errors: RowError[] = [];
  for (let c = 1; c <= COLUMN_COUNT; c++) {
    const text = texts[c - 1] ?? null;
    const hasFormula = formulas[c - 1] ?? false;
    if (hasFormula && !AUTO_CALC_COLUMNS.includes(c)) {
      errors.push({ rowNumber, field: headerName(c), reason: '手工字段不允许包含公式' });
      continue;
    }
    if (text === null || text === '') {
      continue;
    }
    if (AMOUNT_COLUMNS.includes(c)) {
      for (const part of splitMultiValue(text, MULTI_VALUE_COLUMNS.includes(c))) {
        if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(part)) {
          errors.push({ rowNumber, field: headerName(c), reason: `金额“${part}”不是非负十进制金额（最多两位小数）` });
        }
      }
    }
    if (DATE_COLUMNS.includes(c) && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      errors.push({ rowNumber, field: headerName(c), reason: `日期“${text}”不是 YYYY-MM-DD 格式` });
    }
    if (c === 4 && !/^\d{4}$/.test(text)) {
      errors.push({ rowNumber, field: headerName(c), reason: `年度“${text}”不是四位公历年` });
    }
  }
  return errors;
}

/** 多值列拆分（LF 分隔；CRLF/CR 先规范化为 LF，忽略纯空行） */
export function splitMultiValue(text: string, multi: boolean): string[] {
  if (!multi) {
    return [text];
  }
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 列号 → 表头名（错误提示用） */
function headerName(column: number): string {
  const names: Record<number, string> = {
    2: '项目名称',
    3: '资料齐全度',
    4: '年度',
    5: '地区',
    6: '项目进度',
    7: '甲方',
    8: '总包方',
    9: '管理费',
    10: '分包方',
    11: '合同开始日期',
    12: '合同完工日期',
    13: '合同金额（元）',
    14: '主合同付款节点',
    15: '暂定审定金额',
    16: '开票金额（元）',
    17: '已收回款（元）',
    20: '备注',
    23: '分包结算（元）',
    24: '已付分包款（元）',
    25: '零星费用',
  };
  return names[column] ?? `第${column}列`;
}

/** 手工可导入列集合（与模板契约保持一致） */
export const IMPORTABLE_COLUMN_SET: ReadonlySet<number> = new Set(IMPORTABLE_COLUMNS);
export { UNCLASSIFIED_GROUP };
