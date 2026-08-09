import { frameworkErrors } from '@wbme/contracts';
import { describe, expect, it } from 'vitest';
import { buildTablePrismaQuery, buildTableSqlQuery, filterAndSortTableRows } from './table-query';

const FIELDS = {
  name: { prismaField: 'name', type: 'text' as const },
  status: { prismaField: 'status', type: 'enum' as const },
  count: { prismaField: 'count', type: 'number' as const },
  createdAt: { prismaField: 'createdAt', type: 'date' as const },
};

describe('buildTablePrismaQuery', () => {
  it('按资源白名单编译多条件和多级排序', () => {
    const result = buildTablePrismaQuery({
      filters: JSON.stringify({
        logic: 'AND',
        conditions: [
          { field: 'name', operator: 'CONTAINS', value: '项目' },
          { field: 'count', operator: 'GREATER_THAN_OR_EQUAL', value: '2' },
        ],
      }),
      sorts: JSON.stringify([{ field: 'count', direction: 'DESC' }, { field: 'name', direction: 'ASC' }]),
    }, FIELDS);

    expect(result).toEqual({
      where: {
        AND: [
          { name: { contains: '项目', mode: 'insensitive' } },
          { count: { gte: 2 } },
        ],
      },
      orderBy: [{ count: 'desc' }, { name: 'asc' }],
    });
  });

  it('正确保留组内 AND、组间 OR 的筛选语义', () => {
    const result = buildTablePrismaQuery({
      filters: JSON.stringify({
        logic: 'OR',
        groups: [
          { logic: 'AND', conditions: [{ field: 'status', operator: 'EQUALS', value: 'ACTIVE' }, { field: 'count', operator: 'LESS_THAN', value: '5' }] },
          { logic: 'AND', conditions: [{ field: 'name', operator: 'EQUALS', value: '特殊项目' }] },
        ],
      }),
    }, FIELDS);

    expect(result.where).toEqual({
      OR: [
        { AND: [{ status: 'ACTIVE' }, { count: { lt: 5 } }] },
        { AND: [{ name: { equals: '特殊项目', mode: 'insensitive' } }] },
      ],
    });
  });

  it('拒绝未注册字段和字段类型不支持的操作符', () => {
    const unregistered = () => buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'unknown', operator: 'EQUALS', value: 'x' }] }) }, FIELDS);
    const unsupported = () => buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'status', operator: 'CONTAINS', value: 'ACTIVE' }] }) }, FIELDS);
    expect(capturedError(unregistered)).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
    expect(capturedError(unsupported)).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
  });

  it('为只读 SQL 列表生成白名单排序和参数化筛选片段', () => {
    const result = buildTableSqlQuery({
      filters: JSON.stringify({
        logic: 'AND',
        conditions: [
          { field: 'service', operator: 'CONTAINS', value: 'asset' },
          { field: 'status', operator: 'EQUALS', value: 'PENDING' },
        ],
      }),
      sorts: JSON.stringify([{ field: 'lastSeenAt', direction: 'DESC' }, { field: 'id', direction: 'ASC' }]),
    }, {
      id: { column: 'id', type: 'number' },
      service: { column: 'service', type: 'text' },
      status: { column: 'status::text', type: 'enum' },
      lastSeenAt: { column: 'last_seen_at', type: 'date' },
    });

    expect(result).toEqual({
      whereSql: "(service ILIKE '%' || $1 || '%' AND status::text = $2)",
      params: ['asset', 'PENDING'],
      orderBySql: 'last_seen_at DESC, id ASC',
    });
  });

  it('支持 SQL 参数偏移，供调用方在既有范围条件之后安全追加结构化条件', () => {
    const result = buildTableSqlQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'service', operator: 'EQUALS', value: 'asset' }] }),
    }, {
      service: { column: 'service', type: 'text' },
    }, { parameterOffset: 2 });

    expect(result).toMatchObject({ whereSql: '(service ILIKE $3)', params: ['asset'] });
  });

  it('在已授权的聚合行上复用筛选组合与稳定多级排序', () => {
    const result = filterAndSortTableRows([
      { id: 1, name: '乙', minutes: 120 },
      { id: 2, name: '甲', minutes: 120 },
      { id: 3, name: '丙', minutes: 60 },
    ], {
      filters: JSON.stringify({ logic: 'OR', groups: [
        { logic: 'AND', conditions: [{ field: 'name', operator: 'CONTAINS', value: '甲' }] },
        { logic: 'AND', conditions: [{ field: 'minutes', operator: 'GREATER_THAN_OR_EQUAL', value: '120' }] },
      ] }),
      sorts: JSON.stringify([{ field: 'minutes', direction: 'DESC' }, { field: 'name', direction: 'ASC' }]),
    }, {
      id: { type: 'number', value: (row) => row.id },
      name: { type: 'text', value: (row) => row.name },
      minutes: { type: 'number', value: (row) => row.minutes },
    });

    expect(result.map((row) => row.id)).toEqual([2, 1]);
  });
});

function capturedError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('预期操作抛出校验错误');
}
