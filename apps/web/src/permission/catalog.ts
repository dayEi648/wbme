/**
 * 前端权限目录入口：只从 contracts 源文件再导出目录常量，
 * 避免依赖 `@wbme/contracts` 主入口（会把 NestJS DTO 打进浏览器包）。
 */
import {
  PERMISSION_CATALOG,
  type CatalogFunctionDefinition,
  type CatalogSectionDefinition,
  type CatalogSystemDefinition,
} from '../../../../packages/contracts/src/permission/catalog';

export {
  PERMISSION_CATALOG,
  type CatalogFunctionDefinition,
  type CatalogSectionDefinition,
  type CatalogSystemDefinition,
};

/** 功能下拉选项（操作日志「功能」筛选）。 */
export interface CatalogFunctionOption {
  label: string;
  value: string;
}

/**
 * 将权限目录展开为「系统 → 功能」下拉选项（主 PRD §3.3：功能选项随已选系统联动）。
 *
 * @param system 已选系统编码；缺省时列出全部系统功能并以系统名前缀区分
 * @returns 功能编码与中文名选项
 */
export function catalogFunctionOptions(system?: string): CatalogFunctionOption[] {
  return PERMISSION_CATALOG
    .filter((systemDefinition) => system === undefined || system === '' || systemDefinition.code === system)
    .flatMap((systemDefinition) =>
      systemDefinition.sections.flatMap((section) =>
        section.functions.map((fn) => ({
          label: system === undefined || system === '' ? `${systemDefinition.name} / ${fn.name}` : fn.name,
          value: fn.code,
        })),
      ),
    );
}

/** 将持久化的功能编码转换为权限目录中的用户可读功能名称。 */
export function catalogFunctionLabel(code: unknown): string {
  const value = String(code ?? '');
  for (const system of PERMISSION_CATALOG) {
    for (const section of system.sections) {
      const fn = section.functions.find((item) => item.code === value);
      if (fn) return fn.name;
    }
  }
  return '未知功能';
}
