import { Button, Col, Form, Input, InputNumber, Row, Select, Space, Switch, TimePicker, DatePicker } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useRef } from 'react';
import { matchesFieldCondition, type FormField } from '../ResourceFormModal';
import { RemoteSelect } from './RemoteSelect';
import { TreeRemoteSelect } from './TreeRemoteSelect';

interface DetailListFieldProps {
  /** Form.List 字段名（与外层 Form.Item name 一致时由 Form.List 承接）。 */
  name: string;
  columns: FormField[];
  minRows?: number;
  addLabel?: string;
  /** 顶层关联字段；明细内远程选择器据此限定可选范围。 */
  dependencyField?: string;
  /** 顶层关联字段变更时清空明细，避免将旧记录提交给新对象。 */
  resetWhenDependencyChanges?: boolean;
}

/**
 * 动态明细行编辑器：按列声明渲染每行字段，支持增删行。
 *
 * @param props Form.List 名称与列字段声明
 */
export function DetailListField({
  name,
  columns,
  minRows = 1,
  addLabel = '添加一行',
  dependencyField,
  resetWhenDependencyChanges = false,
}: DetailListFieldProps) {
  const form = Form.useFormInstance<Record<string, unknown>>();
  const dependency = Form.useWatch(dependencyField ?? [], form);
  const previousDependency = useRef(dependency);

  useEffect(() => {
    if (!resetWhenDependencyChanges || previousDependency.current === dependency) return;
    previousDependency.current = dependency;
    form.setFieldValue(name, []);
  }, [dependency, form, name, resetWhenDependencyChanges]);

  return (
    <Form.List
      name={name}
      rules={[
        {
          validator: async (_, value) => {
            if (!Array.isArray(value) || value.length < minRows) {
              throw new Error(`至少填写 ${minRows} 行明细`);
            }
          },
        },
      ]}
    >
      {(fields, { add, remove }, { errors }) => (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {fields.map((field) => (
            <div key={field.key} style={{ padding: 12, background: 'rgba(0,0,0,0.02)', borderRadius: 6 }}>
              <Row gutter={[12, 0]} align="top">
                {columns.map((column) => <DetailColumnField key={column.key} listName={name} rowName={field.name} column={column} />)}
                <Col flex="none" style={{ paddingTop: 30 }}>
                  <Button
                    type="text"
                    danger
                    icon={<MinusCircleOutlined />}
                    disabled={fields.length <= minRows}
                    onClick={() => remove(field.name)}
                    aria-label="删除本行"
                  />
                </Col>
              </Row>
            </div>
          ))}
          <Button type="dashed" onClick={() => add({})} block icon={<PlusOutlined />}>{addLabel}</Button>
          <Form.ErrorList errors={errors} />
        </Space>
      )}
    </Form.List>
  );
}

/** 明细单元格：独立订阅本行条件字段与顶层级联字段。 */
function DetailColumnField({ listName, rowName, column }: { listName: string; rowName: number; column: FormField }) {
  const form = Form.useFormInstance<Record<string, unknown>>();
  const siblingValues = Form.useWatch([listName, rowName], form) as Record<string, unknown> | undefined;
  const allValues = Form.useWatch([], form) as Record<string, unknown> | undefined;
  const context = Form.useWatch(column.remoteContextFrom ?? [], form);
  const visibleValues = resolveConditionValues(column.visibleWhen, siblingValues, allValues);
  const requiredValues = resolveConditionValues(column.requiredWhen, siblingValues, allValues);
  if (!matchesFieldCondition(column.visibleWhen, visibleValues)) return null;
  const required = column.required === true || matchesFieldCondition(column.requiredWhen, requiredValues);
  return <Col xs={24} md={resolveDetailSpan(column)}>
    <Form.Item
      name={[rowName, column.key]}
      label={column.label}
      valuePropName={column.type === 'boolean' ? 'checked' : 'value'}
      rules={required ? [{ required: true, message: `请填写${column.label}` }] : undefined}
      getValueProps={column.type === 'time' ? timeGetValueProps : column.type === 'date' ? dateGetValueProps : undefined}
      getValueFromEvent={column.type === 'time' ? timeGetValueFromEvent : column.type === 'date' ? dateGetValueFromEvent : undefined}
    >
      {renderDetailInput(column, context)}
    </Form.Item>
  </Col>;
}

/** 优先读取本行条件字段；未定义时回退到顶层表单字段。 */
function resolveConditionValues(
  condition: FormField['visibleWhen'] | FormField['requiredWhen'],
  siblingValues: Record<string, unknown> | undefined,
  allValues: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!condition || siblingValues?.[condition.field] === undefined) return allValues;
  return siblingValues;
}

/** 明细行内控件渲染（与 ResourceFormModal 字段类型对齐的子集）。 */
function renderDetailInput(field: FormField, context?: unknown) {
  switch (field.type) {
    case 'number':
      return <InputNumber style={{ width: '100%' }} stringMode={false} placeholder={field.placeholder} />;
    case 'textarea':
      return <Input.TextArea rows={2} maxLength={field.maxLength} placeholder={field.placeholder} />;
    case 'select':
      return <Select showSearch optionFilterProp="label" options={field.options} placeholder={field.placeholder ?? '请选择'} allowClear />;
    case 'boolean':
      return <Switch />;
    case 'date':
      return <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />;
    case 'time':
      return <TimePicker format="HH:mm" style={{ width: '100%' }} needConfirm={false} />;
    case 'remote-select':
      return field.remote ? <RemoteSelect source={field.remote} context={context} placeholder={field.placeholder} excludeValues={field.excludeValues} /> : <Input />;
    case 'remote-multi-select':
      return field.remote ? <RemoteSelect mode="multiple" source={field.remote} context={context} placeholder={field.placeholder} excludeValues={field.excludeValues} /> : <Input />;
    case 'tree-select':
      return field.remote ? <TreeRemoteSelect source={field.remote} context={context} placeholder={field.placeholder} /> : <Input />;
    case 'tree-multi-select':
      return field.remote ? <TreeRemoteSelect multiple source={field.remote} context={context} placeholder={field.placeholder} /> : <Input />;
    default:
      return <Input maxLength={field.maxLength} placeholder={field.placeholder} />;
  }
}

function resolveDetailSpan(field: FormField): number {
  if (field.width === 'full' || field.type === 'textarea') return 24;
  if (field.width === 'wide') return 16;
  if (field.width === 'narrow' || field.type === 'number' || field.type === 'boolean') return 8;
  return 12;
}

function timeGetValueProps(value: unknown): { value: dayjs.Dayjs | undefined } {
  if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) {
    // antd TimePicker 无法表达 24:00，历史数据中的 24:00 只能回显为 23:59（存在精度损失）；
    // 需要精确表达"结束于 24:00"的场景由业务页面用 Checkbox 单独处理（参考 HrPage）。
    if (value === '24:00') return { value: dayjs('23:59', 'HH:mm') };
    return { value: dayjs(value, 'HH:mm') };
  }
  return { value: undefined };
}

function timeGetValueFromEvent(value: dayjs.Dayjs | null): string | undefined {
  if (!value) return undefined;
  return value.format('HH:mm');
}

function dateGetValueProps(value: unknown): { value: dayjs.Dayjs | undefined } {
  if (typeof value === 'string' && value) return { value: dayjs(value, 'YYYY-MM-DD', true) };
  return { value: undefined };
}

function dateGetValueFromEvent(value: dayjs.Dayjs | null): string | undefined {
  if (!value) return undefined;
  return value.format('YYYY-MM-DD');
}
