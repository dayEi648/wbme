import {
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  Dropdown,
  Tooltip,
  type MenuProps,
  type TableColumnsType,
} from 'antd';
import { ExportOutlined, FilterOutlined, MoreOutlined, SettingOutlined, SortAscendingOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useFeedback } from '../request/feedback';
import { download, http, type ApiService } from '../request/http';
import { formatDisplayValue, isMoneyField } from './display-format';
import { AdvancedFilter } from './AdvancedFilter';
import { SortPanel } from './SortPanel';
import {
  buildFilterTreePayload,
  flattenConditions,
  isConditionPopulated,
  namedParamMirrorValue,
  NO_VALUE_OPERATORS,
  normalizePresetContent,
  OPERATOR_OPTIONS,
  removeConditionFromTree,
  type FilterCondition,
  type FilterConditionGroup,
  type FilterField,
  type SortCondition,
} from './advanced-filter';

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
  /**
   * 为 true 时该列出现在排序面板的字段下拉中；必须与对应端点服务端 filters/sorts 白名单一致。
   * 仅声明单列 prismaField 或 SQL column 的字段可排序；多列 keyword / compile-only 字段不可排序。
   */
  sortable?: boolean;
}

interface FilterPreset {
  id: number;
  name: string;
  /**
   * 预设内容：新版为 `{ filterTree, sorts }`；历史数据可能为旧版
   * `{ filters, filterGroups, filterLogic, sorts }`，应用时经 normalizePresetContent 归一化。
   */
  content: unknown;
}

