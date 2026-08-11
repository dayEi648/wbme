import {
  Button,
  Card,
  Checkbox,
  Collapse,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popconfirm,
  Select,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { ExportOutlined, FilterOutlined, SettingOutlined, SortAscendingOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useFeedback } from '../request/feedback';
import { download, http, type ApiService } from '../request/http';
import { formatDisplayValue, isMoneyField } from './display-format';
import { RemoteSelect } from './selectors/RemoteSelect';
import { TreeRemoteSelect } from './selectors/TreeRemoteSelect';
import type { RemoteOptionSource } from './selectors/remote-options';

type RecordValue = Record<string, unknown>;

export interface DataColumn {
  key: string;
  title: string;
  defaultVisible?: boolean;
  width?: number;
  fixed?: 'left' | 'right';
  /** 字段类型（L29：number 列渲染使用等宽数字字体 tabular-nums） */
  type?: 'text' | 'enum' | 'number' | 'date';
  /** 将原始行字段转换为受控 React 节点。 */
  render?: (value: unknown, row: RecordValue) => ReactNode;
}

export interface FilterField {
  key: string;
  title: string;
  type?: 'text' | 'enum' | 'number' | 'date' | 'remote' | 'tree';
  /** 固定选项，或按当前筛选条件动态生成（如「功能」选项随已选「系统」联动，主 PRD §3.3）。 */
  options?: Array<{ label: string; value: string }> | ((filters: FilterCondition[]) => Array<{ label: string; value: string }>);
  /** 按名称可搜索的远程字典/实体下拉（主 PRD §10.2）。 */
  remote?: RemoteOptionSource;
}

export interface FilterCondition {
  field: string;
  operator: string;
  value: string;
  /** 区间筛选的结束值；仅 BETWEEN 操作符使用。 */
  valueEnd?: string;
}

type FilterLogic = 'AND' | 'OR';

/**
 * 条件组用于表达“组内 AND、组间 OR”。没有额外组时仍保留全局 AND/OR 的简洁交互。
 */
interface FilterGroup {
  id: string;
  conditions: FilterCondition[];
}

interface SortCondition {
  field: string;
  direction: 'ASC' | 'DESC';
}

interface FilterPreset {
  id: number;
  name: string;
  content: {
    filters?: FilterCondition[];
    filterGroups?: FilterGroup[];
    filterLogic?: FilterLogic;
    sorts?: SortCondition[];
  };
}

interface PaginatedResponse {
  data: RecordValue[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

export interface DataTableProps {
  title: string;
  description?: string;
  service: ApiService;
  endpoint: string;
  pageKey: string;
  columns: DataColumn[];
  filterFields?: FilterField[];
  /** 页面权限已由父级判断后的操作区；列表本身仍由后端授权。 */
  actions?: ReactNode;
  /** 行主键字段，默认 id。 */
  rowKey?: string;
  /** 行单击事件（移动端卡片与桌面端共用）。 */
  onRowClick?: (row: RecordValue) => void;
  /** 行内业务操作；服务端仍负责状态机、权限与幂等校验。 */
  rowActions?: (row: RecordValue) => ReactNode;
  /** 成功加载后的当前页数据，供审批等需要前后切换详情的页面使用。 */
  onRowsLoaded?: (rows: RecordValue[]) => void;
  /** 批量操作（默认勾选后出现操作栏）。 */
  batchAction?: {
    label: string;
    danger?: boolean;
    /** 确认框中说明业务后果，危险操作不得只显示通用文案。 */
    confirmationDescription?: ReactNode;
    onExecute: (ids: Array<string | number>) => Promise<void>;
  };
  /** 暴露当前勾选项，供需要多个批量业务操作的页面复用统一批量工具栏。 */
  onSelectionChange?: (ids: Array<string | number>) => void;
  /**
   * 可导出列表的服务端端点。全部导出不携带页面条件；已筛选导出复用当前结构化筛选和排序。
   * 页面必须仅在对应后端已提供一致性快照导出接口时传入本配置。
   */
  exportConfig?: {
    allEndpoint: string;
    filteredEndpoint?: string;
    filename: string;
    method?: 'GET' | 'POST';
  };
  /** 空列表时的下一步操作，例如创建或导入。 */
  emptyAction?: { label: string; onExecute: () => void };
}

const DEFAULT_OPERATOR_BY_TYPE: Readonly<Record<NonNullable<FilterField['type']>, string>> = {
  text: 'CONTAINS',
  enum: 'EQUALS',
  number: 'EQUALS',
  date: 'EQUALS',
  remote: 'EQUALS',
  tree: 'EQUALS',
};

export const OPERATOR_OPTIONS: Readonly<Record<NonNullable<FilterField['type']>, Array<{ label: string; value: string }>>> = {
  text: [
    { label: '包含', value: 'CONTAINS' },
    { label: '等于', value: 'EQUALS' },
    { label: '不包含', value: 'NOT_CONTAINS' },
    { label: '不等于', value: 'NOT_EQUALS' },
  ],
  enum: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
  ],
  number: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
    { label: '大于', value: 'GREATER_THAN' },
    { label: '大于等于', value: 'GREATER_THAN_OR_EQUAL' },
    { label: '小于', value: 'LESS_THAN' },
    { label: '小于等于', value: 'LESS_THAN_OR_EQUAL' },
  ],
  date: [
    { label: '等于', value: 'EQUALS' },
    { label: '早于', value: 'BEFORE' },
    { label: '晚于', value: 'AFTER' },
    { label: '区间', value: 'BETWEEN' },
  ],
  remote: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
  ],
  tree: [
    { label: '等于', value: 'EQUALS' },
    { label: '不等于', value: 'NOT_EQUALS' },
  ],
};

