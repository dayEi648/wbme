import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors, type DataScope, type UserStatus } from '@wbme/contracts';
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
 * 从 backstage.user_accounts 只读视图加载会话用户（替代直连 base.users；
 * 视图含全部用户（含软删，恢复兼容性需读注销用户），软删由本函数过滤）。
 *
 * @param prisma Prisma 客户端
 * @param userId 账号 id
 * @returns 会话用户；不存在或软删返回 null
 */
export async function loadSessionUser(prisma: RawPrisma, userId: number): Promise<SessionUser | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      user_id: number;
      status: UserStatus;
      session_version: number;
      is_super_admin: boolean;
      deleted_at: Date | null;
    }>
  >`
    SELECT user_id, status, session_version, is_super_admin, deleted_at
    FROM backstage.user_accounts
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  const user = rows[0];
  if (!user || user.deleted_at !== null) {
    return null;
  }
  return {
    id: user.user_id,
    status: user.status,
    sessionVersion: user.session_version,
    isSuperAdmin: user.is_super_admin,
  };
}

/**
 * 查询 backstage.user_accounts 显示名（审批动作流水用）。
 *
 * @param prisma Prisma 客户端
 * @param userId 账号 id
 * @returns 姓名；不存在返回空串
 */
export async function loadUserName(prisma: RawPrisma, userId: number): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM backstage.user_accounts WHERE user_id = ${userId} LIMIT 1
  `;
  return rows[0]?.name ?? '';
}

/**
 * 功能访问上下文（跨 schema 镜像 AuthorizationService.getFunctionAccess）。
 *
 * 功能注册与员工授权分别经 backstage.function_registry /
 * backstage.function_grants 只读视图读取（拥有模块 backstage），不再直连业务表。
 *
 * @param prisma Prisma 客户端
 * @param userId 员工账号 id
 * @param functionCode 稳定功能编码
 * @param options.includeImplicitSuperAdmin 超管隐式全量放行（默认 true）；
 *   待办角标计数传 false：只按 backstage.function_grants 显式授权判定，超管无授权即不可见
 * @returns 注册/系统开放/是否放行/数据范围
 */
export async function getFunctionAccess(
  prisma: RawPrisma,
  userId: number,
  functionCode: string,
  options?: { includeImplicitSuperAdmin?: boolean },
): Promise<FunctionAccess> {
  const fnRows = await prisma.$queryRaw<
    Array<{
      code: string;
      system_code: string;
      system_name: string;
      product_status: string;
    }>
  >`
    SELECT code, system_code, system_name, product_status
    FROM backstage.function_registry
    WHERE code = ${functionCode}
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
  if (user.isSuperAdmin && (options?.includeImplicitSuperAdmin ?? true)) {
    return { ...base, allowed: true, dataScope: null };
  }
  const grantRows = await prisma.$queryRaw<Array<{ data_scope: DataScope }>>`
    SELECT data_scope
    FROM backstage.function_grants
    WHERE user_id = ${userId}
      AND function_code = ${functionCode}
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
 * 功能授权统一断言（业务控制器权限入口）：
 * 未注册/未授权 → 404（范围外资源不泄露存在性）；系统未开放 → SYSTEM_NOT_OPEN(503)。
 *
 * @param prisma Prisma 客户端
 * @param userId 当前用户
 * @param functionCode 稳定功能编码
 * @returns 功能访问上下文（放行保证）
 */
export async function assertFunctionAccess(prisma: RawPrisma, userId: number, functionCode: string): Promise<FunctionAccess> {
  const access = await getFunctionAccess(prisma, userId, functionCode);
  if (!access.registered || !access.allowed) {
    throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
  }
  if (!access.systemOpen) {
    throw new BusinessException(frameworkErrors.SYSTEM_NOT_OPEN, { system: access.systemName });
  }
  return access;
}

/**
 * asset 会话用户加载器：经 backstage.user_accounts 视图（替代直连 base.users）。
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
