/**
 * 钉钉式高级筛选模型层（纯 TS，无 React 依赖；DataTable 与 AdvancedFilter 共用）。
 *
 * 三层架构：根条件组 → 子条件组/条件行，子组只允许出现在根组下（最多 2 层组）。
 * 序列化产物即列表查询的 filters 参数：`{ logic, conditions: [条件 | 子组...] }`，
 * 条件为 `{ field, operator, value, valueEnd? }`（无值运算符 value 传 ""），
 * 无任何有效条件时整体省略 filters 参数。
 */
import type { RemoteOptionSource } from './selectors/remote-options';

export type FilterFieldType = 'text' | 'enum' | 'number' | 'date' | 'remote' | 'tree';

export interface FilterField {
  key: string;
  title: string;
  type?: FilterFieldType;
  /** 固定选项，或按当前筛选条件动态生成（如「功能」选项随已选「系统」联动，主 PRD §3.3）。 */
  options?: Array<{ label: string; value: string }> | ((filters: FilterCondition[]) => Array<{ label: string; value: string }>);
  /** 按名称可搜索的远程字典/实体下拉（主 PRD §10.2）。 */
  remote?: RemoteOptionSource;
  /**
   * 限定该字段可选的运算符子集（运算符 value 列表，按矩阵顺序展示）。
   * 缺省使用字段类型的完整矩阵；用于后端只能支持部分语义的字段
   * （如单月聚合维度只允许「等于」）。
   */
  operators?: string[];
}

export interface FilterCondition {
  /** 前端编辑主键；仅编辑态使用，序列化提交前剥离。 */
  id: string;
  field: string;
  operator: string;
  value: string;
  /** 区间筛选的结束值；仅 BETWEEN 运算符使用。 */
  valueEnd?: string;
  /** 远程/树选项的可读名称；仅供条件标签栏回显，序列化提交前剥离。 */
  valueLabel?: string;
}

export type FilterLogic = 'AND' | 'OR';

/** 条件组：根组可含条件与子组；子组只含条件（最多 2 层组）。 */
export interface FilterConditionGroup {
  id: string;
  logic: FilterLogic;
  children: Array<FilterCondition | FilterConditionGroup>;
}

export interface SortCondition {
  field: string;
  direction: 'ASC' | 'DESC';
}

/** filters 查询参数中的序列化条件（无 id/valueLabel）。 */
export interface FilterTreePayloadCondition {
  field: string;
  operator: string;
  value: string;
  valueEnd?: string;
}

/** filters 查询参数的序列化形状；子组只允许出现在根组下。 */
export interface FilterTreePayloadGroup {
  logic: FilterLogic;
  conditions: Array<FilterTreePayloadCondition | FilterTreePayloadGroup>;
}

/** 无需填写值即可生效的运算符：value 恒为 ""。 */
export const NO_VALUE_OPERATORS: ReadonlySet<string> = new Set([
  'IS_EMPTY',
  'IS_NOT_EMPTY',
  'TODAY',
  'THIS_WEEK',
  'THIS_MONTH',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
]);

/** 各字段类型可选运算符（运算符矩阵，与钉钉高级筛选对齐）。 */
export const OPERATOR_OPTIONS: Readonly<Record<FilterFieldType, Array<{ label: string; value: string }>>> = {
  text: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
    { label: '包含', value: 'CONTAINS' },
    { label: '不包含', value: 'NOT_CONTAINS' },
    { label: '开头是', value: 'STARTS_WITH' },
    { label: '结尾是', value: 'ENDS_WITH' },
    { label: '为空', value: 'IS_EMPTY' },
    { label: '不为空', value: 'IS_NOT_EMPTY' },
  ],
  enum: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
    { label: '为空', value: 'IS_EMPTY' },
    { label: '不为空', value: 'IS_NOT_EMPTY' },
  ],
  number: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
    { label: '大于', value: 'GREATER_THAN' },
    { label: '小于', value: 'LESS_THAN' },
    { label: '大于等于', value: 'GREATER_THAN_OR_EQUAL' },
    { label: '小于等于', value: 'LESS_THAN_OR_EQUAL' },
    { label: '介于', value: 'BETWEEN' },
    { label: '为空', value: 'IS_EMPTY' },
    { label: '不为空', value: 'IS_NOT_EMPTY' },
  ],
  date: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
    { label: '早于', value: 'BEFORE' },
    { label: '晚于', value: 'AFTER' },
    { label: '介于', value: 'BETWEEN' },
    { label: '今天', value: 'TODAY' },
    { label: '本周', value: 'THIS_WEEK' },
    { label: '本月', value: 'THIS_MONTH' },
    { label: '过去 7 天', value: 'LAST_7_DAYS' },
    { label: '过去 30 天', value: 'LAST_30_DAYS' },
    { label: '为空', value: 'IS_EMPTY' },
    { label: '不为空', value: 'IS_NOT_EMPTY' },
  ],
  remote: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
    { label: '为空', value: 'IS_EMPTY' },
    { label: '不为空', value: 'IS_NOT_EMPTY' },
  ],
  tree: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
    { label: '为空', value: 'IS_EMPTY' },
    { label: '不为空', value: 'IS_NOT_EMPTY' },
  ],
};

