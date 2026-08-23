import { Anchor, Button, Card, Col, Empty, Form, Input, InputNumber, Row, Spin, type FormInstance } from 'antd';
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

/**
 * 设置项在管理界面的呈现规则。
 *
 * 后端可继续使用稳定的存储单位；`storedValueFactor` 仅负责界面值与存储值之间
 * 的换算，避免为了改善体验而改动既有配置键或影响已有数据。
 */
export interface SystemSettingPresentation {
  /** 界面显示单位。 */
  unit?: string;
  /** 存储值 = 界面值 × 此系数，未指定时不换算。 */
  storedValueFactor?: number;
  /** 未由接口提供边界时使用的界面边界。 */
  min?: number;
  max?: number;
  /** 数值步进；时长和业务天数等通常应为整数。 */
  step?: number;
  /** 是否要求整数。 */
  integer?: boolean;
  /** 是否必须填写；未指定时保持现有的必填约束。 */
  required?: boolean;
  /** 文本参数的输入提示。 */
  placeholder?: string;
  /** 文本参数的移动端输入类型。 */
  inputMode?: 'url' | 'text';
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
  /** 设置键 → 界面呈现与存储换算规则。 */
  presentations?: Record<string, SystemSettingPresentation>;
  /** 保存一组设置。patches 的 value 已按 valueType 转换为 number/string。 */
  save: (patches: Record<string, string | number>) => Promise<void>;
  /** 额外的非表单分组，例如系统状态。 */
  extraSections?: Array<{ id: string; title: string; content: ReactNode }>;
  /** 空列表提示。 */
  emptyText?: string;
}

