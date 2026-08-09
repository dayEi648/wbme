import { Button, Checkbox, Form, Input, InputNumber, Modal, Select, Space } from 'antd';
import { useEffect } from 'react';

export interface FormField {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'multi-select' | 'boolean';
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

  useEffect(() => {
    if (open) {
      form.setFieldsValue(initialValues ?? {});
    } else {
      form.resetFields();
    }
  }, [form, initialValues, open]);

  const renderInput = (field: FormField) => {
    switch (field.type) {
      case 'textarea':
        return <Input.TextArea rows={4} maxLength={field.maxLength} showCount={Boolean(field.maxLength)} placeholder={field.placeholder} />;
      case 'number':
        return <InputNumber style={{ width: '100%' }} stringMode />;
      case 'date':
        return <Input type="date" />;
      case 'select':
        return <Select showSearch optionFilterProp="label" options={field.options} placeholder={field.placeholder} />;
      case 'multi-select':
        return <Select mode="multiple" showSearch optionFilterProp="label" options={field.options} placeholder={field.placeholder} />;
      case 'boolean':
        return <Checkbox>启用</Checkbox>;
      default:
        return <Input maxLength={field.maxLength} showCount={Boolean(field.maxLength)} placeholder={field.placeholder} />;
    }
  };

  return (
    <Modal title={title} open={open} onCancel={onCancel} footer={null} destroyOnHidden width={560}>
      <Form<Record<string, unknown>> form={form} layout="vertical" onFinish={(values) => void onSubmit(values)} preserve={false}>
        {fields.filter((field) => !field.hidden).map((field) => (
          <Form.Item
            key={field.key}
            name={field.key}
            label={field.label}
            valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
            rules={field.required ? [{ required: true, message: `请填写${field.label}` }] : undefined}
          >
            {renderInput(field)}
          </Form.Item>
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