/** 各字段类型新建条件时的默认运算符。 */
export const DEFAULT_OPERATOR_BY_TYPE: Readonly<Record<FilterFieldType, string>> = {
  text: 'CONTAINS',
  enum: 'EQUALS',
  number: 'EQUALS',
  date: 'EQUALS',
  remote: 'EQUALS',
  tree: 'EQUALS',
};

/** 字段可选运算符：有 operators 白名单时按矩阵顺序过滤，否则用字段类型的完整矩阵。 */
export function operatorOptionsFor(field: FilterField | undefined): Array<{ label: string; value: string }> {
  const options = OPERATOR_OPTIONS[field?.type ?? 'text'];
  if (!field?.operators) {
    return [...options];
  }
  const allowed = new Set(field.operators);
  return options.filter((option) => allowed.has(option.value));
}

/** 字段新建条件的默认运算符：白名单取首项，否则取字段类型默认。 */
export function defaultOperatorFor(field: FilterField | undefined): string {
  return field?.operators?.[0] ?? DEFAULT_OPERATOR_BY_TYPE[field?.type ?? 'text'];
}

/** 数字/日期值格式（validateFilterTree 校验「部分填写」行用）。 */
const NUMBER_VALUE_PATTERN = /^-?\d+(?:\.\d+)?$/;
const DATE_VALUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isFilterGroup(node: FilterCondition | FilterConditionGroup): node is FilterConditionGroup {
  return 'children' in node;
}

/** 新建空条件行：取第一个可筛选字段与该字段的默认运算符（尊重 operators 白名单）。 */
export function createEmptyCondition(fields: FilterField[]): FilterCondition {
  const field = fields[0];
  return {
    id: crypto.randomUUID(),
    field: field?.key ?? '',
    operator: defaultOperatorFor(field),
    value: '',
  };
}

/** 新建逻辑组：默认「且」，含 1 条空条件行。 */
export function createEmptyGroup(fields: FilterField[]): FilterConditionGroup {
  return { id: crypto.randomUUID(), logic: 'AND', children: [createEmptyCondition(fields)] };
}

/**
 * 条件是否已填写：值非空，或运算符本身无需值（为空/今天等）。
 * 注意：仅按 value.trim() 判定会把「为空」类条件误删，剪枝与计数必须走本函数。
 */
export function isConditionPopulated(condition: FilterCondition): boolean {
  return condition.value.trim() !== '' || NO_VALUE_OPERATORS.has(condition.operator);
}

/**
 * 条件可无损镜像为具名查询参数时的镜像值；否则 undefined。
 * 仅「等于」条件可镜像——其余操作符（不等于/包含等）镜像成等号会扭曲语义；
 * 具名镜像仅供尚未解析 filters 的既有接口联调，支持结构化筛选的接口以 filters 树为准。
 */
export function namedParamMirrorValue(condition: FilterCondition): string | undefined {
  return condition.operator === 'EQUALS' && condition.value.trim() !== '' ? condition.value : undefined;
}

/** 深度优先展开树中全部条件行（含未填写的草稿行）。 */
export function flattenConditions(root: FilterConditionGroup): FilterCondition[] {
  const result: FilterCondition[] = [];
  for (const child of root.children) {
    if (isFilterGroup(child)) {
      result.push(...flattenConditions(child));
    } else {
      result.push(child);
    }
  }
  return result;
}

/**
 * 从树中移除指定条件（不可变更新）。
 * 组内删空后补 1 条空条件行、保留组本身（子组删空同理不删组）；该规则适用于编辑草稿。
 * 已应用树的标签栏单条移除同样走本函数，补出的空行由序列化时的剪枝静默清理。
 *
 * @param fields 可筛选字段；用于构造补位的空条件行（缺省则补无字段的空行）
 */
export function removeConditionFromTree(root: FilterConditionGroup, conditionId: string, fields: FilterField[] = []): FilterConditionGroup {
  const removeFromGroup = (group: FilterConditionGroup): FilterConditionGroup => {
    const children = group.children
      .map((child) => (isFilterGroup(child) ? removeFromGroup(child) : child))
      .filter((child) => isFilterGroup(child) || child.id !== conditionId);
    return children.length === 0 ? { ...group, children: [createEmptyCondition(fields)] } : { ...group, children };
  };
  return removeFromGroup(root);
}