/** 列标题内的拖拽柄；松开时才持久化，避免拖动期间产生大量写请求。 */
function ResizableColumnTitle({ title, width, onResize }: { title: string; width: number; onResize: (width: number) => void }) {
  return (
    <div style={{ position: 'relative', minWidth: width, paddingRight: 10 }}>
      {title}
      <span
        aria-label={`调整${title}列宽`}
        role="separator"
        style={{ position: 'absolute', top: -12, right: -4, width: 10, height: 36, cursor: 'col-resize', touchAction: 'none' }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const handle = event.currentTarget;
          const startX = event.clientX;
          const startWidth = width;
          const handleMove = (moveEvent: PointerEvent) => {
            const nextWidth = Math.min(800, Math.max(80, startWidth + moveEvent.clientX - startX));
            handle.style.transform = `translateX(${nextWidth - startWidth}px)`;
          };
          const handleEnd = (endEvent: PointerEvent) => {
            const nextWidth = Math.min(800, Math.max(80, startWidth + endEvent.clientX - startX));
            handle.style.transform = '';
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleEnd);
            onResize(nextWidth);
          };
          window.addEventListener('pointermove', handleMove);
          window.addEventListener('pointerup', handleEnd, { once: true });
        }}
      />
    </div>
  );
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeList(payload: unknown): { rows: RecordValue[]; total: number; page: number; pageSize: number } {
  if (!isRecord(payload) || !Array.isArray(payload.data) || !isRecord(payload.pagination)) {
    throw new Error('列表接口未返回统一的 data + pagination 契约');
  }
  const { data, pagination } = payload as unknown as PaginatedResponse;
  if (!Number.isInteger(pagination.page) || !Number.isInteger(pagination.pageSize) || !Number.isInteger(pagination.totalItems)) {
    throw new Error('列表接口分页信息不合法');
  }
  const rows = data.map(normalizeRow);
  return {
    rows,
    total: pagination.totalItems,
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}

/** 兼容 SQL 只读查询返回的 snake_case，同时保留原始字段，避免页面层散落命名转换。 */
function normalizeRow(row: RecordValue): RecordValue {
  // fin 项目列表以 { project, details, auto } 返回：展开可展示的主档和自动汇总，
  // 同时保留原嵌套对象供详情页使用，避免每个财务页面重复适配。
  const normalized: RecordValue = {
    ...row,
    ...(isRecord(row.project) ? row.project : {}),
    ...(isRecord(row.auto) ? row.auto : {}),
  };
  for (const [key, value] of Object.entries(row)) {
    if (!key.includes('_')) continue;
    const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (normalized[camel] === undefined) normalized[camel] = value;
  }
  return normalized;
}

function asText(value: unknown, key?: string): string {
  return formatDisplayValue(value, key);
}

/**
 * 单元格是否按数字渲染（应用等宽数字字体 tabular-nums，L29）：
 * 显式声明 type:'number'，或列值本身为数值类型即视为数字列——
 * 多数调用方列定义未声明 type（数据源即数值），值探测避免依赖各页面逐一接线。
 */
/**
 * 构造列表查询的 filters 负载（L31 回归：纯函数便于单测）。
 *
 * 复杂组合协议（组内 AND、组间 OR，主 PRD §2.7）：存在条件组时顶层恒为 OR；
 * “全部（AND）”主条件合并为一个 AND 组，与其它组共同保持 OR 语义；
 * “任意（OR）”主条件拆成多个单条件 AND 组。无条件组时保持全局 AND/OR 原样。
 */
export function buildGroupedFilterPayload(
  filterLogic: FilterLogic,
  populatedFilters: FilterCondition[],
  populatedGroups: FilterGroup[],
): { logic: FilterLogic; conditions?: FilterCondition[]; groups?: Array<{ logic: 'AND'; conditions: FilterCondition[] }> } {
  if (populatedGroups.length === 0) {
    return { logic: filterLogic, conditions: populatedFilters };
  }
  return {
    logic: 'OR',
    groups: [
      // 复杂组合协议限定每个条件组必须为 AND：原本的“任意”主条件拆成多个单条件 AND 组，
      // 与其它组共同保持 OR 语义；“全部”主条件则保留为一个 AND 组。
      ...(filterLogic === 'AND'
        ? (populatedFilters.length > 0 ? [{ logic: 'AND' as const, conditions: populatedFilters }] : [])
        : populatedFilters.map((filter) => ({ logic: 'AND' as const, conditions: [filter] }))),
      ...populatedGroups.map((group) => ({ logic: 'AND' as const, conditions: group.conditions })),
    ],
  };
}

export function isNumericCell(column: DataColumn, value: unknown): boolean {
  return column.type === 'number' || typeof value === 'number' || (isMoneyField(column.key) && /^-?\d+(?:\.\d+)?$/.test(String(value)));
}

/**
 * 全站通用数据表格。
 *
 * 支持服务器分页、结构化筛选/多级排序载荷、个人预设和列显隐；移动端改为信息卡片，
 * 以保证不因窄屏而删除已授权的查询能力。
 */
export function DataTable({
  title,
  description,
  service,
  endpoint,
  pageKey,
  columns,
  filterFields = [],
  actions,
  rowKey = 'id',
  onRowClick,
  rowActions,
  onRowsLoaded,
  batchAction,
  onSelectionChange,
  exportConfig,
  emptyAction,
}: DataTableProps) {
  const feedback = useFeedback();
  const [rows, setRows] = useState<RecordValue[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [columnOpen, setColumnOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetManageOpen, setPresetManageOpen] = useState(false);
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [filterGroups, setFilterGroups] = useState<FilterGroup[]>([]);
  const [filterLogic, setFilterLogic] = useState<FilterLogic>('AND');
  const [sorts, setSorts] = useState<SortCondition[]>([]);
  const [appliedFilters, setAppliedFilters] = useState<FilterCondition[]>([]);
  const [appliedFilterGroups, setAppliedFilterGroups] = useState<FilterGroup[]>([]);
  const [appliedFilterLogic, setAppliedFilterLogic] = useState<FilterLogic>('AND');
  const [appliedSorts, setAppliedSorts] = useState<SortCondition[]>([]);
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [activePresetId, setActivePresetId] = useState<number | undefined>();
  const [renamingPresetId, setRenamingPresetId] = useState<number | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => columns.filter((column) => column.defaultVisible !== false).map((column) => column.key));
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [columnFixed, setColumnFixed] = useState<Record<string, 'left' | 'right' | undefined>>({});
  const [selectedKeys, setSelectedKeys] = useState<Array<string | number>>([]);
  const [presetForm] = Form.useForm<{ name: string }>();
  const [renamePresetForm] = Form.useForm<{ name: string }>();

  const queryKey = useMemo(() => JSON.stringify({ page, pageSize, filters: appliedFilters, filterGroups: appliedFilterGroups, filterLogic: appliedFilterLogic, sorts: appliedSorts }), [page, pageSize, appliedFilters, appliedFilterGroups, appliedFilterLogic, appliedSorts]);
  const visibleColumns = useMemo(
    () => visibleKeys.map((key) => columns.find((column) => column.key === key)).filter((column): column is DataColumn => Boolean(column)),
    [columns, visibleKeys],
  );
  const quickFilterFields = useMemo(
    () => filterFields
      .filter((field) => field.type === 'enum' || field.type === 'remote' || field.type === 'tree' || /(?:keyword|name|status|state|month)/i.test(field.key))
      .slice(0, 6),
    [filterFields],
  );
  const quickFilterKeys = useMemo(() => new Set(quickFilterFields.map((field) => field.key)), [quickFilterFields]);
  const appliedFilterCount = appliedFilters.length + appliedFilterGroups.reduce((count, group) => count + group.conditions.length, 0);
  const advancedFilters = filters
    .map((filter, index) => ({ filter, index }))
    .filter(({ filter }) => !quickFilterKeys.has(filter.field));

  /** 构造受控列表参数；筛选字段仍由后端资源白名单解释，前端不会传递 SQL/任意字段。 */
  const buildListParams = (options: { includePagination: boolean; includeConditions: boolean }): URLSearchParams => {
    const params = options.includePagination ? new URLSearchParams({ page: String(page), pageSize: String(pageSize) }) : new URLSearchParams();
    if (!options.includeConditions) {
      return params;
    }

    const populatedFilters = appliedFilters.filter((filter) => filter.value.trim());
    const populatedGroups = appliedFilterGroups
      .map((group) => ({ ...group, conditions: group.conditions.filter((filter) => filter.value.trim()) }))
      .filter((group) => group.conditions.length > 0);
    const allFilterConditions = [...populatedFilters, ...populatedGroups.flatMap((group) => group.conditions)];
    if (allFilterConditions.length > 0) {
      const filterPayload = buildGroupedFilterPayload(appliedFilterLogic, populatedFilters, populatedGroups);
      params.set('filters', JSON.stringify(filterPayload));
      // 同时映射到当前资源已有的白名单具名查询参数，保证既有列表接口与通用契约可联调。
      for (const filter of allFilterConditions) {
        params.set(filter.field, filter.value);
      }
    }
    if (appliedSorts.length > 0) {
      params.set('sorts', JSON.stringify(appliedSorts));
    }
    return params;
  };

  const load = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const params = buildListParams({ includePagination: true, includeConditions: true });
      const queryDelimiter = endpoint.includes('?') ? '&' : '?';
      const result = await http.get<PaginatedResponse>(`${endpoint}${queryDelimiter}${params.toString()}`, { service, active: true });
      const normalized = normalizeList(result);
      setRows(normalized.rows);
      onRowsLoaded?.(normalized.rows);
      setTotal(normalized.total);
      if (normalized.page !== page) {
        setPage(normalized.page);
      }
      if (normalized.pageSize !== pageSize) {
        setPageSize(normalized.pageSize);
      }
    } catch (error) {
      setRows([]);
      setTotal(0);
      setFailed(true);
      feedback.error(error, '列表加载失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // queryKey 是筛选、排序与分页的稳定序列化快照。
  }, [endpoint, onRowsLoaded, queryKey, service]);

  useEffect(() => {
    void (async () => {
      try {
        const [presetResult, columnsResult] = await Promise.all([
          http.get<{ items: FilterPreset[] }>(`/me/table-prefs/${pageKey}/filter-presets`, { service }),
          http.get<{ item: { content?: { visibleKeys?: string[]; columnWidths?: Record<string, number>; columnFixed?: Record<string, 'left' | 'right' | undefined> } } | null }>(`/me/table-prefs/${pageKey}/column-setting`, { service }),
        ]);
        setPresets(presetResult.items);
        const storedKeys = columnsResult.item?.content?.visibleKeys;
          if (Array.isArray(storedKeys)) {
          const knownKeys = storedKeys.filter((key) => columns.some((column) => column.key === key));
          if (knownKeys.length > 0) {
            setVisibleKeys(knownKeys);
            }
          }
          if (columnsResult.item?.content?.columnWidths) {
            setColumnWidths(Object.fromEntries(Object.entries(columnsResult.item.content.columnWidths).filter(([key, width]) => columns.some((column) => column.key === key) && Number.isFinite(width) && width >= 80 && width <= 800)));
          }
          if (columnsResult.item?.content?.columnFixed) {
            setColumnFixed(Object.fromEntries(Object.entries(columnsResult.item.content.columnFixed).filter(([key, fixed]) => columns.some((column) => column.key === key) && (fixed === 'left' || fixed === 'right'))));
          }
      } catch {
        // 偏好读取失败不影响核心业务列表；下一次保存会重新建立设置。
      }
    })();
  }, [columns, pageKey, service]);

  const resizeColumn = (key: string, width: number) => {
    const nextWidths = { ...columnWidths, [key]: width };
    setColumnWidths(nextWidths);
    void http.put(
      `/me/table-prefs/${pageKey}/column-setting`,
      { content: { visibleKeys, columnWidths: nextWidths, columnFixed } },
      { service },
    ).catch((error) => feedback.error(error, '保存列宽失败'));
  };

  const tableColumns: TableColumnsType<RecordValue> = [
    ...visibleColumns.map((column) => ({
      key: column.key,
      title: <ResizableColumnTitle title={column.title} width={columnWidths[column.key] ?? column.width ?? 160} onResize={(width) => resizeColumn(column.key, width)} />,
      width: columnWidths[column.key] ?? column.width,
      fixed: columnFixed[column.key] ?? column.fixed,
      // L29：数字/金额列使用等宽数字字体（tabular-nums），列内数字上下对齐（isNumericCell）
      render: (_: unknown, row: RecordValue) => {
        const content = column.render?.(row[column.key], row) ?? asText(row[column.key], column.key);
        return isNumericCell(column, row[column.key]) ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{content}</span> : content;
      },
    })),
    ...(rowActions ? [{ key: '__actions', title: '操作', fixed: 'right' as const, render: (_: unknown, row: RecordValue) => <span onClick={(event) => event.stopPropagation()}>{rowActions(row)}</span> }] : []),
  ];

  const addFilter = () => {
    const field = filterFields.find((item) => !quickFilterKeys.has(item.key)) ?? filterFields[0];
    if (!field) {
      return;
    }
    setFilters((current) => [
      ...current,
      { field: field.key, operator: DEFAULT_OPERATOR_BY_TYPE[field.type ?? 'text'], value: '' },
    ]);
  };

  const updateFilter = (index: number, patch: Partial<FilterCondition>) => {
    setFilters((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };

  const updateFilterField = (index: number, fieldKey: string) => {
    const field = filterFields.find((item) => item.key === fieldKey);
    updateFilter(index, { field: fieldKey, operator: DEFAULT_OPERATOR_BY_TYPE[field?.type ?? 'text'], value: '' });
  };

  /** 快捷筛选一个字段只保留一个条件，防止默认界面形成难以理解的重复条件。 */
  const updateQuickFilter = (field: FilterField, value: string | undefined) => {
    setFilters((current) => {
      const otherFilters = current.filter((filter) => filter.field !== field.key);
      if (!value?.trim()) {
        return otherFilters;
      }
      return [...otherFilters, {
        field: field.key,
        operator: DEFAULT_OPERATOR_BY_TYPE[field.type ?? 'text'],
        value,
      }];
    });
  };

  /** 解析枚举筛选选项：函数形式按当前筛选条件动态生成（主 PRD §3.3 功能随系统联动）。 */
  const resolveFieldOptions = (field: FilterField): Array<{ label: string; value: string }> | undefined =>
    typeof field.options === 'function' ? field.options(filters) : field.options;

  const addFilterGroup = () => {
    const field = filterFields[0];
    if (!field) return;
    setFilterGroups((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        conditions: [{ field: field.key, operator: DEFAULT_OPERATOR_BY_TYPE[field.type ?? 'text'], value: '' }],
      },
    ]);
  };

  const updateGroupCondition = (groupId: string, index: number, patch: Partial<FilterCondition>) => {
    setFilterGroups((groups) => groups.map((group) => (
      group.id === groupId
        ? { ...group, conditions: group.conditions.map((condition, conditionIndex) => conditionIndex === index ? { ...condition, ...patch } : condition) }
        : group
    )));
  };

  const updateGroupConditionField = (groupId: string, index: number, fieldKey: string) => {
    const field = filterFields.find((item) => item.key === fieldKey);
    updateGroupCondition(groupId, index, { field: fieldKey, operator: DEFAULT_OPERATOR_BY_TYPE[field?.type ?? 'text'], value: '', valueEnd: undefined });
  };

  const refreshPresets = async () => {
    const result = await http.get<{ items: FilterPreset[] }>(`/me/table-prefs/${pageKey}/filter-presets`, { service });
    setPresets(result.items);
  };

  const savePreset = async (values: { name: string }) => {
    try {
      await http.post(
        `/me/table-prefs/${pageKey}/filter-presets`,
        { name: values.name, content: { filters, filterGroups, filterLogic, sorts } },
        { service },
      );
      await refreshPresets();
      setPresetOpen(false);
      presetForm.resetFields();
      feedback.success('筛选预设已保存');
    } catch (error) {
      feedback.error(error, '保存筛选预设失败');
    }
  };

  const renamePreset = async (values: { name: string }) => {
    if (renamingPresetId === null) return;
    try {
      await http.put(`/me/table-prefs/filter-presets/${renamingPresetId}/name`, values, { service });
      await refreshPresets();
      setRenamingPresetId(null);
      renamePresetForm.resetFields();
      feedback.success('筛选预设已重命名');
    } catch (error) {
      feedback.error(error, '重命名筛选预设失败');
    }
  };

  const deletePreset = async (id: number) => {
    try {
      await http.delete(`/me/table-prefs/filter-presets/${id}`, undefined, { service });
      if (activePresetId === id) setActivePresetId(undefined);
      await refreshPresets();
      feedback.success('筛选预设已删除');
    } catch (error) {
      feedback.error(error, '删除筛选预设失败');
    }
  };

  const saveColumns = async (nextKeys: string[], nextWidths = columnWidths, nextFixed = columnFixed) => {
    setVisibleKeys(nextKeys);
    setColumnWidths(nextWidths);
    setColumnFixed(nextFixed);
    try {
      await http.put(`/me/table-prefs/${pageKey}/column-setting`, { content: { visibleKeys: nextKeys, columnWidths: nextWidths, columnFixed: nextFixed } }, { service });
    } catch (error) {
      feedback.error(error, '保存列设置失败');
    }
  };

  const executeBatch = async () => {
    if (!batchAction || selectedKeys.length === 0) {
      return;
    }
    try {
      await batchAction.onExecute(selectedKeys);
      setSelectedKeys([]);
      onSelectionChange?.([]);
      feedback.success('批量操作已完成');
      await load();
    } catch (error) {
      feedback.error(error, '批量操作失败');
    }
  };

  /** 按操作语义给危险批量操作补足结果提示；页面可用 confirmationDescription 覆盖。 */
  const batchConfirmationDescription = batchAction?.confirmationDescription
    ?? (batchAction?.label.includes('注销')
      ? '注销后，该员工将失去所有系统入口；既有业务记录仍会保留。'
      : batchAction?.label.includes('撤销')
        ? '撤销后，已授予的功能将立即失效。'
        : batchAction?.danger
          ? '此操作可能无法恢复，请确认已核对受影响的数据。'
          : undefined);

  /** 下载全部或当前筛选范围；不使用当前页数据，始终由服务端导出完整权限范围。 */
  const exportRows = async (scope: 'all' | 'filtered') => {
    if (!exportConfig) return;
    try {
      const endpoint = scope === 'all' ? exportConfig.allEndpoint : exportConfig.filteredEndpoint ?? exportConfig.allEndpoint;
      const params = buildListParams({ includePagination: false, includeConditions: scope === 'filtered' });
      const delimiter = endpoint.includes('?') ? '&' : '?';
      const blob = await download(`${endpoint}${params.size > 0 ? `${delimiter}${params.toString()}` : ''}`, {
        service,
        active: true,
        method: exportConfig.method,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportConfig.filename;
      link.click();
      URL.revokeObjectURL(url);
      feedback.success(scope === 'all' ? '全部数据导出已开始' : '已筛选数据导出已开始');
    } catch (error) {
      feedback.error(error, scope === 'all' ? '导出全部数据失败' : '导出已筛选数据失败');
    }
  };

  const renderFilterEditor = (
    filter: FilterCondition,
    changeField: (field: string) => void,
    update: (patch: Partial<FilterCondition>) => void,
  ) => {
    const field = filterFields.find((item) => item.key === filter.field) ?? filterFields[0];
    const type = field?.type ?? 'text';
    return <>
      <Select showSearch optionFilterProp="label" value={filter.field} options={filterFields.map((item) => ({ label: item.title, value: item.key }))} onChange={changeField} />
      <Select value={filter.operator} options={OPERATOR_OPTIONS[type]} onChange={(value) => update({ operator: value, valueEnd: value === 'BETWEEN' ? filter.valueEnd ?? '' : undefined })} />
      {field?.type === 'enum' ? (
        <Select showSearch optionFilterProp="label" value={filter.value || undefined} options={field ? resolveFieldOptions(field) : undefined} onChange={(value) => update({ value })} />
      ) : field?.type === 'remote' && field.remote ? (
        <RemoteSelect
          source={field.remote}
          value={filter.value ? Number(filter.value) || filter.value : null}
          onChange={(value) => update({ value: value == null ? '' : String(value) })}
          style={{ minWidth: 180 }}
        />
      ) : field?.type === 'tree' && field.remote ? (
        <TreeRemoteSelect
          source={field.remote}
          value={filter.value ? Number(filter.value) || filter.value : null}
          onChange={(value) => update({ value: value == null ? '' : String(value) })}
          style={{ minWidth: 180 }}
        />
      ) : filter.operator === 'BETWEEN' && field?.type === 'date' ? (
        <Space.Compact block>
          <Input type="date" value={filter.value} onChange={(event) => update({ value: event.target.value })} />
          <Input type="date" value={filter.valueEnd ?? ''} onChange={(event) => update({ valueEnd: event.target.value })} />
        </Space.Compact>
      ) : (
        <Input type={field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : 'text'} value={filter.value} onChange={(event) => update({ value: event.target.value })} />
      )}
    </>;
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          {title}
        </Typography.Title>
        {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
      </div>

      <Space wrap>
        <Button icon={<FilterOutlined />} onClick={() => setFilterOpen(true)}>
          筛选{appliedFilterCount > 0 ? `（${appliedFilterCount}）` : ''}
        </Button>
        <Button icon={<SortAscendingOutlined />} onClick={() => setSortOpen(true)}>
          排序{appliedSorts.length > 0 ? `（${appliedSorts.length}）` : ''}
        </Button>
        <Button onClick={() => setPresetOpen(true)}>保存预设</Button>
        <Select
          allowClear
          placeholder="使用预设"
          style={{ minWidth: 128, maxWidth: 180 }}
          options={presets.map((preset) => ({ label: preset.name, value: preset.id }))}
          onChange={(id: number | undefined) => {
            setActivePresetId(id);
            const preset = presets.find((item) => item.id === id);
            if (preset) {
              setFilters(preset.content.filters ?? []);
              setFilterGroups(preset.content.filterGroups ?? []);
              setFilterLogic(preset.content.filterLogic ?? 'AND');
              setSorts(preset.content.sorts ?? []);
              setAppliedFilters(preset.content.filters ?? []);
              setAppliedFilterGroups(preset.content.filterGroups ?? []);
              setAppliedFilterLogic(preset.content.filterLogic ?? 'AND');
              setAppliedSorts(preset.content.sorts ?? []);
              setPage(1);
            }
          }}
        />
        <Button disabled={presets.length === 0} onClick={() => setPresetManageOpen(true)}>管理预设</Button>
        <Button icon={<SettingOutlined />} onClick={() => setColumnOpen(true)}>
          列设置
        </Button>
        {exportConfig ? (
          <Space.Compact>
            <Button icon={<ExportOutlined />} onClick={() => void exportRows('all')}>导出全部</Button>
            <Button icon={<ExportOutlined />} onClick={() => void exportRows('filtered')}>导出已筛选</Button>
          </Space.Compact>
        ) : null}
        {appliedFilters.length > 0 || appliedFilterGroups.length > 0 || appliedSorts.length > 0 ? (
          <Button
            type="link"
            onClick={() => {
              setFilters([]);
              setFilterGroups([]);
              setFilterLogic('AND');
              setSorts([]);
              setAppliedFilters([]);
              setAppliedFilterGroups([]);
              setAppliedFilterLogic('AND');
              setAppliedSorts([]);
              setActivePresetId(undefined);
              setPage(1);
            }}
          >
            清除全部条件
          </Button>
        ) : null}
        {actions}
      </Space>

      {batchAction && selectedKeys.length > 0 ? (
        <Card size="small">
          <Space wrap>
            <Typography.Text>已选择 {selectedKeys.length} 项</Typography.Text>
            <Popconfirm
              title={`确认${batchAction.label} ${selectedKeys.length} 项？`}
              description={batchConfirmationDescription}
              okText="确认"
              cancelText="取消"
              okButtonProps={{ danger: batchAction.danger }}
              onConfirm={() => void executeBatch()}
            >
              <Button danger={batchAction.danger}>{batchAction.label}</Button>
            </Popconfirm>
            <Button type="link" onClick={() => { setSelectedKeys([]); onSelectionChange?.([]); }}>
              取消选择
            </Button>
          </Space>
        </Card>
      ) : null}

      <Card styles={{ body: { padding: 0 } }}>
        {loading ? (
          <div style={{ minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin tip="正在加载..." />
          </div>
        ) : failed ? (
          <Empty description="加载失败">
            <Button type="primary" onClick={() => void load()}>
              重试
            </Button>
          </Empty>
        ) : rows.length === 0 ? (
          <Empty description={appliedFilterCount > 0 ? '无符合条件的数据' : '暂无数据'}>
            {appliedFilterCount > 0 ? <Button onClick={() => { setFilters([]); setFilterGroups([]); setFilterLogic('AND'); setAppliedFilters([]); setAppliedFilterGroups([]); setAppliedFilterLogic('AND'); setActivePresetId(undefined); setPage(1); }}>清除全部筛选条件</Button> : emptyAction ? <Button type="primary" onClick={emptyAction.onExecute}>{emptyAction.label}</Button> : null}
          </Empty>
        ) : (
          <>
            <div className="wbme-desktop-table">
              <Table<RecordValue>
                rowKey={(row) => String(row[rowKey])}
                columns={tableColumns}
                dataSource={rows}
                pagination={false}
                scroll={{ x: 'max-content' }}
                rowSelection={batchAction ? {
                  selectedRowKeys: selectedKeys,
                  onChange: (keys) => {
                    const nextKeys = keys.map(String);
                    setSelectedKeys(nextKeys);
                    onSelectionChange?.(nextKeys);
                  },
                } : undefined}
                onRow={onRowClick ? (row) => ({ onClick: () => onRowClick(row), style: { cursor: 'pointer' } }) : undefined}
              />
            </div>
            <div className="wbme-mobile-cards" style={{ padding: 16 }}>
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {rows.map((row) => (
                  <Card key={String(row[rowKey])} size="small" hoverable={Boolean(onRowClick)} onClick={() => onRowClick?.(row)}>
                    <Space direction="vertical" size="small" style={{ width: '100%' }}>
                      {batchAction ? (
                        <Checkbox
                          checked={selectedKeys.map(String).includes(String(row[rowKey]))}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            const key = String(row[rowKey]);
                            const nextKeys = event.target.checked
                              ? [...selectedKeys.map(String), key]
                              : selectedKeys.map(String).filter((selected) => selected !== key);
                            setSelectedKeys(nextKeys);
                            onSelectionChange?.(nextKeys);
                          }}
                        >
                          选择此项
                        </Checkbox>
                      ) : null}
                      {visibleColumns.map((column) => (
                        <div key={column.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                          <Typography.Text type="secondary">{column.title}</Typography.Text>
                          {/* L29：数字/金额列使用等宽数字字体，与桌面表格一致（isNumericCell） */}
                          <span style={isNumericCell(column, row[column.key]) ? { fontVariantNumeric: 'tabular-nums' } : undefined}>
                            {column.render?.(row[column.key], row) ?? asText(row[column.key], column.key)}
                          </span>
                        </div>
                      ))}
                      {rowActions ? <div onClick={(event) => event.stopPropagation()}>{rowActions(row)}</div> : null}
                    </Space>
                  </Card>
                ))}
              </Space>
            </div>
          </>
        )}
        {!loading && !failed ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 16 }}>
            <Pagination
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger
              pageSizeOptions={[10, 20, 50, 100]}
              showTotal={(count) => `共 ${count} 条`}
              onChange={(nextPage, nextPageSize) => {
                setPage(nextPage);
                setPageSize(nextPageSize);
              }}
            />
          </div>
        ) : null}
      </Card>

      <Drawer
        title="筛选"
        placement="right"
        open={filterOpen}
        onClose={() => {
          setFilters(appliedFilters);
          setFilterGroups(appliedFilterGroups);
          setFilterLogic(appliedFilterLogic);
          setFilterOpen(false);
        }}
        width={420}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {quickFilterFields.length > 0 ? (
            <Card size="small" title="快捷筛选">
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                {quickFilterFields.map((field) => {
                  const value = filters.find((filter) => filter.field === field.key)?.value ?? '';
                  return <div key={field.key}>
                    <Typography.Text type="secondary">{field.title}</Typography.Text>
                    {field.type === 'enum' ? (
                      <Select allowClear showSearch optionFilterProp="label" value={value || undefined} options={resolveFieldOptions(field)} style={{ width: '100%', marginTop: 4 }} onChange={(nextValue: string | undefined) => updateQuickFilter(field, nextValue)} />
                    ) : field.type === 'remote' && field.remote ? (
                      <div style={{ marginTop: 4 }}>
                        <RemoteSelect
                          source={field.remote}
                          value={value ? Number(value) || value : null}
                          onChange={(nextValue) => updateQuickFilter(field, nextValue == null ? undefined : String(nextValue))}
                        />
                      </div>
                    ) : field.type === 'tree' && field.remote ? (
                      <div style={{ marginTop: 4 }}>
                        <TreeRemoteSelect
                          source={field.remote}
                          value={value ? Number(value) || value : null}
                          onChange={(nextValue) => updateQuickFilter(field, nextValue == null ? undefined : String(nextValue))}
                        />
                      </div>
                    ) : (
                      <Input type={field.type === 'date' ? 'date' : 'text'} value={value} style={{ marginTop: 4 }} onChange={(event) => updateQuickFilter(field, event.target.value)} />
                    )}
                  </div>;
                })}
              </Space>
            </Card>
          ) : null}
          <Collapse
            items={[{
              key: 'advanced-filter',
              label: '高级筛选',
              children: <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {advancedFilters.length > 1 ? (
                  <Card size="small" title="条件关系">
                    <Segmented<FilterLogic>
                      block
                      value={filterLogic}
                      options={filterGroups.length > 0
                        ? [{ label: '主条件同时满足', value: 'AND' }, { label: '主条件满足任一', value: 'OR' }]
                        : [{ label: '同时满足', value: 'AND' }, { label: '满足任一', value: 'OR' }]}
                      onChange={(value) => setFilterLogic(value)}
                    />
                  </Card>
                ) : null}
                {advancedFilters.map(({ filter, index }) => (
                  <Card key={`${filter.field}-${index}`} size="small">
                    <Space direction="vertical" size="small" style={{ width: '100%' }}>
                      {renderFilterEditor(filter, (field) => updateFilterField(index, field), (patch) => updateFilter(index, patch))}
                      <Button danger type="link" onClick={() => setFilters((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除条件</Button>
                    </Space>
                  </Card>
                ))}
                <Button onClick={addFilter} disabled={filterFields.length === 0}>添加筛选条件</Button>
                {filterGroups.map((group, groupIndex) => (
                  <Card key={group.id} size="small" title={`条件组 ${groupIndex + 1}`}>
                    <Space direction="vertical" size="small" style={{ width: '100%' }}>
                      {group.conditions.map((filter, index) => (
                        <Card key={`${group.id}-${index}`} size="small">
                          <Space direction="vertical" size="small" style={{ width: '100%' }}>
                            {renderFilterEditor(filter, (field) => updateGroupConditionField(group.id, index, field), (patch) => updateGroupCondition(group.id, index, patch))}
                            <Button danger type="link" onClick={() => setFilterGroups((current) => current.map((item) => item.id === group.id ? { ...item, conditions: item.conditions.filter((_, conditionIndex) => conditionIndex !== index) } : item))}>移除条件</Button>
                          </Space>
                        </Card>
                      ))}
                      <Button onClick={() => setFilterGroups((current) => current.map((item) => item.id === group.id ? { ...item, conditions: [...item.conditions, { field: filterFields[0]?.key ?? 'id', operator: DEFAULT_OPERATOR_BY_TYPE[filterFields[0]?.type ?? 'text'], value: '' }] } : item))} disabled={filterFields.length === 0}>向条件组添加条件</Button>
                      <Button danger type="link" onClick={() => setFilterGroups((current) => current.filter((item) => item.id !== group.id))}>移除条件组</Button>
                    </Space>
                  </Card>
                ))}
                <Button onClick={addFilterGroup} disabled={filterFields.length === 0}>添加条件组</Button>
              </Space>,
            }]}
          />
          <Button type="primary" block onClick={() => {
            setAppliedFilters(filters);
            setAppliedFilterGroups(filterGroups);
            setAppliedFilterLogic(filterLogic);
            setPage(1);
            setFilterOpen(false);
          }}>
            应用筛选
          </Button>
        </Space>
      </Drawer>

      <Drawer title="排序" placement="right" open={sortOpen} onClose={() => { setSorts(appliedSorts); setSortOpen(false); }} width={420}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {sorts.map((sort, index) => (
            <Card key={`${sort.field}-${index}`} size="small">
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Select value={sort.field} options={columns.map((column) => ({ label: column.title, value: column.key }))} onChange={(value) => setSorts((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, field: value } : item)))} />
                <Select value={sort.direction} options={[{ label: '升序', value: 'ASC' }, { label: '降序', value: 'DESC' }]} onChange={(value: 'ASC' | 'DESC') => setSorts((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, direction: value } : item)))} />
                <Button danger type="link" onClick={() => setSorts((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                  移除排序
                </Button>
              </Space>
            </Card>
          ))}
          <Button onClick={() => setSorts((current) => [...current, { field: columns[0]?.key ?? 'id', direction: 'ASC' }])} disabled={columns.length === 0}>
            添加排序字段
          </Button>
          <Button type="primary" block onClick={() => { setAppliedSorts(sorts); setPage(1); setSortOpen(false); }}>
            应用排序
          </Button>
        </Space>
      </Drawer>

      <Drawer title="列设置" placement="right" open={columnOpen} onClose={() => setColumnOpen(false)} width={360}>
        <Checkbox.Group value={visibleKeys} onChange={(values) => void saveColumns(values.map(String))} style={{ width: '100%' }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            {[...visibleColumns, ...columns.filter((column) => !visibleKeys.includes(column.key))].map((column) => {
              const index = visibleKeys.indexOf(column.key);
              return (
              <Card key={column.key} size="small">
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <Checkbox value={column.key}>{column.title}</Checkbox>
                  <Space wrap>
                    <Button size="small" disabled={index <= 0} onClick={() => { const next = [...visibleKeys]; const previous = next[index - 1]; const current = next[index]; if (previous && current) { next[index - 1] = current; next[index] = previous; void saveColumns(next); } }}>上移</Button>
                    <Button size="small" disabled={index < 0 || index === visibleColumns.length - 1} onClick={() => { const next = [...visibleKeys]; const current = next[index]; const following = next[index + 1]; if (current && following) { next[index] = following; next[index + 1] = current; void saveColumns(next); } }}>下移</Button>
                    <InputNumber
                      size="small"
                      min={80}
                      max={800}
                      placeholder="宽度"
                      value={columnWidths[column.key] ?? column.width}
                      onChange={(value) => {
                        const next = { ...columnWidths };
                        if (value === null) delete next[column.key];
                        else next[column.key] = Number(value);
                        setColumnWidths(next);
                      }}
                      onBlur={() => void saveColumns(visibleKeys, columnWidths, columnFixed)}
                    />
                    <Select size="small" allowClear placeholder="固定" value={columnFixed[column.key] ?? column.fixed} options={[{ label: '固定左侧', value: 'left' }, { label: '固定右侧', value: 'right' }]} onChange={(value: 'left' | 'right' | undefined) => { const next = { ...columnFixed, [column.key]: value }; void saveColumns(visibleKeys, columnWidths, next); }} />
                  </Space>
                </Space>
              </Card>
              );
            })}
          </Space>
        </Checkbox.Group>
      </Drawer>

      <Modal title="保存筛选预设" open={presetOpen} onCancel={() => setPresetOpen(false)} footer={null}>
        <Form form={presetForm} layout="vertical" onFinish={(values) => void savePreset(values)}>
          <Form.Item name="name" label="预设名称" rules={[{ required: true, message: '请输入预设名称' }, { max: 100 }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            保存
          </Button>
        </Form>
      </Modal>

      <Modal title="管理筛选预设" open={presetManageOpen} onCancel={() => setPresetManageOpen(false)} footer={null}>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {presets.length === 0 ? <Empty description="暂无已保存的筛选预设" /> : presets.map((preset) => (
            <Card key={preset.id} size="small">
              <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                <Typography.Text strong>{preset.name}</Typography.Text>
                <Space>
                  <Button
                    size="small"
                    onClick={() => {
                      setRenamingPresetId(preset.id);
                      renamePresetForm.setFieldValue('name', preset.name);
                    }}
                  >
                    重命名
                  </Button>
                  <Popconfirm title={`确认删除预设“${preset.name}”？`} onConfirm={() => void deletePreset(preset.id)}>
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              </Space>
            </Card>
          ))}
        </Space>
      </Modal>

      <Modal title="重命名筛选预设" open={renamingPresetId !== null} onCancel={() => { setRenamingPresetId(null); renamePresetForm.resetFields(); }} footer={null}>
        <Form form={renamePresetForm} layout="vertical" onFinish={(values) => void renamePreset(values)}>
          <Form.Item name="name" label="预设名称" rules={[{ required: true, message: '请输入预设名称' }, { max: 100 }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>保存名称</Button>
        </Form>
      </Modal>
    </Space>
  );
}

/** 统一状态标签；不把后端输入作为 HTML。 */
export function StatusTag({ value }: { value: unknown }) {
  const text = asText(value);
  const color = text.includes('APPROVED') || text.includes('ACTIVE') || text.includes('OPEN') || text.includes('COMPLETED') ? 'green' : text.includes('REJECTED') || text.includes('DEACTIVATED') || text.includes('FAILED') || text.includes('SCRAPPED') ? 'red' : text.includes('PENDING') || text.includes('PROCESSING') ? 'orange' : 'default';
  return <Tag color={color}>{text}</Tag>;
}

/** 从列表结果安全提取行；供非表格化页面的轻量展示复用。 */
export function listItems(payload: unknown): RecordValue[] {
  if (!isRecord(payload)) {
    return [];
  }
  return normalizeList(payload).rows;
}
