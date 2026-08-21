import type { NavigationItem } from '../components/AppShell';
import { comparePlacement, resolveMenuConfig } from './merge';
import type { SystemMenuConfig } from './types';

/**
 * 菜单管理编辑器的树状态（仅展示层；path/permission 不在此模型内，保存时只输出展示配置行）。
 * 统一两种节点：菜单项（叶子）与分组（可任意嵌套）；同一容器内菜单项与分组混排
 * （共享顺序轴，与 AppShell 渲染一致）。
 */
export interface EditorItemNode {
  kind: 'item';
  itemKey: string;
  nameOverride: string | null;
}

export interface EditorGroupNode {
  kind: 'group';
  nodeKey: string;
  nameOverride: string | null;
  children: EditorNode[];
}

export type EditorNode = EditorItemNode | EditorGroupNode;

export interface MenuEditorState {
  top: EditorNode[];
}

/** 由归并结果构建编辑器树（空配置 = 代码默认结构；空分组保留显示，作为拖放目标） */
export function buildEditorState(defaults: NavigationItem[], config: SystemMenuConfig): MenuEditorState {
  const resolved = resolveMenuConfig(defaults, config);
  const buildChildren = (parentKey: string | null): EditorNode[] => {
    type Entry = { order: number; defaultIndex: number; node: EditorNode };
    const entries: Entry[] = [
      ...resolved.items
        .filter((row) => row.parentKey === parentKey)
        .map((row): Entry => ({
          order: row.order,
          defaultIndex: row.defaultIndex,
          node: { kind: 'item', itemKey: row.itemKey, nameOverride: row.nameOverride },
        })),
      ...resolved.groups
        .filter((row) => row.parentKey === parentKey)
        .map((row): Entry => ({
          order: row.order,
          defaultIndex: row.defaultIndex,
          node: { kind: 'group', nodeKey: row.nodeKey, nameOverride: row.nameOverride, children: buildChildren(row.nodeKey) },
        })),
    ];
    return entries.sort(comparePlacement).map((entry) => entry.node);
  };
  return { top: buildChildren(null) };
}

/** 序列化编辑器树为整树展示配置（各容器内 sortOrder 从 0 连续重排；parentKey = 直接父分组） */
export function serializeEditorState(state: MenuEditorState): SystemMenuConfig {
  const groups: SystemMenuConfig['groups'] = [];
  const items: SystemMenuConfig['items'] = [];
  const walk = (nodes: EditorNode[], parentKey: string | null): void => {
    nodes.forEach((node, index) => {
      if (node.kind === 'item') {
        items.push({ itemKey: node.itemKey, parentKey, nameOverride: node.nameOverride, sortOrder: index });
        return;
      }
      groups.push({ nodeKey: node.nodeKey, parentKey, nameOverride: node.nameOverride, sortOrder: index });
      walk(node.children, node.nodeKey);
    });
  };
  walk(state.top, null);
  return { groups, items };
}

/** 拖拽源（kind + 稳定标识） */
export type EditorDragRef =
  | { kind: 'item'; itemKey: string }
  | { kind: 'group'; nodeKey: string };

/**
 * 拖放目标（index 为该容器内的插入下标）。
 * 合法组合：item / group 均可落入 top 或任意分组的 children；
 * 唯一限制：分组不能落入自身或其后代（防环）。组件层 allowDrop 已拦截，此处防御。
 */
export type EditorDropTarget =
  | { type: 'top'; index: number }
  | { type: 'children'; groupKey: string; index: number };

const targetContainer = (target: EditorDropTarget): string =>
  target.type === 'top' ? '@top' : `g:${target.groupKey}`;

/** 按键匹配节点（拖拽源查找用） */
const matchesDrag = (node: EditorNode, drag: EditorDragRef): boolean =>
  drag.kind === 'item'
    ? node.kind === 'item' && node.itemKey === drag.itemKey
    : node.kind === 'group' && node.nodeKey === drag.nodeKey;

