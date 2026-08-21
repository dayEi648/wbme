import { describe, expect, it } from 'vitest';
import type { NavigationItem } from '../components/AppShell';
import { buildEditorState, moveEditorNode, renameEditorNode, serializeEditorState } from './editor-state';
import { applyMenuConfig, EMPTY_MENU_CONFIG } from './merge';
import type { SystemMenuConfig } from './types';

/** 含二级分组的资产系统形态 */
const FIXTURE: NavigationItem[] = [
  { key: 'my-assets', label: '我的资产', path: '/asset/my-assets', permission: 'my_assets', group: '固定资产' },
  { key: 'assets', label: '固定资产台账', path: '/asset/assets', permission: 'fixed_asset_view', group: '固定资产' },
  { key: 'consumables', label: '品类管理', path: '/asset/consumables', permission: 'inventory_manage', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'warehouses', label: '库位管理', path: '/asset/warehouses', permission: 'inventory_manage', group: '消耗品', subGroup: '消耗品管理' },
  { key: 'claims', label: '我的申领', path: '/asset/claims', permission: 'consumable_apply', group: '消耗品', subGroup: '消耗品申领' },
  { key: 'approval', label: '审批中心', path: '/asset/approval', permission: 'consumable_approval' },
  { key: 'config', label: '系统设置', path: '/asset/config', permission: 'asset_config' },
];

/** 顶层叶子夹在分组之间的形态 */
const MIXED_FIXTURE: NavigationItem[] = [
  { key: 'users', label: '用户管理', path: '/backstage/users', group: '用户与权限' },
  { key: 'permissions', label: '人员权限', path: '/backstage/permissions', group: '用户与权限' },
  { key: 'approval', label: '审批中心', path: '/backstage/approval' },
  { key: 'settings', label: '系统设置', path: '/backstage/settings', group: '内容与配置' },
  { key: 'announcements', label: '系统公告', path: '/backstage/announcements', group: '内容与配置' },
  { key: 'operations', label: '操作日志', path: '/backstage/operation-logs', group: '运维监控' },
];

const keysOf = (items: NavigationItem[]): string[] => items.map((item) => item.key);

interface RenderLeaf {
  key: string;
  label: string;
}

interface RenderGroup {
  name: string;
  children: Array<RenderLeaf | RenderGroup>;
}

/** 按 AppShell 聚合语义投影为可序列化的渲染结构（不含系统首页/搜索）：顶层叶子与分组块按数组序混排，分组按 groupPath 任意嵌套 */
function projectForRender(items: NavigationItem[]): Array<RenderLeaf | RenderGroup> {
  const top: Array<RenderLeaf | RenderGroup> = [];
  const groupByPath = new Map<string, RenderGroup>();
  for (const item of items) {
    const path = item.groupPath ?? [item.group, item.subGroup].filter((name): name is string => Boolean(name));
    const leaf: RenderLeaf = { key: item.key, label: item.label };
    if (path.length === 0) {
      top.push(leaf);
      continue;
    }
    let siblings: Array<RenderLeaf | RenderGroup> = top;
    let prefix = '';
    for (const name of path) {
      prefix = prefix === '' ? name : `${prefix}/${name}`;
      let group = groupByPath.get(prefix);
      if (!group) {
        group = { name, children: [] };
        groupByPath.set(prefix, group);
        siblings.push(group);
      }
      siblings = group.children;
    }
    siblings.push(leaf);
  }
  return top;
}

