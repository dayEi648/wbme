import { describe, expect, it } from 'vitest';
import {
  buildFilterTreePayload,
  createEmptyCondition,
  createEmptyGroup,
  DEFAULT_OPERATOR_BY_TYPE,
  defaultOperatorFor,
  flattenConditions,
  isConditionPopulated,
  isFilterGroup,
  namedParamMirrorValue,
  NO_VALUE_OPERATORS,
  normalizePresetContent,
  OPERATOR_OPTIONS,
  operatorOptionsFor,
  pruneFilterTree,
  removeConditionFromTree,
  validateFilterTree,
  type FilterCondition,
  type FilterConditionGroup,
  type FilterField,
} from './advanced-filter';

/**
 * 高级筛选模型层回归测试：运算符矩阵、填充判定、树编辑（移除/剪枝）、
 * filters 序列化协议、预设 content 新旧形状归一化、提交前校验。
 */

const FIELDS: FilterField[] = [
  { key: 'name', title: '名称', type: 'text' },
  { key: 'status', title: '状态', type: 'enum', options: [{ label: '启用', value: 'ACTIVE' }] },
  { key: 'amount', title: '金额', type: 'number' },
  { key: 'createdAt', title: '创建时间', type: 'date' },
];

/** 构造编辑态条件：默认 EQUALS + 空值，可按需覆盖。 */
const condition = (partial: Partial<FilterCondition> & { field: string }): FilterCondition => ({
  id: crypto.randomUUID(),
  operator: 'EQUALS',
  value: '',
  ...partial,
});

/** 构造只含条件的编辑态组。 */
const group = (logic: FilterConditionGroup['logic'], children: FilterConditionGroup['children']): FilterConditionGroup => ({
  id: crypto.randomUUID(),
  logic,
  children,
});

/** 取出数组元素并断言存在（noUncheckedIndexedAccess 下替代下标直取）。 */
function expectDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('断言失败：数组元素不存在');
  }
  return value;
}

describe('OPERATOR_OPTIONS 运算符矩阵', () => {
  it('覆盖全部 6 种字段类型', () => {
    expect(Object.keys(OPERATOR_OPTIONS).sort()).toEqual(['date', 'enum', 'number', 'remote', 'text', 'tree']);
  });

  it('文本：等于/不等于/包含/不包含/开头是/结尾是/为空/不为空', () => {
    expect(OPERATOR_OPTIONS.text.map((option) => option.value)).toEqual([
      'EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'IS_EMPTY', 'IS_NOT_EMPTY',
    ]);
  });

  it('枚举/远程/树：等于/不等于/为空/不为空', () => {
    const expected = ['EQUALS', 'NOT_EQUALS', 'IS_EMPTY', 'IS_NOT_EMPTY'];
    expect(OPERATOR_OPTIONS.enum.map((option) => option.value)).toEqual(expected);
    expect(OPERATOR_OPTIONS.remote.map((option) => option.value)).toEqual(expected);
    expect(OPERATOR_OPTIONS.tree.map((option) => option.value)).toEqual(expected);
  });

  it('数字：比较 + 介于 + 为空/不为空', () => {
    expect(OPERATOR_OPTIONS.number.map((option) => option.value)).toEqual([
      'EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'LESS_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL', 'BETWEEN', 'IS_EMPTY', 'IS_NOT_EMPTY',
    ]);
    expect(OPERATOR_OPTIONS.number.find((option) => option.value === 'BETWEEN')?.label).toBe('介于');
  });

  it('日期：比较 + 介于 + 相对日期 + 为空/不为空', () => {
    expect(OPERATOR_OPTIONS.date.map((option) => option.value)).toEqual([
      'EQUALS', 'NOT_EQUALS', 'BEFORE', 'AFTER', 'BETWEEN', 'TODAY', 'THIS_WEEK', 'THIS_MONTH', 'LAST_7_DAYS', 'LAST_30_DAYS', 'IS_EMPTY', 'IS_NOT_EMPTY',
    ]);
  });

  it('默认运算符：text 为 CONTAINS，其余 EQUALS；无值运算符集合完整', () => {
    expect(DEFAULT_OPERATOR_BY_TYPE.text).toBe('CONTAINS');
    expect(DEFAULT_OPERATOR_BY_TYPE.number).toBe('EQUALS');
    expect(DEFAULT_OPERATOR_BY_TYPE.date).toBe('EQUALS');
    expect([...NO_VALUE_OPERATORS].sort()).toEqual(['IS_EMPTY', 'IS_NOT_EMPTY', 'LAST_30_DAYS', 'LAST_7_DAYS', 'THIS_MONTH', 'THIS_WEEK', 'TODAY']);
  });
});