/** 按 nodeKey 查找分组节点（任意深度） */
export function findGroupNode(state: MenuEditorState, nodeKey: string): EditorGroupNode | null {
  const walk = (nodes: EditorNode[]): EditorGroupNode | null => {
    for (const node of nodes) {
      if (node.kind !== 'group') {
        continue;
      }
      if (node.nodeKey === nodeKey) {
        return node;
      }
      const found = walk(node.children);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return walk(state.top);
}

/** 收集分组子树内全部分组 nodeKey（含自身）——拖放守卫：分组不能落入自身或后代 */
export function collectGroupSubtreeKeys(node: EditorGroupNode): Set<string> {
  const keys = new Set<string>([node.nodeKey]);
  const walk = (children: EditorNode[]): void => {
    for (const child of children) {
      if (child.kind === 'group') {
        keys.add(child.nodeKey);
        walk(child.children);
      }
    }
  };
  walk(node.children);
  return keys;
}

interface Removal {
  next: MenuEditorState;
  removed: EditorNode;
  /** 原容器标识：'@top' 顶层；`g:<nodeKey>` 分组 children */
  container: string;
  index: number;
}

/** 从树中移除拖拽节点（任意深度；返回新树与被移除节点及其原位置） */
function removeNode(state: MenuEditorState, drag: EditorDragRef): Removal | null {
  const attempt = (
    nodes: EditorNode[],
    container: string,
  ): { nodes: EditorNode[]; removal: { removed: EditorNode; container: string; index: number } } | null => {
    const index = nodes.findIndex((node) => matchesDrag(node, drag));
    if (index !== -1) {
      return {
        nodes: nodes.filter((_, position) => position !== index),
        removal: { removed: nodes[index] as EditorNode, container, index },
      };
    }
    for (const [position, node] of nodes.entries()) {
      if (node.kind !== 'group') {
        continue;
      }
      const inner = attempt(node.children, `g:${node.nodeKey}`);
      if (inner) {
        const next = [...nodes];
        next[position] = { ...node, children: inner.nodes };
        return { nodes: next, removal: inner.removal };
      }
    }
    return null;
  };
  const result = attempt(state.top, '@top');
  if (!result) {
    return null;
  }
  return { next: { top: result.nodes }, ...result.removal };
}

/** 目标容器存在性与防环守卫（组件层 allowDrop 已拦截，此处防御） */
function targetGuardFails(state: MenuEditorState, drag: EditorDragRef, target: EditorDropTarget): boolean {
  if (target.type === 'top') {
    return false;
  }
  if (!findGroupNode(state, target.groupKey)) {
    return true;
  }
  if (drag.kind !== 'group') {
    return false;
  }
  const dragGroup = findGroupNode(state, drag.nodeKey);
  if (!dragGroup) {
    return true;
  }
  return collectGroupSubtreeKeys(dragGroup).has(target.groupKey);
}

const insertAt = <T>(list: T[], index: number, node: T): T[] => {
  const next = [...list];
  next.splice(Math.min(index, next.length), 0, node);
  return next;
};

/**
 * 应用一次拖放：先移除再插入；同容器内向下移动时插入下标随移除前移一位。
 * 分组移动到任意层级均保持分组身份（子树整体跟随）。返回 null 表示非法组合（状态不变）。
 */
export function moveEditorNode(state: MenuEditorState, drag: EditorDragRef, target: EditorDropTarget): MenuEditorState | null {
  if (targetGuardFails(state, drag, target)) {
    return null;
  }
  const removal = removeNode(state, drag);
  if (!removal) {
    return null;
  }
  const { next, removed } = removal;
  const sameContainer = removal.container === targetContainer(target);
  const insertIndex = sameContainer && removal.index < target.index ? target.index - 1 : target.index;

  if (target.type === 'top') {
    return { top: insertAt(next.top, insertIndex, removed) };
  }
  const insertInto = (nodes: EditorNode[]): EditorNode[] =>
    nodes.map((node) => {
      if (node.kind !== 'group') {
        return node;
      }
      if (node.nodeKey === target.groupKey) {
        return { ...node, children: insertAt(node.children, insertIndex, removed) };
      }
      return { ...node, children: insertInto(node.children) };
    });
  return { top: insertInto(next.top) };
}

interface LocatedNode {
  index: number;
  size: number;
  target: (index: number) => EditorDropTarget;
}

/** 定位节点所在容器与下标（上移/下移按钮用） */
function locateNode(state: MenuEditorState, drag: EditorDragRef): LocatedNode | null {
  const search = (nodes: EditorNode[], makeTarget: (position: number) => EditorDropTarget): LocatedNode | null => {
    const index = nodes.findIndex((node) => matchesDrag(node, drag));
    if (index !== -1) {
      return { index, size: nodes.length, target: makeTarget };
    }
    for (const node of nodes) {
      if (node.kind !== 'group') {
        continue;
      }
      const found = search(node.children, (position) => ({ type: 'children', groupKey: node.nodeKey, index: position }));
      if (found) {
        return found;
      }
    }
    return null;
  };
  return search(state.top, (position) => ({ type: 'top', index: position }));
}

/**
 * 上移/下移按钮：与所在容器内的相邻兄弟交换位置（不跨容器；跨容器用拖拽）。
 * 到顶/到底或节点不存在返回 null（状态不变）。
 */
export function moveEditorNodeByOffset(state: MenuEditorState, drag: EditorDragRef, delta: -1 | 1): MenuEditorState | null {
  const located = locateNode(state, drag);
  if (!located) {
    return null;
  }
  const targetIndex = located.index + delta;
  if (targetIndex < 0 || targetIndex >= located.size) {
    return null;
  }
  // moveEditorNode 的 index 是移除前下标；同容器下移需 +1 补偿移除带来的前移
  return moveEditorNode(state, drag, located.target(delta === 1 ? targetIndex + 1 : targetIndex));
}

/** 改名目标（组件层 Modal 确认后调用；空白串 = 恢复默认名） */
export type EditorRenameRef =
  | { kind: 'item'; itemKey: string }
  | { kind: 'group'; nodeKey: string };

/** 更新节点中文名覆盖；返回 null 表示目标不存在（状态不变） */
export function renameEditorNode(state: MenuEditorState, target: EditorRenameRef, rawName: string): MenuEditorState | null {
  const nameOverride = rawName.trim() === '' ? null : rawName.trim();
  let found = false;
  const walk = (nodes: EditorNode[]): EditorNode[] =>
    nodes.map((node) => {
      if (node.kind === 'item') {
        if (target.kind === 'item' && node.itemKey === target.itemKey) {
          found = true;
          return { ...node, nameOverride };
        }
        return node;
      }
      if (target.kind === 'group' && node.nodeKey === target.nodeKey) {
        found = true;
        return { ...node, nameOverride };
      }
      return { ...node, children: walk(node.children) };
    });
  const top = walk(state.top);
  return found ? { top } : null;
}
