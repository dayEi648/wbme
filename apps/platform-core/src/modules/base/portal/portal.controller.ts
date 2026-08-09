import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Inject } from '@nestjs/common';
import { BusinessException, frameworkErrors, maskPhone } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
import { PortalService } from './portal.service';

/**
 * 统一门户（base PRD §5）：P1 门户（系统入口 + 公告 + 待办角标）。
 */
@ApiTags('门户')
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
    // 守卫已拒绝非正常账号；此处兜底（账号被并发删除/注销时）不继续计算门户
    if (!user) {
      throw new BusinessException(frameworkErrors.UNAUTHORIZED);
    }
    const portal = await this.portal.getPortal(userId, user.isSuperAdmin);
    return {
      brand: { name: 'WBME 企业管理平台' },
      user: { id: userId, name: user.name, phoneMasked: maskPhone(user.phone) },
      ...portal,
    };
  }
}
