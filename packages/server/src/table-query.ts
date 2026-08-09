import { BusinessException, frameworkErrors } from '@wbme/contracts';

/** 前端通用表格可发送的受控比较操作符。 */
type TableOperator =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'GREATER_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN'
  | 'LESS_THAN_OR_EQUAL'
  | 'BEFORE'
  | 'AFTER'
  | 'BETWEEN';

interface TableFilterCondition {
  field: string;
  operator: TableOperator;
  value: string;
  valueEnd?: string;
}

interface SimpleTableFilters {
  logic: 'AND' | 'OR';
  conditions: TableFilterCondition[];
}

interface GroupedTableFilters {
  logic: 'OR';
  groups: Array<{ logic: 'AND'; conditions: TableFilterCondition[] }>;
}

export interface TableQueryInput {
  filters?: string;
  sorts?: string;
}

/** 资源将公开筛选字段显式映射到自己的 Prisma 标量字段，杜绝任意字段查询。 */
export interface TablePrismaField {
  /** 多字段仅适用于文本筛选，表示同一关键字匹配其中任意字段。 */
  prismaField: string | readonly string[];
  type: 'text' | 'number' | 'enum' | 'date';
}

/** 编译后的 Prisma where/orderBy 片段；调用方与权限/软删除等既有条件以 AND 合并。 */
export interface TablePrismaQuery {
  where?: Record<string, unknown>;
  orderBy?: Array<Record<string, 'asc' | 'desc'>>;
}

/** 资源将公开筛选字段显式映射到只读 SQL 列表达式，避免动态拼接客户端字段。 */
export interface TableSqlField {
  /** 仅允许开发者定义的列名或固定列转换表达式，例如 `status::text`。 */
  column: string;
  type: TablePrismaField['type'];
}

/** 编译后的 SQL 片段；whereSql 不包含 WHERE 关键字，便于调用方追加既有权限条件。 */
export interface TableSqlQuery {
  whereSql?: string;
  params: Array<string | number | Date>;
  orderBySql?: string;
}

/** 内存汇总行的公开字段映射；仅用于已经在服务端按权限聚合完成的小规模结果集。 */
export interface TableInMemoryField<Row> {
  type: TablePrismaField['type'];
  /** 读取一行的受控标量值；不得返回未脱敏的内部字段。 */
  value: (row: Row) => string | number | Date | null | undefined;
}

/**
 * 将已通过 PaginationQueryDto 结构校验的筛选、排序编译为安全 Prisma 片段。
 *
 * @param input 原始列表查询参数
 * @param fields 当前资源注册的字段白名单
 * @returns 可与资源原有数据范围条件组合的 Prisma 查询片段
 * @throws BusinessException 条件字段、类型或操作符不属于资源白名单时抛出校验错误
 */
export function buildTablePrismaQuery(
  input: TableQueryInput,
  fields: Readonly<Record<string, TablePrismaField>>,
): TablePrismaQuery {
  const filters = parseFilters(input.filters);
  const sorts = parseSorts(input.sorts);
  return {
    ...(filters ? { where: compileFilters(filters, fields) } : {}),
    ...(sorts.length > 0 ? { orderBy: sorts.map((sort) => {
      const definition = fieldDefinition(sort.field, fields);
      if (isMultiField(definition.prismaField)) throw validationError(`字段 ${sort.field} 不支持排序`);
      return { [definition.prismaField]: sort.direction === 'ASC' ? 'asc' : 'desc' };
    }) } : {}),
  };
}

/**
 * 将通用表格查询编译为参数化 SQL 片段。
 *
 * 该函数只适用于必须读取数据库视图或聚合表的只读列表；列表达式只来自资源白名单，
 * 所有用户值均通过 `$n` 参数传递，调用方不得把 filters/sorts 原文再拼入 SQL。
 *
 * @param input 原始列表查询参数
 * @param fields 当前资源注册的 SQL 字段白名单
 * @returns 可与既有数据范围条件组合的参数化 SQL 片段
 * @throws BusinessException 字段、操作符或数据类型不在资源白名单时抛出校验错误
 */