describe('operators 白名单（operatorOptionsFor / defaultOperatorFor）', () => {
  it('无白名单时使用字段类型完整矩阵', () => {
    const field: FilterField = { key: 'name', title: '名称', type: 'text' };
    expect(operatorOptionsFor(field).map((option) => option.value)).toEqual(OPERATOR_OPTIONS.text.map((option) => option.value));
    expect(defaultOperatorFor(field)).toBe('CONTAINS');
  });

  it('有白名单时按矩阵顺序过滤，默认运算符取白名单首项', () => {
    const field: FilterField = { key: 'month', title: '月份', type: 'text', operators: ['EQUALS'] };
    expect(operatorOptionsFor(field)).toEqual([{ label: '等于', value: 'EQUALS' }]);
    expect(defaultOperatorFor(field)).toBe('EQUALS');
    // 白名单顺序不影响展示顺序（始终按矩阵顺序）
    const multi: FilterField = { key: 'status', title: '状态', type: 'enum', operators: ['IS_NOT_EMPTY', 'EQUALS'] };
    expect(operatorOptionsFor(multi).map((option) => option.value)).toEqual(['EQUALS', 'IS_NOT_EMPTY']);
    expect(defaultOperatorFor(multi)).toBe('IS_NOT_EMPTY');
  });

  it('createEmptyCondition 尊重白名单默认运算符', () => {
    const created = createEmptyCondition([{ key: 'month', title: '月份', type: 'text', operators: ['EQUALS'] }]);
    expect(created.operator).toBe('EQUALS');
  });

  it('未定义字段回退 text 矩阵', () => {
    expect(operatorOptionsFor(undefined).map((option) => option.value)).toEqual(OPERATOR_OPTIONS.text.map((option) => option.value));
    expect(defaultOperatorFor(undefined)).toBe('CONTAINS');
  });
});

