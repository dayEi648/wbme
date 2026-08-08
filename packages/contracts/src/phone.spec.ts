import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhoneFromParts, normalizePhoneInput } from './phone';

describe('手机号规范化（base PRD §2 平台标准格式）', () => {
  it('钉钉来源：国家码 + 号码 → 平台标准格式', () => {
    expect(normalizePhoneFromParts('86', '13800138000')).toBe('+8613800138000');
    expect(normalizePhoneFromParts('+86', '13800138000')).toBe('+8613800138000');
    expect(normalizePhoneFromParts('0086', '13800138000')).toBe('+8613800138000');
    expect(normalizePhoneFromParts(undefined, '13800138000')).toBe('+8613800138000');
  });

  it('号码内空格/连字符/括号不影响规范化', () => {
    expect(normalizePhoneFromParts('86', '138 0013 8000')).toBe('+8613800138000');
    expect(normalizePhoneFromParts('86', '138-0013-8000')).toBe('+8613800138000');
  });

  it('用户输入：裸 11 位默认国家码', () => {
    expect(normalizePhoneInput('13800138000')).toBe('+8613800138000');
  });

  it('用户输入：带 +86 / 86 / 0086 前缀', () => {
    expect(normalizePhoneInput('+8613800138000')).toBe('+8613800138000');
    expect(normalizePhoneInput('8613800138000')).toBe('+8613800138000');
    expect(normalizePhoneInput('008613800138000')).toBe('+8613800138000');
    expect(normalizePhoneInput('+86 138-0013-8000')).toBe('+8613800138000');
  });

  it('非法输入返回 null（不产生脏数据）', () => {
    expect(normalizePhoneInput('')).toBeNull();
    expect(normalizePhoneInput('abc')).toBeNull();
    expect(normalizePhoneInput('138')).toBeNull();
    expect(normalizePhoneFromParts('86', '')).toBeNull();
    expect(normalizePhoneFromParts('86', 'not-a-phone')).toBeNull();
  });
});

describe('手机号脱敏（主 PRD §9.3：完整手机号不出现于日志/安全上下文）', () => {
  it('保留国家码与前 3 后 4', () => {
    expect(maskPhone('+8613800138000')).toBe('+86 138****8000');
  });

  it('非标准格式统一脱敏兜底', () => {
    expect(maskPhone('bad-value')).toBe('***');
  });
});
