import { describe, expect, it } from 'vitest';
import { formatBeijingDateTime, formatDetailValue, formatDisplayValue, formatMoney } from './display-format';

describe('展示格式化', () => {
  it('将 UTC 时间以北京时间显示', () => {
    expect(formatBeijingDateTime('2026-08-10T01:23:00.000Z')).toBe('2026-08-10 09:23');
    expect(formatDisplayValue('2026-08-10T01:23:00.000Z', 'updatedAt')).toBe('2026-08-10 09:23');
  });

  it('金额按千分位展示且不损失十进制精度', () => {
    expect(formatMoney('12345678901234567890.50')).toBe('12,345,678,901,234,567,890.50');
  });

  it('详情嵌套对象使用中文字段名并格式化内部值', () => {
    expect(formatDetailValue({ updatedAt: '2026-08-10T01:23:00.000Z', contractAmount: '10000.00' })).toEqual({
      更新时间: '2026-08-10 09:23',
      contractAmount: '10,000.00',
    });
  });
});
