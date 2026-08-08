import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors, maskPhone, normalizePhoneFromParts } from '@wbme/contracts';
import { PrismaService } from '../../../../prisma.service';
import { SecurityLogService } from '../../security-log/security-log.service';
import { PasswordService } from '../password.service';
import { AuthService, type LoginResult } from '../auth.service';
import { FlowSessionService } from './flow-session.service';

/**
 * 扫码注册完善（base PRD §2，T2-2）。
 *
 * - 未绑定账号且未携带邀请的扫码 → 限时一次性注册会话 → 完善页
 *   （手机号取自钉钉授权结果只读展示，填写/确认姓名、性别并设置密码）；
 * - 确认事务：创建账号（默认普通员工、ACTIVE）+ 绑定钉钉 + 手机号 = 钉钉返回；
 * - 手机号被待激活基础账号占用 → PENDING_ACCOUNT_EXISTS（提示联系管理员）；
 *   被正常账号占用 → PHONE_TAKEN；unionId 已绑定 → DINGTALK_ALREADY_BOUND。
 */
@Injectable()
export class RegistrationFlow {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly flows: FlowSessionService,
    private readonly password: PasswordService,
    private readonly securityLog: SecurityLogService,
    private readonly auth: AuthService,
  ) {}

  /** A8 注册确认：创建账号 + 绑定 + 手机号 + 密码（单事务），完成后自动登录 */
  async confirm(
    flowId: string,
    input: { unionId: string; mobile: string; stateCode: string; name: string; gender: 'MALE' | 'FEMALE'; password: string },
    ip: string,
  ): Promise<LoginResult> {
    const flow = await this.flows.assert(flowId, 'REGISTRATION');
    if (!flow.unionId || flow.unionId !== input.unionId) {
      throw new BusinessException(accountErrors.FLOW_SESSION_INVALID);
    }
    if (!this.password.validatePolicy(input.password)) {
      throw new BusinessException(accountErrors.INVALID_CREDENTIALS);
    }
    const phone = normalizePhoneFromParts(input.stateCode, input.mobile);
    if (!phone) {
      throw new BusinessException(accountErrors.PHONE_MISSING_FROM_DINGTALK);
    }

    const passwordHash = await this.password.hash(input.password);
    const userId = await this.prisma.client.$transaction(async (tx) => {
      // 钉钉稳定标识仍未被绑定（并发兜底；注销后占用也拒绝）
      const bound = await tx.dingtalkBinding.findFirst({
        where: { dingtalkUnionId: input.unionId },
        select: { id: true },
      });
      if (bound) {
        throw new BusinessException(accountErrors.DINGTALK_ALREADY_BOUND);
      }
      // 手机号占用：待激活基础账号 / 正常账号（硬性校验）
      const occupied = await tx.user.findFirst({
        where: { phone, deletedAt: null, status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] } },
        select: { status: true },
      });
      if (occupied) {
        throw new BusinessException(
          occupied.status === 'PENDING_ACTIVATION' ? accountErrors.PENDING_ACCOUNT_EXISTS : accountErrors.PHONE_TAKEN,
        );
      }
      const created = await tx.user.create({
        data: {
          name: input.name,
          gender: input.gender,
          phone,
          passwordHash,
          status: 'ACTIVE',
        },
      });
      await tx.dingtalkBinding.create({
        data: { userId: created.id, dingtalkUnionId: input.unionId, status: 'BOUND' },
      });
      return created.id;
    });

    await this.flows.consume(flowId);
    await this.securityLog.record('ACCOUNT_ACTIVATED', 'SUCCESS', {
      actorId: userId,
      reason: '扫码注册完成',
      context: { phoneMasked: maskPhone(phone) },
      sourceIp: ip,
    });

    return this.auth.createUserSession(userId, false, ip);
  }
}
