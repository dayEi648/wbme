import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { type DisposalQueryDto } from '@wbme/contracts';
import { buildDisposalRecordWhereClause } from './disposal.service';

/**
 * 处置记录列表查询条件回归（GAP-3）：
 * - filters 与 sorts 在同一次 buildTableSqlQuery 调用中编译；
 * - 返回 orderBySql 供记录查询使用，无 sorts 时返回 undefined；
 * - 默认排序由调用方保持。
 */
describe('buildDisposalRecordWhereClause', () => {
  const query = (overrides: Partial<DisposalQueryDto>): DisposalQueryDto =>
    ({ tab: 'RECORDS', page: 1, pageSize: 20, ...overrides });

  it('无参数时返回 TRUE 条件且无 orderBySql', () => {
    const result = buildDisposalRecordWhereClause(query({}), { kind: 'COMPANY' });
    expect(result.whereSql).toBe('TRUE');
    expect(result.params).toEqual([]);
    expect(result.orderBySql).toBeUndefined();
  });

  it('sorts 与 filters 同次编译并返回 orderBySql', () => {
    const filters = JSON.stringify({ logic: 'AND', conditions: [{ field: 'disposalType', operator: 'EQUALS', value: 'RETURN' }] });
    const sorts = JSON.stringify([{ field: 'createdAt', direction: 'DESC' }]);
    const result = buildDisposalRecordWhereClause(
      query({ filters, sorts }),
      { kind: 'COMPANY' },
    );
    expect(result.whereSql).toContain("dr.disposal_type = $1");
    expect(result.params).toEqual(['RETURN']);
    expect(result.orderBySql).toBe('dr.created_at DESC');
  });

  it('仅有 sorts 时返回 TRUE 条件与 orderBySql', () => {
    const sorts = JSON.stringify([{ field: 'userName', direction: 'ASC' }]);
    const result = buildDisposalRecordWhereClause(
      query({ sorts }),
      { kind: 'COMPANY' },
    );
    expect(result.whereSql).toBe('TRUE');
    expect(result.params).toEqual([]);
    expect(result.orderBySql).toBe("COALESCE(dr.user_name, ar.applicant_name, '') ASC");
  });

  it('部门范围与 sorts 同时存在时参数编号连续', () => {
    const sorts = JSON.stringify([{ field: 'createdAt', direction: 'ASC' }]);
    const result = buildDisposalRecordWhereClause(
      query({ sorts }),
      { kind: 'DEPARTMENT', departmentIds: new Set([1, 2]) },
    );
    expect(result.params).toEqual([[1, 2]]);
    expect(result.orderBySql).toBe('dr.created_at ASC');
  });
});
