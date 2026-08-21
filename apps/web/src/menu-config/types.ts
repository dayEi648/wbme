/** 菜单管理：前端与 platform-core `system-menu-configs` API 对齐的载荷类型（主 PRD §2.1）。 */

/** 支持菜单配置的系统编码 */
export type MenuSystemCode = 'BACKSTAGE' | 'ASSET' | 'HR' | 'FIN';

/**
 * 菜单分组展示配置行（任意层级，分组可自由嵌套）。
 * nodeKey = 稳定身份（代码默认名按层级用 `/` 连接），不随改名/层级调整变化。
 */
export interface MenuGroupConfigRow {
  nodeKey: string;
  /** 父分组 nodeKey；null = 顶层分组 */
  parentKey: string | null;
  /** 中文名覆盖；null = 使用代码默认名 */
  nameOverride: string | null;
  /** 同级范围内顺序（从 0 起；顶层叶子与顶层分组共享同一顺序轴） */
  sortOrder: number;
}

/** 菜单项展示配置行（itemKey = NavigationItem.key；path/permission 仍由代码定义） */
export interface MenuItemConfigRow {
  itemKey: string;
  /** 直接父分组 nodeKey；null = 顶层叶子 */
  parentKey: string | null;
  nameOverride: string | null;
  sortOrder: number;
}

/** 某系统的菜单展示配置（整树；空集合 = 未配置，使用代码默认） */
export interface SystemMenuConfig {
  groups: MenuGroupConfigRow[];
  items: MenuItemConfigRow[];
}
