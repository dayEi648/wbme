/**
 * 项目业务键规范化（fin PRD §3）。
 *
 * 规则：Unicode NFC 规范化 → 首尾去空白 → 连续空白归一化为单个空格 →
 * 拉丁字母大小写折叠（toLocaleLowerCase('en')）。项目名称保留原文展示，
 * 另按本规则生成 business_key 与年度共同建立数据库唯一约束；
 * 页面新建/编辑与 Excel 导入匹配使用完全相同的规范化规则。
 */

/**
 * 规范化项目名称（生成业务键用）。
 *
 * @param name 原始项目名称
 * @returns 规范化后的业务键名称分量（首尾无空白、连续空白归一、拉丁字母小写）
 */
export function normalizeProjectName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en');
}

/** 系统虚拟分组“未分类”（fin PRD §4：Excel 空分类分组；财务配置不得创建同名字典项） */
export const UNCLASSIFIED_GROUP_NAME = '未分类';

/**
 * 业务分类字典项名称是否与系统虚拟分组冲突（规范化后比较，避免大小写/空白变体）。
 *
 * @param name 字典项名称
 * @returns 规范化后等于“未分类”时为 true
 */
export function isUnclassifiedReservedName(name: string): boolean {
  return normalizeProjectName(name) === normalizeProjectName(UNCLASSIFIED_GROUP_NAME);
}
