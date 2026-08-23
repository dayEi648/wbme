import { describe, expect, it } from 'vitest';
import type { NavigationItem } from '../components/AppShell';
import {
  buildEditorState,
  createGroupNode,
  deleteGroupNode,
  findGroupNode,
  moveEditorNode,
  moveEditorNodeByOffset,
  renameEditorNode,
  serializeEditorState,
  type EditorNode,
  type MenuEditorState,
} from './editor-state';
import { configFromDefaults, EMPTY_MENU_CONFIG } from './merge';
import type { SystemMenuConfig } from './types';

/** 配置行数组顺序无语义（sortOrder 字段承载顺序），比较前按标识排序规整 */
function normalizeConfig(config: SystemMenuConfig): SystemMenuConfig {
  return {
    groups: [...config.groups].sort((left, right) => left.nodeKey.localeCompare(right.nodeKey)),
    items: [...config.items].sort((left, right) => left.itemKey.localeCompare(right.itemKey)),
  };
}

const FIXTURE: NavigationItem[] = [
  { key: 'my-assets', label: '我的资产', path: '/asset/my-assets', group: '固定资产' },
  { key: 'assets', label: '固定资产台账', path: '/asset/assets', group: '固定资产' },
  { key: 'consumables', label: '品类管理', path: '/asset/consumables', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'warehouses', label: '库位管理', path: '/asset/warehouses', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'claims', label: '我的申领', path: '/asset/claims', group: '消耗品', subGroup: '消耗品申领' },
  { key: 'approval', label: '审批中心', path: '/asset/approval' },
  { key: 'config', label: '系统设置', path: '/asset/config' },
];

/** 顶层混排列表的节点标识序列（i:菜单项 / g:分组） */
const topKeys = (state: MenuEditorState): string[] =>
  state.top.map((node) => (node.kind === 'item' ? `i:${node.itemKey}` : `g:${node.nodeKey}`));

/** 容器内直接子级的节点标识序列 */
const childKeys = (nodes: EditorNode[] | undefined): string[] =>
  (nodes ?? []).map((node) => (node.kind === 'item' ? `i:${node.itemKey}` : `g:${node.nodeKey}`));

const groupOf = (state: MenuEditorState, nodeKey: string) => findGroupNode(state, nodeKey);

