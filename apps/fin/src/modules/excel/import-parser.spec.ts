import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { loadTemplateWorkbook } from './export-builder';
import { parseImportBuffer, splitMultiValue, type ParseFailure, type ParseResult } from './import-parser';
import { COL, WORKBOOK_SHEET_NAME } from './xlsx-template';

/** 列字母 → 列号（A=1） */
function colNumber(colKey: string): number {
  let result = 0;
  for (const ch of colKey) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result;
}

/** 生成测试工作簿（基于运行模板填数据行；返回 buffer） */
async function buildTestWorkbook(rows: Array<Record<string, string | number | null>>): Promise<Buffer> {
  const workbook = await loadTemplateWorkbook();
  const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
  let rowNumber = 3;
  for (const row of rows) {
    for (const [colKey, value] of Object.entries(row)) {
      sheet.getCell(rowNumber, colNumber(colKey)).value = value;
    }
    rowNumber += 1;
  }
  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/** 解析并断言成功 */
async function parseOk(buffer: Buffer): Promise<ParseResult> {
  const result = await parseImportBuffer(buffer);
  expect('kind' in result).toBe(false);
  return result as ParseResult;
}

/** 解析并断言整文件失败 */
async function parseFail(buffer: Buffer): Promise<ParseFailure> {
  const result = await parseImportBuffer(buffer);
  expect('kind' in result).toBe(true);
  return result as ParseFailure;
}

/**
 * 利润分析导入解析（fin PRD §4）：
 * 分组行/小计行/数据行识别、多值 LF 拆分、公式白名单、金额/日期/年度校验、
 * 模板签名与安全上限。
 */
describe('parseImportBuffer（导入解析）', () => {
  it('空文件（仅标题+表头）解析成功且无数据行', async () => {
    const buffer = await buildTestWorkbook([]);
    const result = await parseOk(buffer);
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('识别分组行（A 空、B 分类名、C/D 空）与项目数据行', async () => {
    const buffer = await buildTestWorkbook([
      { A: null, B: '自施工程' },
      { A: 1, B: '城铁惠山站区工程', D: 2020, E: '前洲' },
      { A: null, B: '未分类' },
      { A: 2, B: '惠山区污水管网改造工程', D: 2021 },
    ]);
    const result = await parseOk(buffer);
    expect(result.rows.map((row) => row.kind)).toEqual(['group', 'project', 'group', 'project']);
    expect(result.rows[0]?.groupName).toBe('自施工程');
    expect(result.rows[2]?.groupName).toBe('未分类');
    expect(result.rows[1]?.cells[COL.NAME - 1]).toBe('城铁惠山站区工程');
    expect(result.rows[1]?.cells[COL.YEAR - 1]).toBe('2020');
  });

  it('识别小计行（A 列“小计”）并跳过', async () => {
    const buffer = await buildTestWorkbook([{ A: null, B: '自施工程' }, { A: '小计', B: null }]);
    const result = await parseOk(buffer);
    expect(result.rows.map((row) => row.kind)).toEqual(['group', 'subtotal']);
  });

  it('多值单元格按 LF 拆分（CRLF/CR 规范化、忽略纯空行）', async () => {
    const buffer = await buildTestWorkbook([
      { A: 1, B: '项目A', J: '分包甲\n分包乙\r\n\r\n分包丙' },
    ]);
    const result = await parseOk(buffer);
    const cells = (result.rows[0] as { cells: Array<string | null> }).cells;
    expect(splitMultiValue(cells[COL.SUBCONTRACTORS - 1] ?? '', true)).toEqual(['分包甲', '分包乙', '分包丙']);
  });

  it('手工列公式 → 行级错误（IMPORT_FORMULA_NOT_ALLOWED 语义）；自动列公式可容忍', async () => {
    const workbook = await loadTemplateWorkbook();
    const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
    sheet.getCell(3, COL.NAME).value = '项目A';
    sheet.getCell(3, COL.YEAR).value = 2020;
    sheet.getCell(3, COL.CONTRACT_AMOUNT).value = { formula: 'SUM(1,2)', result: 3 };
    sheet.getCell(3, COL.TOTAL_RECEIVED).value = { formula: 'SUM(B3:B3)', result: 0 };
    const buffer = workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
    const result = await parseOk(await buffer);
    const errors = result.errors.filter((error) => error.reason.includes('公式'));
    expect(errors.length).toBe(1);
    expect(errors[0]?.field).toBe('合同金额（元）');
    expect(result.rows[0]?.kind).toBe('project');
  });

  it('文本单元格超长（超过页面 DTO 长度上限）→ 行级错误（L22）', async () => {
    const buffer = await buildTestWorkbook([{ A: 1, B: 'x'.repeat(201), D: 2020 }]);
    const result = await parseOk(buffer);
    const errors = result.errors.filter((error) => error.reason.includes('字符上限'));
    expect(errors.length).toBe(1);
    expect(errors[0]?.field).toBe('项目名称');
    expect(result.rows[0]?.kind).toBe('project');
  });

  it('分组行手工列公式 → 行级错误（L23：与数据行同一白名单）', async () => {
    const workbook = await loadTemplateWorkbook();
    const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
    sheet.getCell(3, 1).value = null; // A 空 → 分组行
    sheet.getCell(3, 2).value = '自施工程'; // B 分类名
    sheet.getCell(3, COL.CONTRACT_AMOUNT).value = { formula: 'SUM(1,2)', result: 3 };
    const buffer = workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
    const result = await parseOk(await buffer);
    const errors = result.errors.filter((error) => error.reason.includes('公式'));
    expect(errors.length).toBe(1);
    expect(result.rows[0]?.kind).toBe('group');
  });

  it('金额/日期/年度格式非法 → 行级错误（整文件仍解析成功）', async () => {
    const buffer = await buildTestWorkbook([
      { A: 1, B: '项目A', D: 20, M: '一百万元', K: '2026/01/01' },
    ]);
    const result = await parseOk(buffer);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    const reasons = result.errors.map((error) => error.reason).join('；');
    expect(reasons).toContain('年度');
    expect(reasons).toContain('金额');
    expect(reasons).toContain('日期');
  });

  it('年度 0000～0999 超范围 → 行级错误（fin PRD §3：1000～9999 四位公历年）', async () => {
    const buffer = await buildTestWorkbook([
      { A: 1, B: '项目A', D: 0 },
      { A: 2, B: '项目B', D: 999 },
    ]);
    const result = await parseOk(buffer);
    const yearErrors = result.errors.filter((error) => error.reason.includes('公历年'));
    expect(yearErrors.length).toBe(2);
  });

  it('分包方规范化后重复项 → 行级错误（fin PRD §4：保留用户文字与顺序）', async () => {
    const buffer = await buildTestWorkbook([
      { A: 1, B: '项目A', J: '分包甲\n分包甲' },
      { A: 2, B: '项目B', J: '分包 乙\n分包  乙' },
    ]);
    const result = await parseOk(buffer);
    const dupErrors = result.errors.filter((error) => error.reason.includes('重复'));
    expect(dupErrors.length).toBe(2);
  });

  it('模板签名不匹配（表头漂移）→ SHEET_INVALID', async () => {
    const workbook = await loadTemplateWorkbook();
    const sheet = workbook.getWorksheet(WORKBOOK_SHEET_NAME) as ExcelJS.Worksheet;
    sheet.getCell(2, COL.NAME).value = '项目名称（改）';
    const buffer = workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
    const failure = await parseFail(await buffer);
    expect(failure.kind).toBe('SHEET_INVALID');
  });

  it('非 XLSX 文件 → ZIP_CORRUPT', async () => {
    const failure = await parseFail(Buffer.from('这不是一个zip文件'));
    expect(failure.kind).toBe('ZIP_CORRUPT');
  });

  it('条目数超限 → ARCHIVE_LIMIT（构造 1001 个条目）', async () => {
    const JSZip = await import('jszip').then((m) => m.default);
    const zip = new JSZip();
    for (let i = 0; i < 1001; i++) {
      zip.file(`f${i}.txt`, 'x');
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const failure = await parseFail(Buffer.from(buffer));
    expect(failure.kind).toBe('ARCHIVE_LIMIT');
  });

  it('非法条目（__MACOSX 隐藏文件形态）→ ARCHIVE_LIMIT', async () => {
    // JSZip 会自动清理 ../ 穿越名称，无法用它构造；__MACOSX 条目名不被清理且为非法条目
    const JSZip = await import('jszip').then((m) => m.default);
    const zip = new JSZip();
    zip.file('__MACOSX/.DS_Store', 'x');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const failure = await parseFail(Buffer.from(buffer));
    expect(failure.kind).toBe('ARCHIVE_LIMIT');
  });
});