function settingUnit(key: string, units?: Record<string, string>, presentation?: SystemSettingPresentation): string {
  if (presentation?.unit) {
    return presentation.unit;
  }
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

function storedValueFactor(presentation?: SystemSettingPresentation): number {
  return presentation?.storedValueFactor && presentation.storedValueFactor > 0 ? presentation.storedValueFactor : 1;
}

function displayNumber(value: string | number, presentation?: SystemSettingPresentation): number {
  return Number(value) / storedValueFactor(presentation);
}

function storedNumber(value: unknown, presentation?: SystemSettingPresentation): number {
  return Number(value) * storedValueFactor(presentation);
}

function displayBound(bound: number | undefined, presentation: SystemSettingPresentation | undefined, name: 'min' | 'max'): number | undefined {
  if (presentation?.[name] !== undefined) {
    return presentation[name];
  }
  return bound === undefined ? undefined : bound / storedValueFactor(presentation);
}

function defaultPresentationFor(key: string): SystemSettingPresentation | undefined {
  if (key.endsWith('.days') || key.endsWith('.hours') || key.endsWith('.max.attempts') || key.endsWith('.max.rows')) {
    return { integer: true, step: 1 };
  }
  return undefined;
}

function isFormValidationFailure(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'errorFields' in error
    && Array.isArray(error.errorFields);
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

function SettingSection({ id, title, keys, settings, labels, units, presentations, onSave, saving, extra }: {
  id: string;
  title: string;
  keys: string[];
  settings: SystemSettingItem[];
  labels?: Record<string, string>;
  units?: Record<string, string>;
  presentations?: Record<string, SystemSettingPresentation>;
  onSave: (keys: string[]) => Promise<void>;
  saving: boolean;
  extra?: ReactNode;
}) {
  const items = keys
    .map((key) => settings.find((setting) => setting.key === key))
    .filter((setting): setting is SystemSettingItem => Boolean(setting));

  return (
    <Card id={id} title={title} size="small" style={{ marginBottom: 24, scrollMarginTop: 24 }} extra={<Button type="primary" size="small" loading={saving} onClick={() => void onSave(keys)}>保存</Button>}>
      {items.length === 0 ? null : (
        <Row gutter={[16, 0]}>
          {items.map((item) => {
            const presentation = presentations?.[item.key] ?? defaultPresentationFor(item.key);
            return (
              <Col xs={24} sm={12} lg={8} key={item.key}>
                <Form.Item
                  name={item.key}
                  label={labels?.[item.key] ?? item.label}
                  rules={[
                    ...(presentation?.required === false ? [] : [{ required: true, message: '请输入设置值' }]),
                    ...(item.valueType === 'NUMBER' && presentation?.integer
                      ? [{ validator: (_rule: unknown, value: unknown) => Number.isInteger(Number(value)) ? Promise.resolve() : Promise.reject(new Error('请输入整数')) }]
                      : []),
                  ]}
                  style={{ marginBottom: 20 }}
                >
                  {item.valueType === 'STRING' ? (
                    <Input maxLength={200} placeholder={presentation?.placeholder} inputMode={presentation?.inputMode} />
                  ) : (
                    <InputNumber
                      min={displayBound(item.min, presentation, 'min')}
                      max={displayBound(item.max, presentation, 'max')}
                      step={presentation?.step ?? 1}
                      precision={presentation?.integer ? 0 : undefined}
                      addonAfter={settingUnit(item.key, units, presentation)}
                      style={{ width: '100%' }}
                    />
                  )}
                </Form.Item>
              </Col>
            );
          })}
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
export function SystemSettingsPage({ service, endpoint, groups, labels, units, presentations, save, extraSections = [], emptyText = '当前没有可配置的运行参数。' }: SystemSettingsPageProps) {
  const feedback = useFeedback();
  const [settings, setSettings] = useState<SystemSettingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingSectionId, setSavingSectionId] = useState<string | null>(null);
  const [form] = Form.useForm<Record<string, string | number>>();

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const result = await http.get<unknown>(endpoint, { service, active: true });
        const items = normalizeSettings(result);
        setSettings(items);
        form.setFieldsValue(Object.fromEntries(items.map((item) => [
          item.key,
          item.valueType === 'NUMBER' ? displayNumber(item.value, presentations?.[item.key] ?? defaultPresentationFor(item.key)) : item.value,
        ])));
      } catch (error) {
        feedback.error(error, '系统设置加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [endpoint, feedback, form, presentations, service]);

  const saveKeys = async (sectionId: string, keys: string[]) => {
    let values: Record<string, string | number>;
    try {
      values = await form.validateFields(keys);
    } catch (error) {
      if (!isFormValidationFailure(error)) {
        feedback.error(error, '设置校验失败');
      }
      return;
    }
    setSavingSectionId(sectionId);
    try {
      const patches: Record<string, string | number> = {};
      for (const key of keys) {
        const item = settings.find((setting) => setting.key === key);
        const presentation = presentations?.[key] ?? defaultPresentationFor(key);
        patches[key] = item?.valueType === 'STRING' ? String(values[key] ?? '') : storedNumber(values[key], presentation);
      }
      await save(patches);
      setSettings((current) => current.map((item) => (
        patches[item.key] === undefined ? item : { ...item, value: String(patches[item.key]) }
      )));
      feedback.success('设置已保存');
    } catch (error) {
      feedback.error(error, '设置保存失败');
    } finally {
      setSavingSectionId(null);
    }
  };

  const hasNavigation = groups.length > 0 || extraSections.length > 0;

  return (
    <Row gutter={[24, 24]}>
      <Col xs={24} lg={hasNavigation ? 19 : 24}>
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
                presentations={presentations}
                onSave={(keys) => saveKeys(group.id, group.saveKeys ?? keys)}
                saving={savingSectionId === group.id}
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
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
              </Card>
            ) : null}
          </Form>
        </Spin>
      </Col>
      {hasNavigation ? <Col xs={24} lg={5}>
        <Anchor
          affix
          offsetTop={24}
          items={[
            ...groups.map((group) => ({ key: group.id, href: `#${group.id}`, title: group.title })),
            ...extraSections.map((section) => ({ key: section.id, href: `#${section.id}`, title: section.title })),
          ]}
        />
      </Col> : null}
    </Row>
  );
}
