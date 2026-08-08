import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

/**
 * 统一门户（base PRD §5，T2-6）。
 *
 * - 系统入口可见规则：当前用户拥有该系统至少一项功能授权；超级管理员视为拥有全部；
 *   "即将上线"的系统展示状态但不可进入（入口可见 ≠ 可进入）；
 * - 公告：仅展示当前唯一"正在展示"（PUBLISHING）的系统公告，无则 null；
 *   不展示历史已撤回公告或更新日志；
 * - 待办角标：本期恒为 0（依赖各系统审批统计契约，T5/6/7 联调后接入）。
 */

@Injectable()
export class PortalService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 门户数据：系统入口 + 当前公告 + 待办角标 */
  async getPortal(userId: number, isSuperAdmin: boolean): Promise<{
    systems: Array<{ code: string; name: string; productStatus: 'OPEN' | 'COMING_SOON'; hasPermission: boolean; entryUrl: string }>;
    announcement: { title: string; content: string | null; publishedAt: Date | null } | null;
    badgeCount: number;
  }> {
    const [systems, announcement] = await Promise.all([
      this.prisma.client.system.findMany({
        orderBy: { sort: 'asc' },
        select: { id: true, code: true, name: true, productStatus: true },
      }),
      this.prisma.client.announcement.findFirst({
        where: { status: 'PUBLISHING', deletedAt: null },
        orderBy: { publishedAt: 'desc' },
        select: { title: true, content: true, publishedAt: true },
      }),
    ]);

    // 员工按授权推导入口：拥有该系统至少一项功能（经 functions 目录关联系统）
    let grantedSystemIds = new Set<number>();
    if (!isSuperAdmin) {
      const grants = await this.prisma.client.employeeGrant.findMany({
        where: { userId },
        select: { functionCode: true },
      });
      if (grants.length > 0) {
        const functions = await this.prisma.client.function.findMany({
          where: { code: { in: grants.map((g) => g.functionCode) } },
          select: { systemId: true },
        });
        grantedSystemIds = new Set(functions.map((f) => f.systemId));
      }
    }

    const entryBySystem: Record<string, string> = {
      BACKSTAGE: '/backstage',
      ASSET: '/asset',
      HR: '/hr',
      FIN: '/fin',
    };

    return {
      systems: systems.map((system) => ({
        code: system.code,
        name: system.name,
        productStatus: system.productStatus,
        hasPermission: isSuperAdmin || grantedSystemIds.has(system.id),
        entryUrl: entryBySystem[system.code] ?? `/${system.code.toLowerCase()}`,
      })),
      announcement: announcement
        ? { title: announcement.title, content: announcement.content, publishedAt: announcement.publishedAt }
        : null,
      badgeCount: 0,
    };
  }
}
