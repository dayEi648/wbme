import { Select, Spin } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadRemoteOptions, resolveRemoteEndpoint, type RemoteOptionSource, type SelectOption } from './remote-options';

interface RemoteSelectProps {
  value?: string | number | Array<string | number> | null;
  /**
   * 单选时透传第二个参数 label（选项 label 为 string 才回传），
   * 供高级筛选条件标签栏回显远程选项的可读名称；既有调用方不受影响。
   */
  onChange?: (value: string | number | Array<string | number> | null, label?: string) => void;
  source: RemoteOptionSource;
  mode?: 'multiple';
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  /** 禁止选择的值（如代领不能选自己）。 */
  excludeValues?: Array<string | number>;
  style?: React.CSSProperties;
  /** 级联选择器的上游字段值。 */
  context?: unknown;
}

/**
 * 可搜索远程下拉：打开时加载选项，支持单选/多选。
 *
 * @param props Ant Design Select 受控属性 + 远程数据源
 */
export function RemoteSelect({
  value,
  onChange,
  source,
  mode,
  placeholder = '请选择',
  allowClear = true,
  disabled,
  excludeValues = [],
  style,
  context,
}: RemoteSelectProps) {
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excludeSet = useMemo(() => new Set(excludeValues.map(String)), [excludeValues]);
  const endpoint = resolveRemoteEndpoint(source, context);

  const ensureLoaded = useCallback(async () => {
    if (!endpoint || loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const next = await loadRemoteOptions(source, context);
      setOptions(next);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选项加载失败');
    } finally {
      setLoading(false);
    }
  }, [context, endpoint, loaded, loading, source]);

  useEffect(() => {
    setOptions([]);
    setLoaded(false);
    setError(null);
  }, [endpoint]);

  useEffect(() => {
    // 已有回填值时预加载，避免只显示裸 ID。
    if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
      void ensureLoaded();
    }
  }, [ensureLoaded, value]);

  const visibleOptions = options
    .filter((option) => !excludeSet.has(String(option.value)))
    .map((option) => ({
      label: option.label,
      value: option.value,
      disabled: option.disabled,
      searchText: option.searchText ?? option.label,
    }));

  return (
    <Select
      showSearch
      allowClear={allowClear}
      mode={mode}
      disabled={disabled || !endpoint}
      placeholder={error ?? placeholder}
      loading={loading}
      style={{ width: '100%', ...style }}
      value={value === null || value === undefined || value === '' ? undefined : value}
      options={visibleOptions}
      optionFilterProp="searchText"
      filterOption={(input, option) => String(option?.searchText ?? option?.label ?? '').toLowerCase().includes(input.trim().toLowerCase())}
      onDropdownVisibleChange={(open) => {
        if (open) void ensureLoaded();
      }}
      onChange={(next, option) => {
        // antd Select 第二参：单选为选项对象、多选为数组；label 仅在为 string 时透传
        const label = !Array.isArray(option) && typeof option?.label === 'string' ? option.label : undefined;
        onChange?.(next ?? null, label);
      }}
      notFoundContent={loading ? <Spin size="small" /> : error ?? '暂无选项'}
    />
  );
}
