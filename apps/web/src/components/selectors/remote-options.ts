import { http, type ApiService } from '../../request/http';

/** 下拉选项统一形状。 */
export interface SelectOption {
  label: string;
  value: string | number;
  /** 额外检索文本（如手机号），不单独展示。 */
  searchText?: string;
  disabled?: boolean;
}

/** TreeSelect 节点。 */
export interface TreeOption {
  title: string;
  value: string | number;
  key: string | number;
  disabled?: boolean;
  children?: TreeOption[];
}

/**
 * 远程选项数据源声明。
 *
 * 列表接口统一按 `{ data, pagination }` 或树形/数组响应解析；调用方只声明业务端点与字段映射。
 */
export interface RemoteOptionSource {
  service: ApiService;
  /** 列表或树端点（可含静态 query，如 `?status=ACTIVE`）。 */
  endpoint: string;
  /** 由关联字段构建端点；返回 null 时不会发送请求。 */
  resolveEndpoint?: (context: unknown) => string | null;
  /** 选项展示字段，默认 name。 */
  labelKey?: string;
  /** 选项值字段，默认 id。 */
  valueKey?: string;
  /** 追加到 label 后的次要字段（如 phoneMasked）。 */
  secondaryKey?: string;
  /** 将扁平 parentId 组装为树。 */
  tree?: boolean;
  /** 响应已是嵌套 children 树（如库位树）。 */
  nestedTree?: boolean;
  /** 仅保留 status=ACTIVE 的节点（客户端过滤，树接口常无服务端筛选）。 */
  activeOnly?: boolean;
  /** 自定义行 → 选项；优先于 labelKey/valueKey。 */
  mapOption?: (row: Record<string, unknown>) => SelectOption | null;
  /** 按关联字段筛除行，仅用于交互；服务端仍负责权限与数据范围。 */
  filterRows?: (row: Record<string, unknown>, context: unknown) => boolean;
  /** 同一 value 仅保留首项（例如借还记录归并为代领申请）。 */
  uniqueByValue?: boolean;
  /** 自定义行 → 树节点。 */
  mapTreeNode?: (row: Record<string, unknown>) => TreeOption | null;
  /** 单页条数上限（服务端允许 10/20/50/100）。 */
  pageSize?: 50 | 100;
  /** 最多拉取页数，防止异常大目录拖垮浏览器。 */
  maxPages?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;

/**
 * 拉取远程选项（自动翻页至耗尽或达上限）。
 *
 * @param source 数据源声明
 * @returns 扁平选项列表
 * @throws 网络或业务错误由 http 层抛出
 */
export async function loadRemoteOptions(source: RemoteOptionSource, context?: unknown): Promise<SelectOption[]> {
  const rows = await fetchAllRows(source, context);
  const filtered = filterRows(source, rows, context);
  if (source.mapOption) {
    return uniqueOptions(filtered.map(source.mapOption).filter((item): item is SelectOption => item !== null), source.uniqueByValue);
  }
  const labelKey = source.labelKey ?? 'name';
  const valueKey = source.valueKey ?? 'id';
  const secondaryKey = source.secondaryKey;
  const options: SelectOption[] = [];
  for (const row of filtered) {
    const value = row[valueKey];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const labelBase = String(row[labelKey] ?? value);
    const secondary = secondaryKey && row[secondaryKey] != null ? String(row[secondaryKey]) : '';
    const label = secondary ? `${labelBase}（${secondary}）` : labelBase;
    options.push({ label, value, searchText: `${labelBase} ${secondary}`.trim() });
  }
  return uniqueOptions(options, source.uniqueByValue);
}

/**
 * 拉取远程树选项。
 *
 * @param source 数据源声明（tree 或 nestedTree）
 * @returns TreeSelect 可用节点
 */
export async function loadRemoteTreeOptions(source: RemoteOptionSource, context?: unknown): Promise<TreeOption[]> {
  const rows = await fetchAllRows(source, context);
  const filtered = filterRows(source, rows, context);
  if (source.nestedTree) {
    return filtered.map((row) => mapNestedTreeNode(row, source)).filter((item): item is TreeOption => item !== null);
  }
  return buildTreeFromFlat(filtered, source);
}

/**
 * 从接口响应中提取行数组：优先 `data`，其次根数组，再次树根 `children` 扁平化前的根列表。
 */
function extractRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) {
    return payload.data.filter(isRecord);
  }
  if (Array.isArray(payload.items)) {
    return payload.items.filter(isRecord);
  }
  return [];
}

