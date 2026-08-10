import { Button, DatePicker, Form, Input, InputNumber, Modal, Row, Col, Select, Space, Switch, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect } from 'react';

export interface FormField {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'multi-select' | 'tags' | 'boolean';
  /** 控件宽度语义；未声明时按字段类型给出符合阅读节奏的默认值。 */
  width?: 'narrow' | 'regular' | 'wide' | 'full';
  /** 同一名称字段显示为一个表单分组。 */
  group?: string;
  required?: boolean;
  maxLength?: number;
  options?: Array<{ label: string; value: string | number }>;
  placeholder?: string;
  hidden?: boolean;
}

interface ResourceFormModalProps {
  title: string;
  open: boolean;
  fields: FormField[];
  initialValues?: Record<string, unknown>;
  submitting?: boolean;
  submitText?: string;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}

/**
 * 配置驱动的业务表单弹窗。
 *
 * 表单仅提供体验层校验；字段白名单、数据范围和状态机仍由后端 DTO 与服务层校验。
 */
export function ResourceFormModal({
  title,
  open,
  fields,
  initialValues,
  submitting,
  submitText = '保存',
  onCancel,
  onSubmit,
}: ResourceFormModalProps) {
  const [form] = Form.useForm<Record<string, unknown>>();
  const visibleFields = fields.filter((field) => !field.hidden);
  const modalWidth = resolveModalWidth(visibleFields);

  useEffect(() => {
    if (open) {
      form.setFieldsValue(toFormValues(initialValues ?? {}, fields));
    } else {
      form.resetFields();
    }
  }, [form, initialValues, open]);

  const renderInput = (field: FormField) => {
    switch (field.type) {
      case 'textarea':
        return <Input.TextArea rows={4} maxLength={field.maxLength} showCount={Boolean(field.maxLength)} placeholder={field.placeholder} />;
      case 'number':
        return <InputNumber style={{ width: '100%', textAlign: 'right' }} stringMode />;
      case 'date':
        return <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} placeholder={field.placeholder ?? '请选择日期'} />;
      case 'select':
        return <Select showSearch optionFilterProp="label" options={field.options} placeholder={field.placeholder} />;
      case 'multi-select':
        return <Select mode="multiple" showSearch optionFilterProp="label" options={field.options} placeholder={field.placeholder} />;
      case 'tags':
        return <Select mode="tags" tokenSeparators={[',', '，', ';', '；', '\n']} placeholder={field.placeholder ?? '输入后按回车添加'} />;
      case 'boolean':
        return <Switch />;
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
    <Modal title={title} open={open} onCancel={onCancel} footer={null} destroyOnHidden width={modalWidth}>
      <Form<Record<string, unknown>> form={form} layout="vertical" onFinish={(values) => void onSubmit(fromFormValues(values, fields))} preserve={false}>
        {groups.map((group, groupIndex) => (
          <section key={`${group.name ?? 'default'}-${groupIndex}`}>
            {group.name ? <Typography.Title level={5} style={{ marginTop: groupIndex === 0 ? 0 : 16 }}>{group.name}</Typography.Title> : null}
            <Row gutter={[16, 0]}>
              {group.fields.map((field) => (
                <Col key={field.key} xs={24} md={resolveColumnSpan(field)}>
                  <Form.Item
                    name={field.key}
                    label={field.label}
                    valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
                    rules={field.required ? [{ required: true, message: `请填写${field.label}` }] : undefined}
                  >
                    {renderInput(field)}
                  </Form.Item>
                </Col>
              ))}
            </Row>
          </section>
        ))}
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" htmlType="submit" loading={submitting}>
            {submitText}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}

/** 将接口日历字符串转换为 Ant Design DatePicker 使用的 Dayjs 值。 */
function toFormValues(values: Record<string, unknown>, fields: FormField[]): Record<string, unknown> {
  const result = { ...values };
  for (const field of fields) {
    if (field.type !== 'date') continue;
    const value = values[field.key];
    if (typeof value === 'string' && value) {
      result[field.key] = dayjs(value, 'YYYY-MM-DD', true);
    }
  }
  return result;
}

/** 将 DatePicker 的 Dayjs 值精确还原为 API 所需的 YYYY-MM-DD。 */
function fromFormValues(values: Record<string, unknown>, fields: FormField[]): Record<string, unknown> {
  const result = { ...values };
  for (const field of fields) {
    if (field.type !== 'date') continue;
    const value = values[field.key];
    if (isDayjs(value)) {
      result[field.key] = value.format('YYYY-MM-DD');
    }
  }
  return result;
}

/** 运行时收窄 Dayjs，避免将字符串/Date 错传给 format。 */
function isDayjs(value: unknown): value is Dayjs {
  return dayjs.isDayjs(value);
}

/** 字段默认列宽：数字/短文本紧凑，长文本与备注独占一行。 */
function resolveColumnSpan(field: FormField): number {
  const width = field.width
    ?? (field.type === 'textarea' || field.type === 'tags' ? 'full' : field.type === 'number' || field.type === 'date' || field.type === 'boolean' ? 'narrow' : 'regular');
  if (width === 'full' || width === 'wide') return 24;
  return 12;
}

/** 根据实际字段密度选择弹窗宽度，避免短表单占据无效横向空间。 */
function resolveModalWidth(fields: FormField[]): 420 | 560 | 720 {
  if (fields.some((field) => field.width === 'full' || field.width === 'wide' || field.type === 'textarea' || field.type === 'multi-select' || field.type === 'tags') || fields.length > 8) {
    return 720;
  }
  return fields.length <= 4 ? 420 : 560;
}
