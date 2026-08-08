import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors, maskPhone } from '@wbme/contracts';
import { PrismaService } from '../../../../prisma.service';
import { SecurityLogService } from '../../security-log/security-log.service';
import { PasswordService } from '../password.service';
import { PhoneSyncService } from '../phone-sync.service';
import { FlowSessionService } from './flow-session.service';

/**
 * 钉钉验证式密码重置（base PRD §2、backstage PRD §3 联动，T2-5）。
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
      throw new BusinessException(accountErrors.INVALID_CREDENTIALS);
    }
    const newHash = await this.password.hash(input.newPassword);

    await this.prisma.client.$transaction(async (tx) => {
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

    // 邀请标记 USED（一次性；仅当重置流程完成）
    await this.prisma.client.activationInvitation.updateMany({
      where: { userId: flow.userId, status: 'VALID' },
      data: { status: 'USED', usedAt: new Date() },
    });
    await this.flows.consume(flowId);
    await this.securityLog.record('INVITATION_USED', 'SUCCESS', {
      targetUserId: flow.userId,
      sourceIp: ip,
    });
    await this.securityLog.record('PASSWORD_RESET_COMPLETED', 'SUCCESS', {
      targetUserId: flow.userId,
      context: { phoneMasked: input.mobile ? maskPhone(`+${input.stateCode || '86'}${input.mobile}`) : undefined },
      sourceIp: ip,
    });
  }
}
