import type { NavigationItem } from '../components/AppShell';
import type { MenuGroupConfigRow, MenuItemConfigRow, SystemMenuConfig } from './types';

/** 空展示配置：applyMenuConfig 的恒等输入（未配置时渲染与代码默认完全一致） */
export const EMPTY_MENU_CONFIG: SystemMenuConfig = { groups: [], items: [] };

/** 分组 nodeKey 的默认显示名 = 最后一个 '/' 之后的段（nodeKey = 代码默认名按层级用 '/' 连接） */
export function groupDefaultName(nodeKey: string): string {
  const separator = nodeKey.lastIndexOf('/');
  return separator === -1 ? nodeKey : nodeKey.slice(separator + 1);
}

/** 归并比较：先按配置顺序（未配置为 +∞），再按代码默认首次出现下标；Infinity 参与比较不参与减法，避免 NaN */
export function comparePlacement(
  left: { order: number; defaultIndex: number },
  right: { order: number; defaultIndex: number },
): number {
  if (left.order !== right.order) {
    return left.order < right.order ? -1 : 1;
  }
  return left.defaultIndex - right.defaultIndex;
}

/**
 * 由代码默认导航生成恒等展示配置（全部使用默认归属/顺序/名称）。
 * 顺序轴：同一父容器内的菜单项与分组共享同一轴（顶层容器标识 '@top'，与 AppShell 混排渲染一致）。
 */
export function configFromDefaults(defaults: NavigationItem[]): SystemMenuConfig {
  const groups: MenuGroupConfigRow[] = [];
  const items: MenuItemConfigRow[] = [];
  const knownGroups = new Set<string>();
  const nextOrderByScope = new Map<string, number>();
  const nextOrder = (scope: string): number => {
    const order = nextOrderByScope.get(scope) ?? 0;
    nextOrderByScope.set(scope, order + 1);
    return order;
  };

  for (const item of defaults) {
    const path = [item.group, item.subGroup].filter((name): name is string => Boolean(name));
    let parentKey: string | null = null;
    for (const name of path) {
      const nodeKey: string = parentKey === null ? name : `${parentKey}/${name}`;
      if (!knownGroups.has(nodeKey)) {
        knownGroups.add(nodeKey);
        groups.push({ nodeKey, parentKey, nameOverride: null, sortOrder: nextOrder(parentKey ?? '@top') });
      }
      parentKey = nodeKey;
    }
    items.push({ itemKey: item.key, parentKey, nameOverride: null, sortOrder: nextOrder(parentKey ?? '@top') });
  }
  return { groups, items };
}

/** 归并后的菜单项：归属/改名/顺序的最终态（配置缺失或失效时回退代码默认） */
export interface ResolvedMenuItemRow {
  itemKey: string;
  nameOverride: string | null;
  /** 直接父分组 nodeKey；null = 顶层叶子 */
  parentKey: string | null;
  order: number;
  /** 代码默认数组下标（未配置时的次序兜底） */
  defaultIndex: number;
}

/** 归并后的分组：分组集合由代码定义；nodeKey 是稳定身份（不随改名/移动变化），parentKey 为归并后的当前父级 */
export interface ResolvedMenuGroupRow {
  nodeKey: string;
  parentKey: string | null;
  nameOverride: string | null;
  order: number;
  /** 该分组子树内首个菜单项在代码默认数组中的下标（未配置时的次序兜底） */
  defaultIndex: number;
}

export interface ResolvedMenu {
  items: ResolvedMenuItemRow[];
  groups: ResolvedMenuGroupRow[];
}

/**
 * 归并代码默认导航与数据库展示配置。
 *
 * 分组身份（nodeKey）稳定：代码默认名按层级用 `/` 连接；配置行的 parentKey 是"当前位置"
 * 语义——分组可移动到任意层级（任意嵌套深度），身份不变。
 *
 * 前向兼容与防御：代码新增项/分组按默认位置追加（order = +∞ 兜底）；配置引用代码
 * 已删除的标识一律忽略；自引用/环的层级配置回退默认父级（默认父级也成环则提升为顶层）；
 * 菜单项引用已删除分组时归属回退代码默认（仅保留改名）。永不抛错。
 */
