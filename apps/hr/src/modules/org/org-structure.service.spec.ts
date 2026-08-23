import { describe, expect, it } from 'vitest';
import { buildTableSqlQuery } from '@wbme/server';
import { ORG_EMPLOYEE_FILTER_FIELDS } from './org-structure.service';

describe('ORG_EMPLOYEE_FILTER_FIELDS', () => {
  it('name 排序编译为 ua.name ASC', () => {
    const compiled = buildTableSqlQuery(
      { sorts: JSON.stringify([{ field: 'name', direction: 'ASC' }]) },
      ORG_EMPLOYEE_FILTER_FIELDS,
    );

    expect(compiled.orderBySql).toBe('ua.name ASC, ua.user_id DESC');
  });

  it('name 筛选按姓名模糊匹配', () => {
    const compiled = buildTableSqlQuery(
      { filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator: 'CONTAINS', value: '张' }] }) },
      ORG_EMPLOYEE_FILTER_FIELDS,
    );

    expect(compiled.whereSql).toBe("(ua.name ILIKE '%' || $1 || '%')");
    expect(compiled.params).toEqual(['张']);
  });

  it('compile-only 字段排序返回 400', () => {
    expect(() =>
      buildTableSqlQuery(
        { sorts: JSON.stringify([{ field: 'departmentId', direction: 'ASC' }]) },
        ORG_EMPLOYEE_FILTER_FIELDS,
      ),
    ).toThrow();
  });
});
