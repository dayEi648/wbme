import { BusinessException, frameworkErrors } from '@wbme/contracts';

/** 前端通用表格可发送的受控比较操作符。 */
export type TableOperator =
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
  | 'BETWEEN'
  | 'IS_EMPTY'
  | 'IS_NOT_EMPTY'
  | 'STARTS_WITH'
  | 'ENDS_WITH'
  | 'TODAY'
  | 'THIS_WEEK'
  | 'THIS_MONTH'
  | 'THIS_YEAR'
  | 'LAST_7_DAYS'
  | 'LAST_30_DAYS';

export interface TableFilterCondition {
  field: string;
  operator: TableOperator;
  /** 无值操作符（判空与相对日期）约定传空串，编译时不得进入标量解析。 */
  value: string;
  valueEnd?: string;
}

/**
 * 归一化后的筛选树节点：叶子为单条条件，组节点为一层子组。
 * 子组只允许出现在根下（解析层拒绝更深嵌套），因此编译递归深度有界。
 */
export type TableFilterTreeNode = TableFilterCondition | TableFilterTreeGroup;

/** 筛选树组节点；conditions 内可同时混合条件与子组（仅根节点）。 */
export interface TableFilterTreeGroup {
  logic: 'AND' | 'OR';
  conditions: TableFilterTreeNode[];
}

export interface TableQueryInput {
  filters?: string;
  sorts?: string;
}

/** 资源将公开筛选字段显式映射到自己的 Prisma 标量字段，杜绝任意字段查询。 */
export type TablePrismaField =
  | {
      /** 多字段仅适用于文本筛选，表示同一关键字匹配其中任意字段。 */
      prismaField: string | readonly string[];
      type: 'text' | 'number' | 'enum' | 'date' | 'time';
      /**
       * 自定义谓词拦截器：为特殊取值提供非标准编译（如一个筛选值对应多个数据值）。
       * 返回 undefined 表示该条件仍走标准编译；返回的对象直接作为该条件的 Prisma 片段。
       */
      compile?: (context: TableConditionContext) => Record<string, unknown> | undefined;
    }
  | {
      type: 'text' | 'number' | 'enum' | 'date' | 'time';
      /**
       * 自定义谓词编译：字段没有可映射的 Prisma 列（如按当前用户派生的范围谓词）。
       * 必须覆盖全部允许的操作符并返回 Prisma 片段；返回 undefined 抛出「不支持操作符」，
       * 该字段不参与排序。
       */
      compile: (context: TableConditionContext) => Record<string, unknown> | undefined;
    };

/** 编译后的 Prisma where/orderBy 片段；调用方与权限/软删除等既有条件以 AND 合并。 */
export interface TablePrismaQuery {
  where?: Record<string, unknown>;
  orderBy?: Array<Record<string, 'asc' | 'desc'>>;
}

/**
 * 自定义谓词编译上下文：标量值已按字段类型解析。
 * 用于无独立列可映射的字段（如「存在某关联行」的 EXISTS 谓词）。
 */
export interface TableConditionContext {
  /** 原始条件；操作符支持与否由 compile 实现判定。 */
  condition: TableFilterCondition;
  /** 已按字段类型解析的筛选值；无值操作符（判空/相对日期）为 null。 */
  value: string | number | Date | null;
  /** BETWEEN 的区间结束值（已按字段类型解析）；非 BETWEEN 为 undefined。 */
  valueEnd?: string | number | Date;
}

/** SQL 谓词编译上下文：在通用上下文之上提供参数占位符注册。 */
export interface TableSqlConditionContext extends TableConditionContext {
  /** 注册一个查询参数并返回其 `$n` 占位符。 */
  nextParam: (value: string | number | Date) => string;
}

/**
 * 资源将公开筛选字段显式映射到只读 SQL 列表达式，避免动态拼接客户端字段。
 * 无列可映射的字段改用 compile 生成完整谓词；compile 返回 undefined 表示
 * 该字段不支持此操作符，编译器统一抛校验错误。
 */
