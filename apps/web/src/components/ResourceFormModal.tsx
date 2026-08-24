import { Button, DatePicker, Form, Input, InputNumber, Modal, Row, Col, Select, Space, Switch, TimePicker, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect } from 'react';
import { DetailListField } from './selectors/DetailListField';
import { PermissionGrantEditor, type GrantItem } from './selectors/PermissionGrantEditor';
import { RemoteSelect } from './selectors/RemoteSelect';
import { TreeRemoteSelect } from './selectors/TreeRemoteSelect';
import type { RemoteOptionSource } from './selectors/remote-options';

export interface FormField {
  key: string;
  label: string;
  type?:
    | 'text'
    | 'textarea'
    | 'number'
    | 'date'
    | 'time'
    | 'select'
    | 'multi-select'
    | 'tags'
    | 'boolean'
    | 'remote-select'
    | 'remote-multi-select'
    | 'tree-select'
    | 'tree-multi-select'
    | 'permission-grants'
    | 'detail-list';
  /**
   * 控件宽度语义（24 栅格）：narrow=span 8（约 1/3 行，短数字/排序/开关/极短下拉）、regular=span 12（半行，名称/短文本/选择器）、
   * wide=span 16（约 2/3 行，较长文本/地址类/长标签选择器）、full=span 24（整行，备注/明细/权限）。
   * 未声明时按字段类型给出默认值（见 resolveColumnSpan），逐字段按业务内容选择档位，不做同类型一刀切。
   */
  width?: 'narrow' | 'regular' | 'wide' | 'full';
  /** 同一名称字段显示为一个表单分组。 */
  group?: string;
  required?: boolean;
  maxLength?: number;
  options?: Array<{ label: string; value: string | number }>;
  placeholder?: string;
  hidden?: boolean;
  /** 远程下拉/树选择数据源。 */
  remote?: RemoteOptionSource;
  /** 权限授权编辑器形态。 */
  permissionVariant?: 'tree' | 'matrix';
  /** 动态明细行列定义。 */
  detailColumns?: FormField[];
  /** 明细最少行数。 */
  detailMinRows?: number;
  /** 远程多选中禁止选择的值。 */
  excludeValues?: Array<string | number>;
  /** 隐藏权限管理功能授予（非超管）。 */
  hidePermissionManage?: boolean;
  /** 仅在同级字段符合条件时展示；隐藏后会由 Form preserve=false 清除。 */
  visibleWhen?: FormFieldCondition;
  /** 仅在同级字段符合条件时必填。 */
  requiredWhen?: FormFieldCondition;
  /** 远程选择器的关联字段，值传给远程数据源。 */
  remoteContextFrom?: string;
  /** 远程选择器的上游必选字段，为空时禁用控件。 */
  dependsOn?: string;
  /** 上游字段变化时清空动态明细，避免混入旧对象的数据。 */
  resetWhenDependencyChanges?: boolean;
}

/** 字段条件，支持与一个或多个明确值相等。 */
export interface FormFieldCondition {
  field: string;
  equals: string | number | boolean | Array<string | number | boolean>;
}

interface ResourceFormModalProps {
  title: string;
  open: boolean;
  fields: FormField[];
  initialValues?: Record<string, unknown>;
  submitting?: boolean;
  submitText?: string;
  /** 动态禁用提交按钮：根据当前表单值判断“无变化/无参数”时禁止提交。 */
  submitDisabled?: (values: Record<string, unknown>) => boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}

/**
 * 配置驱动的业务表单弹窗。
 *
 * 表单仅提供体验层校验；字段白名单、数据范围和状态机仍由后端 DTO 与服务层校验。
 * 支持远程选择器、权限授权可视化与动态明细行，禁止业务页面向用户暴露 JSON/裸 ID。
 */
