import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BusinessException } from '@wbme/contracts';
import { buildBorrowWhereClause, buildBorrowWhereSql } from './borrow.service';

/**
 * 借还记录查询条件回归：
 * - 具名参数（keyword/settlementStatus 等）按原语义生成参数化 SQL；
 * - 结构化筛选（filters）与具名参数以 AND 合并，并按字段让位；
 * - keyword 支持文本全操作符、多列 OR/AND 组合。
 */
describe('buildBorrowWhereClause', () => {
  it('无参数时返回空 WHERE 片段', () => {
    const result = buildBorrowWhereClause({});
    expect(result.whereSql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('具名 keyword 生成 consumable_name / user_name CONTAINS 参数化条件', () => {
    const { whereSql, params } = buildBorrowWhereClause({ keyword: '电脑' });
    expect(whereSql).toContain('consumable_name ILIKE');
    expect(whereSql).toContain('user_name ILIKE');
    expect(whereSql).toContain(' OR ');
    expect(params).toEqual(['电脑']);
  });

  it('具名 keyword 与 recordType 以 AND 组合', () => {
    const { whereSql, params } = buildBorrowWhereClause({ recordType: 'AGENT', keyword: '张三' });
    expect(whereSql).toContain("record_type = 'AGENT'");
    expect(whereSql).toMatch(/AND \(\(consumable_name ILIKE '%' \|\| \$1 \|\| '%'\)/);
    expect(params).toEqual(['张三']);
  });

  it('结构化 keyword CONTAINS 生成同样多列 OR 条件', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'CONTAINS', value: '手机' }] });
    const { whereSql, params } = buildBorrowWhereClause({ filters });
    expect(whereSql).toContain('consumable_name ILIKE');
    expect(whereSql).toContain('user_name ILIKE');
    expect(params).toEqual(['手机']);
  });

  it('结构化 keyword EQUALS 使用 ILIKE 精确匹配', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'EQUALS', value: '电脑' }] });
    const { whereSql, params } = buildBorrowWhereClause({ filters });
    expect(whereSql).toContain('consumable_name ILIKE $1');
    expect(whereSql).toContain('user_name ILIKE $1');
    expect(params).toEqual(['电脑']);
  });

  it('结构化 keyword STARTS_WITH / ENDS_WITH 生成对应 ILIKE 模式', () => {
    const starts = JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'STARTS_WITH', value: 'A' }] });
    const { whereSql } = buildBorrowWhereClause({ filters: starts });
    expect(whereSql).toContain("ILIKE $1 || '%'");

    const ends = JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'ENDS_WITH', value: 'Z' }] });
    const { whereSql: endsSql } = buildBorrowWhereClause({ filters: ends });
    expect(endsSql).toContain("ILIKE '%' || $1");
  });

  it('结构化 keyword NOT_CONTAINS 按 AND 组合多列', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'NOT_CONTAINS', value: 'X' }] });
    const { whereSql } = buildBorrowWhereClause({ filters });
    expect(whereSql).toContain('NOT ILIKE');
    expect(whereSql).toMatch(/consumable_name NOT ILIKE[\s\S]*AND[\s\S]*user_name NOT ILIKE/);
  });

  it('结构化 keyword IS_EMPTY / IS_NOT_EMPTY 不依赖参数', () => {
    const empty = JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'IS_EMPTY', value: '' }] });
    const { whereSql, params } = buildBorrowWhereClause({ filters: empty });
    expect(whereSql).toContain('IS NULL');
    expect(whereSql).toContain("= ''");
    expect(params).toEqual([]);

    const notEmpty = JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'IS_NOT_EMPTY', value: '' }] });
    const { whereSql: notEmptySql } = buildBorrowWhereClause({ filters: notEmpty });
    expect(notEmptySql).toContain('IS NOT NULL');
  });

  it('结构化 settlementStatus EQUALS 生成未结清/已结清派生条件', () => {
    const open = JSON.stringify({ logic: 'AND', conditions: [{ field: 'settlementStatus', operator: 'EQUALS', value: 'OPEN' }] });
    const { whereSql } = buildBorrowWhereClause({ filters: open });
    expect(whereSql).toContain('(qty - returned_qty - written_off_qty) > 0');

    const settled = JSON.stringify({ logic: 'AND', conditions: [{ field: 'settlementStatus', operator: 'EQUALS', value: 'SETTLED' }] });
    const { whereSql: settledSql } = buildBorrowWhereClause({ filters: settled });
    expect(settledSql).toContain('(qty - returned_qty - written_off_qty) = 0');
  });

  it('filters 与具名参数按字段让位：keyword 在树中时具名 keyword 被跳过', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'EQUALS', value: 'F' }] });
    const { whereSql, params } = buildBorrowWhereClause({ keyword: 'N', filters });
    expect(params).toEqual(['F']);
    expect(whereSql).not.toContain("'%' || $1 || '%'");
    expect(whereSql).toContain('consumable_name ILIKE $1');
  });

  it('filters 与具名参数按字段让位：settlementStatus 在树中时具名 settlementStatus 被跳过', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'settlementStatus', operator: 'EQUALS', value: 'OPEN' }] });
    const { whereSql } = buildBorrowWhereClause({ settlementStatus: 'SETTLED', filters });
    expect(whereSql).toContain('> 0');
    expect(whereSql).not.toContain('= 0');
  });

  it('departmentIds 为空集时直接返回恒假条件', () => {
    const { whereSql, params } = buildBorrowWhereClause({ departmentIds: new Set<number>() });
    expect(whereSql).toBe('WHERE 1 = 0');
    expect(params).toEqual([]);
  });

  it('filters 中未知字段抛出校验错误', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'unknownField', operator: 'EQUALS', value: 'x' }] });
    expect(() => buildBorrowWhereClause({ filters })).toThrow(BusinessException);
  });

  it('filters 中字段不支持的操作符抛出校验错误', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'settlementStatus', operator: 'CONTAINS', value: 'OPEN' }] });
    expect(() => buildBorrowWhereClause({ filters })).toThrow(BusinessException);
  });

  it('sorts 与 filters 在同一次调用中编译并返回 orderBySql', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'qty', operator: 'GREATER_THAN', value: '5' }] });
    const sorts = JSON.stringify([{ field: 'createdAt', direction: 'DESC' }, { field: 'qty', direction: 'ASC' }]);
    const { whereSql, params, orderBySql } = buildBorrowWhereClause({ filters, sorts });
    expect(whereSql).toContain('qty > $1');
    expect(params).toEqual([5]);
    expect(orderBySql).toBe('created_at DESC, qty ASC');
  });

  it('仅有 sorts 时返回空 WHERE 与 orderBySql', () => {
    const sorts = JSON.stringify([{ field: 'dueAt', direction: 'ASC' }]);
    const { whereSql, params, orderBySql } = buildBorrowWhereClause({ sorts });
    expect(whereSql).toBe('');
    expect(params).toEqual([]);
    expect(orderBySql).toBe('due_at ASC');
  });

  it('无 sorts 时不返回 orderBySql，调用方保持默认排序', () => {
    const { orderBySql } = buildBorrowWhereClause({ recordType: 'PERSONAL' });
    expect(orderBySql).toBeUndefined();
  });
});

/**
 * 旧版 buildBorrowWhereSql 兼容：返回值仅 WHERE 片段（参数化），历史调用点/单测做回归断言。
 */
describe('buildBorrowWhereSql 兼容性', () => {
  it('keyword 仍生成多列 ILIKE 条件', () => {
    const sql = buildBorrowWhereSql({ keyword: '电脑' });
    expect(sql).toContain('consumable_name ILIKE');
    expect(sql).toContain('user_name ILIKE');
    expect(sql).toContain('WHERE');
  });

  it('keyword 与 recordType 以 AND 组合', () => {
    const sql = buildBorrowWhereSql({ recordType: 'AGENT', keyword: '张三' });
    expect(sql).toContain("record_type = 'AGENT'");
    expect(sql).toContain('AND');
  });

  it('无 keyword 时不生成 ILIKE 条件', () => {
    const sql = buildBorrowWhereSql({ recordType: 'PERSONAL' });
    expect(sql).not.toContain('ILIKE');
    expect(sql).toContain("record_type = 'PERSONAL'");
  });
});
