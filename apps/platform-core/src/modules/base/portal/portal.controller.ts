import { Controller, Get, Inject } from '@nestjs/common';
import { maskPhone } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
import { PortalService } from './portal.service';

/**
 * 统一门户（base PRD §5，T2-6）：P1 门户（系统入口 + 公告 + 待办角标）。
 */
@Controller('portal')
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** P1 门户数据（登录态） */
  @Get()
  async getPortal(@CurrentUser() userId: number): Promise<unknown> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true, name: true, phone: true },
    });
    const portal = await this.portal.getPortal(userId, user?.isSuperAdmin ?? false);
    return {
      brand: { name: 'WBME 企业管理平台' },
      user: user
        ? { id: userId, name: user.name, phoneMasked: maskPhone(user.phone) }
        : null,
      ...portal,
    };
  }
}