export function buildTableSqlQuery(
  input: TableQueryInput,
  fields: Readonly<Record<string, TableSqlField>>,
  options: { parameterOffset?: number } = {},
): TableSqlQuery {
  const filters = parseFilters(input.filters);
  const sorts = parseSorts(input.sorts);
  const params: Array<string | number | Date> = [];
  const nextParam = (value: string | number | Date): string => {
    params.push(value);
    return `$${(options.parameterOffset ?? 0) + params.length}`;
  };
  const compile = (condition: TableFilterCondition): string => compileSqlCondition(condition, fields, nextParam);
  const whereSql = filters
    ? ('groups' in filters
      ? `(${filters.groups.map((group) => `(${group.conditions.map(compile).join(' AND ')})`).join(' OR ')})`
      : `(${filters.conditions.map(compile).join(` ${filters.logic} `)})`)
    : undefined;
  const orderBySql = sorts.length > 0
    ? sorts.map((sort) => {
      const definition = fields[sort.field];
      if (!definition) throw validationError(`不支持筛选或排序字段 ${sort.field}`);
      return `${definition.column} ${sort.direction}`;
    }).join(', ')
    : undefined;
  return { ...(whereSql ? { whereSql } : {}), params, ...(orderBySql ? { orderBySql } : {}) };
}

/**
 * 在已完成数据范围约束的内存汇总结果上应用同一套结构化筛选与稳定多级排序。
 *
 * 适用于不能直接映射为单表 Prisma/SQL 条件的派生统计；调用方必须先在数据库层完成
 * 授权范围约束，且只注册可安全公开的字段。
 *
 * @param rows 已受权限约束的汇总行
 * @param input 原始列表查询参数
 * @param fields 当前资源公开字段白名单
 * @returns 已筛选、稳定排序后的新数组，不修改调用方原数组
 * @throws BusinessException 条件字段、类型或操作符不属于资源白名单时抛出校验错误
 */
export function filterAndSortTableRows<Row>(
  rows: readonly Row[],
  input: TableQueryInput,
  fields: Readonly<Record<string, TableInMemoryField<Row>>>,
): Row[] {
  const filters = parseFilters(input.filters);
  const sorts = parseSorts(input.sorts);
  const matches = (row: Row): boolean => {
    if (!filters) return true;
    if ('groups' in filters) {
      return filters.groups.some((group) => group.conditions.every((condition) => matchesMemoryCondition(row, condition, fields)));
    }
    const conditionMatches = filters.conditions.map((condition) => matchesMemoryCondition(row, condition, fields));
    return filters.logic === 'AND' ? conditionMatches.every(Boolean) : conditionMatches.some(Boolean);
  };
  const filtered = rows.filter(matches).map((row, index) => ({ row, index }));
  if (sorts.length === 0) return filtered.map((item) => item.row);
  return filtered.sort((left, right) => {
    for (const sort of sorts) {
      const definition = memoryFieldDefinition(sort.field, fields);
      const compared = compareMemoryValues(definition.value(left.row), definition.value(right.row), definition.type);
      if (compared !== 0) return sort.direction === 'ASC' ? compared : -compared;
    }
    return left.index - right.index;
  }).map((item) => item.row);
}

function parseFilters(raw: string | undefined): SimpleTableFilters | GroupedTableFilters | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('not object');
    if (Array.isArray(parsed.conditions)) {
      return { logic: parsed.logic === 'OR' ? 'OR' : 'AND', conditions: parsed.conditions.map(asCondition) };
    }
    if (parsed.logic === 'OR' && Array.isArray(parsed.groups)) {
      return {
        logic: 'OR',
        groups: parsed.groups.map((group) => {
          if (!isRecord(group) || group.logic !== 'AND' || !Array.isArray(group.conditions)) throw new Error('invalid group');
          return { logic: 'AND', conditions: group.conditions.map(asCondition) };
        }),
      };
    }
  } catch {
    throw validationError('筛选条件格式不合法');
  }
  throw validationError('筛选条件格式不合法');
}

