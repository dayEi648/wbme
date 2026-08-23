import { Anchor, Button, Card, Col, Form, Input, InputNumber, Row, Spin, type FormInstance } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { useFeedback } from '../request/feedback';
import { http, type ApiService } from '../request/http';

/** 设置项统一结构（兼容 platform 的 settings 与 asset/hr/fin 的 items 两种返回）。 */
export interface SystemSettingItem {
  key: string;
  label: string;
  value: string;
  valueType: 'NUMBER' | 'STRING';
  min?: number;
  max?: number;
}

export interface SystemSettingsGroup {
  id: string;
  title: string;
  /** 常规表单渲染使用的设置键。 */
  keys: string[];
  /** 保存时实际提交的设置键；缺省等于 keys（例如操作日志的额外字段也需要一并保存）。 */
  saveKeys?: string[];
  /** 分组内额外内容（如操作日志统一修改）；可访问表单与设置项。 */
  renderExtra?: (context: { form: FormInstance; settings: SystemSettingItem[] }) => ReactNode;
}

export interface SystemSettingsPageProps {
  service: ApiService;
  endpoint: string;
  groups: SystemSettingsGroup[];
  /** 设置键 → 短标签；未命中时使用后端返回的 label。 */
  labels?: Record<string, string>;
  /** 设置键 → 单位后缀；未命中时按 key 后缀推导。 */
  units?: Record<string, string>;
  /** 保存一组设置。patches 的 value 已按 valueType 转换为 number/string。 */
  save: (patches: Record<string, string | number>) => Promise<void>;
  /** 额外的非表单分组，例如系统状态。 */
  extraSections?: Array<{ id: string; title: string; content: ReactNode }>;
  /** 空列表提示。 */
  emptyText?: string;
}

function settingUnit(key: string, units?: Record<string, string>): string {
  if (units?.[key]) {
    return units[key];
  }
  if (key.endsWith('.seconds')) return '秒';
  if (key.endsWith('.days')) return '天';
  if (key.endsWith('.hours')) return '小时';
  if (key.endsWith('.max.attempts')) return '次';
  if (key.endsWith('.max.rows')) return '行';
  return '';
}

function normalizeSettings(payload: unknown): SystemSettingItem[] {
  const record = payload as { settings?: unknown; items?: unknown } | null;
  const raw = Array.isArray(record?.settings) ? record.settings : Array.isArray(record?.items) ? record.items : [];
  return (raw as Array<Record<string, unknown>>).map((item) => ({
    key: String(item.key ?? ''),
    label: String(item.label ?? item.key ?? ''),
    value: String(item.value ?? item.defaultValue ?? ''),
    valueType: item.valueType === 'STRING' ? 'STRING' : 'NUMBER',
    min: typeof item.min === 'number' ? item.min : undefined,
    max: typeof item.max === 'number' ? item.max : undefined,
  }));
}

function SettingSection({ id, title, keys, settings, labels, units, onSave, extra }: {
  id: string;
  title: string;
  keys: string[];
  settings: SystemSettingItem[];
  labels?: Record<string, string>;
  units?: Record<string, string>;
  onSave: (keys: string[]) => void;
  extra?: ReactNode;
}) {
  const items = keys
    .map((key) => settings.find((setting) => setting.key === key))
    .filter((setting): setting is SystemSettingItem => Boolean(setting));

  return (
    <Card id={id} title={title} size="small" style={{ marginBottom: 24, scrollMarginTop: 24 }} extra={<Button type="primary" size="small" onClick={() => onSave(keys)}>保存</Button>}>
      {items.length === 0 ? null : (
        <Row gutter={[16, 0]}>
          {items.map((item) => (
            <Col xs={24} sm={12} lg={8} key={item.key}>
              <Form.Item name={item.key} label={labels?.[item.key] ?? item.label} rules={[{ required: true }]} style={{ marginBottom: 16 }}>
                {item.valueType === 'STRING' ? (
                  <Input maxLength={200} />
                ) : (
                  <InputNumber min={item.min} max={item.max} addonAfter={settingUnit(item.key, units)} style={{ width: '100%' }} />
                )}
              </Form.Item>
            </Col>
          ))}
        </Row>
      )}
      {extra}
    </Card>
  );
}

/**
 * 通用系统设置书签页：左侧吸顶目录 + 右侧分组表单。
 *
 * 兼容：
 * - platform 的 `/system-settings`（settings 数组，全部数值型）
 * - asset/hr/fin 的 `/asset-settings`、`/hr-settings`、`/finance-settings`（items 数组，STRING/NUMBER）
 */
export function SystemSettingsPage({ service, endpoint, groups, labels, units, save, extraSections = [], emptyText = '当前没有可配置的运行参数。' }: SystemSettingsPageProps) {
  const feedback = useFeedback();
  const [settings, setSettings] = useState<SystemSettingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [form] = Form.useForm<Record<string, string | number>>();

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const result = await http.get<unknown>(endpoint, { service, active: true });
        const items = normalizeSettings(result);
        setSettings(items);
        form.setFieldsValue(Object.fromEntries(items.map((item) => [item.key, item.value])));
      } catch (error) {
        feedback.error(error, '系统设置加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [endpoint, feedback, form, service]);

  const saveKeys = async (keys: string[]) => {
    try {
      const values = await form.validateFields(keys);
      const patches: Record<string, string | number> = {};
      for (const key of keys) {
        const item = settings.find((setting) => setting.key === key);
        patches[key] = item?.valueType === 'STRING' ? String(values[key] ?? '') : Number(values[key]);
      }
      await save(patches);
      feedback.success('设置已保存并即时生效');
    } catch {
      // 校验失败由表单组件提示
    }
  };

  return (
    <Row gutter={[24, 24]}>
      <Col xs={24} lg={19}>
        <Spin spinning={loading}>
          <Form form={form} layout="vertical">
            {groups.map((group) => (
              <SettingSection
                key={group.id}
                id={group.id}
                title={group.title}
                keys={group.keys}
                settings={settings}
                labels={labels}
                units={units}
                onSave={(keys) => void saveKeys(group.saveKeys ?? keys)}
                extra={group.renderExtra?.({ form, settings })}
              />
            ))}
            {extraSections.map((section) => (
              <Card key={section.id} id={section.id} title={section.title} size="small" style={{ marginBottom: 24, scrollMarginTop: 24 }}>
                {section.content}
              </Card>
            ))}
            {settings.length === 0 && !loading ? (
              <Card size="small" style={{ marginBottom: 24 }}>
                {emptyText}
              </Card>
            ) : null}
          </Form>
        </Spin>
      </Col>
      <Col xs={24} lg={5}>
        <Anchor
          affix
          offsetTop={24}
          items={[
            ...groups.map((group) => ({ key: group.id, href: `#${group.id}`, title: group.title })),
            ...extraSections.map((section) => ({ key: section.id, href: `#${section.id}`, title: section.title })),
          ]}
        />
      </Col>
    </Row>
  );
}