/** 逐项归属/名称解析（与顺序无关；归并产物与代码默认统一为显示名路径） */
function placementsOf(items: NavigationItem[]): Array<{ key: string; label: string; path: string[] }> {
  return items
    .map((item) => ({
      key: item.key,
      label: item.label,
      path: item.groupPath ?? [item.group, item.subGroup].filter((name): name is string => Boolean(name)),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

describe('applyMenuConfig（代码默认 + 数据库展示配置 → 最终导航）', () => {
  it('未配置（空集合）时与代码默认完全一致（同一引用快路径）', () => {
    expect(applyMenuConfig(FIXTURE, EMPTY_MENU_CONFIG)).toBe(FIXTURE);
  });

  it('恒等回环：默认结构经 编辑器状态 → 序列化 → 合并 后渲染结构与归属/名称和代码默认一致', () => {
    for (const defaults of [FIXTURE, MIXED_FIXTURE]) {
      const merged = applyMenuConfig(defaults, serializeEditorState(buildEditorState(defaults, EMPTY_MENU_CONFIG)));
      expect(projectForRender(merged)).toEqual(projectForRender(defaults));
      expect(placementsOf(merged)).toEqual(placementsOf(defaults));
    }
  });

  it('改名：菜单项/顶层分组/嵌套分组的中文名覆盖；空白串恢复默认名', () => {
    let state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    state = renameEditorNode(state, { kind: 'item', itemKey: 'assets' }, '资产台账')!;
    state = renameEditorNode(state, { kind: 'group', nodeKey: '固定资产' }, '固定资产管理')!;
    state = renameEditorNode(state, { kind: 'group', nodeKey: '消耗品/消耗品申领' }, '申领')!;
    const renamed = applyMenuConfig(FIXTURE, serializeEditorState(state));
    expect(renamed.find((item) => item.key === 'assets')?.label).toBe('资产台账');
    expect(renamed.find((item) => item.key === 'my-assets')?.groupPath).toEqual(['固定资产管理']);
    expect(renamed.find((item) => item.key === 'claims')?.groupPath).toEqual(['消耗品', '申领']);

    state = renameEditorNode(state, { kind: 'item', itemKey: 'assets' }, '   ')!;
    expect(applyMenuConfig(FIXTURE, serializeEditorState(state)).find((item) => item.key === 'assets')?.label).toBe('固定资产台账');
  });

  it('移动与调序：菜单项移到顶层/跨分组（含深层分组）、嵌套分组跨分组、顶层混排调序', () => {
    let state = buildEditorState(FIXTURE, EMPTY_MENU_CONFIG);
    // claims（消耗品/消耗品申领）→ 顶层第一个
    state = moveEditorNode(state, { kind: 'item', itemKey: 'claims' }, { type: 'top', index: 0 })!;
    // assets（固定资产）→ 消耗品/消耗品管理 第一位（菜单项可直接挂到任意深度的分组）
    state = moveEditorNode(state, { kind: 'item', itemKey: 'assets' }, { type: 'children', groupKey: '消耗品/消耗品管理', index: 0 })!;
    // 二级分组 消耗品/消耗品申领 → 固定资产 分组末尾
    state = moveEditorNode(state, { kind: 'group', nodeKey: '消耗品/消耗品申领' }, { type: 'children', groupKey: '固定资产', index: Number.MAX_SAFE_INTEGER })!;
    const result = applyMenuConfig(FIXTURE, serializeEditorState(state));
    expect(keysOf(result)).toEqual(['claims', 'my-assets', 'assets', 'consumables', 'warehouses', 'approval', 'config']);
    expect(result.find((item) => item.key === 'claims')?.groupPath).toBeUndefined();
    expect(result.find((item) => item.key === 'assets')?.groupPath).toEqual(['消耗品', '消耗品管理']);

    // 顶层混排调序：消耗品 移到最前
    const reordered = applyMenuConfig(
      FIXTURE,
      serializeEditorState(
        moveEditorNode(buildEditorState(FIXTURE, EMPTY_MENU_CONFIG), { kind: 'group', nodeKey: '消耗品' }, { type: 'top', index: 0 })!,
      ),
    );
    expect(keysOf(reordered)).toEqual(['consumables', 'warehouses', 'claims', 'my-assets', 'assets', 'approval', 'config']);
  });

  it('层级调整：二级分组升级为顶层分组（nodeKey 不变，默认显示名取末段），原父组变空则不渲染', () => {
    const config: SystemMenuConfig = {
      groups: [
        { nodeKey: '消耗品/消耗品申领', parentKey: null, nameOverride: null, sortOrder: 0 },
        { nodeKey: '消耗品/消耗品管理', parentKey: null, nameOverride: null, sortOrder: 1 },
      ],
      items: [
        { itemKey: 'claims', parentKey: '消耗品/消耗品申领', nameOverride: null, sortOrder: 0 },
        { itemKey: 'consumables', parentKey: '消耗品/消耗品管理', nameOverride: null, sortOrder: 0 },
        { itemKey: 'warehouses', parentKey: '消耗品/消耗品管理', nameOverride: null, sortOrder: 1 },
      ],
    };
    const result = applyMenuConfig(FIXTURE, config);
    expect(result.find((item) => item.key === 'claims')?.groupPath).toEqual(['消耗品申领']);
    expect(result.find((item) => item.key === 'consumables')?.groupPath).toEqual(['消耗品管理']);
    // 原父组 消耗品 已无菜单项，不渲染
    expect(result.some((item) => item.groupPath?.[0] === '消耗品')).toBe(false);
    // 升级的分组块排在最前（配置顺序 0/1）
    expect(keysOf(result).slice(0, 3)).toEqual(['claims', 'consumables', 'warehouses']);
  });

  it('层级调整：顶层分组降入另一分组成为二级分组', () => {
    const config: SystemMenuConfig = {
      groups: [{ nodeKey: '固定资产', parentKey: '消耗品', nameOverride: null, sortOrder: 0 }],
      items: [
        { itemKey: 'my-assets', parentKey: '固定资产', nameOverride: null, sortOrder: 0 },
        { itemKey: 'assets', parentKey: '固定资产', nameOverride: null, sortOrder: 1 },
      ],
    };
    const result = applyMenuConfig(FIXTURE, config);
    expect(result.find((item) => item.key === 'my-assets')?.groupPath).toEqual(['消耗品', '固定资产']);
    expect(result.find((item) => item.key === 'assets')?.groupPath).toEqual(['消耗品', '固定资产']);
  });

  it('任意层级：顶层分组降入二级分组成为三级分组，渲染结构同步嵌套', () => {
    const config: SystemMenuConfig = {
      groups: [
        { nodeKey: '运维监控', parentKey: null, nameOverride: null, sortOrder: 0 },
        { nodeKey: '用户与权限', parentKey: '运维监控', nameOverride: null, sortOrder: 0 },
      ],
      items: [
        { itemKey: 'users', parentKey: '用户与权限', nameOverride: null, sortOrder: 0 },
        { itemKey: 'permissions', parentKey: '用户与权限', nameOverride: null, sortOrder: 1 },
        { itemKey: 'operations', parentKey: '运维监控', nameOverride: null, sortOrder: 1 },
      ],
    };
    const result = applyMenuConfig(MIXED_FIXTURE, config);
    expect(result.find((item) => item.key === 'users')?.groupPath).toEqual(['运维监控', '用户与权限']);
    expect(result.find((item) => item.key === 'operations')?.groupPath).toEqual(['运维监控']);
    expect(projectForRender(result)).toEqual([
      {
        name: '运维监控',
        children: [
          {
            name: '用户与权限',
            children: [
              { key: 'users', label: '用户管理' },
              { key: 'permissions', label: '人员权限' },
            ],
          },
          { key: 'operations', label: '操作日志' },
        ],
      },
      { key: 'approval', label: '审批中心' },
      {
        name: '内容与配置',
        children: [
          { key: 'settings', label: '系统设置' },
          { key: 'announcements', label: '系统公告' },
        ],
      },
    ]);
  });

  it('非法层级配置回退：自引用/环回退默认父级，不抛错、不丢菜单项', () => {
    // 自引用 → 回退代码默认父级（顶层）
    const selfRef: SystemMenuConfig = {
      groups: [{ nodeKey: '固定资产', parentKey: '固定资产', nameOverride: null, sortOrder: 0 }],
      items: [],
    };
    const selfRefResult = applyMenuConfig(FIXTURE, selfRef);
    expect(selfRefResult.find((item) => item.key === 'my-assets')?.groupPath).toEqual(['固定资产']);

    // 互指环：固定资产 ↔ 消耗品 → 按代码默认顺序确定性破环（固定资产 先解析，保留其候选父；
    // 消耗品 回退顶层），不丢菜单项
    const cyclic: SystemMenuConfig = {
      groups: [
        { nodeKey: '固定资产', parentKey: '消耗品', nameOverride: null, sortOrder: 0 },
        { nodeKey: '消耗品', parentKey: '固定资产', nameOverride: null, sortOrder: 1 },
      ],
      items: [],
    };
    const cyclicResult = applyMenuConfig(FIXTURE, cyclic);
    expect(cyclicResult.find((item) => item.key === 'my-assets')?.groupPath).toEqual(['消耗品', '固定资产']);
    expect(cyclicResult.find((item) => item.key === 'consumables')?.groupPath).toEqual(['消耗品', '消耗品管理']);

    // 兄弟互指环：消耗品管理 ↔ 消耗品申领 → 管理 保留候选父（成为三级），申领 回退默认父级 消耗品
    const siblingCycle: SystemMenuConfig = {
      groups: [
        { nodeKey: '消耗品/消耗品管理', parentKey: '消耗品/消耗品申领', nameOverride: null, sortOrder: 0 },
        { nodeKey: '消耗品/消耗品申领', parentKey: '消耗品/消耗品管理', nameOverride: null, sortOrder: 1 },
      ],
      items: [],
    };
    const siblingResult = applyMenuConfig(FIXTURE, siblingCycle);
    expect(siblingResult.find((item) => item.key === 'consumables')?.groupPath).toEqual(['消耗品', '消耗品申领', '消耗品管理']);
    expect(siblingResult.find((item) => item.key === 'claims')?.groupPath).toEqual(['消耗品', '消耗品申领']);
  });

  it('前向兼容：未知标识忽略、引用已删除分组回退默认归属、代码新增项按默认位置追加', () => {
    const config: SystemMenuConfig = {
      groups: [
        { nodeKey: '已删除分组', parentKey: null, nameOverride: null, sortOrder: 0 },
        { nodeKey: '固定资产', parentKey: null, nameOverride: null, sortOrder: 1 },
      ],
      items: [
        { itemKey: 'ghost', parentKey: null, nameOverride: null, sortOrder: 0 },
        { itemKey: 'my-assets', parentKey: '已删除分组', nameOverride: null, sortOrder: 0 },
        { itemKey: 'assets', parentKey: '固定资产', nameOverride: null, sortOrder: 0 },
      ],
    };
    const result = applyMenuConfig(FIXTURE, config);
    // 代码已删除的菜单项不出现在结果中
    expect(result.some((item) => item.key === 'ghost')).toBe(false);
    // 引用代码中不存在的分组：归属回退代码默认（固定资产）
    expect(result.find((item) => item.key === 'my-assets')?.groupPath).toEqual(['固定资产']);
    // 顶层共享顺序轴：已配置分组（order 1）在前；未配置节点 +∞ 按默认下标兜底（消耗品 di=2 先于叶子 approval/config）
    expect(keysOf(result)).toEqual(['assets', 'my-assets', 'consumables', 'warehouses', 'claims', 'approval', 'config']);
  });
});