function parseSorts(raw: string | undefined): Array<{ field: string; direction: 'ASC' | 'DESC' }> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not array');
    return parsed.map((sort) => {
      if (!isRecord(sort) || typeof sort.field !== 'string' || (sort.direction !== 'ASC' && sort.direction !== 'DESC')) throw new Error('invalid sort');
      return { field: sort.field, direction: sort.direction };
    });
  } catch {
    throw validationError('排序条件格式不合法');
  }
}

function compileFilters(
  filters: SimpleTableFilters | GroupedTableFilters,
  fields: Readonly<Record<string, TablePrismaField>>,
): Record<string, unknown> {
  if ('groups' in filters) {
    return { OR: filters.groups.map((group) => ({ AND: group.conditions.map((condition) => compileCondition(condition, fields)) })) };
  }
  return { [filters.logic]: filters.conditions.map((condition) => compileCondition(condition, fields)) };
}

function compileCondition(
  condition: TableFilterCondition,
  fields: Readonly<Record<string, TablePrismaField>>,
): Record<string, unknown> {
  const definition = fieldDefinition(condition.field, fields);
  const prismaFields = isMultiField(definition.prismaField) ? definition.prismaField : [definition.prismaField];
  const value = scalarValue(condition.value, definition.type);
  const operation = condition.operator;
  const forEachField = (
    makeFilter: (field: string) => Record<string, unknown>,
    multipleLogic: 'AND' | 'OR' = 'OR',
  ): Record<string, unknown> => {
    const results = prismaFields.map(makeFilter);
    return results.length === 1 ? results[0] as Record<string, unknown> : { [multipleLogic]: results };
  };
  if (definition.type === 'text') {
    if (operation === 'EQUALS') return forEachField((field) => ({ [field]: { equals: value, mode: 'insensitive' } }));
    if (operation === 'NOT_EQUALS') return forEachField((field) => ({ [field]: { not: { equals: value, mode: 'insensitive' } } }), 'AND');
    if (operation === 'CONTAINS') return forEachField((field) => ({ [field]: { contains: value, mode: 'insensitive' } }));
    if (operation === 'NOT_CONTAINS') return forEachField((field) => ({ [field]: { not: { contains: value, mode: 'insensitive' } } }), 'AND');
  }
  if (definition.type === 'enum') {
    if (operation === 'EQUALS') return forEachField((field) => ({ [field]: value }));
    if (operation === 'NOT_EQUALS') return forEachField((field) => ({ [field]: { not: value } }));
  }
  if (definition.type === 'number') {
    if (operation === 'EQUALS') return forEachField((field) => ({ [field]: value }));
    if (operation === 'NOT_EQUALS') return forEachField((field) => ({ [field]: { not: value } }));
    if (operation === 'GREATER_THAN') return forEachField((field) => ({ [field]: { gt: value } }));
    if (operation === 'GREATER_THAN_OR_EQUAL') return forEachField((field) => ({ [field]: { gte: value } }));
    if (operation === 'LESS_THAN') return forEachField((field) => ({ [field]: { lt: value } }));
    if (operation === 'LESS_THAN_OR_EQUAL') return forEachField((field) => ({ [field]: { lte: value } }));
  }
  if (definition.type === 'date') {
    if (!(value instanceof Date)) throw validationError(`字段 ${condition.field} 必须是日期`);
    if (operation === 'EQUALS') return forEachField((field) => ({ [field]: { gte: value, lt: nextDay(value) } }));
    if (operation === 'BEFORE') return forEachField((field) => ({ [field]: { lt: value } }));
    if (operation === 'AFTER') return forEachField((field) => ({ [field]: { gt: nextDay(value) } }));
    if (operation === 'BETWEEN') {
      if (!condition.valueEnd) throw validationError(`字段 ${condition.field} 缺少区间结束值`);
      const end = scalarValue(condition.valueEnd, 'date');
      if (!(end instanceof Date) || end < value) throw validationError(`字段 ${condition.field} 的日期区间不合法`);
      return forEachField((field) => ({ [field]: { gte: value, lt: nextDay(end) } }));
    }
  }
  throw validationError(`字段 ${condition.field} 不支持 ${operation} 操作符`);
}