export function resolveMenuConfig(defaults: NavigationItem[], config: SystemMenuConfig): ResolvedMenu {
  const identity = configFromDefaults(defaults);
  const configGroupByKey = new Map(config.groups.map((row) => [row.nodeKey, row]));
  const configItemByKey = new Map(config.items.map((row) => [row.itemKey, row]));
  const identityKeys = new Set(identity.groups.map((row) => row.nodeKey));

  // 候选父级 = 配置行 parentKey（引用自身或代码已删除的分组时回退代码默认父级）
  const candidateParent = new Map<string, string | null>();
  for (const base of identity.groups) {
    const row = configGroupByKey.get(base.nodeKey);
    const desired = row === undefined ? base.parentKey : row.parentKey;
    candidateParent.set(
      base.nodeKey,
      desired !== null && (desired === base.nodeKey || !identityKeys.has(desired)) ? base.parentKey : desired,
    );
  }

  /** 沿 resolved 父链的 DFS 解析（visiting/done 三态）：
   * 候选父为 null = 用户移到顶层，直接取顶层；候选父在当前解析链上 = 经由自身成环，
   * 回退默认父级；默认父级也不可用则提升为顶层。先解析完成的祖先链必不含后代节点
   * （递归中已被 visiting 拦截回退），确定性且永不抛错。 */
  const identityParent = new Map(identity.groups.map((row) => [row.nodeKey, row.parentKey] as const));
  const resolvedParent = new Map<string, string | null>();
  const resolveState = new Map<string, 'visiting' | 'done'>();
  const resolveNode = (nodeKey: string): string | null => {
    if (resolveState.get(nodeKey) === 'done') {
      return resolvedParent.get(nodeKey) ?? null;
    }
    resolveState.set(nodeKey, 'visiting');
    const candidate = candidateParent.get(nodeKey) ?? null;
    const defaultParent = identityParent.get(nodeKey) ?? null;
    const usable = (parent: string | null, exclude: string | null): parent is string => {
      if (parent === null || parent === exclude || resolveState.get(parent) === 'visiting') {
        return false;
      }
      resolveNode(parent);
      return true;
    };
    let resolved: string | null = null;
    if (candidate !== null && usable(candidate, null)) {
      resolved = candidate;
    } else if (candidate !== null && usable(defaultParent, candidate)) {
      resolved = defaultParent;
    }
    resolveState.set(nodeKey, 'done');
    resolvedParent.set(nodeKey, resolved);
    return resolved;
  };
  for (const base of identity.groups) {
    resolveNode(base.nodeKey);
  }

  /** 分组子树内首个菜单项的代码默认下标（递归；分组/菜单项数量上限小，无需记忆化） */
  const identityChildren = new Map<string, string[]>();
  for (const base of identity.groups) {
    if (base.parentKey === null) {
      continue;
    }
    const siblings = identityChildren.get(base.parentKey) ?? [];
    siblings.push(base.nodeKey);
    identityChildren.set(base.parentKey, siblings);
  }
  const subtreeFirstIndex = (nodeKey: string): number => {
    let min = Number.POSITIVE_INFINITY;
    identity.items.forEach((row, index) => {
      if (row.parentKey === nodeKey) {
        min = Math.min(min, index);
      }
    });
    for (const child of identityChildren.get(nodeKey) ?? []) {
      min = Math.min(min, subtreeFirstIndex(child));
    }
    return min;
  };

  const groups: ResolvedMenuGroupRow[] = identity.groups.map((base) => {
    const row = configGroupByKey.get(base.nodeKey);
    return {
      nodeKey: base.nodeKey,
      parentKey: resolvedParent.get(base.nodeKey) ?? null,
      nameOverride: row?.nameOverride ?? null,
      order: row?.sortOrder ?? Number.POSITIVE_INFINITY,
      defaultIndex: subtreeFirstIndex(base.nodeKey),
    };
  });

  const items: ResolvedMenuItemRow[] = defaults.map((item, defaultIndex) => {
    const row = configItemByKey.get(item.key);
    let parentKey = identity.items[defaultIndex]?.parentKey ?? null;
    let order = Number.POSITIVE_INFINITY;
    // 配置归属有效：顶层叶子（null）或引用代码仍存在的分组（任意层级）；否则回退默认归属（仅保留改名）
    if (row && (row.parentKey === null || identityKeys.has(row.parentKey))) {
      parentKey = row.parentKey;
      order = row.sortOrder;
    }
    return { itemKey: item.key, nameOverride: row?.nameOverride ?? null, parentKey, order, defaultIndex };
  });

  return { items, groups };
}

/**
 * 代码默认导航 + 数据库展示配置 → 最终 NavigationItem[]（供 AppShell/SystemHome 消费）。
 * 输出数组顺序即渲染顺序：同一父容器内的菜单项与分组按 (配置顺序, 默认下标) 归并；
 * 分组以 groupPath（祖先分组显示名数组）表达任意层级，空分组不渲染
 * （与 AppShell「分组随菜单项首次出现而创建」语义一致）。
 */
export function applyMenuConfig(defaults: NavigationItem[], config: SystemMenuConfig): NavigationItem[] {
  if (config.groups.length === 0 && config.items.length === 0) {
    return defaults;
  }
  const resolved = resolveMenuConfig(defaults, config);
  const itemByKey = new Map(defaults.map((item) => [item.key, item]));
  const groupByKey = new Map(resolved.groups.map((row) => [row.nodeKey, row]));

  // 自身或后代含菜单项的分组才渲染：含直接项的分组标记后沿父链向上传播
  const usedGroupKeys = new Set<string>();
  const markUsed = (nodeKey: string): void => {
    let cursor: string | null = nodeKey;
    while (cursor !== null && !usedGroupKeys.has(cursor)) {
      usedGroupKeys.add(cursor);
      cursor = groupByKey.get(cursor)?.parentKey ?? null;
    }
  };
  for (const row of resolved.items) {
    if (row.parentKey !== null) {
      markUsed(row.parentKey);
    }
  }

  type Node = { order: number; defaultIndex: number } & (
    | { item: ResolvedMenuItemRow }
    | { group: ResolvedMenuGroupRow }
  );
  const result: NavigationItem[] = [];
  const emitContainer = (parentKey: string | null, ancestors: string[]): void => {
    const nodes: Node[] = [
      ...resolved.items
        .filter((row) => row.parentKey === parentKey)
        .map((row): Node => ({ order: row.order, defaultIndex: row.defaultIndex, item: row })),
      ...resolved.groups
        .filter((row) => row.parentKey === parentKey && usedGroupKeys.has(row.nodeKey))
        .map((row): Node => ({ order: row.order, defaultIndex: row.defaultIndex, group: row })),
    ].sort(comparePlacement);
    for (const node of nodes) {
      if ('group' in node) {
        emitContainer(node.group.nodeKey, [...ancestors, node.group.nameOverride ?? groupDefaultName(node.group.nodeKey)]);
        continue;
      }
      const source = itemByKey.get(node.item.itemKey);
      if (!source) {
        continue;
      }
      result.push({
        ...source,
        label: node.item.nameOverride ?? source.label,
        group: ancestors[0],
        subGroup: ancestors[1],
        groupPath: ancestors.length > 0 ? [...ancestors] : undefined,
      });
    }
  };
  emitContainer(null, []);
  return result;
}