interface PaginatedResponse {
  data: RecordValue[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

export interface DataTableProps {
  title: string;
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
export function isNumericCell(column: DataColumn, value: unknown): boolean {
  return column.type === 'number' || typeof value === 'number' || (isMoneyField(column.key) && /^-?\d+(?:\.\d+)?$/.test(String(value)));
}

/**
 * 全站通用数据表格。
 *
 * 支持服务器分页、钉钉式高级筛选（条件树载荷，见 advanced-filter.ts）/多级排序、个人预设和列显隐；
 * 移动端改为信息卡片，以保证不因窄屏而删除已授权的查询能力。
 */
export function DataTable({
  title,
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
  /** 已生效的筛选树（唯一筛选状态；编辑草稿由 AdvancedFilter 内部持有）。 */
  const [appliedFilterTree, setAppliedFilterTree] = useState<FilterConditionGroup>(() => ({ id: crypto.randomUUID(), logic: 'AND', children: [] }));
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

  const queryKey = useMemo(
    () => JSON.stringify({ page, pageSize, filters: buildFilterTreePayload(appliedFilterTree) ?? null, sorts: appliedSorts }),
    [page, pageSize, appliedFilterTree, appliedSorts],
  );
  const visibleColumns = useMemo(
    () => visibleKeys.map((key) => columns.find((column) => column.key === key)).filter((column): column is DataColumn => Boolean(column)),
    [columns, visibleKeys],
  );
  const sortableColumns = useMemo(
    () => columns.filter((column) => column.sortable),
    [columns],
  );
  /** 已生效的有效条件（剪枝口径与查询载荷一致），驱动计数徽标、条件标签栏与具名参数镜像。 */
  const appliedConditions = useMemo(
    () => flattenConditions(appliedFilterTree).filter(isConditionPopulated),
    [appliedFilterTree],
  );
  const appliedFilterCount = appliedConditions.length;

  /** 构造受控列表参数；筛选字段仍由后端资源白名单解释，前端不会传递 SQL/任意字段。 */
  const buildListParams = (options: { includePagination: boolean; includeConditions: boolean }): URLSearchParams => {
    const params = options.includePagination ? new URLSearchParams({ page: String(page), pageSize: String(pageSize) }) : new URLSearchParams();
    if (!options.includeConditions) {
      return params;
    }

    const filterPayload = buildFilterTreePayload(appliedFilterTree);
    if (filterPayload) {
      params.set('filters', JSON.stringify(filterPayload));
      // 仅「等于」条件可无损镜像为既有白名单具名参数（供尚未解析 filters 的接口联调）；
      // 其余操作符（不等于/包含等）镜像成等号会扭曲语义，一律只走 filters 负载。
      for (const condition of appliedConditions) {
        const mirrored = namedParamMirrorValue(condition);
        if (mirrored !== undefined) {
          params.set(condition.field, mirrored);
        }
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

  const refreshPresets = async () => {
    const result = await http.get<{ items: FilterPreset[] }>(`/me/table-prefs/${pageKey}/filter-presets`, { service });
    setPresets(result.items);
  };

  const savePreset = async (values: { name: string }) => {
    try {
      await http.post(
        `/me/table-prefs/${pageKey}/filter-presets`,
        { name: values.name, content: { filterTree: buildFilterTreePayload(appliedFilterTree) ?? null, sorts: appliedSorts } },
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

  /** 应用筛选预设（桌面「使用预设」下拉与移动端「更多」菜单共用同一套状态迁移）；兼容新旧两种 content 形状。 */
  const applyPreset = (preset: FilterPreset) => {
    const { tree, sorts: presetSorts } = normalizePresetContent(preset.content);
    setActivePresetId(preset.id);
    setAppliedFilterTree(tree);
    setAppliedSorts(presetSorts);
    setPage(1);
  };

  /** 清除工具栏全部已应用条件（筛选/排序/预设），桌面「清除全部条件」与移动端「更多」菜单共用。 */
  const clearAllConditions = () => {
    setAppliedFilterTree({ id: crypto.randomUUID(), logic: 'AND', children: [] });
    setAppliedSorts([]);
    setActivePresetId(undefined);
    setPage(1);
  };

  /** 标签栏单条移除：树内删空后保留的空行由序列化剪枝静默清理（见 removeConditionFromTree）。 */
  const removeAppliedCondition = (conditionId: string) => {
    setAppliedFilterTree((current) => removeConditionFromTree(current, conditionId, filterFields));
    setPage(1);
  };

  /** 条件标签文案：`字段名 运算符label 值`；无值运算符不显示值，枚举解析选项 label，远程/树用 valueLabel 回显。 */
  const formatConditionTag = (condition: FilterCondition): string => {
    const field = filterFields.find((item) => item.key === condition.field);
    const fieldTitle = field?.title ?? condition.field;
    const type = field?.type ?? 'text';
    const operatorLabel = OPERATOR_OPTIONS[type].find((option) => option.value === condition.operator)?.label ?? condition.operator;
    if (NO_VALUE_OPERATORS.has(condition.operator)) {
      return `${fieldTitle} ${operatorLabel}`;
    }
    let valueText: string;
    if (condition.operator === 'BETWEEN') {
      valueText = `${condition.value} ~ ${condition.valueEnd ?? ''}`;
    } else if (type === 'enum' && field) {
      const options = typeof field.options === 'function' ? field.options(appliedConditions) : field.options;
      valueText = options?.find((option) => option.value === condition.value)?.label ?? condition.value;
    } else if (type === 'remote' || type === 'tree') {
      valueText = condition.valueLabel ?? condition.value;
    } else {
      valueText = condition.value;
    }
    return `${fieldTitle} ${operatorLabel} ${valueText}`;
  };

  /**
   * 移动端「更多」菜单：承接桌面工具栏的次要操作（排序/列设置/预设/导出/清除条件），
   * 首屏只保留筛选与页面主操作，避免窄屏下工具栏换行堆叠数屏。
   */
  const moreMenuItems: NonNullable<MenuProps['items']> = [
    ...(sortableColumns.length > 0
      ? [{ key: 'sort', icon: <SortAscendingOutlined />, label: `排序${appliedSorts.length > 0 ? `（${appliedSorts.length}）` : ''}`, onClick: () => setSortOpen(true) }]
      : []),
    { key: 'columns', icon: <SettingOutlined />, label: '列设置', onClick: () => setColumnOpen(true) },
    { key: 'preset-save', label: '保存预设', onClick: () => setPresetOpen(true) },
    presets.length > 0
      ? { key: 'preset-apply', label: '使用预设', children: presets.map((preset) => ({ key: `preset-${preset.id}`, label: preset.name, onClick: () => applyPreset(preset) })) }
      : { key: 'preset-apply-empty', label: '使用预设（暂无已保存）', disabled: true },
    { key: 'preset-manage', label: '管理预设', disabled: presets.length === 0, onClick: () => setPresetManageOpen(true) },
    ...(exportConfig
      ? [
          { type: 'divider' as const },
          { key: 'export-all', icon: <ExportOutlined />, label: '导出全部', onClick: () => void exportRows('all') },
          { key: 'export-filtered', icon: <ExportOutlined />, label: '导出已筛选', onClick: () => void exportRows('filtered') },
        ]
      : []),
    ...(appliedFilterCount > 0 || appliedSorts.length > 0
      ? [{ type: 'divider' as const }, { key: 'clear-all', label: '清除全部条件', danger: true, onClick: clearAllConditions }]
      : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      {/* 移动端工具栏：首屏只保留筛选与页面主操作，次要操作折叠进「更多」（桌面端形态不变）。 */}
      <div className="wbme-mobile-toolbar">
        <Space wrap>
          {filterFields.length > 0 ? (
            <Button icon={<FilterOutlined />} onClick={() => setFilterOpen(true)}>
              筛选{appliedFilterCount > 0 ? `（${appliedFilterCount}）` : ''}
            </Button>
          ) : null}
          {actions}
          <Dropdown menu={{ items: moreMenuItems }} trigger={['click']} placement="bottomLeft">
            <Button icon={<MoreOutlined />}>更多</Button>
          </Dropdown>
        </Space>
      </div>
      <div className="wbme-desktop-toolbar">
        <Space wrap>
          {filterFields.length > 0 ? (
            <Button icon={<FilterOutlined />} onClick={() => setFilterOpen(true)}>
              筛选{appliedFilterCount > 0 ? `（${appliedFilterCount}）` : ''}
            </Button>
          ) : null}
          {sortableColumns.length > 0 ? (
            <Button icon={<SortAscendingOutlined />} onClick={() => setSortOpen(true)}>
              排序{appliedSorts.length > 0 ? `（${appliedSorts.length}）` : ''}
            </Button>
          ) : null}
          <Button onClick={() => setPresetOpen(true)}>保存预设</Button>
          <Select
            allowClear
            placeholder="使用预设"
            style={{ minWidth: 128, maxWidth: 180 }}
            options={presets.map((preset) => ({ label: preset.name, value: preset.id }))}
            onChange={(id: number | undefined) => {
              const preset = presets.find((item) => item.id === id);
              if (preset) {
                applyPreset(preset);
              } else {
                setActivePresetId(undefined);
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
          {appliedFilterCount > 0 || appliedSorts.length > 0 ? (
            <Button
              type="link"
              onClick={clearAllConditions}
            >
              清除全部条件
            </Button>
          ) : null}
          {actions}
        </Space>
      </div>

      {/* 条件标签栏：每个有效条件一个可关闭标签；点击标签文本重新打开高级筛选。 */}
      {appliedFilterCount > 0 ? (
        <Space wrap size={[8, 8]} style={{ width: '100%' }}>
          {appliedConditions.map((condition) => (
            <Tag
              key={condition.id}
              closable
              style={{ cursor: 'pointer', marginInlineEnd: 0 }}
              onClick={() => setFilterOpen(true)}
              onClose={(event) => {
                event.preventDefault();
                event.stopPropagation();
                removeAppliedCondition(condition.id);
              }}
            >
              {formatConditionTag(condition)}
            </Tag>
          ))}
          <Button type="link" size="small" onClick={clearAllConditions}>
            清除
          </Button>
        </Space>
      ) : null}

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
            {appliedFilterCount > 0 ? <Button onClick={() => { setAppliedFilterTree({ id: crypto.randomUUID(), logic: 'AND', children: [] }); setActivePresetId(undefined); setPage(1); }}>清除全部筛选条件</Button> : emptyAction ? <Button type="primary" onClick={emptyAction.onExecute}>{emptyAction.label}</Button> : null}
          </Empty>
        ) : (
          <>
            <div className="wbme-desktop-table">
              <Table<RecordValue>
                aria-label={title}
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

      <AdvancedFilter
        open={filterOpen}
        fields={filterFields}
        appliedTree={appliedFilterTree}
        onApply={(tree) => {
          setAppliedFilterTree(tree);
          setPage(1);
          setFilterOpen(false);
        }}
        onCancel={() => setFilterOpen(false)}
      />

      <SortPanel
        open={sortOpen}
        sortableColumns={sortableColumns.map((column) => ({ key: column.key, title: column.title }))}
        appliedSorts={appliedSorts}
        onApply={(nextSorts) => {
          setAppliedSorts(nextSorts);
          setPage(1);
          setSortOpen(false);
        }}
        onCancel={() => setSortOpen(false)}
      />

      <Drawer title="列设置" placement="right" open={columnOpen} onClose={() => setColumnOpen(false)} width="min(92vw, 360px)">
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
                    <Tooltip title="固定列：表格横向滚动时该列保持可见">
                      <Select
                        size="small"
                        allowClear
                        placeholder="不固定"
                        aria-label={`${column.title}固定位置`}
                        style={{ minWidth: 120 }}
                        value={columnFixed[column.key] ?? column.fixed ?? ''}
                        options={[
                          { label: '不固定', value: '' },
                          { label: '固定在左侧', value: 'left' },
                          { label: '固定在右侧', value: 'right' },
                        ]}
                        onChange={(value: '' | 'left' | 'right' | undefined) => {
                          const next = { ...columnFixed, [column.key]: value === '' || value === undefined ? undefined : value };
                          void saveColumns(visibleKeys, columnWidths, next);
                        }}
                      />
                    </Tooltip>
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
    </div>
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