/** 将单个条件转换为参数化 SQL 谓词；列名固定来自 TableSqlField 白名单。 */
function compileSqlCondition(
  condition: TableFilterCondition,
  fields: Readonly<Record<string, TableSqlField>>,
  nextParam: (value: string | number | Date) => string,
): string {
  const definition = fields[condition.field];
  if (!definition) throw validationError(`不支持筛选或排序字段 ${condition.field}`);
  const value = scalarValue(condition.value, definition.type);
  const parameter = nextParam(value);
  const column = definition.column;
  if (definition.type === 'text') {
    if (condition.operator === 'EQUALS') return `${column} ILIKE ${parameter}`;
    if (condition.operator === 'NOT_EQUALS') return `${column} NOT ILIKE ${parameter}`;
    if (condition.operator === 'CONTAINS') return `${column} ILIKE '%' || ${parameter} || '%'`;
    if (condition.operator === 'NOT_CONTAINS') return `${column} NOT ILIKE '%' || ${parameter} || '%'`;
  }
  if (definition.type === 'enum') {
    if (condition.operator === 'EQUALS') return `${column} = ${parameter}`;
    if (condition.operator === 'NOT_EQUALS') return `${column} <> ${parameter}`;
  }
  if (definition.type === 'number') {
    const operationSql: Partial<Record<TableOperator, string>> = {
      EQUALS: '=',
      NOT_EQUALS: '<>',
      GREATER_THAN: '>',
      GREATER_THAN_OR_EQUAL: '>=',
      LESS_THAN: '<',
      LESS_THAN_OR_EQUAL: '<=',
    };
    const operator = operationSql[condition.operator];
    if (operator) return `${column} ${operator} ${parameter}`;
  }
  if (definition.type === 'date') {
    if (!(value instanceof Date)) throw validationError(`字段 ${condition.field} 必须是日期`);
    if (condition.operator === 'EQUALS') return `${column} >= ${parameter} AND ${column} < ${nextParam(nextDay(value))}`;
    if (condition.operator === 'BEFORE') return `${column} < ${parameter}`;
    if (condition.operator === 'AFTER') return `${column} >= ${nextParam(nextDay(value))}`;
    if (condition.operator === 'BETWEEN') {
      if (!condition.valueEnd) throw validationError(`字段 ${condition.field} 缺少区间结束值`);
      const end = scalarValue(condition.valueEnd, 'date');
      if (!(end instanceof Date) || end < value) throw validationError(`字段 ${condition.field} 的日期区间不合法`);
      return `${column} >= ${parameter} AND ${column} < ${nextParam(nextDay(end))}`;
    }
  }
  throw validationError(`字段 ${condition.field} 不支持 ${condition.operator} 操作符`);
}

/** 在内存行上解释受控条件；字段与操作符校验与 Prisma/SQL 编译器完全一致。 */
function matchesMemoryCondition<Row>(
  row: Row,
  condition: TableFilterCondition,
  fields: Readonly<Record<string, TableInMemoryField<Row>>>,
): boolean {
  const definition = memoryFieldDefinition(condition.field, fields);
  const actual = definition.value(row);
  const expected = scalarValue(condition.value, definition.type);
  if (definition.type === 'text') {
    const left = String(actual ?? '').toLocaleLowerCase('zh-CN');
    const right = String(expected).toLocaleLowerCase('zh-CN');
    if (condition.operator === 'EQUALS') return left === right;
    if (condition.operator === 'NOT_EQUALS') return left !== right;
    if (condition.operator === 'CONTAINS') return left.includes(right);
    if (condition.operator === 'NOT_CONTAINS') return !left.includes(right);
  }
  if (definition.type === 'enum') {
    if (condition.operator === 'EQUALS') return String(actual ?? '') === expected;
    if (condition.operator === 'NOT_EQUALS') return String(actual ?? '') !== expected;
  }
  if (definition.type === 'number') {
    const left = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(left) || typeof expected !== 'number') return false;
    if (condition.operator === 'EQUALS') return left === expected;
    if (condition.operator === 'NOT_EQUALS') return left !== expected;
    if (condition.operator === 'GREATER_THAN') return left > expected;
    if (condition.operator === 'GREATER_THAN_OR_EQUAL') return left >= expected;
    if (condition.operator === 'LESS_THAN') return left < expected;
    if (condition.operator === 'LESS_THAN_OR_EQUAL') return left <= expected;
  }
  if (definition.type === 'date') {
    const left = memoryDate(actual);
    if (!(expected instanceof Date) || !left) return false;
    if (condition.operator === 'EQUALS') return left >= expected && left < nextDay(expected);
    if (condition.operator === 'BEFORE') return left < expected;
    if (condition.operator === 'AFTER') return left >= nextDay(expected);
    if (condition.operator === 'BETWEEN') {
      if (!condition.valueEnd) throw validationError(`字段 ${condition.field} 缺少区间结束值`);
      const end = scalarValue(condition.valueEnd, 'date');
      if (!(end instanceof Date) || end < expected) throw validationError(`字段 ${condition.field} 的日期区间不合法`);
      return left >= expected && left < nextDay(end);
    }
  }
  throw validationError(`字段 ${condition.field} 不支持 ${condition.operator} 操作符`);
}

