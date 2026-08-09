import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors, maskPhone, normalizePhoneFromParts } from '@wbme/contracts';
import { PrismaService } from '../../../../prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { SecurityLogService } from '../../security-log/security-log.service';
import { PasswordService } from '../password.service';
import { TokenService } from '../token.service';
import { AuthService, type LoginResult } from '../auth.service';
import { FlowSessionService } from './flow-session.service';

/**
 * 激活流程（base PRD §2）。
 *
 * - A6 redeem：一次性凭证（URL fragment → body）兑换 → 校验邀请有效 →
 *   发 Path 限定的一次性流程 Cookie（激活后续步骤不再携带原始凭证）；
 * - A7 confirm：姓名/性别/密码 + 钉钉授权身份 → 同一事务：
 *   绑定钉钉 + 手机号改为钉钉返回 + 写密码 + ACTIVE + 邀请标记 USED；
 *   身份要素 = 钉钉稳定标识 + 一次性邀请，不要求与创建时预留手机号一致；
 * - 邀请无效/过期/已使用/账号已激活/手机号被占用/unionId 已绑定时拒绝。
 */
@Injectable()
export class ActivationFlow {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly token: TokenService,
    private readonly flows: FlowSessionService,
    private readonly password: PasswordService,
    private readonly settings: SettingsService,
    private readonly securityLog: SecurityLogService,
    private readonly auth: AuthService,
  ) {}

  /** A6 兑换：凭证 → 校验邀请，返回目标用户（手机号为激活前联系参考） */
  async redeem(rawToken: string): Promise<{ userId: number; name: string; phoneMasked: string; tokenHash: string }> {
    const tokenHash = this.token.hash(rawToken);
    const invitation = await this.prisma.client.activationInvitation.findFirst({
      where: { tokenHash, status: 'VALID' },
      select: { id: true, userId: true, expiresAt: true },
    });
    if (!invitation) {
      throw new BusinessException(accountErrors.INVITATION_INVALID);
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new BusinessException(accountErrors.INVITATION_INVALID);
    }
    const user = await this.prisma.client.user.findUnique({
      where: { id: invitation.userId },
      select: { id: true, name: true, phone: true, status: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null || user.status !== 'PENDING_ACTIVATION') {
      throw new BusinessException(accountErrors.ACCOUNT_ACTIVATED);
    }
    return { userId: user.id, name: user.name, phoneMasked: maskPhone(user.phone), tokenHash };
  }

  /** A7 确认：绑定钉钉 + 手机号 + 密码 + ACTIVE（单事务原子完成，完成后自动登录） */
  async confirm(
    flowId: string,
    input: { unionId: string; mobile: string; stateCode: string; name: string; gender: 'MALE' | 'FEMALE'; password: string },
    ip: string,
  ): Promise<LoginResult> {
    try {
      return await this.confirmInner(flowId, input, ip);
    } catch (error) {
      // 确认失败同样即删流程会话（base PRD §7.3：一次性，成功后或失败即删）
      await this.flows.consume(flowId).catch(() => undefined);
      throw error;
    }
  }

  /** A7 主体逻辑（失败路径由外层 confirm 统一消费流程会话） */
  private async confirmInner(
    flowId: string,
    input: { unionId: string; mobile: string; stateCode: string; name: string; gender: 'MALE' | 'FEMALE'; password: string },
    ip: string,
  ): Promise<LoginResult> {
    const flow = await this.flows.assert(flowId, 'ACTIVATION');
    if (!flow.unionId || flow.unionId !== input.unionId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    if (!this.password.validatePolicy(input.password)) {
      throw new BusinessException(accountErrors.PASSWORD_POLICY_FAILED);
    }
    const phone = normalizePhoneFromParts(input.stateCode, input.mobile);
    if (!phone) {
      throw new BusinessException(accountErrors.PHONE_MISSING_FROM_DINGTALK);
    }

    const passwordHash = await this.password.hash(input.password);
    const result = await this.prisma.client.$transaction(async (tx) => {
      // 目标账号仍待激活（并发/已激活兜底）
      const user = await tx.user.findUnique({
        where: { id: flow.userId ?? -1 },
        select: { id: true, phone: true, status: true },
      });
      if (!user || user.status !== 'PENDING_ACTIVATION') {
        throw new BusinessException(accountErrors.ACCOUNT_ACTIVATED);
      }
      // 钉钉稳定标识未绑定任何账号（含并发兜底）
      const bound = await tx.dingtalkBinding.findFirst({
        where: { dingtalkUnionId: input.unionId },
        select: { id: true },
      });
      if (bound) {
        throw new BusinessException(accountErrors.DINGTALK_ALREADY_BOUND);
      }
      // 手机号未被其他"待激活/正常"账号占用（硬性校验：占用即拒绝激活）
      const occupied = await tx.user.findFirst({
        where: { phone, id: { not: user.id }, deletedAt: null, status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] } },
        select: { id: true },
      });
      if (occupied) {
        throw new BusinessException(accountErrors.PHONE_TAKEN);
      }

      // 邀请再校验（事务内，条件更新防并发重复使用；按兑换时的凭证摘要精确限定）
      const invitation = await tx.activationInvitation.updateMany({
        where: {
          userId: user.id,
          tokenHash: flow.tokenHash,
          status: 'VALID',
          expiresAt: { gt: new Date() },
        },
        data: { status: 'USED', usedAt: new Date() },
      });
      if (invitation.count === 0) {
        throw new BusinessException(accountErrors.INVITATION_INVALID);
      }

      // 同一事务：账号生效 + 绑定钉钉 + 手机号更新 + 写密码
      await tx.user.update({
        where: { id: user.id },
        data: { name: input.name, gender: input.gender, phone, passwordHash, status: 'ACTIVE' },
      });
      await tx.dingtalkBinding.create({
        data: { userId: user.id, dingtalkUnionId: input.unionId, status: 'BOUND' },
      });
      return user;
    });

    await this.flows.consume(flowId);
    await this.securityLog.record('INVITATION_USED', 'SUCCESS', {
      targetUserId: result.id,
      sourceIp: ip,
    });
    await this.securityLog.record('ACCOUNT_ACTIVATED', 'SUCCESS', {
      actorId: result.id,
      context: { phoneBefore: maskPhone(result.phone), phoneAfter: maskPhone(phone) },
      sourceIp: ip,
    });
    await this.securityLog.record('PHONE_SYNCED', 'SUCCESS', {
      targetUserId: result.id,
      reason: '激活时按钉钉返回设置手机号',
      context: { fromMasked: maskPhone(result.phone), toMasked: maskPhone(phone) },
      sourceIp: ip,
    });
    return this.auth.createUserSession(result.id, false, ip);
  }
}
