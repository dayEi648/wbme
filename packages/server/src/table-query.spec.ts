import { frameworkErrors } from '@wbme/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTablePrismaQuery,
  buildTableSqlQuery,
  collectTableFilterFields,
  filterAndSortTableRows,
  normalizeTableFilters,
  type TableConditionContext,
  type TableInMemoryField,
  type TableSqlField,
} from './table-query';

const FIELDS = {
  id: { prismaField: 'id', type: 'number' as const },
  name: { prismaField: 'name', type: 'text' as const },
  status: { prismaField: 'status', type: 'enum' as const },
  count: { prismaField: 'count', type: 'number' as const },
  createdAt: { prismaField: 'createdAt', type: 'date' as const },
};

const SQL_FIELDS = {
  id: { column: 'id', type: 'number' as const },
  name: { column: 'name', type: 'text' as const },
  status: { column: 'status::text', type: 'enum' as const },
  count: { column: 'count', type: 'number' as const },
  createdAt: { column: 'created_at', type: 'date' as const },
};

interface MemoryRow {
  id: number;
  name: string | null;
  status: string | null;
  count: number | null;
  createdAt: Date | string | null;
}

const MEMORY_FIELDS: Record<string, TableInMemoryField<MemoryRow>> = {
  name: { type: 'text', value: (row) => row.name },
  status: { type: 'enum', value: (row) => row.status },
  count: { type: 'number', value: (row) => row.count },
  createdAt: { type: 'date', value: (row) => row.createdAt },
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
      orderBy: [{ count: 'desc' }, { name: 'asc' }, { id: 'desc' }],
    });
  });

  it('自定义排序已包含 id 时不重复追加唯一性兜底', () => {
    const result = buildTablePrismaQuery({
      sorts: JSON.stringify([{ field: 'name', direction: 'ASC' }, { field: 'id', direction: 'ASC' }]),
    }, FIELDS);

    expect(result.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
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

  it('SQL 自定义排序自动追加注册的 id 列作为唯一性兜底', () => {
    const result = buildTableSqlQuery({
      sorts: JSON.stringify([{ field: 'name', direction: 'ASC' }]),
    }, SQL_FIELDS);

    expect(result.orderBySql).toBe('name ASC, id DESC');
  });

  it('SQL 自定义排序已包含 id 时不重复追加唯一性兜底', () => {
    const result = buildTableSqlQuery({
      sorts: JSON.stringify([{ field: 'name', direction: 'ASC' }, { field: 'id', direction: 'ASC' }]),
    }, SQL_FIELDS);

    expect(result.orderBySql).toBe('name ASC, id ASC');
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

describe('树形条件组协议', () => {
  // AND 根下混排单条条件与 OR 子组
  const treeFilters = JSON.stringify({
    logic: 'AND',
    conditions: [
      { field: 'status', operator: 'EQUALS', value: 'ACTIVE' },
      {
        logic: 'OR',
        conditions: [
          { field: 'name', operator: 'CONTAINS', value: '项目' },
          { field: 'count', operator: 'LESS_THAN', value: '5' },
        ],
      },
    ],
  });

  it('Prisma 递归编译为嵌套 AND/OR 结构', () => {
    const result = buildTablePrismaQuery({ filters: treeFilters }, FIELDS);

    expect(result.where).toEqual({
      AND: [
        { status: 'ACTIVE' },
        { OR: [{ name: { contains: '项目', mode: 'insensitive' } }, { count: { lt: 5 } }] },
      ],
    });
  });

  it('SQL 递归编译括号包裹并保持参数顺序', () => {
    const result = buildTableSqlQuery({ filters: treeFilters }, SQL_FIELDS);

    expect(result.whereSql).toBe("(status::text = $1 AND (name ILIKE '%' || $2 || '%' OR count < $3))");
    expect(result.params).toEqual(['ACTIVE', '项目', 5]);
  });

  it('内存递归按组逻辑过滤行', () => {
    const rows: MemoryRow[] = [
      { id: 1, name: '建设项目', status: 'ACTIVE', count: 9, createdAt: null },
      { id: 2, name: '其它', status: 'ACTIVE', count: 3, createdAt: null },
      { id: 3, name: '其它', status: 'ACTIVE', count: 9, createdAt: null },
      { id: 4, name: '建设项目', status: 'DISABLED', count: 1, createdAt: null },
    ];

    const result = filterAndSortTableRows(rows, { filters: treeFilters }, MEMORY_FIELDS);

    expect(result.map((row) => row.id)).toEqual([1, 2]);
  });

  it('旧 OR-groups 形状归一化为等价的新树', () => {
    const legacy = {
      logic: 'OR',
      groups: [
        { logic: 'AND', conditions: [{ field: 'status', operator: 'EQUALS', value: 'ACTIVE' }, { field: 'count', operator: 'LESS_THAN', value: '5' }] },
        { logic: 'AND', conditions: [{ field: 'name', operator: 'EQUALS', value: '特殊项目' }] },
      ],
    };
    const tree = {
      logic: 'OR',
      conditions: [
        { logic: 'AND', conditions: [{ field: 'status', operator: 'EQUALS', value: 'ACTIVE' }, { field: 'count', operator: 'LESS_THAN', value: '5' }] },
        { logic: 'AND', conditions: [{ field: 'name', operator: 'EQUALS', value: '特殊项目' }] },
      ],
    };

    expect(normalizeTableFilters(JSON.stringify(legacy))).toEqual(tree);
    expect(buildTablePrismaQuery({ filters: JSON.stringify(legacy) }, FIELDS).where)
      .toEqual(buildTablePrismaQuery({ filters: JSON.stringify(tree) }, FIELDS).where);
    expect(buildTableSqlQuery({ filters: JSON.stringify(legacy) }, SQL_FIELDS))
      .toEqual(buildTableSqlQuery({ filters: JSON.stringify(tree) }, SQL_FIELDS));
  });

  it('拒绝子组再嵌套子组的三层结构', () => {
    const deep = JSON.stringify({
      logic: 'AND',
      conditions: [
        { logic: 'OR', conditions: [{ logic: 'AND', conditions: [{ field: 'name', operator: 'EQUALS', value: 'x' }] }] },
      ],
    });

    expect(capturedError(() => normalizeTableFilters(deep))).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
    expect(capturedError(() => buildTablePrismaQuery({ filters: deep }, FIELDS))).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
  });
});

describe('判空操作符 IS_EMPTY/IS_NOT_EMPTY', () => {
  it('文本字段判空覆盖 null 与空串', () => {
    const isEmpty = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator: 'IS_EMPTY', value: '' }] }) }, FIELDS);
    const isNotEmpty = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator: 'IS_NOT_EMPTY', value: '' }] }) }, FIELDS);

    expect(isEmpty.where).toEqual({ AND: [{ OR: [{ name: null }, { name: '' }] }] });
    expect(isNotEmpty.where).toEqual({ AND: [{ AND: [{ NOT: { name: null } }, { NOT: { name: '' } }] }] });
  });

  it('枚举字段判空仅匹配 null，绝不向枚举列传空串', () => {
    const isEmpty = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'status', operator: 'IS_EMPTY', value: '' }] }) }, FIELDS);
    const isNotEmpty = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'status', operator: 'IS_NOT_EMPTY', value: '' }] }) }, FIELDS);

    expect(isEmpty.where).toEqual({ AND: [{ status: null }] });
    expect(isNotEmpty.where).toEqual({ AND: [{ status: { not: null } }] });
  });

  it('数值与日期字段的空 value 不触发标量解析报错', () => {
    const numberEmpty = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'count', operator: 'IS_EMPTY', value: '' }] }) }, FIELDS);
    const dateNotEmpty = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'createdAt', operator: 'IS_NOT_EMPTY', value: '' }] }) }, FIELDS);

    expect(numberEmpty.where).toEqual({ AND: [{ count: null }] });
    expect(dateNotEmpty.where).toEqual({ AND: [{ createdAt: { not: null } }] });
  });

  it('多字段文本判空按 AND 组合（全部字段为空才算空）', () => {
    const multiFields = { keyword: { prismaField: ['name', 'code'] as const, type: 'text' as const } };

    const isEmpty = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'IS_EMPTY', value: '' }] }) }, multiFields);
    const isNotEmpty = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'IS_NOT_EMPTY', value: '' }] }) }, multiFields);

    expect(isEmpty.where).toEqual({
      AND: [{ AND: [{ OR: [{ name: null }, { name: '' }] }, { OR: [{ code: null }, { code: '' }] }] }],
    });
    expect(isNotEmpty.where).toEqual({
      AND: [{ AND: [{ AND: [{ NOT: { name: null } }, { NOT: { name: '' } }] }, { AND: [{ NOT: { code: null } }, { NOT: { code: '' } }] }] }],
    });
  });

  it('SQL 判空生成 IS NULL 谓词且不占用参数位', () => {
    const textEmpty = buildTableSqlQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator: 'IS_EMPTY', value: '' }] }) }, SQL_FIELDS);
    const textNotEmpty = buildTableSqlQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator: 'IS_NOT_EMPTY', value: '' }] }) }, SQL_FIELDS);
    const enumEmpty = buildTableSqlQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'status', operator: 'IS_EMPTY', value: '' }] }) }, SQL_FIELDS);

    expect(textEmpty).toEqual({ whereSql: "((name IS NULL OR name = ''))", params: [] });
    expect(textNotEmpty).toEqual({ whereSql: "((name IS NOT NULL AND name <> ''))", params: [] });
    expect(enumEmpty).toEqual({ whereSql: '(status::text IS NULL)', params: [] });
  });

  it('内存判空：文本覆盖空串，枚举仅 null', () => {
    const rows: MemoryRow[] = [
      { id: 1, name: null, status: null, count: null, createdAt: null },
      { id: 2, name: '', status: '', count: 0, createdAt: null },
      { id: 3, name: '项目', status: 'ACTIVE', count: 1, createdAt: null },
    ];
    const filter = (field: string, operator: string) => JSON.stringify({ logic: 'AND', conditions: [{ field, operator, value: '' }] });

    expect(filterAndSortTableRows(rows, { filters: filter('name', 'IS_EMPTY') }, MEMORY_FIELDS).map((row) => row.id)).toEqual([1, 2]);
    expect(filterAndSortTableRows(rows, { filters: filter('name', 'IS_NOT_EMPTY') }, MEMORY_FIELDS).map((row) => row.id)).toEqual([3]);
    // 枚举空串不是 null，不应被判空命中
    expect(filterAndSortTableRows(rows, { filters: filter('status', 'IS_EMPTY') }, MEMORY_FIELDS).map((row) => row.id)).toEqual([1]);
    expect(filterAndSortTableRows(rows, { filters: filter('status', 'IS_NOT_EMPTY') }, MEMORY_FIELDS).map((row) => row.id)).toEqual([2, 3]);
  });
});

