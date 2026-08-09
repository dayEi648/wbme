import { Button, Card, Input, InputNumber, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useFeedback } from '../request/feedback';
import { http, type ApiService } from '../request/http';

interface SettingItem {
  key: string;
  label: string;
  value: string;
  valueType: 'NUMBER' | 'STRING';
}

interface SettingsEditorProps {
  title: string;
  description: string;
  service: ApiService;
  endpoint: string;
  /** 将一项设置转换为所属服务的更新请求。 */
  save: (item: SettingItem, value: string) => Promise<void>;
}

/**
 * 平台业务设置编辑器。
 *
 * 读取服务端注册的键，再逐项提交；具体写入路径由调用页面提供，避免把 asset/hr 的契约差异隐藏在组件内。
 */
export function SettingsEditor({ title, description, service, endpoint, save }: SettingsEditorProps) {
  const feedback = useFeedback();
  const [items, setItems] = useState<SettingItem[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const result = await http.get<{ items?: SettingItem[] }>(endpoint, { service, active: true });
        const nextItems = Array.isArray(result.items) ? result.items : [];
        setItems(nextItems);
        setValues(Object.fromEntries(nextItems.map((item) => [item.key, item.value])));
      } catch (error) {
        feedback.error(error, '运行参数加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [endpoint, feedback, service]);

  const saveItem = async (item: SettingItem) => {
    const value = values[item.key] ?? item.value;
    setSavingKey(item.key);
    try {
      await save(item, value);
      setItems((current) => current.map((currentItem) => currentItem.key === item.key ? { ...currentItem, value } : currentItem));
      feedback.success(`${item.label}已保存`);
    } catch (error) {
      feedback.error(error, `${item.label}保存失败`);
    } finally {
      setSavingKey(null);
    }
  };

  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <div>
      <Typography.Title level={3} style={{ marginBottom: 4 }}>{title}</Typography.Title>
      <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
    </div>
    <Card loading={loading}>
      {loading ? <Spin /> : items.length === 0 ? <Typography.Text type="secondary">当前没有可配置的运行参数。</Typography.Text> : <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {items.map((item) => <Card key={item.key} size="small" title={item.label} extra={<Typography.Text type="secondary">{item.key}</Typography.Text>}>
          <Space wrap style={{ width: '100%' }}>
            {item.valueType === 'NUMBER' ? <InputNumber stringMode value={values[item.key]} style={{ minWidth: 220 }} onChange={(value) => setValues((current) => ({ ...current, [item.key]: value === null ? '' : String(value) }))} /> : <Input value={values[item.key]} maxLength={200} style={{ minWidth: 320 }} onChange={(event) => setValues((current) => ({ ...current, [item.key]: event.target.value }))} />}
            <Button type="primary" loading={savingKey === item.key} onClick={() => void saveItem(item)}>保存</Button>
          </Space>
        </Card>)}
      </Space>}
    </Card>
  </Space>;
}
