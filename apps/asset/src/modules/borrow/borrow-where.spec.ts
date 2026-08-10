import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { buildBorrowWhereSql } from './borrow.service';

/**
 * M20 复核修复回归：keyword（物品/借用人关键字）查询条件生成。
 * 该函数输出经 $queryRawUnsafe 直拼 SQL——关键字中的单引号必须转义（防注入），
 * 且 ILIKE 模糊匹配必须落在 consumable_name / user_name 两个字段。
 */
describe('buildBorrowWhereSql keyword（M20）', () => {
  it('keyword 生成物品名/借用人姓名 ILIKE 条件', () => {
    const sql = buildBorrowWhereSql({ keyword: '电脑' });
    expect(sql).toContain("consumable_name ILIKE '%电脑%'");
    expect(sql).toContain("user_name ILIKE '%电脑%'");
    expect(sql).toContain('WHERE');
  });

  it('关键字中的单引号被转义为 SQL 字面量（防注入）', () => {
    const sql = buildBorrowWhereSql({ keyword: "O'Brien" });
    expect(sql).toContain("'%O''Brien%'");
    expect(sql).not.toContain("'O'Brien'");
  });

  it('keyword 与既有条件以 AND 组合', () => {
    const sql = buildBorrowWhereSql({ recordType: 'AGENT', keyword: '张三' });
    expect(sql).toContain("record_type = 'AGENT'");
    expect(sql).toContain("AND (consumable_name ILIKE '%张三%' OR user_name ILIKE '%张三%')");
  });

  it('无关键字时不生成 keyword 条件', () => {
    const sql = buildBorrowWhereSql({ recordType: 'PERSONAL' });
    expect(sql).not.toContain('ILIKE');
    expect(sql).toContain("record_type = 'PERSONAL'");
  });
});