describe('菜单编辑器状态（build/serialize/move/rename）', () => {
  it('序列化回环：默认结构 build → serialize 与恒等配置一致', () => {
    expect(normalizeConfig(serializeEditorState(buildEditorState(FIXTURE, EMPTY_MENU_CONFIG)))).toEqual(normalizeConfig(configFromDefaults(FIXTURE)));
  });

  it('顶层混排：叶子与分组同轴；同容器向下移动时插入下标随移除前移一位', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    expect(topKeys(state)).toEqual(['g:固定资产', 'g:消耗品', 'i:approval', 'i:config']);
    // approval 移到顶层末尾
    const moved = moveEditorNode(state, { kind: 'item', itemKey: 'approval' }, { type: 'top', index: 4 });
    expect(topKeys(moved!)).toEqual(['g:固定资产', 'g:消耗品', 'i:config', 'i:approval']);
    // 向上移动：approval 移回分组之前
    const restored = moveEditorNode(moved!, { kind: 'item', itemKey: 'approval' }, { type: 'top', index: 0 });
    expect(topKeys(restored!)).toEqual(['i:approval', 'g:固定资产', 'g:消耗品', 'i:config']);
  });

  it('追加到任意深度分组末尾（index = MAX_SAFE_INTEGER 截断为长度）', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    const moved = moveEditorNode(
      state,
      { kind: 'item', itemKey: 'approval' },
      { type: 'children', groupKey: '消耗品/消耗品管理', index: Number.MAX_SAFE_INTEGER },
    )!;
    expect(childKeys(groupOf(moved, '消耗品/消耗品管理')?.children)).toEqual(['i:consumables', 'i:warehouses', 'i:approval']);
    expect(topKeys(moved)).toEqual(['g:固定资产', 'g:消耗品', 'i:config']);
  });

  it('层级调整：嵌套分组移到顶层（子树整体跟随），序列化/重建回环一致', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    const promoted = moveEditorNode(state, { kind: 'group', nodeKey: '消耗品/消耗品申领' }, { type: 'top', index: 0 })!;
    expect(topKeys(promoted)).toEqual(['g:消耗品/消耗品申领', 'g:固定资产', 'g:消耗品', 'i:approval', 'i:config']);
    expect(childKeys(groupOf(promoted, '消耗品/消耗品申领')?.children)).toEqual(['i:claims']);
    expect(childKeys(groupOf(promoted, '消耗品')?.children)).toEqual(['g:消耗品/消耗品管理']);

    const serialized = serializeEditorState(promoted);
    expect(serialized.groups.find((row) => row.nodeKey === '消耗品/消耗品申领')).toMatchObject({ parentKey: null, sortOrder: 0 });
    expect(serialized.items.find((row) => row.itemKey === 'claims')).toMatchObject({ parentKey: '消耗品/消耗品申领' });
    // 回环：序列化结果重建编辑器树，结构与移动后一致
    expect(topKeys(buildEditorState(FIXTURE, serialized))).toEqual(topKeys(promoted));
  });

  it('层级调整：顶层分组落入另一分组成为子分组（仍为分组，子树不变）', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    const demoted = moveEditorNode(state, { kind: 'group', nodeKey: '固定资产' }, { type: 'children', groupKey: '消耗品', index: Number.MAX_SAFE_INTEGER })!;
    expect(topKeys(demoted)).toEqual(['g:消耗品', 'i:approval', 'i:config']);
    expect(childKeys(groupOf(demoted, '固定资产')?.children)).toEqual(['i:my-assets', 'i:assets']);
    expect(childKeys(groupOf(demoted, '消耗品')?.children)).toEqual(['g:消耗品/消耗品管理', 'g:消耗品/消耗品申领', 'g:固定资产']);

    const serialized = serializeEditorState(demoted);
    expect(serialized.groups.find((row) => row.nodeKey === '固定资产')).toMatchObject({ parentKey: '消耗品' });
    expect(serialized.items.find((row) => row.itemKey === 'my-assets')).toMatchObject({ parentKey: '固定资产' });
    expect(topKeys(buildEditorState(FIXTURE, serialized))).toEqual(topKeys(demoted));
  });

  it('任意层级：顶层分组降入二级分组成为三级分组', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    const nested = moveEditorNode(state, { kind: 'group', nodeKey: '固定资产' }, { type: 'children', groupKey: '消耗品/消耗品申领', index: 0 })!;
    expect(topKeys(nested)).toEqual(['g:消耗品', 'i:approval', 'i:config']);
    expect(childKeys(groupOf(nested, '消耗品/消耗品申领')?.children)).toEqual(['g:固定资产', 'i:claims']);
    expect(childKeys(groupOf(nested, '固定资产')?.children)).toEqual(['i:my-assets', 'i:assets']);

    const serialized = serializeEditorState(nested);
    expect(serialized.groups.find((row) => row.nodeKey === '固定资产')).toMatchObject({ parentKey: '消耗品/消耗品申领' });
    // 回环
    expect(topKeys(buildEditorState(FIXTURE, serialized))).toEqual(topKeys(nested));
    expect(childKeys(groupOf(buildEditorState(FIXTURE, serialized), '固定资产')?.children)).toEqual(['i:my-assets', 'i:assets']);
  });

  it('防环守卫：分组不可落入自身或其后代', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    // 落入自身
    expect(moveEditorNode(state, { kind: 'group', nodeKey: '固定资产' }, { type: 'children', groupKey: '固定资产', index: 0 })).toBeNull();
    // 落入后代：消耗品 → 消耗品/消耗品申领
    expect(moveEditorNode(state, { kind: 'group', nodeKey: '消耗品' }, { type: 'children', groupKey: '消耗品/消耗品申领', index: 0 })).toBeNull();
    // 先降 固定资产 入 消耗品/消耗品申领，再把 消耗品 降入 固定资产（更深的后代）同样拒绝
    const nested = moveEditorNode(state, { kind: 'group', nodeKey: '固定资产' }, { type: 'children', groupKey: '消耗品/消耗品申领', index: 0 })!;
    expect(moveEditorNode(nested, { kind: 'group', nodeKey: '消耗品' }, { type: 'children', groupKey: '固定资产', index: 0 })).toBeNull();
  });

  it('不存在的目标/节点返回 null（状态不变）', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    expect(moveEditorNode(state, { kind: 'item', itemKey: 'approval' }, { type: 'children', groupKey: '不存在的分组', index: 0 })).toBeNull();
    expect(moveEditorNode(state, { kind: 'group', nodeKey: '不存在的分组' }, { type: 'top', index: 0 })).toBeNull();
    expect(moveEditorNode(state, { kind: 'item', itemKey: 'not-exist' }, { type: 'top', index: 0 })).toBeNull();
    expect(renameEditorNode(state, { kind: 'item', itemKey: 'not-exist' }, '新名字')).toBeNull();
    expect(renameEditorNode(state, { kind: 'group', nodeKey: '不存在的分组' }, '新名字')).toBeNull();
  });

  it('上移/下移按钮：与相邻兄弟交换位置；到顶/到底返回 null', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    // approval（顶层下标 2）上移一位
    const movedUp = moveEditorNodeByOffset(state, { kind: 'item', itemKey: 'approval' }, -1)!;
    expect(topKeys(movedUp)).toEqual(['g:固定资产', 'i:approval', 'g:消耗品', 'i:config']);
    // 消耗品（顶层下标 1）下移一位
    const movedDown = moveEditorNodeByOffset(state, { kind: 'group', nodeKey: '消耗品' }, 1)!;
    expect(topKeys(movedDown)).toEqual(['g:固定资产', 'i:approval', 'g:消耗品', 'i:config']);
    // 分组内直接项：assets 上移与 my-assets 交换
    const swapped = moveEditorNodeByOffset(state, { kind: 'item', itemKey: 'assets' }, -1)!;
    expect(childKeys(groupOf(swapped, '固定资产')?.children)).toEqual(['i:assets', 'i:my-assets']);
    // 深层分组内：warehouses 上移与 consumables 交换
    const deepSwapped = moveEditorNodeByOffset(state, { kind: 'item', itemKey: 'warehouses' }, -1)!;
    expect(childKeys(groupOf(deepSwapped, '消耗品/消耗品管理')?.children)).toEqual(['i:warehouses', 'i:consumables']);
    // 边界：顶层第一个不可上移、最后一个不可下移；二级分组内唯一项两个方向都不可动
    expect(moveEditorNodeByOffset(state, { kind: 'group', nodeKey: '固定资产' }, -1)).toBeNull();
    expect(moveEditorNodeByOffset(state, { kind: 'item', itemKey: 'config' }, 1)).toBeNull();
    expect(moveEditorNodeByOffset(state, { kind: 'item', itemKey: 'claims' }, -1)).toBeNull();
    expect(moveEditorNodeByOffset(state, { kind: 'item', itemKey: 'claims' }, 1)).toBeNull();
  });

  it('移空的分组保留在编辑器中（作为拖放目标）', () => {
    let state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    for (const itemKey of ['consumables', 'warehouses']) {
      state = moveEditorNode(state, { kind: 'item', itemKey }, { type: 'children', groupKey: '固定资产', index: Number.MAX_SAFE_INTEGER })!;
    }
    state = moveEditorNode(state, { kind: 'group', nodeKey: '消耗品/消耗品管理' }, { type: 'top', index: 0 })!;
    state = moveEditorNode(state, { kind: 'group', nodeKey: '消耗品/消耗品申领' }, { type: 'top', index: 1 })!;
    const emptied = groupOf(state, '消耗品');
    expect(emptied).toBeDefined();
    expect(emptied?.children).toEqual([]);
  });

  it('改名：任意层级分组/菜单项；空白串恢复默认（nameOverride = null）', () => {
    let state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    state = renameEditorNode(state, { kind: 'group', nodeKey: '固定资产' }, '固定资产管理')!;
    expect(groupOf(state, '固定资产')?.nameOverride).toBe('固定资产管理');
    state = renameEditorNode(state, { kind: 'group', nodeKey: '消耗品/消耗品管理' }, '品类与库位')!;
    expect(groupOf(state, '消耗品/消耗品管理')?.nameOverride).toBe('品类与库位');
    state = renameEditorNode(state, { kind: 'item', itemKey: 'config' }, '  ')!;
    expect(state.top.find((node) => node.kind === 'item' && node.itemKey === 'config')?.nameOverride).toBeNull();
  });

  it('新建分组：顶层创建空分组并序列化/重建回环一致', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    const created = createGroupNode(state, null)!;
    expect(created.nodeKey.startsWith('custom:')).toBe(true);
    expect(topKeys(created.next).slice(-1)[0]).toBe(`g:${created.nodeKey}`);
    expect(groupOf(created.next, created.nodeKey)?.children).toEqual([]);

    const serialized = serializeEditorState(created.next);
    expect(serialized.groups.find((row) => row.nodeKey === created.nodeKey)).toMatchObject({ parentKey: null, nameOverride: null });
    expect(topKeys(buildEditorState(FIXTURE, serialized))).toEqual(topKeys(created.next));
  });

  it('新建分组：可创建到已有分组内，序列化保留 parentKey', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    const created = createGroupNode(state, '固定资产')!;
    expect(childKeys(groupOf(created.next, '固定资产')?.children).slice(-1)[0]).toBe(`g:${created.nodeKey}`);

    const serialized = serializeEditorState(created.next);
    expect(serialized.groups.find((row) => row.nodeKey === created.nodeKey)).toMatchObject({ parentKey: '固定资产' });
    expect(buildEditorState(FIXTURE, serialized)).toEqual(created.next);
  });

  it('新建分组：父分组不存在返回 null；改名后保存为 nameOverride', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    expect(createGroupNode(state, '不存在的分组')).toBeNull();

    const created = createGroupNode(state, null)!;
    const renamed = renameEditorNode(created.next, { kind: 'group', nodeKey: created.nodeKey }, '加班管理')!;
    const serialized = serializeEditorState(renamed);
    expect(serialized.groups.find((row) => row.nodeKey === created.nodeKey)?.nameOverride).toBe('加班管理');
    expect(groupOf(buildEditorState(FIXTURE, serialized), created.nodeKey)?.nameOverride).toBe('加班管理');
  });

  it('删除分组：仅允许删除空分组，非空分组返回 null', () => {
    const state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    const created = createGroupNode(state, null)!;
    const deleted = deleteGroupNode(created.next, created.nodeKey)!;
    expect(topKeys(deleted)).not.toContain(`g:${created.nodeKey}`);
    // 非空分组不可删除（默认分组含菜单项；新建分组含子分组也不可删除）
    expect(deleteGroupNode(state, '固定资产')).toBeNull();
    const nested = createGroupNode(state, null)!;
    const withChild = createGroupNode(nested.next, nested.nodeKey)!;
    expect(deleteGroupNode(withChild.next, nested.nodeKey)).toBeNull();
    expect(deleteGroupNode(state, '不存在的分组')).toBeNull();
  });
});
