import { describe, expect, it } from 'vitest';
import { isFieldRequired, matchesFieldCondition, resolveColumnSpan, type FormField } from './ResourceFormModal';

describe('配置表单条件字段', () => {
  it('只在命中指定处置方式时展示对应字段', () => {
    const condition = { field: 'disposalType', equals: ['RETURN', 'WRITE_OFF'] as Array<string> };
    expect(matchesFieldCondition(condition, { disposalType: 'RETURN' })).toBe(true);
    expect(matchesFieldCondition(condition, { disposalType: 'AGENT_SETTLE' })).toBe(false);
  });

  it('核销类型仅在核销方式下变为必填', () => {
    const field: FormField = {
      key: 'writeOffType',
      label: '核销类型',
      type: 'select',
      requiredWhen: { field: 'method', equals: 'WRITE_OFF' },
    };
    expect(isFieldRequired(field, { method: 'WRITE_OFF' })).toBe(true);
    expect(isFieldRequired(field, { method: 'RETURN' })).toBe(false);
  });
});

describe('配置表单字段列宽', () => {
  it('显式 width 四档映射到 24 栅格', () => {
    expect(resolveColumnSpan({ key: 'a', label: 'a', width: 'narrow' })).toBe(8);
    expect(resolveColumnSpan({ key: 'b', label: 'b', width: 'regular' })).toBe(12);
    expect(resolveColumnSpan({ key: 'c', label: 'c', width: 'wide' })).toBe(16);
    expect(resolveColumnSpan({ key: 'd', label: 'd', width: 'full' })).toBe(24);
  });

  it('未声明 width 时按类型给默认值', () => {
    expect(resolveColumnSpan({ key: 'n', label: 'n', type: 'number' })).toBe(8);
    expect(resolveColumnSpan({ key: 'd', label: 'd', type: 'date' })).toBe(8);
    expect(resolveColumnSpan({ key: 's', label: 's', type: 'boolean' })).toBe(8);
    expect(resolveColumnSpan({ key: 't', label: 't', type: 'text' })).toBe(12);
    expect(resolveColumnSpan({ key: 'r', label: 'r', type: 'remote-select' })).toBe(12);
    expect(resolveColumnSpan({ key: 'ta', label: 'ta', type: 'textarea' })).toBe(24);
    expect(resolveColumnSpan({ key: 'dl', label: 'dl', type: 'detail-list' })).toBe(24);
  });
});
