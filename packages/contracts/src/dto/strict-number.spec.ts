import { describe, expect, it } from 'vitest';
import { transformPositiveInt } from './strict-number';

/**
 * 数量严格解析（asset PRD §5：不接受小数、零、负数、科学计数法或非数值文本）。
 * 纯单测，无数据库依赖。
 */
describe('transformPositiveInt（数量字段严格解析，P3 修复）', () => {
  it('接受纯数字文本与正整数', () => {
    expect(transformPositiveInt({ value: '5' })).toBe(5);
    expect(transformPositiveInt({ value: '100' })).toBe(100);
    expect(transformPositiveInt({ value: 5 })).toBe(5);
    expect(transformPositiveInt({ value: 100 })).toBe(100);
  });

  it('拒绝科学计数法文本', () => {
    expect(() => transformPositiveInt({ value: '1e2' })).toThrow();
    expect(() => transformPositiveInt({ value: '1E2' })).toThrow();
    expect(() => transformPositiveInt({ value: '1e-2' })).toThrow();
  });

  it('拒绝小数文本与小数数字', () => {
    expect(() => transformPositiveInt({ value: '1.5' })).toThrow();
    expect(() => transformPositiveInt({ value: '1.0' })).toThrow();
    expect(() => transformPositiveInt({ value: 1.5 })).toThrow();
    expect(() => transformPositiveInt({ value: 0.5 })).toThrow();
  });

  it('拒绝零、负数、非数值文本与其他类型', () => {
    expect(() => transformPositiveInt({ value: '0' })).toThrow();
    expect(() => transformPositiveInt({ value: '-1' })).toThrow();
    expect(() => transformPositiveInt({ value: 0 })).toThrow();
    expect(() => transformPositiveInt({ value: -1 })).toThrow();
    expect(() => transformPositiveInt({ value: 'abc' })).toThrow();
    expect(() => transformPositiveInt({ value: '' })).toThrow();
    expect(() => transformPositiveInt({ value: null })).toThrow();
    expect(() => transformPositiveInt({ value: true })).toThrow();
    expect(() => transformPositiveInt({ value: [] })).toThrow();
    expect(() => transformPositiveInt({ value: undefined })).toThrow();
  });
});