/** 稳定排序比较：空值始终排在非空值之后，文本按中文本地化规则比较。 */
function compareMemoryValues(
  left: string | number | Date | null | undefined,
  right: string | number | Date | null | undefined,
  type: TablePrismaField['type'],
): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  if (type === 'number') return Number(left) - Number(right);
  if (type === 'date') {
    const leftDate = memoryDate(left);
    const rightDate = memoryDate(right);
    if (!leftDate || !rightDate) return leftDate ? -1 : rightDate ? 1 : 0;
    return leftDate.getTime() - rightDate.getTime();
  }
  return String(left).localeCompare(String(right), 'zh-CN', { sensitivity: 'base', numeric: true });
}

/** 内存日期字段兼容数据库 Date 与 YYYY-MM-DD，非法值视作空值。 */
function memoryDate(value: string | number | Date | null | undefined): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = scalarValue(value, 'date');
    return parsed instanceof Date ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function scalarValue(value: string, type: TablePrismaField['type']): string | number | Date {
  if (type === 'text' || type === 'enum') return value;
  if (type === 'number') {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw validationError('数值筛选值不合法');
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw validationError('数值筛选值不合法');
    return parsed;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validationError('日期筛选值必须为 YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000+08:00`);
  if (Number.isNaN(parsed.getTime()) || formatShanghaiDate(parsed) !== value) throw validationError('日期筛选值不合法');
  return parsed;
}

function nextDay(value: Date): Date {
  return new Date(value.getTime() + 24 * 60 * 60 * 1000);
}

/** 使用产品约定的中国时区验证用户输入的纯日期，避免 Date 自动归一化无效日期。 */
function formatShanghaiDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function asCondition(value: unknown): TableFilterCondition {
  if (!isRecord(value) || typeof value.field !== 'string' || typeof value.operator !== 'string' || typeof value.value !== 'string') {
    throw new Error('invalid condition');
  }
  return { field: value.field, operator: value.operator as TableOperator, value: value.value, ...(typeof value.valueEnd === 'string' ? { valueEnd: value.valueEnd } : {}) };
}

function fieldDefinition(field: string, fields: Readonly<Record<string, TablePrismaField>>): TablePrismaField {
  const definition = fields[field];
  if (!definition) throw validationError(`不支持筛选或排序字段 ${field}`);
  return definition;
}

function memoryFieldDefinition<Row>(field: string, fields: Readonly<Record<string, TableInMemoryField<Row>>>): TableInMemoryField<Row> {
  const definition = fields[field];
  if (!definition) throw validationError(`不支持筛选或排序字段 ${field}`);
  return definition;
}

function validationError(message: string): BusinessException {
  return new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: [{ field: 'filters', reason: message }] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 识别用于跨字段文本查询的只读字段列表。 */
function isMultiField(value: string | readonly string[]): value is readonly string[] {
  return Array.isArray(value);
}
