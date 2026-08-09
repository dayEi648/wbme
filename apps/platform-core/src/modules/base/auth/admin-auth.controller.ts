import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { IdempotentDto, USER_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { FunctionPermissionGuard, RequireFunction } from '../../backstage/permission/function-permission.guard';
import { LoginProtectionService } from '../login-protection/login-protection.service';
import { AdminInvitationService } from './admin-invitation.service';

/**
 * 管理后台认证操作（backstage PRD §3 联动）：
 * M1 生成激活邀请、M2 生成重置邀请、M4 解锁账号。
 * 权限："用户管理"功能（函数权限守卫：超管豁免 + 目录存在性过滤）。
 */
@ApiTags('用户管理')
@Controller('users')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(USER_MANAGE_FUNCTION_CODE)
export class AdminAuthController {
  constructor(
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
    return this.invitations.issueActivationInvitation(operatorId, targetUserId);
  }

  /** M2 生成钉钉验证式密码重置邀请（仅 ACTIVE；超管目标仅另一超管或本人钉钉验证） */
  @Post(':id/password-reset-invitations')
  async issuePasswordResetInvitation(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() _dto: IdempotentDto,
  ): Promise<{ resetUrl: string }> {
    return this.invitations.issueResetInvitation(operatorId, targetUserId);
  }

  /** M4 解锁账号（幂等：未锁定也成功） */
  @Post(':id/unlock')
  async unlock(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() _dto: IdempotentDto,
  ): Promise<{ ok: true }> {
    await this.protection.unlockByAdmin(targetUserId, operatorId);
    return { ok: true };
  }
}