describe('前后缀操作符 STARTS_WITH/ENDS_WITH', () => {
  it('Prisma 编译为 startsWith/endsWith 且不区分大小写', () => {
    const startsWith = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator: 'STARTS_WITH', value: '项' }] }) }, FIELDS);
    const endsWith = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator: 'ENDS_WITH', value: 'Alpha' }] }) }, FIELDS);

    expect(startsWith.where).toEqual({ AND: [{ name: { startsWith: '项', mode: 'insensitive' } }] });
    expect(endsWith.where).toEqual({ AND: [{ name: { endsWith: 'Alpha', mode: 'insensitive' } }] });
  });

  it('SQL 编译为 ILIKE 单侧通配', () => {
    const startsWith = buildTableSqlQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator: 'STARTS_WITH', value: '项' }] }) }, SQL_FIELDS);
    const endsWith = buildTableSqlQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator: 'ENDS_WITH', value: 'Alpha' }] }) }, SQL_FIELDS);

    expect(startsWith).toEqual({ whereSql: "(name ILIKE $1 || '%')", params: ['项'] });
    expect(endsWith).toEqual({ whereSql: "(name ILIKE '%' || $1)", params: ['Alpha'] });
  });

  it('内存按 zh-CN 小写归一后匹配前后缀', () => {
    const rows: MemoryRow[] = [
      { id: 1, name: '项目Alpha', status: null, count: null, createdAt: null },
      { id: 2, name: 'alpha项目', status: null, count: null, createdAt: null },
      { id: 3, name: '其它', status: null, count: null, createdAt: null },
    ];
    const filter = (operator: string, value: string) => JSON.stringify({ logic: 'AND', conditions: [{ field: 'name', operator, value }] });

    expect(filterAndSortTableRows(rows, { filters: filter('STARTS_WITH', '项') }, MEMORY_FIELDS).map((row) => row.id)).toEqual([1]);
    expect(filterAndSortTableRows(rows, { filters: filter('STARTS_WITH', 'ALPHA') }, MEMORY_FIELDS).map((row) => row.id)).toEqual([2]);
    expect(filterAndSortTableRows(rows, { filters: filter('ENDS_WITH', 'alpha') }, MEMORY_FIELDS).map((row) => row.id)).toEqual([1]);
  });
});

