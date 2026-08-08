import { Body, Controller, Inject, Param, ParseIntPipe, Post } from '@nestjs/common';
import { BusinessException, frameworkErrors, IdempotentDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
import { LoginProtectionService } from '../login-protection/login-protection.service';
import { AdminInvitationService } from './admin-invitation.service';

/**
 * 管理后台认证操作（backstage PRD §3 联动）：
 * M1 生成激活邀请、M4 解锁账号（权限"用户管理"，T3-5 完整权限守卫接入前的最小校验：
 * 超管或持有 user_manage 授权）。
 */
@Controller('users')
export class AdminAuthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly protection: LoginProtectionService,
    private readonly invitations: AdminInvitationService,
  ) {}

  /** M1 生成/重新生成激活邀请（仅待激活；重新生成旧邀请失效） */
  @Post(':id/activation-invitations')
  async issueActivationInvitation(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() _dto: IdempotentDto,
  ): Promise<{ activationUrl: string }> {
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

  /** M3 生成换绑邀请（仅超管；目标账号 ACTIVE 且有有效绑定） */
  @Post(':id/rebind-invitations')
  async issueRebindInvitation(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() _dto: IdempotentDto,
  ): Promise<{ rebindUrl: string }> {
    await this.assertSuperAdmin(operatorId);
    return this.invitations.issueRebindInvitation(operatorId, targetUserId);
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

  /** 仅超级管理员（M3 换绑邀请；T3 完整站点角色守卫接管） */
  private async assertSuperAdmin(operatorId: number): Promise<void> {
    const operator = await this.prisma.client.user.findUnique({
      where: { id: operatorId },
      select: { isSuperAdmin: true },
    });
    if (!operator?.isSuperAdmin) {
      throw new BusinessException(frameworkErrors.FORBIDDEN);
    }
  }
}
