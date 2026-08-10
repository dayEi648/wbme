import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { DataScope } from '@wbme/contracts';
import { REDIS_CLIENT, REDIS_NAMESPACE, redisKey, type Redis } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
import { widestScope } from './catalog-registry.util';

/** 一条有效功能授权（功能编码 + 数据范围） */
export interface EffectiveGrant {
  functionCode: string;
  dataScope: DataScope;
}

/** 四版本授权上下文快照（base PRD §3） */
interface AuthContextSnapshot {
  /** 账号授权版本 users.permission_version */
  pv: number;
  /** 用户组织版本 hr.org_version.user_org_version */
  ov: number;
  /** 组织树版本 hr.org_version.org_tree_version */
  otv: number;
  /** 权限目录版本 permission_catalog_meta.catalog_version */
  dv: number;
  isSuperAdmin: boolean;
  grants: EffectiveGrant[];
}

/** 当前四版本读数 */
interface AuthVersions {
  pv: number;
  ov: number;
  otv: number;
  dv: number;
}

/** 四版本读取结果；组织版本源不可用时禁止复用或写入缓存 */
interface AuthVersionReadResult {
  versions: AuthVersions;
  cacheable: boolean;
}

/** 授权上下文缓存软 TTL（秒）：版本不一致立即失效；TTL 仅防止僵尸键 */
const AUTH_CONTEXT_TTL_SECONDS = 300;

/**
 * 授权查询服务（主 PRD §3.1；全站守卫与数据范围的生效判断口径）。
 *
 * - 读取 employee_grants 并以「目录中存在」过滤：启动对账移除功能后，其历史授权行
 *   保留为审计数据但不得继续生效（主 PRD §3.1），本服务是唯一生效判断口径；
 * - 超级管理员豁免：不受任何功能授权约束，视为拥有全部功能（无需展开授权行）；
 * - Redis 授权上下文缓存：仅当「账号授权版本 + 权限目录版本 + 用户组织版本 + 组织树版本」
 *   四项与快照一致时可复用（base PRD §3）；版本不一致或 Redis 不可用时回退实时读库。
 */