describe('数值区间 BETWEEN', () => {
  it('Prisma 编译为闭区间 gte/lte', () => {
    const result = buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'count', operator: 'BETWEEN', value: '1', valueEnd: '5' }] }) }, FIELDS);

    expect(result.where).toEqual({ AND: [{ count: { gte: 1, lte: 5 } }] });
  });

  it('SQL 编译为双参数闭区间', () => {
    const result = buildTableSqlQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'count', operator: 'BETWEEN', value: '1', valueEnd: '5' }] }) }, SQL_FIELDS);

    expect(result).toEqual({ whereSql: '(count >= $1 AND count <= $2)', params: [1, 5] });
  });

  it('内存按闭区间匹配', () => {
    const rows: MemoryRow[] = [0, 1, 3, 5, 6].map((count, index) => ({ id: index + 1, name: null, status: null, count, createdAt: null }));

    const result = filterAndSortTableRows(rows, { filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'count', operator: 'BETWEEN', value: '1', valueEnd: '5' }] }) }, MEMORY_FIELDS);

    expect(result.map((row) => row.count)).toEqual([1, 3, 5]);
  });

  it('结束值小于起点或缺失时拒绝', () => {
    const reversed = () => buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'count', operator: 'BETWEEN', value: '5', valueEnd: '1' }] }) }, FIELDS);
    const missing = () => buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'count', operator: 'BETWEEN', value: '5' }] }) }, FIELDS);
    const invalid = () => buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'count', operator: 'BETWEEN', value: '1', valueEnd: 'x' }] }) }, FIELDS);

    for (const action of [reversed, missing, invalid]) {
      expect(capturedError(action)).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
    }
  });
});