describe('namedParamMirrorValue 具名参数镜像', () => {
  it('仅值非空的「等于」条件可镜像', () => {
    expect(namedParamMirrorValue(condition({ field: 'status', operator: 'EQUALS', value: 'ACTIVE' }))).toBe('ACTIVE');
  });

  it('不等于/包含/介于等操作符不镜像（镜像成等号会扭曲语义）', () => {
    for (const operator of ['NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'GREATER_THAN', 'BETWEEN']) {
      expect(namedParamMirrorValue(condition({ field: 'x', operator, value: '1' }))).toBeUndefined();
    }
  });

  it('空值与无值运算符不镜像', () => {
    expect(namedParamMirrorValue(condition({ field: 'x', operator: 'EQUALS', value: '  ' }))).toBeUndefined();
    expect(namedParamMirrorValue(condition({ field: 'x', operator: 'IS_EMPTY', value: '' }))).toBeUndefined();
  });
});

describe('createEmptyCondition / createEmptyGroup', () => {
  it('空条件取第一个字段与该类型默认运算符', () => {
    const created = createEmptyCondition(FIELDS);
    expect(created.field).toBe('name');
    expect(created.operator).toBe('CONTAINS');
    expect(created.value).toBe('');
    expect(created.id).toBeTruthy();
  });

  it('空组为 AND + 1 条空条件；两次创建 id 不同', () => {
    const created = createEmptyGroup(FIELDS);
    expect(created.logic).toBe('AND');
    expect(created.children).toHaveLength(1);
    expect(created.id).not.toBe(createEmptyGroup(FIELDS).id);
  });
});

describe('isConditionPopulated', () => {
  it('「为空」类运算符 value 为 "" 也视为已填充（不能按 value.trim() 误删）', () => {
    expect(isConditionPopulated(condition({ field: 'name', operator: 'IS_EMPTY', value: '' }))).toBe(true);
    expect(isConditionPopulated(condition({ field: 'createdAt', operator: 'TODAY', value: '' }))).toBe(true);
  });

  it('普通运算符按值是否非空判定', () => {
    expect(isConditionPopulated(condition({ field: 'name', value: '' }))).toBe(false);
    expect(isConditionPopulated(condition({ field: 'name', value: '   ' }))).toBe(false);
    expect(isConditionPopulated(condition({ field: 'name', value: '甲' }))).toBe(true);
  });
});

describe('flattenConditions', () => {
  it('深度优先展开根组与子组中的全部条件', () => {
    const inner = condition({ field: 'amount', value: '1' });
    const outer = condition({ field: 'name', value: '甲' });
    const tree = group('AND', [outer, group('OR', [inner])]);
    expect(flattenConditions(tree).map((item) => item.id)).toEqual([outer.id, inner.id]);
  });
});

describe('removeConditionFromTree', () => {
  it('移除指定条件且不改动原树（不可变更新）', () => {
    const kept = condition({ field: 'name', value: '甲' });
    const removed = condition({ field: 'status', value: 'ACTIVE' });
    const tree = group('AND', [kept, removed]);
    const next = removeConditionFromTree(tree, removed.id, FIELDS);
    expect(tree.children).toHaveLength(2);
    expect(flattenConditions(next).map((item) => item.id)).toEqual([kept.id]);
  });

  it('根组只剩 1 条时删除后补空行，保留根组', () => {
    const only = condition({ field: 'name', value: '甲' });
    const next = removeConditionFromTree(group('AND', [only]), only.id, FIELDS);
    expect(next.children).toHaveLength(1);
    const blank = expectDefined(next.children[0]);
    expect(isFilterGroup(blank)).toBe(false);
    if (!isFilterGroup(blank)) {
      expect(blank.field).toBe('name');
      expect(blank.value).toBe('');
      expect(blank.id).not.toBe(only.id);
    }
  });

  it('子组删空后补空行，不删除子组自身', () => {
    const inner = condition({ field: 'amount', value: '1' });
    const subGroup = group('OR', [inner]);
    const next = removeConditionFromTree(group('AND', [condition({ field: 'name', value: '甲' }), subGroup]), inner.id, FIELDS);
    const nextSubGroup = expectDefined(next.children[1]);
    expect(isFilterGroup(nextSubGroup)).toBe(true);
    if (isFilterGroup(nextSubGroup)) {
      expect(nextSubGroup.children).toHaveLength(1);
      expect(isConditionPopulated(expectDefined(nextSubGroup.children[0]) as FilterCondition)).toBe(false);
    }
  });

  it('未传字段时补无字段的空行', () => {
    const only = condition({ field: 'name', value: '甲' });
    const next = removeConditionFromTree(group('AND', [only]), only.id);
    const blank = expectDefined(next.children[0]);
    expect(isFilterGroup(blank)).toBe(false);
    if (!isFilterGroup(blank)) {
      expect(blank.field).toBe('');
    }
  });
});

describe('pruneFilterTree', () => {
  it('删除未填充条件与删空后的子组，保留 id/valueLabel 与根组自身', () => {
    const populated = condition({ field: 'name', value: '甲', valueLabel: '甲方' });
    const subGroup = group('OR', [condition({ field: 'amount', value: '' })]);
    const tree = group('AND', [populated, condition({ field: 'status', value: '' }), subGroup]);
    const next = pruneFilterTree(tree);
    expect(next.children).toHaveLength(1);
    const survivor = expectDefined(next.children[0]);
    expect(isFilterGroup(survivor)).toBe(false);
    if (!isFilterGroup(survivor)) {
      expect(survivor.id).toBe(populated.id);
      expect(survivor.valueLabel).toBe('甲方');
    }
  });

  it('「为空」条件在剪枝中存活', () => {
    const empty = condition({ field: 'name', operator: 'IS_EMPTY', value: '' });
    const next = pruneFilterTree(group('AND', [empty]));
    expect(next.children).toHaveLength(1);
  });
});

describe('buildFilterTreePayload', () => {
  it('剥离 id/valueLabel，按树形序列化嵌套结构', () => {
    const outer = condition({ field: 'name', value: '甲', valueLabel: '甲方' });
    const innerA = condition({ field: 'amount', operator: 'GREATER_THAN', value: '10' });
    const innerB = condition({ field: 'createdAt', operator: 'BETWEEN', value: '2026-01-01', valueEnd: '2026-01-31' });
    const tree = group('AND', [outer, group('OR', [innerA, innerB])]);
    expect(buildFilterTreePayload(tree)).toEqual({
      logic: 'AND',
      conditions: [
        { field: 'name', operator: 'EQUALS', value: '甲' },
        {
          logic: 'OR',
          conditions: [
            { field: 'amount', operator: 'GREATER_THAN', value: '10' },
            { field: 'createdAt', operator: 'BETWEEN', value: '2026-01-01', valueEnd: '2026-01-31' },
          ],
        },
      ],
    });
  });

  it('剪枝空行与空子组；无值运算符保留且 value 为 ""', () => {
    const tree = group('AND', [
      condition({ field: 'name', value: '' }),
      condition({ field: 'status', operator: 'IS_NOT_EMPTY', value: '' }),
      group('OR', [condition({ field: 'amount', value: '' })]),
    ]);
    expect(buildFilterTreePayload(tree)).toEqual({
      logic: 'AND',
      conditions: [{ field: 'status', operator: 'IS_NOT_EMPTY', value: '' }],
    });
  });

  it('全部为空时返回 undefined（不传 filters 参数）', () => {
    expect(buildFilterTreePayload(group('AND', [condition({ field: 'name', value: '' })]))).toBeUndefined();
    expect(buildFilterTreePayload(group('AND', []))).toBeUndefined();
  });

  it('非 BETWEEN 条件不带 valueEnd 键', () => {
    const payload = buildFilterTreePayload(group('AND', [condition({ field: 'name', value: '甲' })]));
    expect(payload?.conditions[0]).toEqual({ field: 'name', operator: 'EQUALS', value: '甲' });
    expect('valueEnd' in (payload?.conditions[0] ?? {})).toBe(false);
  });
});

describe('normalizePresetContent', () => {
  const sorts = [{ field: 'createdAt', direction: 'DESC' as const }];
  const legacyFilter = { field: 'name', operator: 'CONTAINS', value: '甲' };
  const legacyGroupFilter = { field: 'amount', operator: 'GREATER_THAN', value: '10' };

  it('新版 { filterTree, sorts }：结构保留、所有条件补新 id', () => {
    const { tree, sorts: normalizedSorts } = normalizePresetContent({
      filterTree: {
        logic: 'OR',
        conditions: [
          { field: 'name', operator: 'CONTAINS', value: '甲', valueEnd: undefined },
          { logic: 'AND', conditions: [legacyGroupFilter] },
        ],
      },
      sorts,
    });
    expect(tree.logic).toBe('OR');
    expect(tree.children).toHaveLength(2);
    const first = expectDefined(tree.children[0]);
    const second = expectDefined(tree.children[1]);
    expect(isFilterGroup(first)).toBe(false);
    if (!isFilterGroup(first)) {
      expect(first).toMatchObject({ field: 'name', operator: 'CONTAINS', value: '甲' });
      expect(first.id).toBeTruthy();
    }
    expect(isFilterGroup(second)).toBe(true);
    if (isFilterGroup(second)) {
      expect(second.logic).toBe('AND');
      expect(second.children[0]).toMatchObject(legacyGroupFilter);
    }
    expect(normalizedSorts).toEqual(sorts);
  });

  it('旧版无条件组：根组沿用 filterLogic，filters 平铺', () => {
    const { tree } = normalizePresetContent({ filters: [legacyFilter], filterGroups: [], filterLogic: 'OR', sorts: [] });
    expect(tree.logic).toBe('OR');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject(legacyFilter);
  });

  it('旧版 AND 主条件 + 条件组：主条件合并为一个 AND 组，与条件组同处根 OR 下', () => {
    const { tree } = normalizePresetContent({
      filters: [legacyFilter],
      filterGroups: [{ id: 'g1', conditions: [legacyGroupFilter] }],
      filterLogic: 'AND',
    });
    expect(tree.logic).toBe('OR');
    expect(tree.children).toHaveLength(2);
    const mainGroup = expectDefined(tree.children[0]);
    const legacyGroup = expectDefined(tree.children[1]);
    expect(isFilterGroup(mainGroup) && mainGroup.logic).toBe('AND');
    expect(isFilterGroup(mainGroup) && mainGroup.children[0]).toMatchObject(legacyFilter);
    expect(isFilterGroup(legacyGroup) && legacyGroup.children[0]).toMatchObject(legacyGroupFilter);
  });

  it('旧版 OR 主条件 + 条件组：主条件拆为单条件 AND 组', () => {
    const second = { field: 'status', operator: 'EQUALS', value: 'ACTIVE' };
    const { tree } = normalizePresetContent({
      filters: [legacyFilter, second],
      filterGroups: [{ id: 'g1', conditions: [legacyGroupFilter] }],
      filterLogic: 'OR',
    });
    expect(tree.logic).toBe('OR');
    expect(tree.children).toHaveLength(3);
    for (const child of tree.children) {
      expect(isFilterGroup(child)).toBe(true);
    }
    const [firstGroup, secondGroup] = tree.children as [FilterConditionGroup, FilterConditionGroup, ...FilterConditionGroup[]];
    expect(firstGroup.children[0]).toMatchObject(legacyFilter);
    expect(secondGroup.children[0]).toMatchObject(second);
  });

  it('旧版数据补新 id、丢弃缺 field/operator 的坏行', () => {
    const { tree } = normalizePresetContent({ filters: [legacyFilter, { operator: 'EQUALS' }], filterLogic: 'AND' });
    expect(tree.children).toHaveLength(1);
    const first = expectDefined(tree.children[0]);
    expect(isFilterGroup(first)).toBe(false);
    if (!isFilterGroup(first)) {
      expect(first.id).toBeTruthy();
    }
  });

  it('仅存排序的预设（filterTree: null）：空树 + 既有排序', () => {
    const { tree, sorts: normalizedSorts } = normalizePresetContent({ filterTree: null, sorts });
    expect(tree.logic).toBe('AND');
    expect(tree.children).toEqual([]);
    expect(normalizedSorts).toEqual(sorts);
  });

  it('非法/缺失输入回退空树 + 空排序', () => {
    for (const input of [null, undefined, 'garbage', 42, {}]) {
      const { tree, sorts: normalizedSorts } = normalizePresetContent(input);
      expect(tree.logic).toBe('AND');
      expect(tree.children).toEqual([]);
      expect(normalizedSorts).toEqual([]);
    }
  });
});

describe('validateFilterTree', () => {
  it('BETWEEN 只填一端时报错（含字段名）', () => {
    const onlyStart = condition({ field: 'createdAt', operator: 'BETWEEN', value: '2026-01-01', valueEnd: '' });
    expect(validateFilterTree(group('AND', [onlyStart]), FIELDS)).toEqual(['「创建时间」的介于条件需要同时填写起止值']);
    const onlyEnd = condition({ field: 'amount', operator: 'BETWEEN', value: '', valueEnd: '10' });
    expect(validateFilterTree(group('AND', [onlyEnd]), FIELDS)).toEqual(['「金额」的介于条件需要同时填写起止值']);
  });

  it('完全未填的行不报错（由剪枝静默处理）', () => {
    const empty = condition({ field: 'name', value: '' });
    const emptyBetween = condition({ field: 'createdAt', operator: 'BETWEEN', value: '', valueEnd: '' });
    expect(validateFilterTree(group('AND', [empty, emptyBetween]), FIELDS)).toEqual([]);
  });

  it('number/date 值非空但格式非法时报错', () => {
    const badNumber = condition({ field: 'amount', value: 'abc' });
    const badDate = condition({ field: 'createdAt', operator: 'BEFORE', value: '2026/01/01' });
    const badBetweenEnd = condition({ field: 'amount', operator: 'BETWEEN', value: '1', valueEnd: 'x' });
    expect(validateFilterTree(group('AND', [badNumber]), FIELDS)).toHaveLength(1);
    expect(validateFilterTree(group('AND', [badDate]), FIELDS)).toHaveLength(1);
    expect(validateFilterTree(group('AND', [badBetweenEnd]), FIELDS)).toHaveLength(1);
  });

  it('合法条件与无值运算符不报错', () => {
    const tree = group('AND', [
      condition({ field: 'amount', operator: 'BETWEEN', value: '1', valueEnd: '10' }),
      condition({ field: 'createdAt', operator: 'TODAY', value: '' }),
      condition({ field: 'name', value: '甲' }),
    ]);
    expect(validateFilterTree(tree, FIELDS)).toEqual([]);
  });
});
