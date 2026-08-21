import { frameworkErrors } from '@wbme/contracts';
import { describe, expect, it } from 'vitest';
import { assertMonthEqualsOnly, extractMonthEqualsValue } from './month-filter';

describe('加班历史记录月份筛选守卫（month-filter）', () => {
  it('无月份条件或唯一「等于」月份通过（含子组嵌套与重复同值）', () => {
    expect(() => assertMonthEqualsOnly(JSON.stringify({
      logic: 'AND',
      conditions: [{ field: 'keyword', operator: 'CONTAINS', value: '张' }],
    }))).not.toThrow();
    expect(() => assertMonthEqualsOnly(JSON.stringify({
      logic: 'AND',
      conditions: [{ field: 'month', operator: 'EQUALS', value: '2026-08' }],
    }))).not.toThrow();
    expect(() => assertMonthEqualsOnly(JSON.stringify({
      logic: 'OR',
      conditions: [
        { field: 'month', operator: 'EQUALS', value: '2026-08' },
        { logic: 'AND', conditions: [{ field: 'month', operator: 'EQUALS', value: '2026-08' }] },
      ],
    }))).not.toThrow();
  });

  it('月份使用非「等于」操作符时显式拒绝', () => {
    for (const operator of ['NOT_EQUALS', 'CONTAINS', 'STARTS_WITH', 'IS_EMPTY']) {
      const raw = JSON.stringify({
        logic: 'AND',
        conditions: [{ field: 'month', operator, value: operator === 'IS_EMPTY' ? '' : '2026-08' }],
      });
      expect(capturedError(() => assertMonthEqualsOnly(raw))).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
    }
  });

  it('多个不同月份值拒绝（单月聚合维度无法表达月份并集）', () => {
    const raw = JSON.stringify({
      logic: 'OR',
      conditions: [
        { field: 'month', operator: 'EQUALS', value: '2026-08' },
        { field: 'month', operator: 'EQUALS', value: '2026-09' },
      ],
    });
    expect(capturedError(() => assertMonthEqualsOnly(raw))).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
  });

  it('extractMonthEqualsValue 提取子组内的等于值；无月份条件返回 undefined', () => {
    expect(extractMonthEqualsValue(JSON.stringify({
      logic: 'AND',
      conditions: [{ field: 'keyword', operator: 'CONTAINS', value: 'x' }],
    }))).toBeUndefined();
    expect(extractMonthEqualsValue(JSON.stringify({
      logic: 'OR',
      conditions: [{ logic: 'AND', conditions: [{ field: 'month', operator: 'EQUALS', value: '2026-08' }] }],
    }))).toBe('2026-08');
  });

  it('非法 filters 形状抛校验错误', () => {
    expect(capturedError(() => assertMonthEqualsOnly('not-json'))).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
  });
});

function capturedError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('预期操作抛出校验错误');
}
