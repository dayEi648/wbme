import { BusinessException, frameworkErrors, PERMISSION_MANAGE_FUNCTION_CODE, permissionErrors, type DataScope } from '@wbme/contracts';
import type { PrismaClient } from '../../../generated/prisma/client';

/**
 * 权限目录注册表共享工具（backstage 权限域；T3-2 建立，T3-3 起供授权管理与权限组共用）。
 *
 * 目录以数据库注册表为准（platform-core 启动对账保证与 @wbme/contracts 的代码目录一致）；
 * 授权/组明细的功能存在性与可选数据范围校验统一走此处。
 */

/** 目录功能元数据（数据库注册表形态） */
export interface FunctionMeta {
  code: string;
  name: string;
  dataScopeOptions: string[];
  sort: number;
  system: { code: string; name: string; sort: number };
  section: { code: string; name: string; sort: number };
}

/** 授权行（读取形态） */
export interface GrantRow {
  id: number;
  userId: number;
  functionCode: string;
  dataScope: DataScope;
}

/** 授权项（功能编码 + 数据范围；与 GrantItemDto 结构一致） */
export interface GrantItem {
  functionCode: string;
  dataScope: DataScope;
}

/** 数据范围展示标注（授权摘要形如"固定资产维护（部门）"，backstage PRD §4） */
export const DATA_SCOPE_LABELS: Record<DataScope, string> = {
  SELF: '本人',
  DEPARTMENT: '部门',
  COMPANY: '公司',
};

/** 数据范围宽严顺序：公司 > 部门 > 本人（主 PRD §3.1「按最宽范围生效」） */
const DATA_SCOPE_RANK: Record<DataScope, number> = { SELF: 0, DEPARTMENT: 1, COMPANY: 2 };

/** 最宽数据范围（公司 > 部门 > 本人，主 PRD §3.1 多档位授权合并）；空数组返回 null */
export function widestScope(scopes: readonly DataScope[]): DataScope | null {
  let widest: DataScope | null = null;
  for (const scope of scopes) {
    if (widest === null || DATA_SCOPE_RANK[scope] > DATA_SCOPE_RANK[widest]) {
      widest = scope;
    }
  }
  return widest;
}

/** 授权（功能编码, 数据范围）对键 */
export function grantKey(functionCode: string, dataScope: string): string {
  return `${functionCode} ${dataScope}`;
}

/**
 * 加载目录功能元数据（数据库注册表全量，约数十行）。
 *
 * @param prisma platform-core Prisma 客户端
 * @returns 功能编码 → 元数据
 */
export async function loadCatalogMap(prisma: PrismaClient): Promise<Map<string, FunctionMeta>> {
  const rows = await prisma.function.findMany({
    select: {
      code: true,
      name: true,
      dataScopeOptions: true,
      sort: true,
      system: { select: { code: true, name: true, sort: true } },
      section: { select: { code: true, name: true, sort: true } },
    },
  });
  return new Map(rows.map((row) => [row.code, row]));
}

/**
 * 校验授权项：功能编码不重复、仍注册于目录、数据范围在可选档位内、
 * "权限管理"功能仅超级管理员可授予/撤销（主 PRD §3.1 委派规则，对权限组明细同样适用——
 * 否则权限管理员可借组展开间接授予该功能，绕过委派约束）。
 *
 * @param items 授权项（校验后的 DTO）
 * @param operatorIsSuperAdmin 操作人是否超管
 * @param catalog 目录功能元数据
 * @throws VALIDATION_FAILED / FUNCTION_NOT_REGISTERED / PERMISSION_MANAGEMENT_GRANT_FORBIDDEN / SCOPE_NOT_SUPPORTED
 */
export function validateGrantItems(
  items: readonly GrantItem[],
  operatorIsSuperAdmin: boolean,
  catalog: Map<string, FunctionMeta>,
): void {
  const codes = items.map((item) => item.functionCode);
  if (new Set(codes).size !== codes.length) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { fields: { grants: '功能编码不可重复' } });
  }
  for (const item of items) {
    const fn = catalog.get(item.functionCode);
    if (!fn) {
      throw new BusinessException(permissionErrors.FUNCTION_NOT_REGISTERED);
    }
    if (fn.code === PERMISSION_MANAGE_FUNCTION_CODE && !operatorIsSuperAdmin) {
      throw new BusinessException(permissionErrors.PERMISSION_MANAGEMENT_GRANT_FORBIDDEN);
    }
    if (!fn.dataScopeOptions.includes(item.dataScope)) {
      throw new BusinessException(permissionErrors.SCOPE_NOT_SUPPORTED);
    }
  }
}

/**
 * 合并授权项：同一功能只保留最宽数据范围（主 PRD §3.1「同一权限点被多个不同范围
 * 授权时按最宽范围生效」）；逐项功能与权限组展开项合并时使用。
 *
 * @param items 待合并授权项（可含重复功能编码）
 * @returns 按功能编码去最宽档位后的授权项（保持首次出现顺序）
 */
export function mergeWidestScope(items: readonly GrantItem[]): GrantItem[] {
  const byCode = new Map<string, GrantItem>();
  for (const item of items) {
    const existing = byCode.get(item.functionCode);
    if (!existing || DATA_SCOPE_RANK[item.dataScope] > DATA_SCOPE_RANK[existing.dataScope]) {
      byCode.set(item.functionCode, item);
    }
  }
  return [...byCode.values()];
}

/** 授权展示标签："功能名称（数据范围）"；目录外功能按编码兜底展示 */
export function grantLabel(catalog: Map<string, FunctionMeta>, functionCode: string, dataScope: string): string {
  const fn = catalog.get(functionCode);
  const scope = DATA_SCOPE_LABELS[dataScope as DataScope] ?? dataScope;
  return `${fn?.name ?? functionCode}（${scope}）`;
}

/** 授权行按目录排序（系统 sort → 板块 sort → 功能 sort → 编码） */
export function sortGrantRows(rows: readonly GrantRow[], catalog: Map<string, FunctionMeta>): GrantRow[] {
  const order = (row: GrantRow): [number, number, number, string] => {
    const fn = catalog.get(row.functionCode);
    return [fn?.system.sort ?? 0, fn?.section.sort ?? 0, fn?.sort ?? 0, row.functionCode];
  };
  return [...rows].sort((a, b) => {
    const left = order(a);
    const right = order(b);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || left[3].localeCompare(right[3]);
  });
}
