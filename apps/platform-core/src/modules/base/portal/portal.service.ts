import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ApprovalCenterService } from '../approval-proxy/approval-center.service';
import { PendingBadgeClient } from './pending-badge.client';

/**
 * 统一门户（base PRD §5）。
 *
 * - 系统入口可见规则：当前用户拥有该系统至少一项功能授权；超级管理员视为拥有全部；
 * - 公告：仅展示当前唯一"正在展示"（PUBLISHING）的系统公告；
 * - 待办角标：本地 backstage 可见待办 + hr/asset 内部 pending-count 之和。
 */
@Injectable()
export class PortalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly approvalCenter: ApprovalCenterService,
    private readonly pendingBadge: PendingBadgeClient,
  ) {}

  /** 门户数据：系统入口 + 当前公告 + 待办角标（按系统拆分，M24） */
  async getPortal(userId: number, isSuperAdmin: boolean): Promise<{
    systems: Array<{ code: string; name: string; productStatus: 'OPEN' | 'COMING_SOON'; hasPermission: boolean; entryUrl: string }>;
    announcement: { title: string; content: string | null; publishedAt: Date | null } | null;
    badgeBySystem: Record<string, number>;
  }> {
    const [systems, announcement, localPending, remotePending] = await Promise.all([
      this.prisma.client.system.findMany({
        orderBy: { sort: 'asc' },
        select: { id: true, code: true, name: true, productStatus: true },
      }),
      this.prisma.client.announcement.findFirst({
        where: { status: 'PUBLISHING', deletedAt: null },
        orderBy: { publishedAt: 'desc' },
        select: { title: true, content: true, publishedAt: true },
      }),
      this.countLocalPending(userId, isSuperAdmin),
      this.pendingBadge.fetchRemotePendingBySystem(userId),
    ]);

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
      // 按系统角标（base PRD §5：系统入口展示各自待处理数量；fin 无审批待办恒 0）
      badgeBySystem: {
        BACKSTAGE: localPending,
        HR: remotePending.HR,
        ASSET: remotePending.ASSET,
        FIN: 0,
      },
    };
  }

  /**
   * 本地 backstage 待办：持有 user_manage 或超管才计入资料修改 PENDING。
   *
   * @param userId 用户
   * @param isSuperAdmin 是否超管
   * @returns 本地待办数
   */
  private async countLocalPending(userId: number, isSuperAdmin: boolean): Promise<number> {
    if (!isSuperAdmin) {
      const grant = await this.prisma.client.employeeGrant.findFirst({
        where: { userId, functionCode: 'user_manage' },
        select: { id: true },
      });
      if (!grant) {
        return 0;
      }
    }
    const { total } = await this.approvalCenter.pendingCount();
    return total;
  }
}
