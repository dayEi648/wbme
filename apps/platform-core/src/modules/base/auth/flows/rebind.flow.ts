import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors, maskPhone } from '@wbme/contracts';
import { PrismaService } from '../../../../prisma.service';
import { SecurityLogService } from '../../security-log/security-log.service';
import { PhoneSyncService } from '../phone-sync.service';
import { FlowSessionService } from './flow-session.service';

/**
 * 钉钉换绑（base PRD §2、backstage PRD §3 联动，T2-5）。
 *
 * - 自助换绑（A12）：验证当前钉钉身份或平台密码 + 新钉钉授权；超管代发一次性换绑邀请（M3）；
 * - 新身份必须属本公司组织且尚未绑定其它账号；换绑完成事务原子替换
 *   （新行 BOUND + 旧行 UNBOUND），手机号同一事务按同步规则更新
 *   （新号码被占用则拒绝换绑）；成功后该用户全部会话失效；
 * - 旧绑定在新身份全部校验通过前继续有效；发起/失败/成功全部写安全日志。
 */
@Injectable()
export class RebindFlow {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly flows: FlowSessionService,
    private readonly phoneSync: PhoneSyncService,
    private readonly securityLog: SecurityLogService,
  ) {}

  /** 换绑凭证兑换（M3 端点：账号必须 ACTIVE 且有有效绑定） */
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
    const binding = await this.prisma.client.dingtalkBinding.findFirst({
      where: { userId: user.id, status: 'BOUND' },
      select: { id: true },
    });
    if (!binding) {
      throw new BusinessException(accountErrors.BINDING_NOT_FOUND);
    }
    return { userId: user.id, name: user.name };
  }

  /** 换绑确认（A11）：新钉钉身份原子替换旧绑定 + 手机号同步 + 全会话失效 */
  async confirm(
    flowId: string,
    input: { unionId: string; mobile: string; stateCode: string },
    ip: string,
  ): Promise<void> {
    const flow = await this.flows.assert(flowId, 'REBIND');
    if (!flow.userId || !flow.unionId || flow.unionId !== input.unionId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    const userId = flow.userId;

    try {
      await this.doConfirm(userId, input, ip);
    } catch (error) {
      // 换绑失败：安全日志（backstage PRD §8 发起/失败/成功全部记录）
      await this.securityLog.record('BINDING_CHANGED_FAILED', 'FAILURE', {
        targetUserId: userId,
        reason: error instanceof BusinessException ? error.entry.code : 'SYSTEM',
        sourceIp: ip,
      });
      throw error;
    }
    await this.flows.consume(flowId);
    await this.securityLog.record('INVITATION_USED', 'SUCCESS', {
      targetUserId: userId,
      sourceIp: ip,
    });
    await this.securityLog.record('BINDING_CHANGED_COMPLETED', 'SUCCESS', {
      targetUserId: userId,
      context: { phoneMasked: maskPhone(`+${input.stateCode || '86'}${input.mobile}`) },
      sourceIp: ip,
    });
  }

  /** 换绑确认事务主体（失败由 confirm 记录 BINDING_CHANGED_FAILED 后上抛） */
  private async doConfirm(
    userId: number,
    input: { unionId: string; mobile: string; stateCode: string },
    ip: string,
  ): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      // 新钉钉身份未绑定任何账号（并发兜底）
      const bound = await tx.dingtalkBinding.findFirst({
        where: { dingtalkUnionId: input.unionId },
        select: { id: true },
      });
      if (bound) {
        throw new BusinessException(accountErrors.DINGTALK_ALREADY_BOUND);
      }
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, status: true, sessionVersion: true },
      });
      if (!user || user.status !== 'ACTIVE') {
        throw new BusinessException(accountErrors.USER_NOT_ACTIVE);
      }
      // 原子替换：旧绑定 UNBOUND（保留历史），新绑定 BOUND
      await tx.dingtalkBinding.updateMany({
        where: { userId, status: 'BOUND' },
        data: { status: 'UNBOUND', unboundAt: new Date() },
      });
      await tx.dingtalkBinding.create({
        data: { userId, dingtalkUnionId: input.unionId, status: 'BOUND' },
      });
      // 手机号同步：换绑时新号码被占用必须拒绝（不是跳过）
      const sync = await this.phoneSync.syncFromDingtalk(tx, userId, input.stateCode, input.mobile, ip);
      if (sync.outcome === 'skipped_conflict') {
        throw new BusinessException(accountErrors.PHONE_TAKEN);
      }
      // session_version 递增：换绑成功后全部会话失效
      await tx.user.update({
        where: { id: userId },
        data: { sessionVersion: { increment: 1 } },
      });
    });

    await this.prisma.client.activationInvitation.updateMany({
      where: { userId, status: 'VALID' },
      data: { status: 'USED', usedAt: new Date() },
    });
  }
}