export function ResourceFormModal({
  title,
  open,
  fields,
  initialValues,
  submitting,
  submitText = '保存',
  submitDisabled,
  onCancel,
  onSubmit,
}: ResourceFormModalProps) {
  const [form] = Form.useForm<Record<string, unknown>>();
  const watchedValues = Form.useWatch([], form) as Record<string, unknown> | undefined;
  const isSubmitDisabled = submitDisabled ? submitDisabled(watchedValues ?? {}) : false;
  const visibleFields = fields.filter((field) => !field.hidden && matchesFieldCondition(field.visibleWhen, watchedValues));
  const modalWidth = resolveModalWidth(visibleFields);

  useEffect(() => {
    if (open) {
      form.setFieldsValue(toFormValues(initialValues ?? {}, fields));
    } else {
      form.resetFields();
    }
  }, [form, initialValues, open, fields]);

  const renderInput = (field: FormField) => {
    switch (field.type) {
      case 'textarea':
        return <Input.TextArea rows={4} maxLength={field.maxLength} showCount={Boolean(field.maxLength)} placeholder={field.placeholder} />;
      case 'number':
        return <InputNumber style={{ width: '100%', textAlign: 'right' }} stringMode />;
      case 'date':
        return <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} placeholder={field.placeholder ?? '请选择日期'} />;
      case 'time':
        return <TimePicker format="HH:mm" style={{ width: '100%' }} placeholder={field.placeholder ?? '请选择时间'} needConfirm={false} />;
      case 'select':
        return <Select showSearch optionFilterProp="label" options={field.options} placeholder={field.placeholder} allowClear={!field.required} />;
      case 'multi-select':
        return <Select mode="multiple" showSearch optionFilterProp="label" options={field.options} placeholder={field.placeholder} />;
      case 'tags':
        return <Select mode="tags" tokenSeparators={[',', '，', ';', '；', '\n']} placeholder={field.placeholder ?? '输入后按回车添加'} />;
      case 'boolean':
        return <Switch />;
      case 'remote-select':
        return field.remote ? <RemoteFieldSelect field={field} /> : <Input />;
      case 'remote-multi-select':
        return field.remote ? <RemoteFieldSelect field={field} multiple /> : <Input />;
      case 'tree-select':
        return field.remote ? <RemoteFieldTreeSelect field={field} /> : <Input />;
      case 'tree-multi-select':
        return field.remote ? <RemoteFieldTreeSelect field={field} multiple /> : <Input />;
      case 'permission-grants':
        return (
          <PermissionGrantEditor
            variant={field.permissionVariant ?? 'tree'}
            hidePermissionManage={field.hidePermissionManage}
          />
        );
      case 'detail-list':
        return (
          <DetailListField
            name={field.key}
            columns={field.detailColumns ?? []}
            minRows={field.detailMinRows ?? 1}
            addLabel={field.placeholder ?? '添加一行'}
            dependencyField={field.remoteContextFrom ?? field.dependsOn}
            resetWhenDependencyChanges={field.resetWhenDependencyChanges}
          />
        );
      default:
        return <Input maxLength={field.maxLength} showCount={Boolean(field.maxLength)} placeholder={field.placeholder} />;
    }
  };

  const groups = visibleFields.reduce<Array<{ name?: string; fields: FormField[] }>>((result, field) => {
    const previous = result.at(-1);
    if (previous && previous.name === field.group) {
      previous.fields.push(field);
    } else {
      result.push({ name: field.group, fields: [field] });
    }
    return result;
  }, []);

  return (
    <Modal title={title} open={open} onCancel={onCancel} footer={null} destroyOnHidden width={`min(92vw, ${modalWidth}px)`}>
      <Form<Record<string, unknown>>
        form={form}
        layout="vertical"
        onFinish={(values) => void onSubmit(fromFormValues(values, fields))}
        preserve={false}
      >
        {groups.map((group, groupIndex) => (
          <section key={`${group.name ?? 'default'}-${groupIndex}`}>
            {group.name ? <Typography.Title level={5} style={{ marginTop: groupIndex === 0 ? 0 : 16 }}>{group.name}</Typography.Title> : null}
            <Row gutter={[16, 0]}>
              {group.fields.map((field) => (
                <Col key={field.key} xs={24} md={resolveColumnSpan(field)}>
                  {field.type === 'detail-list' ? (
                    <Form.Item label={field.label} required={field.required} style={{ marginBottom: 0 }}>
                      {renderInput(field)}
                    </Form.Item>
                  ) : (
                    <Form.Item
                      name={field.key}
                      label={field.label}
                      valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
                      rules={isFieldRequired(field, watchedValues) ? [{ required: true, message: `请填写${field.label}` }] : undefined}
                      getValueProps={field.type === 'time' ? timeGetValueProps : undefined}
                      normalize={field.type === 'time' ? timeNormalize : undefined}
                    >
                      {renderInput(field)}
                    </Form.Item>
                  )}
                </Col>
              ))}
            </Row>
          </section>
        ))}
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" htmlType="submit" loading={submitting} disabled={isSubmitDisabled}>
            {submitText}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}

/** 单/多选远程控件的 Form 适配器：订阅上游字段并传递给数据源。 */
function RemoteFieldSelect({ field, multiple = false }: { field: FormField; multiple?: boolean }) {
  const form = Form.useFormInstance<Record<string, unknown>>();
  const contextField = field.remoteContextFrom ?? field.dependsOn;
  const context = Form.useWatch(contextField ?? [], form);
  return <RemoteSelect
    mode={multiple ? 'multiple' : undefined}
    source={field.remote!}
    context={context}
    disabled={Boolean(field.dependsOn && isEmptyDependency(context))}
    placeholder={field.placeholder}
    excludeValues={field.excludeValues}
  />;
}

/** 树选择远程控件的 Form 适配器：订阅上游字段并传递给数据源。 */
function RemoteFieldTreeSelect({ field, multiple = false }: { field: FormField; multiple?: boolean }) {
  const form = Form.useFormInstance<Record<string, unknown>>();
  const contextField = field.remoteContextFrom ?? field.dependsOn;
  const context = Form.useWatch(contextField ?? [], form);
  return <TreeRemoteSelect
    multiple={multiple}
    source={field.remote!}
    context={context}
    disabled={Boolean(field.dependsOn && isEmptyDependency(context))}
    placeholder={field.placeholder}
  />;
}