describe('日期不等 NOT_EQUALS', () => {
  const day = new Date('2026-08-21T00:00:00.000+08:00');
  const next = new Date('2026-08-22T00:00:00.000+08:00');
  const filter = JSON.stringify({ logic: 'AND', conditions: [{ field: 'createdAt', operator: 'NOT_EQUALS', value: '2026-08-21' }] });

  it('Prisma 编译为当天之外的 OR 区间', () => {
    const result = buildTablePrismaQuery({ filters: filter }, FIELDS);

    expect(result.where).toEqual({ AND: [{ OR: [{ createdAt: { lt: day } }, { createdAt: { gte: next } }] }] });
  });

  it('SQL 编译为括号包裹的 OR 谓词', () => {
    const result = buildTableSqlQuery({ filters: filter }, SQL_FIELDS);

    expect(result).toEqual({ whereSql: '((created_at < $1 OR created_at >= $2))', params: [day, next] });
  });

  it('内存匹配当天之外的行', () => {
    const rows: MemoryRow[] = [
      { id: 1, name: null, status: null, count: null, createdAt: new Date('2026-08-20T23:59:59.000+08:00') },
      { id: 2, name: null, status: null, count: null, createdAt: new Date('2026-08-21T10:00:00.000+08:00') },
      { id: 3, name: null, status: null, count: null, createdAt: '2026-08-22' },
    ];

    const result = filterAndSortTableRows(rows, { filters: filter }, MEMORY_FIELDS);

    expect(result.map((row) => row.id)).toEqual([1, 3]);
  });
});

