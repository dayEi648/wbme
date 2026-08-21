import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { normalizeTableFilters, type TableFilterTreeNode } from '@wbme/server';

/**
 * 加班历史记录的月份是「按单月聚合」的统计维度：只有「等于」能映射为唯一聚合月份，
 * 其余操作符（不等于/包含等）无法表达为单月统计，显式拒绝而非静默返回误导性结果。
 * 同一筛选树中出现多个不同月份值同样无法聚合为单月，一并拒绝。
 *
 * @param raw 原始 filters 查询参数（JSON 字符串）
 * @throws VALIDATION_FAILED 月份条件不是「等于」，或出现多个不同月份值
 */
export function assertMonthEqualsOnly(raw: string): void {
  const months = new Set<string>();
  walkMonthConditions(raw, (operator, value) => {
    if (operator !== 'EQUALS') {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: [{ field: 'filters', reason: '月份字段仅支持「等于」筛选' }],
      });
    }
    months.add(value);
  });
  if (months.size > 1) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
      fields: [{ field: 'filters', reason: '月份字段仅支持单个月份' }],
    });
  }
}

/**
 * 提取筛选树中首个月份「等于」条件的值，用于决定聚合月份。
 * 调用前必须先经 assertMonthEqualsOnly 校验（保证唯一且为等于）。
 *
 * @param raw 原始 filters 查询参数（JSON 字符串）
 * @returns 月份值（YYYY-MM）；无月份条件时为 undefined
 */
export function extractMonthEqualsValue(raw: string): string | undefined {
  let month: string | undefined;
  walkMonthConditions(raw, (operator, value) => {
    if (operator === 'EQUALS' && month === undefined) {
      month = value;
    }
  });
  return month;
}

/** 深度优先访问树中全部 month 条件（normalizeTableFilters 拒绝非法形状，此处不再容错）。 */
function walkMonthConditions(raw: string, visit: (operator: string, value: string) => void): void {
  const walk = (node: TableFilterTreeNode): void => {
    if ('conditions' in node) {
      node.conditions.forEach(walk);
      return;
    }
    if (node.field === 'month') {
      visit(node.operator, node.value);
    }
  };
  normalizeTableFilters(raw).conditions.forEach(walk);
}
