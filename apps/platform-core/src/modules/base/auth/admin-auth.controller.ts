import { Body, Controller, Inject, Param, ParseIntPipe, Post } from '@nestjs/common';
import { BusinessException, frameworkErrors, IdempotentDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
import { LoginProtectionService } from '../login-protection/login-protection.service';
import { AdminInvitationService } from './admin-invitation.service';

/**
 * 管理后台认证操作（backstage PRD §3 联动）：
 * M1 生成激活邀请、M2 生成重置邀请、M4 解锁账号（权限"用户管理"，T3-5 完整权限守卫接入前的最小校验：
 * 超管或持有 user_manage 授权）。
 */
@Controller('users')
export class AdminAuthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly protection: LoginProtectionService,
    private readonly invitations: AdminInvitationService,
  ) {}

  /** M1 生成/重新生成激活邀请（仅待激活；重新生成旧邀请失效）；返回链接与二维码（同一凭证） */
  @Post(':id/activation-invitations')
  async issueActivationInvitation(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() _dto: IdempotentDto,
  ): Promise<{ activationUrl: string; activationQr: string }> {
    await this.assertUserManage(operatorId);
    return this.invitations.issueActivationInvitation(operatorId, targetUserId);
  }

  /** M2 生成钉钉验证式密码重置邀请（仅 ACTIVE；超管目标仅另一超管或本人钉钉验证） */
  @Post(':id/password-reset-invitations')
  async issuePasswordResetInvitation(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() _dto: IdempotentDto,
  ): Promise<{ resetUrl: string }> {
    await this.assertUserManage(operatorId);
    return this.invitations.issueResetInvitation(operatorId, targetUserId);
  }

  /** M4 解锁账号（幂等：未锁定也成功） */
  @Post(':id/unlock')
  async unlock(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() _dto: IdempotentDto,
  ): Promise<{ ok: true }> {
    await this.assertUserManage(operatorId);
    await this.protection.unlockByAdmin(targetUserId, operatorId);
    return { ok: true };
  }

  /** 最小"用户管理"授权校验（T3-5 完整权限守卫接管） */
  private async assertUserManage(operatorId: number): Promise<void> {
    const operator = await this.prisma.client.user.findUnique({
      where: { id: operatorId },
      select: { isSuperAdmin: true },
    });
    if (!operator) {
      throw new BusinessException(frameworkErrors.UNAUTHORIZED);
    }
    if (operator.isSuperAdmin) {
      return;
    }
    const grant = await this.prisma.client.employeeGrant.findFirst({
      where: { userId: operatorId, functionCode: 'user_manage' },
      select: { id: true },
    });
    if (!grant) {
      throw new BusinessException(frameworkErrors.FORBIDDEN);
    }
  }

}
