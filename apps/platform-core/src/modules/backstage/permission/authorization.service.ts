import { Inject, Injectable } from '@nestjs/common';
import type { DataScope } from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';

/** 一条有效功能授权（功能编码 + 数据范围） */
export interface EffectiveGrant {
  functionCode: string;
  dataScope: DataScope;
}

/**
 * 授权查询服务（主 PRD §3.1；实现规划 T3-2 建立、T3-4 推广为全站守卫与数据范围）。
 *
 * - 读取 employee_grants 并以「目录中存在」过滤：启动对账移除功能后，其历史授权行
 *   保留为审计数据但不得继续生效（主 PRD §3.1），本服务是唯一生效判断口径；
 * - 超级管理员豁免：不受任何功能授权约束，视为拥有全部功能（无需展开授权行）。
 */
@Injectable()
export class AuthorizationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 查询员工当前有效授权（目录过滤后）。
   *
   * @param userId 员工账号 id
   * @returns 站点角色与有效授权列表；账号不存在/已注销返回空授权与非超管
   */
  async getEffectiveGrants(userId: number): Promise<{ isSuperAdmin: boolean; grants: EffectiveGrant[] }> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null) {
      return { isSuperAdmin: false, grants: [] };
    }
    const rows = await this.prisma.client.employeeGrant.findMany({
      where: { userId },
      select: { functionCode: true, dataScope: true },
    });
    if (rows.length === 0) {
      return { isSuperAdmin: user.isSuperAdmin, grants: [] };
    }
    const registered = await this.registeredFunctionCodes(rows.map((row) => row.functionCode));
    return {
      isSuperAdmin: user.isSuperAdmin,
      grants: rows.filter((row) => registered.has(row.functionCode)),
    };
  }

  /**
   * 校验员工是否持有指定功能的有效授权（超管豁免；目录外功能授权不生效）。
   *
   * @param userId 员工账号 id
   * @param functionCode 稳定功能编码
   * @returns 持有（或超管）返回 true
   */
  async hasFunction(userId: number, functionCode: string): Promise<boolean> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null) {
      return false;
    }
    if (user.isSuperAdmin) {
      return true;
    }
    const grant = await this.prisma.client.employeeGrant.findFirst({
      where: { userId, functionCode },
      select: { id: true },
    });
    if (!grant) {
      return false;
    }
    const registered = await this.registeredFunctionCodes([functionCode]);
    return registered.has(functionCode);
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