/** 判断字段条件是否满足；未设置条件时恒为 true。 */
export function matchesFieldCondition(condition: FormFieldCondition | undefined, values: Record<string, unknown> | undefined): boolean {
  if (!condition) return true;
  const expected = Array.isArray(condition.equals) ? condition.equals : [condition.equals];
  return expected.some((value) => values?.[condition.field] === value);
}

/** 合并静态必填与条件必填。 */
export function isFieldRequired(field: FormField, values: Record<string, unknown> | undefined): boolean {
  return field.required === true || matchesFieldCondition(field.requiredWhen, values);
}

/** 判断上游关联字段是否为空。 */
function isEmptyDependency(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** 将接口日历/时间字符串转换为 Ant Design 控件使用的 Dayjs 值。 */
function toFormValues(values: Record<string, unknown>, fields: FormField[]): Record<string, unknown> {
  const result = { ...values };
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === 'date' && typeof value === 'string' && value) {
      result[field.key] = dayjs(value, 'YYYY-MM-DD', true);
    }
    if (field.type === 'time' && typeof value === 'string' && value) {
      // antd TimePicker 无法表达 24:00，历史数据中的 24:00 只能回显为 23:59（存在精度损失）；
      // 需要精确表达"结束于 24:00"的场景（如加班）由业务页面用 Checkbox 单独处理（参考 HrPage）。
      result[field.key] = value === '24:00' ? dayjs('23:59', 'HH:mm') : dayjs(value, 'HH:mm');
    }
    if (field.type === 'permission-grants' && Array.isArray(value)) {
      result[field.key] = value as GrantItem[];
    }
    if (field.type === 'detail-list' && Array.isArray(value)) {
      result[field.key] = value;
    }
  }
  return result;
}

/** 将 DatePicker/TimePicker 的 Dayjs 值还原为 API 字符串；明细与授权保持结构化对象。 */
function fromFormValues(values: Record<string, unknown>, fields: FormField[]): Record<string, unknown> {
  const result = { ...values };
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === 'date' && isDayjs(value)) {
      result[field.key] = value.format('YYYY-MM-DD');
    }
    if (field.type === 'time') {
      result[field.key] = formatTimeValue(value);
    }
  }
  return result;
}

function timeGetValueProps(value: unknown): { value: Dayjs | undefined } {
  if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) {
    // 与 toFormValues 一致：antd TimePicker 无法表达 24:00，回显为 23:59（精度损失见 toFormValues 注释）。
    if (value === '24:00') return { value: dayjs('23:59', 'HH:mm') };
    return { value: dayjs(value, 'HH:mm') };
  }
  if (isDayjs(value)) return { value };
  return { value: undefined };
}

function timeNormalize(value: Dayjs | null): string | undefined {
  return formatTimeValue(value);
}

/** 将 TimePicker 值格式化为 HH:mm。 */
function formatTimeValue(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) {
    return value;
  }
  if (!isDayjs(value)) return undefined;
  const formatted = value.format('HH:mm');
  return formatted;
}

/** 运行时收窄 Dayjs，避免将字符串/Date 错传给 format。 */
function isDayjs(value: unknown): value is Dayjs {
  return dayjs.isDayjs(value);
}

/**
 * 字段列宽（24 栅格）：narrow=8、regular=12、wide=16、full=24。
 * 未声明 width 时按字段类型给默认值：长文本/多值/权限/明细独占整行，数字/日期/时间/开关按窄排，其余半行。
 */
export function resolveColumnSpan(field: FormField): number {
  const width = field.width
    ?? (field.type === 'textarea'
      || field.type === 'tags'
      || field.type === 'permission-grants'
      || field.type === 'detail-list'
      || field.type === 'remote-multi-select'
      || field.type === 'tree-multi-select'
      ? 'full'
      : field.type === 'number' || field.type === 'date' || field.type === 'time' || field.type === 'boolean'
        ? 'narrow'
        : 'regular');
  if (width === 'full') return 24;
  if (width === 'wide') return 16;
  if (width === 'narrow') return 8;
  return 12;
}

/** 根据实际字段密度选择弹窗宽度（420/560/720/960）；含整行/宽字段或字段较多时加宽，权限矩阵与明细行使用最宽弹窗。 */
function resolveModalWidth(fields: FormField[]): 420 | 560 | 720 | 960 {
  if (fields.some((field) => field.type === 'permission-grants' || field.type === 'detail-list')) {
    return 960;
  }
  if (fields.some((field) => field.width === 'full' || field.width === 'wide' || field.type === 'textarea' || field.type === 'multi-select' || field.type === 'tags' || field.type === 'remote-multi-select' || field.type === 'tree-multi-select') || fields.length > 8) {
    return 720;
  }
  return fields.length <= 4 ? 420 : 560;
}
