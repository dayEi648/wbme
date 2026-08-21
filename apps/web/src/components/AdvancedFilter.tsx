import { Button, DatePicker, Drawer, Grid, Input, InputNumber, Modal, Segmented, Select, Space } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFeedback } from '../request/feedback';
import { RemoteSelect } from './selectors/RemoteSelect';
import { TreeRemoteSelect } from './selectors/TreeRemoteSelect';
import {
  createEmptyCondition,
  createEmptyGroup,
  defaultOperatorFor,
  flattenConditions,
  isFilterGroup,
  NO_VALUE_OPERATORS,
  operatorOptionsFor,
  pruneFilterTree,
  removeConditionFromTree,
  validateFilterTree,
  type FilterCondition,
  type FilterConditionGroup,
  type FilterField,
  type FilterFieldType,
  type FilterLogic,
} from './advanced-filter';

interface AdvancedFilterProps {
  open: boolean;
  fields: FilterField[];
  /** 已生效的筛选树；打开时深拷贝为草稿，取消/关闭不回写。 */
  appliedTree: FilterConditionGroup;
  /** 「确定」时回传剪枝后的草稿树（保留 id/valueLabel，供下次打开回显）。 */
  onApply: (tree: FilterConditionGroup) => void;
  onCancel: () => void;
}

/** 日期值控件与序列化统一使用的格式。 */
const DATE_FORMAT = 'YYYY-MM-DD';

/** 字段选择器按类型分组的标签与展示顺序（仅渲染实际出现的类型）。 */
const FIELD_TYPE_GROUP_LABEL: Readonly<Record<FilterFieldType, string>> = {
  text: '文本',
  enum: '选项',
  number: '数字',
  date: '日期',
  remote: '关联',
  tree: '树形',
};
const FIELD_TYPE_GROUP_ORDER: FilterFieldType[] = ['text', 'enum', 'number', 'date', 'remote', 'tree'];

/**
 * 条件行下拉统一最小宽度兜底：Modal 打开动画（缩放）期间点击 Select 时，
 * rc-select 会按动画中的缩放尺寸测量并锁定下拉宽度（曾实测仅 36px 宽导致选项不可见）。
 */
const SELECT_POPUP_STYLES = { popup: { root: { minWidth: 200 } } } as const;

/** 不可变更新树中指定条件。 */
function mapCondition(root: FilterConditionGroup, conditionId: string, mapper: (condition: FilterCondition) => FilterCondition): FilterConditionGroup {
  return {
    ...root,
    children: root.children.map((child) =>
      isFilterGroup(child) ? mapCondition(child, conditionId, mapper) : child.id === conditionId ? mapper(child) : child),
  };
}

/** 不可变更新树中指定组（切换逻辑、追加子级等）。 */
function mapGroup(root: FilterConditionGroup, groupId: string, mapper: (group: FilterConditionGroup) => FilterConditionGroup): FilterConditionGroup {
  const next = root.id === groupId ? mapper(root) : root;
  return {
    ...next,
    children: next.children.map((child) => (isFilterGroup(child) ? mapGroup(child, groupId, mapper) : child)),
  };
}

/**
 * 钉钉式高级筛选面板：桌面端居中 Modal、移动端右侧抽屉，共用同一草稿树。
 *
 * 打开时深拷贝 appliedTree 为草稿（空树补 1 条空条件行）；「取消」丢弃草稿，
 * 「确定」先校验（部分填写的行报错并停留），通过后回传剪枝后的树。
 */