/**
 * 翻页拉取全部行；树形端点通常一次返回全量，仍走同一解析。
 */
async function fetchAllRows(source: RemoteOptionSource, context: unknown): Promise<Array<Record<string, unknown>>> {
  const endpoint = resolveRemoteEndpoint(source, context);
  if (!endpoint) return [];
  const pageSize = source.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = source.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Array<Record<string, unknown>> = [];
  let page = 1;
  while (page <= maxPages) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const path = `${endpoint}${separator}page=${page}&pageSize=${pageSize}`;
    const payload = await http.get<unknown>(path, { service: source.service, active: true });
    const rows = extractRows(payload);
    collected.push(...rows);
    const totalPages = isRecord(payload) && isRecord(payload.pagination)
      ? Number(payload.pagination.totalPages ?? 1)
      : 1;
    if (page >= totalPages || rows.length === 0) break;
    page += 1;
  }
  return collected;
}

/**
 * 解析选择器本次实际请求端点。
 *
 * @param source 数据源声明
 * @param context 关联字段值
 * @returns 可请求端点；缺少上游条件时返回 null
 */
export function resolveRemoteEndpoint(source: RemoteOptionSource, context?: unknown): string | null {
  return source.resolveEndpoint ? source.resolveEndpoint(context) : source.endpoint;
}

/** 统一执行启用状态与关联字段筛选。 */
function filterRows(source: RemoteOptionSource, rows: Array<Record<string, unknown>>, context: unknown): Array<Record<string, unknown>> {
  return rows.filter((row) => {
    if (source.activeOnly && row.status !== 'ACTIVE' && row.status !== undefined) return false;
    return source.filterRows?.(row, context) ?? true;
  });
}

/** 按 value 去重并保留接口排序后的首个可读标签。 */
function uniqueOptions(options: SelectOption[], uniqueByValue: boolean | undefined): SelectOption[] {
  if (!uniqueByValue) return options;
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = String(option.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 扁平 parentId 列表组装为树。 */
function buildTreeFromFlat(rows: Array<Record<string, unknown>>, source: RemoteOptionSource): TreeOption[] {
  const labelKey = source.labelKey ?? 'name';
  const valueKey = source.valueKey ?? 'id';
  const byParent = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const parentRaw = row.parentId;
    const parentKey = parentRaw === null || parentRaw === undefined || parentRaw === '' || parentRaw === 0
      ? '__root__'
      : String(parentRaw);
    const list = byParent.get(parentKey) ?? [];
    list.push(row);
    byParent.set(parentKey, list);
  }
  const build = (parentKey: string): TreeOption[] => {
    const children = byParent.get(parentKey) ?? [];
    return children
      .map((row) => {
        if (source.mapTreeNode) return source.mapTreeNode(row);
        const value = row[valueKey];
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        return {
          title: String(row[labelKey] ?? value),
          value,
          key: value,
          disabled: source.activeOnly && row.status !== undefined && row.status !== 'ACTIVE',
          children: build(String(value)),
        };
      })
      .filter((item): item is TreeOption => item !== null);
  };
  return build('__root__');
}

/** 已嵌套 children 的树节点映射。 */
function mapNestedTreeNode(row: Record<string, unknown>, source: RemoteOptionSource): TreeOption | null {
  if (source.mapTreeNode) return source.mapTreeNode(row);
  const labelKey = source.labelKey ?? 'name';
  const valueKey = source.valueKey ?? 'id';
  const value = row[valueKey];
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const childRows = Array.isArray(row.children) ? row.children.filter(isRecord) : [];
  return {
    title: String(row[labelKey] ?? value),
    value,
    key: value,
    disabled: source.activeOnly && row.status !== undefined && row.status !== 'ACTIVE',
    children: childRows.map((child) => mapNestedTreeNode(child, source)).filter((item): item is TreeOption => item !== null),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
