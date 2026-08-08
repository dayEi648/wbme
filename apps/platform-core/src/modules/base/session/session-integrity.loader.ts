import { Inject, Injectable } from '@nestjs/common';
import type { SessionUser, SessionUserLoader } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';

/**
 * 会话用户加载器（platform-core 实现，读 base.users）。
 *
 * 会话守卫每次请求按当前账号状态与 session_version 校验：
 * 改密/重置/注销后旧会话立即失效（版本不一致），不等待会话过期（base PRD §3）。
 */
@Injectable()
export class SessionIntegrityLoader implements SessionUserLoader {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async load(userId: number): Promise<SessionUser | null> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, sessionVersion: true, isSuperAdmin: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null) {
      return null;
    }
    return {
      id: user.id,
      status: user.status,
      sessionVersion: user.sessionVersion,
      isSuperAdmin: user.isSuperAdmin,
    };
  }
}
