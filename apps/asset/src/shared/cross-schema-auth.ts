import { Inject, Injectable } from '@nestjs/common';
import type { DataScope, UserStatus } from '@wbme/contracts';
import type { SessionUser, SessionUserLoader } from '@wbme/server';
import { PrismaService } from '../prisma.service';

/** 跨 schema 原始 SQL 所需的最小 Prisma 客户端面 */
type RawPrisma = {
  $queryRaw: PrismaService['client']['$queryRaw'];
};

/** 功能访问上下文（对齐 AuthorizationService.getFunctionAccess） */
export interface FunctionAccess {
  registered: boolean;
  systemCode: string | null;
  systemName: string | null;
  systemOpen: boolean;
  allowed: boolean;
  dataScope: DataScope | null;
}

/** 数据范围宽严顺序：公司 > 部门 > 本人（主 PRD §3.1） */
const DATA_SCOPE_RANK: Record<DataScope, number> = { SELF: 0, DEPARTMENT: 1, COMPANY: 2 };

/**
 * 最宽数据范围（公司 > 部门 > 本人）；空数组返回 null。
 *
 * @param scopes 多档位授权
 * @returns 最宽档位
 */
export function widestScope(scopes: readonly DataScope[]): DataScope | null {
  let widest: DataScope | null = null;
  for (const scope of scopes) {
    if (widest === null || DATA_SCOPE_RANK[scope] > DATA_SCOPE_RANK[widest]) {
      widest = scope;
    }
  }
  return widest;
}

/**
 * 从 base.users 加载会话用户（跨 schema 只读）。
 *
 * @param prisma Prisma 客户端
 * @param userId 账号 id
 * @returns 会话用户；不存在或软删返回 null
 */
export async function loadSessionUser(prisma: RawPrisma, userId: number): Promise<SessionUser | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: number;
      status: UserStatus;
      session_version: number;
      is_super_admin: boolean;
      deleted_at: Date | null;
    }>
  >`
    SELECT id, status, session_version, is_super_admin, deleted_at
    FROM base.users
    WHERE id = ${userId}
    LIMIT 1
  `;
  const user = rows[0];
  if (!user || user.deleted_at !== null) {
    return null;
  }
  return {
    id: user.id,
    status: user.status,
    sessionVersion: user.session_version,
    isSuperAdmin: user.is_super_admin,
  };
}

/**
 * 查询 base.users 显示名（审批动作流水用）。
 *
 * @param prisma Prisma 客户端
 * @param userId 账号 id
 * @returns 姓名；不存在返回空串
 */
export async function loadUserName(prisma: RawPrisma, userId: number): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM base.users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0]?.name ?? '';
}

/**
 * 功能访问上下文（跨 schema 镜像 AuthorizationService.getFunctionAccess）。
 *
 * @param prisma Prisma 客户端
 * @param userId 员工账号 id
 * @param functionCode 稳定功能编码
 * @returns 注册/系统开放/是否放行/数据范围
 */
export async function getFunctionAccess(
  prisma: RawPrisma,
  userId: number,
  functionCode: string,
): Promise<FunctionAccess> {
  const fnRows = await prisma.$queryRaw<
    Array<{
      code: string;
      system_code: string;
      system_name: string;
      product_status: string;
    }>
  >`
    SELECT f.code,
           s.code AS system_code,
           s.name AS system_name,
           s.product_status::text AS product_status
    FROM backstage.functions f
    INNER JOIN backstage.systems s ON s.id = f.system_id
    WHERE f.code = ${functionCode}
    LIMIT 1
  `;
  const fn = fnRows[0];
  if (!fn) {
    return { registered: false, systemCode: null, systemName: null, systemOpen: false, allowed: false, dataScope: null };
  }
  const base = {
    registered: true,
    systemCode: fn.system_code,
    systemName: fn.system_name,
    systemOpen: fn.product_status === 'OPEN',
  };
  const user = await loadSessionUser(prisma, userId);
  if (!user) {
    return { ...base, allowed: false, dataScope: null };
  }
  if (user.isSuperAdmin) {
    return { ...base, allowed: true, dataScope: null };
  }
  const grantRows = await prisma.$queryRaw<Array<{ data_scope: DataScope }>>`
    SELECT eg.data_scope
    FROM backstage.employee_grants eg
    INNER JOIN backstage.functions f ON f.code = eg.function_code
    WHERE eg.user_id = ${userId}
      AND eg.function_code = ${functionCode}
  `;
  if (grantRows.length === 0) {
    return { ...base, allowed: false, dataScope: null };
  }
  return {
    ...base,
    allowed: true,
    dataScope: widestScope(grantRows.map((row) => row.data_scope)),
  };
}

/**
 * asset 会话用户加载器：经 `$queryRaw` 读 base.users（主 PRD §9.6）。
 */
@Injectable()
export class CrossSchemaSessionLoader implements SessionUserLoader {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 加载会话用户。
   *
   * @param userId 账号 id
   * @returns 会话用户或 null
   */
  async load(userId: number): Promise<SessionUser | null> {
    return loadSessionUser(this.prisma.client, userId);
  }
}
