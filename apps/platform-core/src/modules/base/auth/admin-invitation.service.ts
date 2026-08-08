import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors, frameworkErrors, maskPhone } from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';
import { SETTING_KEYS, SettingsService } from '../settings/settings.service';
import { SecurityLogService } from '../security-log/security-log.service';
import { TokenService } from './token.service';

/**
 * 管理员邀请生成（M1/M2/M3 的凭证部分，backstage PRD §3 联动、base PRD §2）。
 *
 * - 生成一次性凭证（库中只存 SHA-256），默认 7 天有效（系统设置可调）；
 * - 重新生成会立即使旧有效邀请失效（条件更新 VALID → REVOKED）；
 * - 凭证原文只出现在返回的链接/二维码（URL fragment），不进入日志与操作日志；
 * - 邀请生成属于管理操作，同时写操作日志（CREATE，base.operation_logs）。
 */

@Injectable()
export class AdminInvitationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly token: TokenService,
    private readonly settings: SettingsService,
    private readonly securityLog: SecurityLogService,
  ) {}

  /** M1 生成激活邀请（仅待激活账号；重新生成旧邀请失效） */
  async issueActivationInvitation(adminId: number, targetUserId: number): Promise<{ activationUrl: string }> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, status: true, phone: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    if (user.status !== 'PENDING_ACTIVATION') {
      throw new BusinessException(accountErrors.USER_NOT_PENDING);
    }

    const rawToken = this.token.generate();
    const validSeconds = await this.settings.getNumber(SETTING_KEYS.INVITATION_VALID_SECONDS);
    await this.prisma.client.$transaction(async (tx) => {
      // 重新生成：旧有效邀请立即失效（条件更新，部分唯一索引 (user_id) WHERE status='VALID' 并发安全）
      await tx.activationInvitation.updateMany({
        where: { userId: targetUserId, status: 'VALID' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      await tx.activationInvitation.create({
        data: {
          userId: targetUserId,
          tokenHash: this.token.hash(rawToken),
          expiresAt: new Date(Date.now() + validSeconds * 1000),
          createdBy: adminId,
        },
      });
      // 操作日志（CREATE；管理员生成邀请）
      await tx.operationLog.create({
        data: {
          operatorId: adminId,
          system: 'BACKSTAGE',
          feature: 'user_manage',
          actionType: 'CREATE',
          summary: `为待激活账号 ${maskPhone(user.phone)} 生成激活邀请`,
        },
      });
    });

    await this.securityLog.record('INVITATION_ISSUED', 'SUCCESS', {
      actorId: adminId,
      targetUserId,
    });
    return { activationUrl: this.activationUrl(rawToken) };
  }

  /** M2 生成钉钉验证式密码重置邀请（仅 ACTIVE；与激活邀请共用凭证表，同账号同时最多一个有效凭证） */
  async issueResetInvitation(adminId: number, targetUserId: number): Promise<{ resetUrl: string }> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, status: true, phone: true, deletedAt: true, isSuperAdmin: true },
    });
    if (!user || user.deletedAt !== null) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    if (user.status !== 'ACTIVE') {
      throw new BusinessException(accountErrors.USER_NOT_ACTIVE);
    }
    // 超管账号只能由另一名超管或本人经钉钉验证重置（backstage PRD §3；T3-5 完整校验接管）
    if (user.isSuperAdmin) {
      const operator = await this.prisma.client.user.findUnique({ where: { id: adminId }, select: { isSuperAdmin: true } });
      if (!operator?.isSuperAdmin) {
        throw new BusinessException(frameworkErrors.FORBIDDEN);
      }
    }
    const resetUrl = await this.issueCredential(adminId, targetUserId, 'reset-password');
    await this.securityLog.record('PASSWORD_RESET_ISSUED', 'SUCCESS', { actorId: adminId, targetUserId });
    return { resetUrl };
  }

  /** M3 生成换绑邀请（仅超管；目标账号 ACTIVE 且有有效绑定） */
  async issueRebindInvitation(adminId: number, targetUserId: number): Promise<{ rebindUrl: string }> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null || user.status !== 'ACTIVE') {
      throw new BusinessException(accountErrors.USER_NOT_ACTIVE);
    }
    const binding = await this.prisma.client.dingtalkBinding.findFirst({
      where: { userId: targetUserId, status: 'BOUND' },
      select: { id: true },
    });
    if (!binding) {
      throw new BusinessException(accountErrors.BINDING_NOT_FOUND);
    }
    return { rebindUrl: await this.issueCredential(adminId, targetUserId, 'rebind') };
  }

  /** 通用凭证签发（激活/重置/换绑共用 activation_invitations 表；同账号同时最多一个有效凭证） */
  private async issueCredential(adminId: number, targetUserId: number, fragmentPath: string): Promise<string> {
    const rawToken = this.token.generate();
    const validSeconds = await this.settings.getNumber(SETTING_KEYS.INVITATION_VALID_SECONDS);
    await this.prisma.client.$transaction(async (tx) => {
      // 重新生成：旧有效凭证立即失效（条件更新 + 部分唯一索引并发安全）
      await tx.activationInvitation.updateMany({
        where: { userId: targetUserId, status: 'VALID' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      await tx.activationInvitation.create({
        data: {
          userId: targetUserId,
          tokenHash: this.token.hash(rawToken),
          expiresAt: new Date(Date.now() + validSeconds * 1000),
          createdBy: adminId,
        },
      });
    });
    await this.securityLog.record('INVITATION_ISSUED', 'SUCCESS', { actorId: adminId, targetUserId });
    const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173';
    return `${origin}/${fragmentPath}#${rawToken}`;
  }

  /** 激活链接：凭证放 URL fragment（base PRD §2：不得放在 path/query） */
  private activationUrl(rawToken: string): string {
    const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173';
    return `${origin}/activate#${rawToken}`;
  }
}