describe('相对日期操作符', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('按 Asia/Shanghai 日历日求值各相对区间', () => {
    // 固定为上海时间 2026-08-21 16:00（周五）
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T08:00:00.000Z'));
    const compile = (operator: string) => buildTablePrismaQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'createdAt', operator, value: '' }] }),
    }, FIELDS).where;

    expect(compile('TODAY')).toEqual({
      AND: [{ createdAt: { gte: new Date('2026-08-20T16:00:00.000Z'), lt: new Date('2026-08-21T16:00:00.000Z') } }],
    });
    // 本周一 2026-08-17 至下周一 2026-08-24
    expect(compile('THIS_WEEK')).toEqual({
      AND: [{ createdAt: { gte: new Date('2026-08-16T16:00:00.000Z'), lt: new Date('2026-08-23T16:00:00.000Z') } }],
    });
    expect(compile('THIS_MONTH')).toEqual({
      AND: [{ createdAt: { gte: new Date('2026-07-31T16:00:00.000Z'), lt: new Date('2026-08-31T16:00:00.000Z') } }],
    });
    expect(compile('THIS_YEAR')).toEqual({
      AND: [{ createdAt: { gte: new Date('2025-12-31T16:00:00.000Z'), lt: new Date('2026-12-31T16:00:00.000Z') } }],
    });
    // 含今天共 7 个自然日：2026-08-15 至 2026-08-22
    expect(compile('LAST_7_DAYS')).toEqual({
      AND: [{ createdAt: { gte: new Date('2026-08-14T16:00:00.000Z'), lt: new Date('2026-08-21T16:00:00.000Z') } }],
    });
    // 含今天共 30 个自然日：2026-07-23 至 2026-08-22
    expect(compile('LAST_30_DAYS')).toEqual({
      AND: [{ createdAt: { gte: new Date('2026-07-22T16:00:00.000Z'), lt: new Date('2026-08-21T16:00:00.000Z') } }],
    });
  });

  it('SQL 与内存路径复用同一区间', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T08:00:00.000Z'));
    const filter = JSON.stringify({ logic: 'AND', conditions: [{ field: 'createdAt', operator: 'TODAY', value: '' }] });

    const sql = buildTableSqlQuery({ filters: filter }, SQL_FIELDS);
    expect(sql).toEqual({
      whereSql: '(created_at >= $1 AND created_at < $2)',
      params: [new Date('2026-08-20T16:00:00.000Z'), new Date('2026-08-21T16:00:00.000Z')],
    });

    const rows: MemoryRow[] = [
      { id: 1, name: null, status: null, count: null, createdAt: new Date('2026-08-20T16:00:00.000Z') },
      { id: 2, name: null, status: null, count: null, createdAt: new Date('2026-08-20T15:59:59.000Z') },
      { id: 3, name: null, status: null, count: null, createdAt: new Date('2026-08-21T16:00:00.000Z') },
      { id: 4, name: null, status: null, count: null, createdAt: null },
    ];
    expect(filterAndSortTableRows(rows, { filters: filter }, MEMORY_FIELDS).map((row) => row.id)).toEqual([1]);
  });

  it('拒绝非日期字段使用相对日期操作符', () => {
    const action = () => buildTablePrismaQuery({ filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'count', operator: 'TODAY', value: '' }] }) }, FIELDS);

    expect(capturedError(action)).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
  });
});