/**
 * 定稿剪枝（「确定」应用/序列化前调用）：删除未填充条件与删空后的子组。
 * 保留条件的 id/valueLabel 供编辑态继续使用；根组永不删除自身，剪空后 children 为 []。
 */
export function pruneFilterTree(root: FilterConditionGroup): FilterConditionGroup {
  const children = root.children
    .map((child): FilterCondition | FilterConditionGroup | null => {
      if (!isFilterGroup(child)) {
        return isConditionPopulated(child) ? child : null;
      }
      // 子组只含条件（最多 2 层组）；删空后的子组整体移除
      const conditions = child.children.filter((node): node is FilterCondition => !isFilterGroup(node) && isConditionPopulated(node));
      return conditions.length > 0 ? { ...child, children: conditions } : null;
    })
    .filter((child): child is FilterCondition | FilterConditionGroup => child !== null);
  return { ...root, children };
}

/** 序列化为 filters 查询参数形状：剪枝 + 剥离 id/valueLabel；无任何有效条件时返回 undefined（不传 filters）。 */
export function buildFilterTreePayload(root: FilterConditionGroup): FilterTreePayloadGroup | undefined {
  const pruned = pruneFilterTree(root);
  if (pruned.children.length === 0) {
    return undefined;
  }
  const toPayloadCondition = (condition: FilterCondition): FilterTreePayloadCondition => {
    const payload: FilterTreePayloadCondition = { field: condition.field, operator: condition.operator, value: condition.value };
    if (condition.valueEnd !== undefined) {
      payload.valueEnd = condition.valueEnd;
    }
    return payload;
  };
  return {
    logic: pruned.logic,
    conditions: pruned.children.map((child) =>
      isFilterGroup(child)
        ? {
            logic: child.logic,
            // pruneFilterTree 已保证子组只含已填充条件
            conditions: child.children.filter((node): node is FilterCondition => !isFilterGroup(node)).map(toPayloadCondition),
          }
        : toPayloadCondition(child)),
  };
}

/**
 * 提交前校验：仅对「部分填写」的行报错——BETWEEN 只填一端、number/date 值非空但格式非法。
 * 完全未填的行由 pruneFilterTree 静默丢弃，不报错。
 *
 * @returns 逐条错误文案；空数组表示校验通过
 */
