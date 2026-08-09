import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { isUnclassifiedReservedName, normalizeProjectName, UNCLASSIFIED_GROUP_NAME } from './name-normalize';

/**
 * 项目业务键规范化（fin PRD §3）：
 * NFC 规范化 → 首尾去空白 → 连续空白归一 → 拉丁字母大小写折叠。
 */
describe('normalizeProjectName（业务键规范化）', () => {
  it('去除首尾空白并保留内部名称', () => {
    expect(normalizeProjectName('  城铁惠山站区工程  ')).toBe('城铁惠山站区工程');
  });

  it('连续空白归一化为单个空格', () => {
    expect(normalizeProjectName('惠山  污水  管网')).toBe('惠山 污水 管网');
    expect(normalizeProjectName('惠山\t污水\n管网')).toBe('惠山 污水 管网');
  });

  it('拉丁字母大小写折叠（全小写）', () => {
    expect(normalizeProjectName('ABC 工程')).toBe('abc 工程');
    expect(normalizeProjectName('AbC')).toBe('abc');
  });

  it('Unicode NFC 规范化（组合字符折叠为预组合形式）', () => {
    // 'é' 由 e + U+0301 组合
    const decomposed = 'étude';
    expect(decomposed.normalize('NFC')).toBe('étude');
    expect(normalizeProjectName(decomposed)).toBe('étude');
  });

  it('空字符串与纯空白', () => {
    expect(normalizeProjectName('')).toBe('');
    expect(normalizeProjectName('   ')).toBe('');
  });
});

describe('isUnclassifiedReservedName（未分类保留名）', () => {
  it('精确匹配保留名', () => {
    expect(isUnclassifiedReservedName(UNCLASSIFIED_GROUP_NAME)).toBe(true);
  });

  it('空白/大小写变体也视为冲突（规范化比较）', () => {
    expect(isUnclassifiedReservedName(' 未分类 ')).toBe(true);
    expect(isUnclassifiedReservedName('未 分类')).toBe(false);
  });

  it('其他名称不冲突', () => {
    expect(isUnclassifiedReservedName('自施工程')).toBe(false);
    expect(isUnclassifiedReservedName('未分类工程')).toBe(false);
  });
});