describe('buildTableSqlQuery 自定义谓词字段（compile）', () => {
  /** 模拟「存在某关联行」的 EXISTS 字段：仅支持等于/不等于/判空。 */
  const EXISTS_FIELDS: Record<string, TableSqlField> = {
    name: { column: 'ua.name', type: 'text' },
    departmentId: {
      type: 'number',
      compile: ({ condition, value, nextParam }) => {
        const membership = (match?: string) =>
          `EXISTS (SELECT 1 FROM hr.user_org uo WHERE uo.user_id = ua.user_id${match ? ` AND ${match}` : ''})`;
        if (condition.operator === 'IS_EMPTY') return `NOT ${membership()}`;
        if (condition.operator === 'IS_NOT_EMPTY') return membership();
        if (condition.operator === 'EQUALS' || condition.operator === 'NOT_EQUALS') {
          if (typeof value !== 'number') return undefined;
          const predicate = membership(`uo.department_id = ${nextParam(value)}`);
          return condition.operator === 'EQUALS' ? predicate : `NOT ${predicate}`;
        }
        return undefined;
      },
    },
  };

  it('编译 EXISTS 谓词并与列条件按树形逻辑组合、参数连续编号', () => {
    const result = buildTableSqlQuery({
      filters: JSON.stringify({
        logic: 'OR',
        conditions: [
          { field: 'departmentId', operator: 'EQUALS', value: '5' },
          {
            logic: 'AND',
            conditions: [
              { field: 'name', operator: 'CONTAINS', value: '张' },
              { field: 'departmentId', operator: 'NOT_EQUALS', value: '7' },
            ],
          },
        ],
      }),
    }, EXISTS_FIELDS);

    expect(result).toEqual({
      whereSql: "(EXISTS (SELECT 1 FROM hr.user_org uo WHERE uo.user_id = ua.user_id AND uo.department_id = $1) OR (ua.name ILIKE '%' || $2 || '%' AND NOT EXISTS (SELECT 1 FROM hr.user_org uo WHERE uo.user_id = ua.user_id AND uo.department_id = $3)))",
      params: [5, '张', 7],
    });
  });

  it('判空操作符 value 为空串时不进入标量解析', () => {
    const result = buildTableSqlQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'departmentId', operator: 'IS_EMPTY', value: '' }] }),
    }, EXISTS_FIELDS);

    expect(result).toEqual({
      whereSql: '(NOT EXISTS (SELECT 1 FROM hr.user_org uo WHERE uo.user_id = ua.user_id))',
      params: [],
    });
  });

  it('compile 返回 undefined 即「不支持该操作符」，标量解析失败同样抛校验错误', () => {
    const unsupported = () => buildTableSqlQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'departmentId', operator: 'GREATER_THAN', value: '5' }] }),
    }, EXISTS_FIELDS);
    const invalidScalar = () => buildTableSqlQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'departmentId', operator: 'EQUALS', value: 'abc' }] }),
    }, EXISTS_FIELDS);

    for (const action of [unsupported, invalidScalar]) {
      expect(capturedError(action)).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
    }
  });

  it('自定义谓词字段没有列表达式，排序时显式拒绝', () => {
    const action = () => buildTableSqlQuery({
      sorts: JSON.stringify([{ field: 'departmentId', direction: 'ASC' }]),
    }, EXISTS_FIELDS);

    expect(capturedError(action)).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
  });
});

describe('collectTableFilterFields', () => {
  it('递归收集根组与子组中的条件字段名', () => {
    const tree = normalizeTableFilters(JSON.stringify({
      logic: 'OR',
      conditions: [
        { field: 'status', operator: 'EQUALS', value: 'ACTIVE' },
        {
          logic: 'AND',
          conditions: [
            { field: 'keyword', operator: 'CONTAINS', value: '张' },
            { field: 'departmentId', operator: 'EQUALS', value: '5' },
          ],
        },
      ],
    }));

    expect([...collectTableFilterFields(tree)].sort()).toEqual(['departmentId', 'keyword', 'status']);
  });
});