export function AdvancedFilter({ open, fields, appliedTree, onApply, onCancel }: AdvancedFilterProps) {
  const feedback = useFeedback();
  const screens = Grid.useBreakpoint();
  const isDesktop = Boolean(screens.md);
  /** 编辑草稿；null 表示面板未打开。 */
  const [draft, setDraft] = useState<FilterConditionGroup | null>(null);

  // 打开瞬间快照 appliedTree/fields；面板打开期间二者变化不应重置用户草稿
  const appliedTreeRef = useRef(appliedTree);
  appliedTreeRef.current = appliedTree;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  useEffect(() => {
    if (!open) {
      return;
    }
    const next = structuredClone(appliedTreeRef.current);
    if (next.children.length === 0) {
      next.children = [createEmptyCondition(fieldsRef.current)];
    }
    setDraft(next);
  }, [open]);

  const fieldOptions = useMemo(
    () => FIELD_TYPE_GROUP_ORDER
      .map((type) => ({
        label: FIELD_TYPE_GROUP_LABEL[type],
        options: fields.filter((field) => (field.type ?? 'text') === type).map((field) => ({ label: field.title, value: field.key })),
      }))
      .filter((group) => group.options.length > 0),
    [fields],
  );

  const updateDraft = (updater: (current: FilterConditionGroup) => FilterConditionGroup) => {
    setDraft((current) => (current ? updater(current) : current));
  };

  const patchCondition = (conditionId: string, patch: Partial<FilterCondition>) => {
    updateDraft((current) => mapCondition(current, conditionId, (condition) => ({ ...condition, ...patch })));
  };

  /** 切换字段：运算符重置为该字段默认（尊重 operators 白名单），清空值与标签。 */
  const changeConditionField = (conditionId: string, fieldKey: string) => {
    const field = fields.find((item) => item.key === fieldKey);
    patchCondition(conditionId, {
      field: fieldKey,
      operator: defaultOperatorFor(field),
      value: '',
      valueEnd: undefined,
      valueLabel: undefined,
    });
  };

  /** 切换运算符：无值运算符清空值；进入「介于」补 valueEnd，离开则删除。 */
  const changeConditionOperator = (condition: FilterCondition, operator: string) => {
    const patch: Partial<FilterCondition> = { operator };
    if (NO_VALUE_OPERATORS.has(operator)) {
      patch.value = '';
      patch.valueEnd = undefined;
    } else if (operator === 'BETWEEN') {
      patch.valueEnd = condition.valueEnd ?? '';
    } else {
      patch.valueEnd = undefined;
    }
    patchCondition(condition.id, patch);
  };

  const addCondition = (groupId: string) => {
    updateDraft((current) => mapGroup(current, groupId, (group) => ({ ...group, children: [...group.children, createEmptyCondition(fields)] })));
  };

  /** 添加条件组：仅根组开放（最多 2 层组）。 */
  const addConditionGroup = () => {
    updateDraft((current) => ({ ...current, children: [...current.children, createEmptyGroup(fields)] }));
  };

  const removeConditionGroup = (groupId: string) => {
    updateDraft((current) => ({ ...current, children: current.children.filter((child) => !(isFilterGroup(child) && child.id === groupId)) }));
  };

  /** 删除条件行：组内删空后补空行保组（见 removeConditionFromTree）。 */
  const removeCondition = (conditionId: string) => {
    updateDraft((current) => removeConditionFromTree(current, conditionId, fields));
  };

  const handleReset = () => {
    setDraft(createEmptyGroup(fields));
  };

  const handleConfirm = () => {
    if (!draft) {
      return;
    }
    const errors = validateFilterTree(draft, fields);
    if (errors.length > 0) {
      // 校验报错复用统一反馈：feedback.error 对非 ApiError 直接展示 fallback 文案
      feedback.error(new Error(errors[0]), errors[0]);
      return;
    }
    onApply(pruneFilterTree(draft));
  };

  const renderValueInput = (condition: FilterCondition, field: FilterField | undefined, tree: FilterConditionGroup) => {
    const type = field?.type ?? 'text';
    if (NO_VALUE_OPERATORS.has(condition.operator)) {
      return <Input disabled placeholder="无需填写值" style={{ flex: 1 }} />;
    }
    if (type === 'number') {
      const numberValue = condition.value === '' ? null : condition.value;
      const numberValueEnd = condition.valueEnd === undefined || condition.valueEnd === '' ? null : condition.valueEnd;
      if (condition.operator === 'BETWEEN') {
        return (
          <Space.Compact style={{ flex: 1 }}>
            <InputNumber stringMode style={{ width: '50%' }} placeholder="最小值" value={numberValue} onChange={(value) => patchCondition(condition.id, { value: value ?? '' })} />
            <InputNumber stringMode style={{ width: '50%' }} placeholder="最大值" value={numberValueEnd} onChange={(value) => patchCondition(condition.id, { valueEnd: value ?? '' })} />
          </Space.Compact>
        );
      }
      return <InputNumber stringMode style={{ flex: 1, width: '100%' }} placeholder="请输入数字" value={numberValue} onChange={(value) => patchCondition(condition.id, { value: value ?? '' })} />;
    }
    if (type === 'date') {
      if (condition.operator === 'BETWEEN') {
        return (
          <DatePicker.RangePicker
            style={{ flex: 1, width: '100%' }}
            value={condition.value || condition.valueEnd ? [condition.value ? dayjs(condition.value) : null, condition.valueEnd ? dayjs(condition.valueEnd) : null] : null}
            onChange={(values) => {
              const [start, end] = values ?? [null, null];
              patchCondition(condition.id, { value: start ? start.format(DATE_FORMAT) : '', valueEnd: end ? end.format(DATE_FORMAT) : '' });
            }}
          />
        );
      }
      return (
        <DatePicker
          style={{ flex: 1, width: '100%' }}
          value={condition.value ? dayjs(condition.value) : null}
          onChange={(value) => patchCondition(condition.id, { value: value ? value.format(DATE_FORMAT) : '' })}
        />
      );
    }
    if (type === 'enum') {
      // 函数形式 options 按当前草稿条件动态生成（如「功能」随已选「系统」联动，主 PRD §3.3）
      const fieldOptions = field?.options;
      const options = typeof fieldOptions === 'function' ? fieldOptions(flattenConditions(tree)) : fieldOptions;
      return (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ flex: 1, minWidth: 0 }}
          styles={SELECT_POPUP_STYLES}
          placeholder="请选择"
          value={condition.value === '' ? undefined : condition.value}
          options={options}
          onChange={(value: string | undefined) => patchCondition(condition.id, { value: value ?? '' })}
        />
      );
    }
    if ((type === 'remote' || type === 'tree') && field?.remote) {
      const selectValue = condition.value === '' ? null : Number(condition.value) || condition.value;
      const handleChange = (value: string | number | Array<string | number> | null, label?: string) => {
        patchCondition(condition.id, { value: value === null || Array.isArray(value) ? '' : String(value), valueLabel: label });
      };
      return type === 'remote'
        ? <RemoteSelect source={field.remote} value={selectValue} onChange={handleChange} style={{ flex: 1 }} />
        : <TreeRemoteSelect source={field.remote} value={selectValue} onChange={handleChange} style={{ flex: 1 }} />;
    }
    return <Input allowClear style={{ flex: 1 }} placeholder="请输入" value={condition.value} onChange={(event) => patchCondition(condition.id, { value: event.target.value })} />;
  };

  /** 单条件行：字段 → 运算符 → 值三段式；桌面横向排列，移动端纵向堆叠。 */
  const renderConditionRow = (condition: FilterCondition, tree: FilterConditionGroup) => {
    const field = fields.find((item) => item.key === condition.field);
    return (
      <div key={condition.id} style={{ display: 'flex', flexDirection: isDesktop ? 'row' : 'column', gap: 8, alignItems: isDesktop ? 'center' : 'stretch' }}>
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="选择字段"
          style={isDesktop ? { width: 180 } : { width: '100%' }}
          styles={SELECT_POPUP_STYLES}
          value={condition.field === '' ? undefined : condition.field}
          options={fieldOptions}
          onChange={(fieldKey) => changeConditionField(condition.id, fieldKey)}
        />
        <Select
          style={isDesktop ? { width: 140 } : { width: '100%' }}
          styles={SELECT_POPUP_STYLES}
          value={condition.operator}
          options={operatorOptionsFor(field)}
          onChange={(operator) => changeConditionOperator(condition, operator)}
        />
        {renderValueInput(condition, field, tree)}
        <Button type="text" danger icon={<DeleteOutlined />} aria-label="删除条件" onClick={() => removeCondition(condition.id)} />
      </div>
    );
  };

  /** 条件组：组头「且/或」切换逻辑；子组缩进 + 左边框区分，仅根组可添加条件组。 */
  const renderGroup = (group: FilterConditionGroup, tree: FilterConditionGroup, isRoot: boolean) => (
    <div key={group.id} style={isRoot ? undefined : { marginLeft: 12, paddingLeft: 12, borderLeft: '2px solid #e5e5e5' }}>
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <Segmented<FilterLogic>
            value={group.logic}
            options={[{ label: '且', value: 'AND' }, { label: '或', value: 'OR' }]}
            onChange={(logic) => updateDraft((current) => mapGroup(current, group.id, (item) => ({ ...item, logic })))}
          />
          {isRoot ? null : (
            <Button danger type="link" size="small" onClick={() => removeConditionGroup(group.id)}>
              删除条件组
            </Button>
          )}
        </div>
        {group.children.map((child) => (isFilterGroup(child) ? renderGroup(child, tree, false) : renderConditionRow(child, tree)))}
        <Space wrap>
          <Button type="dashed" size="small" icon={<PlusOutlined />} disabled={fields.length === 0} onClick={() => addCondition(group.id)}>
            添加条件
          </Button>
          {isRoot ? (
            <Button type="dashed" size="small" icon={<PlusOutlined />} disabled={fields.length === 0} onClick={addConditionGroup}>
              添加条件组
            </Button>
          ) : null}
        </Space>
      </Space>
    </div>
  );

  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <Button onClick={handleReset}>重置</Button>
      <Space>
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" onClick={handleConfirm}>确定</Button>
      </Space>
    </div>
  );

  return isDesktop ? (
    <Modal title="高级筛选" open={open} onCancel={onCancel} width={720} footer={footer} maskClosable={false}>
      {draft ? renderGroup(draft, draft, true) : null}
    </Modal>
  ) : (
    <Drawer title="高级筛选" placement="right" open={open} onClose={onCancel} width="min(92vw, 420px)" footer={footer}>
      {draft ? renderGroup(draft, draft, true) : null}
    </Drawer>
  );
}
