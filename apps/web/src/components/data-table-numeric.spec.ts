import { describe, expect, it } from 'vitest';
import { isNumericCell, type DataColumn } from './DataTable';

/**
 * L29 回归测试：数字/金额列等宽数字字体（tabular-nums）的判定逻辑。
 * 调用方列定义多数未声明 type:'number'（数据源即数值类型），因此列值本身
 * 为 number 时同样视为数字列——防止"组件能力就绪但全站列未接线"问题复发。
 */

function column(partial: Partial<DataColumn> = {}): DataColumn {
  return { key: 'k', title: '列', ...partial };
}

describe('isNumericCell（L29）', () => {
  it('显式声明 type:number 视为数字列（即使值为字符串）', () => {
    expect(isNumericCell(column({ type: 'number' }), '1,234.56')).toBe(true);
  });

  it('未声明 type 但列值为 number 视为数字列（调用方未接线的数据源数值列）', () => {
    expect(isNumericCell(column(), 1234.56)).toBe(true);
  });

  it('未声明 type 且列值为字符串/对象/null 不视为数字列', () => {
    expect(isNumericCell(column(), '资产名称')).toBe(false);
    expect(isNumericCell(column(), null)).toBe(false);
    expect(isNumericCell(column(), { a: 1 })).toBe(false);
  });

  it('显式声明非数字 type（如 date/text）且值为 number 仍视为数字列（数值内容等宽无害）', () => {
    expect(isNumericCell(column({ type: 'date' }), 2026)).toBe(true);
  });
});
