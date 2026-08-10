import { describe, expect, it } from 'vitest';
import { buildGroupedFilterPayload, OPERATOR_OPTIONS } from './DataTable';
import type { FilterCondition } from './DataTable';

/**
 * L28/L31 回归测试：
 * - 数字/金额筛选必须提供“不等于”操作符（与后端 table-query 的 NOT_EQUALS 对齐）；
 * - 条件组存在时 filters 负载顶层恒 OR、组内 AND（主 PRD §2.7），AND 主条件语义真实化。
 */

const condition = (field: string, value: string): FilterCondition => ({ field, operator: 'EQUALS', value });

describe('OPERATOR_OPTIONS.number（L28）', () => {
  it('数字筛选包含“不等于”（后端 table-query 已支持 NOT_EQUALS）', () => {
    const values = OPERATOR_OPTIONS.number.map((option) => option.value);
    expect(values).toContain('NOT_EQUALS');
    expect(OPERATOR_OPTIONS.number.find((option) => option.value === 'NOT_EQUALS')?.label).toBe('不等于');
  });

  it('文本与枚举筛选不受影响（原有操作符完整）', () => {
    expect(OPERATOR_OPTIONS.text.map((option) => option.value)).toContain('CONTAINS');
    expect(OPERATOR_OPTIONS.enum.map((option) => option.value)).toEqual(['EQUALS', 'NOT_EQUALS']);
  });
});

describe('buildGroupedFilterPayload（L31）', () => {
  it('无条件组：保持全局 AND/OR 原样', () => {
    expect(buildGroupedFilterPayload('AND', [condition('a', '1')], [])).toEqual({
      logic: 'AND',
      conditions: [condition('a', '1')],
    });
    expect(buildGroupedFilterPayload('OR', [condition('a', '1'), condition('b', '2')], [])).toEqual({
      logic: 'OR',
      conditions: [condition('a', '1'), condition('b', '2')],
    });
  });

  it('有条件组 + AND 主条件：主条件合并为一个 AND 组，顶层 OR', () => {
    const payload = buildGroupedFilterPayload(
      'AND',
      [condition('a', '1'), condition('b', '2')],
      [{ id: 'g1', conditions: [condition('c', '3')] }],
    );
    expect(payload.logic).toBe('OR');
    expect(payload.groups).toEqual([
      { logic: 'AND', conditions: [condition('a', '1'), condition('b', '2')] },
      { logic: 'AND', conditions: [condition('c', '3')] },
    ]);
  });

  it('有条件组 + OR 主条件：主条件拆为单条件 AND 组，与条件组同处顶层 OR', () => {
    const payload = buildGroupedFilterPayload(
      'OR',
      [condition('a', '1'), condition('b', '2')],
      [{ id: 'g1', conditions: [condition('c', '3'), condition('d', '4')] }],
    );
    expect(payload.logic).toBe('OR');
    expect(payload.groups).toEqual([
      { logic: 'AND', conditions: [condition('a', '1')] },
      { logic: 'AND', conditions: [condition('b', '2')] },
      { logic: 'AND', conditions: [condition('c', '3'), condition('d', '4')] },
    ]);
  });

  it('有条件组但主条件为空：仅保留条件组', () => {
    const payload = buildGroupedFilterPayload('AND', [], [{ id: 'g1', conditions: [condition('c', '3')] }]);
    expect(payload.logic).toBe('OR');
    expect(payload.groups).toEqual([{ logic: 'AND', conditions: [condition('c', '3')] }]);
  });
});