@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * 查询员工当前有效授权（目录过滤后）。
   *
   * @param userId 员工账号 id
   * @returns 站点角色与有效授权列表；账号不存在/已注销返回空授权与非超管
   */
  async getEffectiveGrants(userId: number): Promise<{ isSuperAdmin: boolean; grants: EffectiveGrant[] }> {
    const context = await this.loadAuthContext(userId);
    return { isSuperAdmin: context.isSuperAdmin, grants: context.grants };
  }

  /**
   * 校验员工是否持有指定功能的有效授权（超管豁免；目录外功能授权不生效）。
   * 功能未注册于目录时任何人（含超管）不可用——移除的功能不参与入口与守卫判断（主 PRD §3.1）。
   *
   * @param userId 员工账号 id
   * @param functionCode 稳定功能编码
   * @returns 持有（或超管且功能仍注册）返回 true
   */
  async hasFunction(userId: number, functionCode: string): Promise<boolean> {
    const access = await this.getFunctionAccess(userId, functionCode);
    return access.allowed;
  }

  /**
   * 功能访问上下文（函数权限守卫的单一取数口，主 PRD §9.6 守卫链：
   * 系统可用性 → 功能权限 → 粗粒度数据范围）。
   *
   * @param userId 员工账号 id
   * @param functionCode 路由声明的稳定功能编码
   * @returns 访问上下文：
   *   - registered：功能是否仍注册于目录（false = 路由声明了不存在的编码，代码/部署缺陷）；
   *   - systemOpen：所属系统 product_status 是否为 OPEN（base/backstage 恒 OPEN；
   *     未开放系统对所有人（含超管）不可进入，base PRD §5 入口可见≠可进入）；
   *   - allowed：是否放行（超管豁免；目录外功能授权不生效）；
   *   - dataScope：有效数据范围（多档位授权按最宽合并，公司 > 部门 > 本人）；
   *     null = 不受数据范围限制（超管豁免，仅针对访问控制）
   */
  async getFunctionAccess(
    userId: number,
    functionCode: string,
  ): Promise<{
    registered: boolean;
    systemCode: string | null;
    systemName: string | null;
    systemOpen: boolean;
    allowed: boolean;
    dataScope: DataScope | null;
  }> {
    const fn = await this.prisma.client.function.findUnique({
      where: { code: functionCode },
      select: {
        system: { select: { code: true, name: true, productStatus: true } },
      },
    });
    if (!fn) {
      return { registered: false, systemCode: null, systemName: null, systemOpen: false, allowed: false, dataScope: null };
    }
    const base = {
      registered: true,
      systemCode: fn.system.code,
      systemName: fn.system.name,
      systemOpen: fn.system.productStatus === 'OPEN',
    };
    const context = await this.loadAuthContext(userId);
    if (context.isSuperAdmin) {
      return { ...base, allowed: true, dataScope: null };
    }
    const matched = context.grants.filter((grant) => grant.functionCode === functionCode);
    if (matched.length === 0) {
      return { ...base, allowed: false, dataScope: null };
    }
    return { ...base, allowed: true, dataScope: widestScope(matched.map((grant) => grant.dataScope)) };
  }

  /**
   * 主动失效某用户的授权上下文缓存（提权/撤权后可选加速；正确性仍依赖版本比对）。
   *
   * @param userId 员工账号 id
   */
  async invalidateAuthContext(userId: number): Promise<void> {
    if (!this.redis || this.redis.status !== 'ready') {
      return;
    }
    try {
      await this.redis.del(redisKey(REDIS_NAMESPACE.AUTH, 'context', userId));
    } catch (error) {
      this.logger.warn(
        `失效授权上下文缓存失败 userId=${userId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * 加载授权上下文：版本一致时复用 Redis 快照，否则重建并写回。
   *
   * @param userId 员工账号 id
   * @returns 授权上下文快照
   */
  private async loadAuthContext(userId: number): Promise<AuthContextSnapshot> {
    const { versions, cacheable } = await this.readAuthVersions(userId);
    if (cacheable) {
      const cached = await this.readAuthContextCache(userId);
      if (
        cached &&
        cached.pv === versions.pv &&
        cached.ov === versions.ov &&
        cached.otv === versions.otv &&
        cached.dv === versions.dv
      ) {
        return cached;
      }
    }
    const rebuilt = await this.rebuildAuthContext(userId, versions);
    if (cacheable) {
      await this.writeAuthContextCache(userId, rebuilt);
    }
    return rebuilt;
  }

  /**
   * 读取四版本当前值（账号授权 / 组织 / 目录）。
   *
   * @param userId 员工账号 id
   * @returns 四版本与可缓存标识；账号不存在时 pv=0，组织版本源不可读时禁用缓存
   */
  private async readAuthVersions(userId: number): Promise<AuthVersionReadResult> {
    const [user, catalogMeta, orgVersions] = await Promise.all([
      this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { permissionVersion: true, deletedAt: true },
      }),
      this.prisma.client.permissionCatalogMeta.findUnique({
        where: { id: 1 },
        select: { catalogVersion: true },
      }),
      this.readOrgVersions(),
    ]);
    return {
      versions: {
        pv: user && user.deletedAt === null ? user.permissionVersion : 0,
        ov: orgVersions.ov,
        otv: orgVersions.otv,
        dv: catalogMeta?.catalogVersion ?? 0,
      },
      cacheable: orgVersions.available,
    };
  }

  /**
   * 经 hr.org_version 只读视图读取组织版本（主 PRD §9.4 跨 schema）。
   *
   * @returns 用户组织版本、组织树版本与是否可可靠读取
   */
  private async readOrgVersions(): Promise<{ ov: number; otv: number; available: boolean }> {
    try {
      const rows = await this.prisma.client.$queryRaw<Array<{ user_org_version: number; org_tree_version: number }>>`
        SELECT user_org_version, org_tree_version FROM hr.org_version LIMIT 1
      `;
      const row = rows[0];
      if (!row) {
        return { ov: 0, otv: 0, available: true };
      }
      return {
        ov: Number(row.user_org_version) || 0,
        otv: Number(row.org_tree_version) || 0,
        available: true,
      };
    } catch (error) {
      this.logger.warn(
        '读取 hr.org_version 失败，本次授权上下文回退实时读库且不复用缓存',
        error instanceof Error ? error.message : String(error),
      );
      return { ov: 0, otv: 0, available: false };
    }
  }

  /**
   * 从数据库重建授权上下文（目录过滤后的有效授权）。
   *
   * @param userId 员工账号 id
   * @param versions 已读取的四版本
   * @returns 完整快照
   */
  private async rebuildAuthContext(userId: number, versions: AuthVersions): Promise<AuthContextSnapshot> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null) {
      return { ...versions, isSuperAdmin: false, grants: [] };
    }
    if (user.isSuperAdmin) {
      return { ...versions, isSuperAdmin: true, grants: [] };
    }
    const rows = await this.prisma.client.employeeGrant.findMany({
      where: { userId },
      select: { functionCode: true, dataScope: true },
    });
    if (rows.length === 0) {
      return { ...versions, isSuperAdmin: false, grants: [] };
    }
    const registered = await this.registeredFunctionCodes(rows.map((row) => row.functionCode));
    return {
      ...versions,
      isSuperAdmin: false,
      grants: rows.filter((row) => registered.has(row.functionCode)),
    };
  }

  /** 读取 Redis 授权上下文缓存；故障时返回 null（回退读库） */
  private async readAuthContextCache(userId: number): Promise<AuthContextSnapshot | null> {
    if (!this.redis || this.redis.status !== 'ready') {
      return null;
    }
    try {
      const raw = await this.redis.get(redisKey(REDIS_NAMESPACE.AUTH, 'context', userId));
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as AuthContextSnapshot;
    } catch (error) {
      this.logger.warn(
        `读取授权上下文缓存失败 userId=${userId}`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /** 写入 Redis 授权上下文缓存；故障仅记日志不抛错 */
  private async writeAuthContextCache(userId: number, snapshot: AuthContextSnapshot): Promise<void> {
    if (!this.redis || this.redis.status !== 'ready') {
      return;
    }
    try {
      await this.redis.set(
        redisKey(REDIS_NAMESPACE.AUTH, 'context', userId),
        JSON.stringify(snapshot),
        'EX',
        AUTH_CONTEXT_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `写入授权上下文缓存失败 userId=${userId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * 过滤出目录中仍注册的功能编码（生效判断以目录存在为准）。
   *
   * @param codes 待过滤功能编码
   * @returns 仍注册的编码集合
   */
  private async registeredFunctionCodes(codes: readonly string[]): Promise<Set<string>> {
    const functions = await this.prisma.client.function.findMany({
      where: { code: { in: [...new Set(codes)] } },
      select: { code: true },
    });
    return new Set(functions.map((row) => row.code));
  }
}