export function validateFilterTree(root: FilterConditionGroup, fields: FilterField[]): string[] {
  const errors: string[] = [];
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  const isValueFormatValid = (type: FilterFieldType, value: string): boolean => {
    if (type === 'number') return NUMBER_VALUE_PATTERN.test(value.trim());
    if (type === 'date') return DATE_VALUE_PATTERN.test(value.trim());
    return true;
  };
  for (const condition of flattenConditions(root)) {
    const field = fieldByKey.get(condition.field);
    const fieldTitle = field?.title ?? condition.field;
    const type = field?.type ?? 'text';
    if (NO_VALUE_OPERATORS.has(condition.operator)) {
      continue;
    }
    if (condition.operator === 'BETWEEN') {
      const hasStart = condition.value.trim() !== '';
      const hasEnd = (condition.valueEnd ?? '').trim() !== '';
      if (hasStart !== hasEnd) {
        errors.push(`「${fieldTitle}」的介于条件需要同时填写起止值`);
        continue;
      }
      if (!hasStart) {
        continue;
      }
      if (!isValueFormatValid(type, condition.value) || !isValueFormatValid(type, condition.valueEnd ?? '')) {
        errors.push(`「${fieldTitle}」的值格式不正确（${type === 'number' ? '需为数字' : '需为 YYYY-MM-DD 日期'}）`);
      }
      continue;
    }
    if (condition.value.trim() === '') {
      continue;
    }
    if (!isValueFormatValid(type, condition.value)) {
      errors.push(`「${fieldTitle}」的值格式不正确（${type === 'number' ? '需为数字' : '需为 YYYY-MM-DD 日期'}）`);
    }
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 空根组（AND + 无子级），预设归一化的回退形态。 */
function createEmptyRootGroup(): FilterConditionGroup {
  return { id: crypto.randomUUID(), logic: 'AND', children: [] };
}

/** 旧版/序列化条件 → 编辑态条件：补新 id；缺 field/operator 的坏数据直接丢弃。 */
function toEditableCondition(raw: unknown): FilterCondition | null {
  if (!isRecord(raw) || typeof raw.field !== 'string' || typeof raw.operator !== 'string') {
    return null;
  }
  const condition: FilterCondition = {
    id: crypto.randomUUID(),
    field: raw.field,
    operator: raw.operator,
    value: typeof raw.value === 'string' ? raw.value : '',
  };
  if (typeof raw.valueEnd === 'string') {
    condition.valueEnd = raw.valueEnd;
  }
  if (typeof raw.valueLabel === 'string') {
    condition.valueLabel = raw.valueLabel;
  }
  return condition;
}

/** 序列化组形状 → 编辑态组（补新 id）；allowGroups 仅根组为 true（最多 2 层组）。 */
function toEditableGroup(raw: Record<string, unknown>, allowGroups: boolean): FilterConditionGroup {
  const logic: FilterLogic = raw.logic === 'OR' ? 'OR' : 'AND';
  const items = Array.isArray(raw.conditions) ? raw.conditions : [];
  const children: Array<FilterCondition | FilterConditionGroup> = [];
  for (const item of items) {
    if (isRecord(item) && Array.isArray(item.conditions)) {
      if (allowGroups) {
        children.push(toEditableGroup(item, false));
      }
      continue;
    }
    const condition = toEditableCondition(item);
    if (condition) {
      children.push(condition);
    }
  }
  return { id: crypto.randomUUID(), logic, children };
}

/** 排序项归一化：仅保留 field/direction 合法的项。 */
function normalizeSorts(raw: unknown): SortCondition[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(isRecord)
    .filter((item): item is Record<string, unknown> & { field: string; direction: 'ASC' | 'DESC' } =>
      typeof item.field === 'string' && (item.direction === 'ASC' || item.direction === 'DESC'))
    .map((item) => ({ field: item.field, direction: item.direction }));
}

/**
 * 预设 content 归一化为编辑态 {树, 排序}，应用预设时一次性写入状态。
 *
 * 兼容两种存储形状：
 * - 新版 `{ filterTree, sorts }`（filterTree 为序列化组形状，可为 null 表示仅存排序）；
 * - 旧版 `{ filters, filterGroups, filterLogic, sorts }`，语义映射（保语义）：
 *   filterGroups 为空 → 根 { logic: filterLogic ?? 'AND', children: filters }；
 *   filterGroups 非空 → 根 OR，主条件按 filterLogic 归并（AND 合为一组）或拆分（OR 拆为单条件组），
 *   与各条件组（组内恒 AND）同处根 OR 之下。
 * 非法/缺失输入回退空树 + 空排序；所有条件一律补新 id。
 */
export function normalizePresetContent(content: unknown): { tree: FilterConditionGroup; sorts: SortCondition[] } {
  if (!isRecord(content)) {
    return { tree: createEmptyRootGroup(), sorts: [] };
  }
  const sorts = normalizeSorts(content.sorts);

  if (isRecord(content.filterTree)) {
    return { tree: toEditableGroup(content.filterTree, true), sorts };
  }

  if (Array.isArray(content.filters) || Array.isArray(content.filterGroups)) {
    const filters = (Array.isArray(content.filters) ? content.filters : [])
      .map(toEditableCondition)
      .filter((condition): condition is FilterCondition => condition !== null);
    const groups = (Array.isArray(content.filterGroups) ? content.filterGroups : [])
      .map((raw): FilterConditionGroup | null => {
        if (!isRecord(raw)) {
          return null;
        }
        const conditions = (Array.isArray(raw.conditions) ? raw.conditions : [])
          .map(toEditableCondition)
          .filter((condition): condition is FilterCondition => condition !== null);
        return conditions.length > 0 ? { id: crypto.randomUUID(), logic: 'AND', children: conditions } : null;
      })
      .filter((group): group is FilterConditionGroup => group !== null);
    const logic: FilterLogic = content.filterLogic === 'OR' ? 'OR' : 'AND';
    if (groups.length === 0) {
      return { tree: { id: crypto.randomUUID(), logic, children: filters }, sorts };
    }
    // 旧复杂组合协议（组内 AND、组间 OR）：主条件与条件组同处根 OR 之下
    const children: Array<FilterCondition | FilterConditionGroup> = [
      ...(logic === 'AND'
        ? (filters.length > 0 ? [{ id: crypto.randomUUID(), logic: 'AND' as const, children: filters }] : [])
        : filters.map((filter) => ({ id: crypto.randomUUID(), logic: 'AND' as const, children: [filter] }))),
      ...groups,
    ];
    return { tree: { id: crypto.randomUUID(), logic: 'OR', children }, sorts };
  }

  // 无筛选内容（如仅存排序的预设 { filterTree: null, sorts }）：空树 + 既有排序
  return { tree: createEmptyRootGroup(), sorts };
}
