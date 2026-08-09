import 'reflect-metadata';
import type ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  COLUMN_COUNT,
  matchesTemplateSignature,
  normalizeHeaderText,
  templateFilePath,
  TEMPLATE_HEADERS,
  TITLE_MERGE,
} from './xlsx-template';
import { loadTemplateWorkbook } from './export-builder';

/**
 * 模板契约测试（fin PRD §4）：
 * - 运行模板（src/assets）必须存在且 28 列表头与 TEMPLATE_HEADERS 一一对应（防漂移）；
 * - 签名函数按空白/换行归一化比较表头，并校验 A1:AB1 标题合并。
 */
describe('利润分析 V2 运行模板契约', () => {
  it('运行模板文件存在', () => {
    expect(existsSync(templateFilePath())).toBe(true);
  });

  it('模板表头与常量完全一致（28 列有序；含换行表头按归一化比较）', async () => {
    const workbook = await loadTemplateWorkbook();
    expect(workbook.worksheets.length).toBe(1);
    const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;
    const headers: string[] = [];
    for (let c = 1; c <= COLUMN_COUNT; c++) {
      const value = sheet.getCell(2, c).value;
      headers.push(value === null ? '' : String(value));
    }
    expect(headers.length).toBe(COLUMN_COUNT);
    for (let i = 0; i < COLUMN_COUNT; i++) {
      expect(normalizeHeaderText(headers[i] as string)).toBe(normalizeHeaderText(TEMPLATE_HEADERS[i] as string));
    }
  });

  it('标题行合并为 A1:AB1（模板关键合并结构）', async () => {
    const workbook = await loadTemplateWorkbook();
    const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;
    expect(sheet.model.merges?.some((m) => m === TITLE_MERGE)).toBe(true);
  });

  it('matchesTemplateSignature：匹配通过、表头漂移拒绝、合并缺失拒绝', () => {
    expect(matchesTemplateSignature('利润分析汇总', TEMPLATE_HEADERS, TITLE_MERGE)).toBe(true);
    const drifted = [...TEMPLATE_HEADERS];
    drifted[2] = '资料齐全度（改了）';
    expect(matchesTemplateSignature('任意名称', drifted, TITLE_MERGE)).toBe(false);
    expect(matchesTemplateSignature('任意名称', TEMPLATE_HEADERS, null)).toBe(false);
    // 列数不足拒绝
    expect(matchesTemplateSignature('任意名称', TEMPLATE_HEADERS.slice(0, 10), TITLE_MERGE)).toBe(false);
  });

  it('表头文本归一化（换行/空白移除）', () => {
    expect(normalizeHeaderText('分包结算\n（元）')).toBe('分包结算（元）');
    expect(normalizeHeaderText(' 累计  收款（元） ')).toBe('累计收款（元）');
  });
});