describe('buildTablePrismaQuery 自定义谓词拦截（compile）', () => {
  /** 模拟「一个筛选值对应多个数据值」的枚举字段拦截。 */
  const INTERCEPT_FIELDS = {
    requestType: {
      prismaField: 'requestType',
      type: 'enum' as const,
      compile: ({ condition, value }: TableConditionContext) => {
        if (value !== 'CONSUMABLE_REQUEST') return undefined;
        if (condition.operator === 'EQUALS') return { requestType: { in: ['CONSUMABLE_REQUEST', 'AGENT_REQUEST'] } };
        if (condition.operator === 'NOT_EQUALS') return { requestType: { notIn: ['CONSUMABLE_REQUEST', 'AGENT_REQUEST'] } };
        return undefined;
      },
    },
  };

  it('特殊取值走拦截编译，其余取值回退标准编译', () => {
    const intercepted = buildTablePrismaQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'requestType', operator: 'EQUALS', value: 'CONSUMABLE_REQUEST' }] }),
    }, INTERCEPT_FIELDS);
    expect(intercepted.where).toEqual({ AND: [{ requestType: { in: ['CONSUMABLE_REQUEST', 'AGENT_REQUEST'] } }] });

    const standard = buildTablePrismaQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'requestType', operator: 'EQUALS', value: 'BORROW' }] }),
    }, INTERCEPT_FIELDS);
    expect(standard.where).toEqual({ AND: [{ requestType: 'BORROW' }] });
  });

  it('拦截在任意层级子组内生效', () => {
    const result = buildTablePrismaQuery({
      filters: JSON.stringify({
        logic: 'OR',
        conditions: [{ logic: 'AND', conditions: [{ field: 'requestType', operator: 'NOT_EQUALS', value: 'CONSUMABLE_REQUEST' }] }],
      }),
    }, INTERCEPT_FIELDS);

    expect(result.where).toEqual({ OR: [{ AND: [{ requestType: { notIn: ['CONSUMABLE_REQUEST', 'AGENT_REQUEST'] } }] }] });
  });
});

describe('buildTablePrismaQuery 纯自定义谓词字段（无 prismaField）', () => {
  /** 模拟「按当前用户派生范围」这类无真实列的字段：钩子覆盖允许的操作符，其余返回 undefined。 */
  const COMPILE_ONLY_FIELDS = {
    scope: {
      type: 'enum' as const,
      compile: ({ condition, value }: TableConditionContext) => {
        if (condition.operator === 'EQUALS' && value === 'OWNED') return { responsibleUserId: 7 };
        return undefined;
      },
    },
  };

  it('命中钩子直接编译为 Prisma 片段', () => {
    const result = buildTablePrismaQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'scope', operator: 'EQUALS', value: 'OWNED' }] }),
    }, COMPILE_ONLY_FIELDS);

    expect(result.where).toEqual({ AND: [{ responsibleUserId: 7 }] });
  });

  it('钩子未覆盖的操作符抛「不支持该操作符」，而非回退标准编译', () => {
    const error = capturedError(() => buildTablePrismaQuery({
      filters: JSON.stringify({ logic: 'AND', conditions: [{ field: 'scope', operator: 'CONTAINS', value: 'OWNED' }] }),
    }, COMPILE_ONLY_FIELDS));

    expect(error).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
  });

  it('无列字段排序显式拒绝', () => {
    const error = capturedError(() => buildTablePrismaQuery({
      sorts: JSON.stringify([{ field: 'scope', direction: 'ASC' }]),
    }, COMPILE_ONLY_FIELDS));

    expect(error).toMatchObject({ entry: { code: frameworkErrors.VALIDATION_FAILED.code } });
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
