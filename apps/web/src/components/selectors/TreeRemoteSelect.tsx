import { Spin, TreeSelect } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { loadRemoteTreeOptions, resolveRemoteEndpoint, type RemoteOptionSource, type TreeOption } from './remote-options';

interface TreeRemoteSelectProps {
  value?: string | number | Array<string | number> | null;
  onChange?: (value: string | number | Array<string | number> | null) => void;
  source: RemoteOptionSource;
  multiple?: boolean;
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
  /** 级联选择器的上游字段值。 */
  context?: unknown;
}

/**
 * 可搜索远程树选择（部门/分类/库位）。
 *
 * @param props TreeSelect 受控属性 + 远程树数据源
 */
export function TreeRemoteSelect({
  value,
  onChange,
  source,
  multiple,
  placeholder = '请选择',
  allowClear = true,
  disabled,
  style,
  context,
}: TreeRemoteSelectProps) {
  const [treeData, setTreeData] = useState<TreeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = resolveRemoteEndpoint(source, context);

  const ensureLoaded = useCallback(async () => {
    if (!endpoint || loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      setTreeData(await loadRemoteTreeOptions(source, context));
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选项加载失败');
    } finally {
      setLoading(false);
    }
  }, [context, endpoint, loaded, loading, source]);

  useEffect(() => {
    setTreeData([]);
    setLoaded(false);
    setError(null);
  }, [endpoint]);

  useEffect(() => {
    if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
      void ensureLoaded();
    }
  }, [ensureLoaded, value]);

  return (
    <TreeSelect
      showSearch
      allowClear={allowClear}
      treeCheckable={multiple}
      multiple={multiple}
      treeDefaultExpandAll
      disabled={disabled || !endpoint}
      placeholder={error ?? placeholder}
      loading={loading}
      style={{ width: '100%', ...style }}
      value={value === null || value === undefined || value === '' ? undefined : value}
      treeData={treeData}
      treeNodeFilterProp="title"
      onDropdownVisibleChange={(open) => {
        if (open) void ensureLoaded();
      }}
      onChange={(next) => onChange?.(next ?? null)}
      notFoundContent={loading ? <Spin size="small" /> : error ?? '暂无选项'}
    />
  );
}