export type TableSqlField =
  | {
      /** 仅允许开发者定义的列名或固定列转换表达式，例如 `status::text`。 */
      column: string;
      type: TablePrismaField['type'];
      compile?: undefined;
    }
  | {
      column?: undefined;
      type: TablePrismaField['type'];
      /** 自定义谓词编译（EXISTS/多列匹配类字段）；返回 undefined 即「不支持该操作符」。 */
      compile: (context: TableSqlConditionContext) => string | undefined;
    };

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

/** 无值操作符：value 约定为空串，必须在校验字段白名单之后、scalarValue 标量解析之前分支。 */
const VALUELESS_OPERATORS: ReadonlySet<TableOperator> = new Set(['IS_EMPTY', 'IS_NOT_EMPTY']);

/** 相对日期操作符：同样无值，按 Asia/Shanghai 日历日在服务端求值。 */
const RELATIVE_DATE_OPERATORS: ReadonlySet<TableOperator> = new Set(['TODAY', 'THIS_WEEK', 'THIS_MONTH', 'THIS_YEAR', 'LAST_7_DAYS', 'LAST_30_DAYS']);

/** 一天的毫秒数；上海时区无夏令时，日期平移可直接按毫秒计算。 */
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const orderBy: Array<Record<string, 'asc' | 'desc'>> = sorts.map((sort) => {
    const definition = fieldDefinition(sort.field, fields);
    // 自定义谓词字段（无 Prisma 列）与多字段映射都不能排序
    if (!('prismaField' in definition) || isMultiField(definition.prismaField)) throw validationError(`字段 ${sort.field} 不支持排序`);
    return { [definition.prismaField]: sort.direction === 'ASC' ? 'asc' : 'desc' };
  });
  // 稳定分页兜底：自定义排序必须追加唯一 id 作为末级排序，避免同值行翻页重复/遗漏（主 PRD §9.5）
  if (orderBy.length > 0 && !orderBy.some((sort) => 'id' in sort)) {
    orderBy.push({ id: 'desc' });
  }
  return {
    ...(filters ? { where: compileGroup(filters, fields) } : {}),
    ...(orderBy.length > 0 ? { orderBy } : {}),
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
  const compileNode = (node: TableFilterTreeNode): string => isTreeGroup(node)
    ? `(${node.conditions.map(compileNode).join(` ${node.logic} `)})`
    : compileSqlCondition(node, fields, nextParam);
  const whereSql = filters ? compileNode(filters) : undefined;
  const orderBySqlParts = sorts.map((sort) => {
    const definition = fields[sort.field];
    if (!definition) throw validationError(`不支持筛选或排序字段 ${sort.field}`);
    const column = definition.column;
    // 自定义谓词字段（EXISTS 类）没有可排序的列表达式
    if (column === undefined) throw validationError(`字段 ${sort.field} 不支持排序`);
    return `${column} ${sort.direction}`;
  });
  // 稳定分页兜底：自定义排序必须追加唯一 id 作为末级排序，避免同值行翻页重复/遗漏（主 PRD §9.5）。
  // 仅当资源注册了可排序的 id 列且客户端未显式按 id 排序时追加。
  const idDefinition = fields.id;
  if (orderBySqlParts.length > 0
    && !sorts.some((sort) => sort.field === 'id')
    && idDefinition?.column) {
    orderBySqlParts.push(`${idDefinition.column} DESC`);
  }
  const orderBySql = orderBySqlParts.length > 0 ? orderBySqlParts.join(', ') : undefined;
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
  const matchesNode = (row: Row, node: TableFilterTreeNode): boolean => {
    if (isTreeGroup(node)) {
      const matches = node.conditions.map((child) => matchesNode(row, child));
      return node.logic === 'AND' ? matches.every(Boolean) : matches.some(Boolean);
    }
    return matchesMemoryCondition(row, node, fields);
  };
  const filtered = rows.filter((row) => !filters || matchesNode(row, filters)).map((row, index) => ({ row, index }));
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

/**
 * 解析 filters 查询参数并归一化为树形条件组，供编译器与 operation-log 等场景复用。
 *
 * 接受三种入参形状并统一为树：新树形（根组下可混排条件与一层子组）、旧平铺
 * （与无子组的新树同形）、旧条件组（`logic: "OR"` + `groups`，归一化为根 OR 组嵌套
 * AND 子组）。子组不得再嵌套子组，超出即拒绝，保证编译递归深度有界。
 *
 * @param raw filters 查询参数原文（JSON 字符串）
 * @returns 可直接 JSON.stringify 的纯对象筛选树
 * @throws BusinessException 输入不是合法 JSON 或不符合任何受支持形状时抛出校验错误
 */
export function normalizeTableFilters(raw: string): TableFilterTreeGroup {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('not object');
    if (Array.isArray(parsed.conditions)) {
      return { logic: parsed.logic === 'OR' ? 'OR' : 'AND', conditions: parsed.conditions.map(asTreeNode) };
    }
    // 旧条件组形状：显式识别 groups 键，归一化为「根 OR 组 + AND 子组」的新树
    if (parsed.logic === 'OR' && Array.isArray(parsed.groups)) {
      return {
        logic: 'OR',
        conditions: parsed.groups.map((group) => {
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

function parseFilters(raw: string | undefined): TableFilterTreeGroup | undefined {
  return raw ? normalizeTableFilters(raw) : undefined;
}

/**
 * 收集筛选树中出现的全部条件字段名（含子组，不含组节点本身）。
 *
 * 用于「filters 树中出现的字段以树为准、同名具名查询参数让位」的逐字段裁决：
 * 具名参数仅对未出现在树中的字段保持兼容。
 *
 * @param tree 归一化后的筛选树（normalizeTableFilters 的产物）
 * @returns 条件字段名集合
 */
export function collectTableFilterFields(tree: TableFilterTreeGroup): ReadonlySet<string> {
  const fields = new Set<string>();
  const walk = (node: TableFilterTreeNode): void => {
    if (isTreeGroup(node)) {
      node.conditions.forEach(walk);
      return;
    }
    fields.add(node.field);
  };
  tree.conditions.forEach(walk);
  return fields;
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

/** 递归编译筛选树为 Prisma 嵌套条件；深度由解析层限制为根 + 一层子组，不会无界递归。 */
function compileGroup(
  group: TableFilterTreeGroup,
  fields: Readonly<Record<string, TablePrismaField>>,
): Record<string, unknown> {
  return { [group.logic]: group.conditions.map((node) => (isTreeGroup(node) ? compileGroup(node, fields) : compileCondition(node, fields))) };
}

function compileCondition(
  condition: TableFilterCondition,
  fields: Readonly<Record<string, TablePrismaField>>,
): Record<string, unknown> {
  const definition = fieldDefinition(condition.field, fields);
  // 自定义谓词拦截：先按类型解析标量（无值操作符传 null），返回 undefined 继续标准编译
  if (definition.compile) {
    const valueless = VALUELESS_OPERATORS.has(condition.operator) || RELATIVE_DATE_OPERATORS.has(condition.operator);
    const intercepted = definition.compile({
      condition,
      value: valueless ? null : scalarValue(condition.value, definition.type),
      valueEnd: condition.valueEnd === undefined ? undefined : scalarValue(condition.valueEnd, definition.type),
    });
    if (intercepted !== undefined) return intercepted;
  }
  // 纯 compile 字段（无 Prisma 列）未拦截时没有标准编译可回退；此分支同时收窄联合类型
  if (!('prismaField' in definition)) throw validationError(`字段 ${condition.field} 不支持 ${condition.operator} 操作符`);
  const prismaFields = isMultiField(definition.prismaField) ? definition.prismaField : [definition.prismaField];
  const operation = condition.operator;
  const forEachField = (
    makeFilter: (field: string) => Record<string, unknown>,
    multipleLogic: 'AND' | 'OR' = 'OR',
  ): Record<string, unknown> => {
    const results = prismaFields.map(makeFilter);
    return results.length === 1 ? results[0] as Record<string, unknown> : { [multipleLogic]: results };
  };
  // 无值操作符必须先分支：其 value 约定为空串，进入 scalarValue 会被误判为「筛选值不合法」
  if (VALUELESS_OPERATORS.has(operation)) {
    const isEmpty = operation === 'IS_EMPTY';
    if (definition.type === 'text') {
      // 文本判空覆盖 null 与空串；多字段须全部字段为空才算空，故按 AND 组合
      return isEmpty
        ? forEachField((field) => ({ OR: [{ [field]: null }, { [field]: '' }] }), 'AND')
        : forEachField((field) => ({ AND: [{ NOT: { [field]: null } }, { NOT: { [field]: '' } }] }), 'AND');
    }
    // 枚举/数值/日期仅按 null 判空：枚举列传 '' 会被 Prisma 客户端校验拒绝
    return isEmpty
      ? forEachField((field) => ({ [field]: null }))
      : forEachField((field) => ({ [field]: { not: null } }));
  }
  if (RELATIVE_DATE_OPERATORS.has(operation)) {
    if (definition.type !== 'date') throw validationError(`字段 ${condition.field} 不支持 ${operation} 操作符`);
    const range = relativeDateRange(operation, new Date());
    return forEachField((field) => ({ [field]: { gte: range.gte, lt: range.lt } }));
  }
  const value = scalarValue(condition.value, definition.type);
  if (definition.type === 'text') {
    if (operation === 'EQUALS') return forEachField((field) => ({ [field]: { equals: value, mode: 'insensitive' } }));
    if (operation === 'NOT_EQUALS') return forEachField((field) => ({ [field]: { not: { equals: value, mode: 'insensitive' } } }), 'AND');
    if (operation === 'CONTAINS') return forEachField((field) => ({ [field]: { contains: value, mode: 'insensitive' } }));
    if (operation === 'NOT_CONTAINS') return forEachField((field) => ({ [field]: { not: { contains: value, mode: 'insensitive' } } }), 'AND');
    if (operation === 'STARTS_WITH') return forEachField((field) => ({ [field]: { startsWith: value, mode: 'insensitive' } }));
    if (operation === 'ENDS_WITH') return forEachField((field) => ({ [field]: { endsWith: value, mode: 'insensitive' } }));
  }
  if (definition.type === 'enum') {
    if (operation === 'EQUALS') return forEachField((field) => ({ [field]: value }));
    if (operation === 'NOT_EQUALS') return forEachField((field) => ({ [field]: { not: value } }));
  }
  if (definition.type === 'number' || definition.type === 'time') {
    if (operation === 'EQUALS') return forEachField((field) => ({ [field]: value }));
    if (operation === 'NOT_EQUALS') return forEachField((field) => ({ [field]: { not: value } }));
    if (operation === 'GREATER_THAN') return forEachField((field) => ({ [field]: { gt: value } }));
    if (operation === 'GREATER_THAN_OR_EQUAL') return forEachField((field) => ({ [field]: { gte: value } }));
    if (operation === 'LESS_THAN') return forEachField((field) => ({ [field]: { lt: value } }));
    if (operation === 'LESS_THAN_OR_EQUAL') return forEachField((field) => ({ [field]: { lte: value } }));
    if (operation === 'BETWEEN') {
      if (!condition.valueEnd) throw validationError(`字段 ${condition.field} 缺少区间结束值`);
      const end = scalarValue(condition.valueEnd, definition.type);
      if (typeof value !== 'number' || typeof end !== 'number' || end < value) throw validationError(`字段 ${condition.field} 的数值区间不合法`);
      return forEachField((field) => ({ [field]: { gte: value, lte: end } }));
    }
  }
  if (definition.type === 'date') {
    if (!(value instanceof Date)) throw validationError(`字段 ${condition.field} 必须是日期`);
    if (operation === 'EQUALS') return forEachField((field) => ({ [field]: { gte: value, lt: nextDay(value) } }));
    // 匹配当天之外：早于当天零点，或晚于等于次日零点
    if (operation === 'NOT_EQUALS') return forEachField((field) => ({ OR: [{ [field]: { lt: value } }, { [field]: { gte: nextDay(value) } }] }));
    if (operation === 'BEFORE') return forEachField((field) => ({ [field]: { lt: value } }));
    if (operation === 'AFTER') return forEachField((field) => ({ [field]: { gte: nextDay(value) } }));
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
  if (definition.compile) {
    // 无值操作符不进入标量解析（其 value 约定为空串）；其余先解析再交给自定义谓词
    const valueless = VALUELESS_OPERATORS.has(condition.operator) || RELATIVE_DATE_OPERATORS.has(condition.operator);
    const compiled = definition.compile({
      condition,
      value: valueless ? null : scalarValue(condition.value, definition.type),
      valueEnd: condition.valueEnd === undefined ? undefined : scalarValue(condition.valueEnd, definition.type),
      nextParam,
    });
    if (compiled === undefined) throw validationError(`字段 ${condition.field} 不支持 ${condition.operator} 操作符`);
    return compiled;
  }
  const column = definition.column;
  // 无值操作符必须先分支：其 value 约定为空串，进入 scalarValue 会被误判为「筛选值不合法」
  if (VALUELESS_OPERATORS.has(condition.operator)) {
    const isEmpty = condition.operator === 'IS_EMPTY';
    if (definition.type === 'text') {
      return isEmpty ? `(${column} IS NULL OR ${column} = '')` : `(${column} IS NOT NULL AND ${column} <> '')`;
    }
    // 枚举/数值/日期仅按 null 判空
    return isEmpty ? `${column} IS NULL` : `${column} IS NOT NULL`;
  }
  if (RELATIVE_DATE_OPERATORS.has(condition.operator)) {
    if (definition.type !== 'date') throw validationError(`字段 ${condition.field} 不支持 ${condition.operator} 操作符`);
    const range = relativeDateRange(condition.operator, new Date());
    return `${column} >= ${nextParam(range.gte)} AND ${column} < ${nextParam(range.lt)}`;
  }
  const value = scalarValue(condition.value, definition.type);
  const parameter = nextParam(value);
  if (definition.type === 'text') {
    if (condition.operator === 'EQUALS') return `${column} ILIKE ${parameter}`;
    if (condition.operator === 'NOT_EQUALS') return `${column} NOT ILIKE ${parameter}`;
    if (condition.operator === 'CONTAINS') return `${column} ILIKE '%' || ${parameter} || '%'`;
    if (condition.operator === 'NOT_CONTAINS') return `${column} NOT ILIKE '%' || ${parameter} || '%'`;
    if (condition.operator === 'STARTS_WITH') return `${column} ILIKE ${parameter} || '%'`;
    if (condition.operator === 'ENDS_WITH') return `${column} ILIKE '%' || ${parameter}`;
  }
  if (definition.type === 'enum') {
    if (condition.operator === 'EQUALS') return `${column} = ${parameter}`;
    if (condition.operator === 'NOT_EQUALS') return `${column} <> ${parameter}`;
  }
  if (definition.type === 'number' || definition.type === 'time') {
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
    if (condition.operator === 'BETWEEN') {
      if (!condition.valueEnd) throw validationError(`字段 ${condition.field} 缺少区间结束值`);
      const end = scalarValue(condition.valueEnd, definition.type);
      if (typeof value !== 'number' || typeof end !== 'number' || end < value) throw validationError(`字段 ${condition.field} 的数值区间不合法`);
      return `${column} >= ${parameter} AND ${column} <= ${nextParam(end)}`;
    }
  }
  if (definition.type === 'date') {
    if (!(value instanceof Date)) throw validationError(`字段 ${condition.field} 必须是日期`);
    if (condition.operator === 'EQUALS') return `${column} >= ${parameter} AND ${column} < ${nextParam(nextDay(value))}`;
    if (condition.operator === 'NOT_EQUALS') return `(${column} < ${parameter} OR ${column} >= ${nextParam(nextDay(value))})`;
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
  // 无值操作符必须先分支：其 value 约定为空串，进入 scalarValue 会被误判为「筛选值不合法」
  if (VALUELESS_OPERATORS.has(condition.operator)) {
    // 文本判空覆盖 null/undefined/空串；枚举/数值/日期仅 null/undefined 判空
    const isEmpty = definition.type === 'text'
      ? actual === null || actual === undefined || actual === ''
      : actual === null || actual === undefined;
    return condition.operator === 'IS_EMPTY' ? isEmpty : !isEmpty;
  }
  if (RELATIVE_DATE_OPERATORS.has(condition.operator)) {
    if (definition.type !== 'date') throw validationError(`字段 ${condition.field} 不支持 ${condition.operator} 操作符`);
    const left = memoryDate(actual);
    if (!left) return false;
    const range = relativeDateRange(condition.operator, new Date());
    return left >= range.gte && left < range.lt;
  }
  const expected = scalarValue(condition.value, definition.type);
  if (definition.type === 'text') {
    const left = String(actual ?? '').toLocaleLowerCase('zh-CN');
    const right = String(expected).toLocaleLowerCase('zh-CN');
    if (condition.operator === 'EQUALS') return left === right;
    if (condition.operator === 'NOT_EQUALS') return left !== right;
    if (condition.operator === 'CONTAINS') return left.includes(right);
    if (condition.operator === 'NOT_CONTAINS') return !left.includes(right);
    if (condition.operator === 'STARTS_WITH') return left.startsWith(right);
    if (condition.operator === 'ENDS_WITH') return left.endsWith(right);
  }
  if (definition.type === 'enum') {
    if (condition.operator === 'EQUALS') return String(actual ?? '') === expected;
    if (condition.operator === 'NOT_EQUALS') return String(actual ?? '') !== expected;
  }
  if (definition.type === 'number' || definition.type === 'time') {
    const left = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(left) || typeof expected !== 'number') return false;
    if (condition.operator === 'EQUALS') return left === expected;
    if (condition.operator === 'NOT_EQUALS') return left !== expected;
    if (condition.operator === 'GREATER_THAN') return left > expected;
    if (condition.operator === 'GREATER_THAN_OR_EQUAL') return left >= expected;
    if (condition.operator === 'LESS_THAN') return left < expected;
    if (condition.operator === 'LESS_THAN_OR_EQUAL') return left <= expected;
    if (condition.operator === 'BETWEEN') {
      if (!condition.valueEnd) throw validationError(`字段 ${condition.field} 缺少区间结束值`);
      const end = scalarValue(condition.valueEnd, definition.type);
      if (typeof end !== 'number' || end < expected) throw validationError(`字段 ${condition.field} 的数值区间不合法`);
      return left >= expected && left <= end;
    }
  }
  if (definition.type === 'date') {
    const left = memoryDate(actual);
    if (!(expected instanceof Date) || !left) return false;
    if (condition.operator === 'EQUALS') return left >= expected && left < nextDay(expected);
    if (condition.operator === 'NOT_EQUALS') return left < expected || left >= nextDay(expected);
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
  if (type === 'number' || type === 'time') return Number(left) - Number(right);
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
  if (type === 'time') {
    const match = /^(?:([01]\d|2[0-3]):([0-5]\d)|(24):00)$/.exec(value);
    if (!match) throw validationError('时间筛选值必须为 HH:mm');
    if (match[3] === '24') return 1_440;
    return Number(match[1]) * 60 + Number(match[2]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validationError('日期筛选值必须为 YYYY-MM-DD');
  const parsed = shanghaiDayStart(value);
  if (Number.isNaN(parsed.getTime()) || formatShanghaiDate(parsed) !== value) throw validationError('日期筛选值不合法');
  return parsed;
}

function nextDay(value: Date): Date {
  return new Date(value.getTime() + DAY_MS);
}

/**
 * 相对日期换算：按 Asia/Shanghai 日历日求值，返回左闭右开区间 [gte, lt)。
 * 周一为一周起点；LAST_7_DAYS/LAST_30_DAYS 含今天，共 7/30 个自然日。
 */
function relativeDateRange(operator: TableOperator, now: Date): { gte: Date; lt: Date } {
  const today = formatShanghaiDate(now);
  const start = shanghaiDayStart(today);
  if (operator === 'TODAY') return { gte: start, lt: nextDay(start) };
  if (operator === 'THIS_WEEK') {
    // 星期几按日历日判定：以正午 UTC 构造日期取 UTCDay，避免时区边界误差
    const weekDay = new Date(`${today}T12:00:00.000Z`).getUTCDay();
    const sinceMonday = (weekDay + 6) % 7;
    const monday = new Date(start.getTime() - sinceMonday * DAY_MS);
    return { gte: monday, lt: new Date(monday.getTime() + 7 * DAY_MS) };
  }
  if (operator === 'THIS_MONTH') {
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    return { gte: shanghaiDayStart(`${today.slice(0, 7)}-01`), lt: shanghaiDayStart(nextMonth) };
  }
  if (operator === 'THIS_YEAR') {
    const year = Number(today.slice(0, 4));
    return { gte: shanghaiDayStart(`${year}-01-01`), lt: shanghaiDayStart(`${year + 1}-01-01`) };
  }
  if (operator === 'LAST_7_DAYS') return { gte: new Date(start.getTime() - 6 * DAY_MS), lt: nextDay(start) };
  if (operator === 'LAST_30_DAYS') return { gte: new Date(start.getTime() - 29 * DAY_MS), lt: nextDay(start) };
  throw validationError(`不支持相对日期操作符 ${operator}`);
}

/** 上海时区纯日期的零点时刻；与 scalarValue 的日期构造方式保持一致。 */
function shanghaiDayStart(yearMonthDay: string): Date {
  return new Date(`${yearMonthDay}T00:00:00.000+08:00`);
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

/** 根下的树节点：单条条件或一层子组；子组内再出现子组直接拒绝，保证编译递归深度有界。 */
function asTreeNode(value: unknown): TableFilterTreeNode {
  if (isRecord(value) && Array.isArray(value.conditions)) {
    return {
      logic: value.logic === 'OR' ? 'OR' : 'AND',
      conditions: value.conditions.map((item) => {
        if (isRecord(item) && Array.isArray(item.conditions)) throw new Error('nested group');
        return asCondition(item);
      }),
    };
  }
  return asCondition(value);
}

function asCondition(value: unknown): TableFilterCondition {
  if (!isRecord(value) || typeof value.field !== 'string' || typeof value.operator !== 'string' || typeof value.value !== 'string') {
    throw new Error('invalid condition');
  }
  return { field: value.field, operator: value.operator as TableOperator, value: value.value, ...(typeof value.valueEnd === 'string' ? { valueEnd: value.valueEnd } : {}) };
}

function isTreeGroup(node: TableFilterTreeNode): node is TableFilterTreeGroup {
  return 'conditions' in node;
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
