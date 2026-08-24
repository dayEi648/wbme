import { describe, expect, it } from 'vitest';
import { enumOptions, formatEnumLabel } from './enum-display';
import { formatDisplayValue } from './display-format';

describe('枚举中文展示', () => {
  it('按业务领域翻译同一编码，避免 ACTIVE 被错误套用为单一文案', () => {
    expect(formatEnumLabel('userStatus', 'ACTIVE')).toBe('正常');
    expect(formatEnumLabel('dictionaryStatus', 'ACTIVE')).toBe('启用');
    expect(formatEnumLabel('qrStatus', 'ACTIVE')).toBe('有效');
  });

  it('将操作日志等接口编码转换为用户可读中文', () => {
    expect(formatEnumLabel('operationAction', 'QUERY')).toBe('查询');
    expect(formatDisplayValue('UPDATE', 'actionType', 'operationAction')).toBe('更新');
  });

  it('选择器使用中文标签，同时保留接口所需英文提交值', () => {
    expect(enumOptions('writeOffType')).toEqual([
      { label: '遗失', value: 'LOST' },
      { label: '损坏', value: 'DAMAGED' },
    ]);
  });

  it('未知编码不直接暴露给业务用户', () => {
    expect(formatEnumLabel('approvalStatus', 'UNRECOGNIZED')).toBe('未知');
  });
});
