import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors, maskPhone, normalizePhoneFromParts, normalizePhoneInput } from '@wbme/contracts';
import { PrismaService } from '../../../../prisma.service';
import { SecurityLogService } from '../../security-log/security-log.service';
import { PasswordService } from '../password.service';
import { PhoneSyncService } from '../phone-sync.service';
import { FlowSessionService } from './flow-session.service';

/**
 * 钉钉验证式密码重置（base PRD §2、backstage PRD §3 联动）。
 *
 * - 管理员发起限时一次性重置凭证（M2，不能查看/设置新密码）→ 目标员工钉钉授权
 *   （unionId 与账号现有绑定一致 + 组织成员）→ 短时重置流程会话 → 设新密码；
 * - 重置完成前旧密码与旧会话保持有效，完成事务提交后统一失效
 *   （session_version 递增，base PRD §2/§3）；
 * - 完成时按手机号同步规则更新手机号（被占用则跳过同步，重置本身不受影响）。
 */
@Injectable()
export class ResetFlow {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly flows: FlowSessionService,
    private readonly password: PasswordService,
    private readonly phoneSync: PhoneSyncService,
    private readonly securityLog: SecurityLogService,
  ) {}

  /**
   * 自助重置发起（A10'，base PRD §2）：已绑定钉钉的账号凭手机号发起。
   * 账号不存在/未绑定统一提示 RESET_SELF_UNAVAILABLE（不泄露手机号是否注册）。
   * 不校验手机号与绑定手机号一致（手机号以钉钉授权为准，见 §2 自动同步规则）。
   */
  async initiateByPhone(phone: string, ip: string): Promise<{ userId: number; name: string }> {
    const normalized = normalizePhoneInput(phone);
    if (!normalized) {
      throw new BusinessException(accountErrors.RESET_SELF_UNAVAILABLE);
    }
    const user = await this.prisma.client.user.findFirst({
      where: { phone: normalized, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    const binding = user
      ? await this.prisma.client.dingtalkBinding.findFirst({ where: { userId: user.id, status: 'BOUND' }, select: { id: true } })
      : null;
    if (!user || !binding) {
      throw new BusinessException(accountErrors.RESET_SELF_UNAVAILABLE);
    }
    // 自助发起与管理员发起同属"密码重置发起"事件（backstage PRD §8）
    await this.securityLog.record('PASSWORD_RESET_ISSUED', 'SUCCESS', {
      targetUserId: user.id,
      reason: '自助发起（钉钉验证式）',
      sourceIp: ip,
    });
    return { userId: user.id, name: user.name };
  }

  /** 重置凭证兑换（M2 端点：账号必须为 ACTIVE；失败/过期/已使用不得重放） */
  async redeem(rawToken: string, tokenHash: string): Promise<{ userId: number; name: string }> {
    const invitation = await this.prisma.client.activationInvitation.findFirst({
      where: { tokenHash, status: 'VALID' },
      select: { userId: true, expiresAt: true },
    });
    if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
      throw new BusinessException(accountErrors.INVITATION_INVALID);
    }
    const user = await this.prisma.client.user.findUnique({
      where: { id: invitation.userId },
      select: { id: true, name: true, status: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null || user.status !== 'ACTIVE') {
      throw new BusinessException(accountErrors.USER_NOT_ACTIVE);
    }
    return { userId: user.id, name: user.name };
  }

  /** 重置确认（A10）：unionId 与账号现有绑定一致 → 设新密码 + 手机号同步 + 全会话失效 */
  async confirm(
    flowId: string,
    input: { unionId: string; mobile: string; stateCode: string; newPassword: string },
    ip: string,
  ): Promise<void> {
    const flow = await this.flows.assert(flowId, 'RESET');
    if (!flow.userId || !flow.unionId || flow.unionId !== input.unionId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    const userId = flow.userId;
    if (!this.password.validatePolicy(input.newPassword)) {
      throw new BusinessException(accountErrors.PASSWORD_POLICY_FAILED);
    }
    const newHash = await this.password.hash(input.newPassword);

    await this.prisma.client.$transaction(async (tx) => {
      // 邀请一次性校验（事务内条件更新，与激活流程一致，base PRD §2）：
      // 仅管理员凭证路径（流程会话携带 tokenHash）消费邀请；仅 VALID 且未过期可消费，
      // 并发/已使用/被作废（REVOKED）/过期均拒绝，防并发重放。
      // 自助路径（A10' initiate 签发，无 tokenHash）不消费任何邀请——
      // 以免误消费账号现有 VALID 邀请，身份准入以发起时校验 + 钉钉验证为准。
      if (flow.tokenHash) {
        const invitation = await tx.activationInvitation.updateMany({
          where: { userId: flow.userId, tokenHash: flow.tokenHash, status: 'VALID', expiresAt: { gt: new Date() } },
          data: { status: 'USED', usedAt: new Date() },
        });
        if (invitation.count === 0) {
          throw new BusinessException(accountErrors.INVITATION_INVALID);
        }
      }
      // 绑定一致性：钉钉身份必须是该账号当前有效绑定（base PRD §2）
      const binding = await tx.dingtalkBinding.findFirst({
        where: { userId, dingtalkUnionId: input.unionId, status: 'BOUND' },
        select: { id: true },
      });
      if (!binding) {
        throw new BusinessException(accountErrors.DINGTALK_ORG_MISMATCH);
      }
      const user = await tx.user.findUnique({ where: { id: userId }, select: { sessionVersion: true, status: true } });
      if (!user || user.status !== 'ACTIVE') {
        throw new BusinessException(accountErrors.USER_NOT_ACTIVE);
      }
      // 写新密码 + session_version 递增（旧会话全部失效）
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: newHash, sessionVersion: { increment: 1 } },
      });
      // 手机号同步（被占用则跳过，重置不受影响；base PRD §2）
      await this.phoneSync.syncFromDingtalk(tx, userId, input.stateCode, input.mobile, ip);
    });

    await this.flows.consume(flowId);
    if (flow.tokenHash) {
      await this.securityLog.record('INVITATION_USED', 'SUCCESS', {
        targetUserId: flow.userId,
        sourceIp: ip,
      });
    }
    const normalizedPhone = normalizePhoneFromParts(input.stateCode, input.mobile);
    await this.securityLog.record('PASSWORD_RESET_COMPLETED', 'SUCCESS', {
      targetUserId: flow.userId,
      context: normalizedPhone ? { phoneMasked: maskPhone(normalizedPhone) } : undefined,
      sourceIp: ip,
    });
  }
}
