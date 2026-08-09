import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors, frameworkErrors, maskPhone, normalizePhoneInput } from '@wbme/contracts';
import { CsrfService, SessionService } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
import { SETTING_KEYS, SettingsService } from '../settings/settings.service';
import { SecurityLogService } from '../security-log/security-log.service';
import { LoginProtectionService } from '../login-protection/login-protection.service';
import { PasswordService } from './password.service';
import { PhoneSyncService } from './phone-sync.service';

/** 登录结果（A1） */
export interface LoginResult {
  user: {
    id: number;
    name: string;
    gender: 'MALE' | 'FEMALE';
    phoneMasked: string;
    status: string;
    isSuperAdmin: boolean;
  };
  /** 新会话（Cookie 由控制器写入） */
  sessionId: string;
  /** 绝对过期时间点（epoch ms） */
  sessionExpiresAt: number;
  /** 是否"记住我"会话（控制器据此持久化 Cookie，base PRD §3） */
  rememberMe: boolean;
  /** 绝对过期时长（秒；"记住我"时 Cookie maxAge 与服务端时限一致） */
  absTimeoutSeconds: number;
  /** CSRF Cookie 值（双提交，控制器一并下发） */
  csrfToken: string;
}

/** 当前身份（A3） */
export interface MeResult {
  user: {
    id: number;
    name: string;
    gender: 'MALE' | 'FEMALE';
    phoneMasked: string;
    status: string;
    isSuperAdmin: boolean;
  };
  hasDingtalkBinding: boolean;
  /** 当前会话可见的功能编码；仅用于前端显隐，服务端守卫仍是最终授权边界。 */
  functionCodes: string[];
}

/**
 * 认证业务服务（base PRD §2/§4）。
 *
 * 登录失败统一提示不泄露账号是否存在；账号状态（注销/待激活）与登录保护
 * 在密码校验前检查；登录成功即创建全新会话（防会话固定），并清除账号连续失败计数。
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly protection: LoginProtectionService,
    private readonly securityLog: SecurityLogService,
    private readonly settings: SettingsService,
    private readonly session: SessionService,
    private readonly csrf: CsrfService,
    private readonly phoneSync: PhoneSyncService,
  ) {}

  /** 手机号 + 密码登录（A1） */
  async loginPassword(input: { phone: string; password: string; rememberMe?: boolean }, ip: string): Promise<LoginResult> {
    const phone = normalizePhoneInput(input.phone);
    const user = phone ? await this.findUserByPhone(phone) : null;

    // 未注册手机号：统一提示 + IP 失败计数（不解析 userId，防撞库放大）；
    // IP 锁对未注册路径同样生效（base PRD §4：IP 锁按来源 IP 累计全部失败）
    if (!user) {
      await this.protection.assertNotLocked(null, ip);
      await this.protection.recordFailure(null, ip);
      await this.securityLog.record('LOGIN_FAILURE', 'FAILURE', {
        reason: '账号不存在（统一提示）',
        sourceIp: ip,
      });
      throw new BusinessException(accountErrors.INVALID_CREDENTIALS);
    }

    // 账号状态前置检查（不校验密码，避免泄露密码正确性）
    // 状态异常分支：计入 IP 锁计数（base PRD §4：IP 锁按来源 IP 累计全部失败），不记账号锁——
    // 待激活账号无密码、"账号锁"语义只针对密码校验失败，计账号锁会让撞库探测可恶意锁死真实员工
    if (user.status === 'DEACTIVATED') {
      await this.protection.assertNotLocked(null, ip);
      await this.protection.recordFailure(null, ip);
      await this.securityLog.record('LOGIN_FAILURE', 'FAILURE', {
        actorId: user.id,
        reason: '账号已注销',
        sourceIp: ip,
      });
      throw new BusinessException(accountErrors.ACCOUNT_DEACTIVATED);
    }
    if (user.status === 'PENDING_ACTIVATION') {
      await this.protection.assertNotLocked(null, ip);
      await this.protection.recordFailure(null, ip);
      await this.securityLog.record('LOGIN_FAILURE', 'FAILURE', {
        actorId: user.id,
        reason: '账号待激活',
        sourceIp: ip,
      });
      throw new BusinessException(accountErrors.ACCOUNT_PENDING_ACTIVATION);
    }

    // 登录保护：账号锁/IP 锁
    await this.protection.assertNotLocked(user.id, ip);

    // 密码校验
    const ok = await this.password.verifyPassword(input.password, user.passwordHash ?? '');
    if (!ok) {
      await this.protection.recordFailure(user.id, ip);
      await this.securityLog.record('LOGIN_FAILURE', 'FAILURE', {
        actorId: user.id,
        reason: '密码错误',
        sourceIp: ip,
      });
      throw new BusinessException(accountErrors.INVALID_CREDENTIALS);
    }

    // 成功：清账号失败计数 + 安全日志 + 创建全新会话（轮换语义，防会话固定）
    await this.protection.recordSuccess(user.id);
    await this.securityLog.record('LOGIN_SUCCESS', 'SUCCESS', {
      actorId: user.id,
      sourceIp: ip,
    });
    return this.createUserSession(user.id, input.rememberMe === true, ip);
  }

  /** 当前身份（A3） */
  async me(userId: number): Promise<MeResult> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, gender: true, phone: true, status: true, isSuperAdmin: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null) {
      throw new BusinessException(frameworkErrors.SESSION_EXPIRED);
    }
    const [binding, functionCodes] = await Promise.all([
      this.prisma.client.dingtalkBinding.findFirst({
        where: { userId, status: 'BOUND' },
        select: { id: true },
      }),
      user.isSuperAdmin
        ? this.prisma.client.function
            .findMany({ select: { code: true }, orderBy: { code: 'asc' } })
            .then((functions) => functions.map((functionItem) => functionItem.code))
        : this.prisma.client.employeeGrant
            .findMany({ where: { userId }, select: { functionCode: true }, orderBy: { functionCode: 'asc' } })
            .then((grants) => grants.map((grant) => grant.functionCode)),
    ]);
    return {
      user: {
        id: user.id,
        name: user.name,
        gender: user.gender,
        phoneMasked: maskPhone(user.phone),
        status: user.status,
        isSuperAdmin: user.isSuperAdmin,
      },
      hasDingtalkBinding: binding !== null,
      functionCodes,
    };
  }

  /** 登出（A2）：删除会话并记录安全日志 */
  async logout(sessionId: string, userId: number, ip: string): Promise<void> {
    await this.session.destroy(sessionId);
    await this.securityLog.record('LOGOUT', 'SUCCESS', {
      actorId: userId,
      sourceIp: ip,
    });
  }

  /** 修改密码（A9）：校验旧密码 + 新密码；成功后 session_version 递增，全部会话失效（base PRD §2/§3） */
  async changePassword(userId: number, currentPassword: string, newPassword: string, ip: string): Promise<void> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true, status: true, deletedAt: true },
    });
    if (!user || user.deletedAt !== null || user.status !== 'ACTIVE') {
      throw new BusinessException(frameworkErrors.UNAUTHORIZED);
    }
    const ok = await this.password.verifyPassword(currentPassword, user.passwordHash ?? '');
    if (!ok) {
      await this.securityLog.record('PASSWORD_CHANGED', 'FAILURE', {
        actorId: userId,
        reason: '当前密码不正确',
        sourceIp: ip,
      });
      throw new BusinessException(accountErrors.OLD_PASSWORD_INCORRECT);
    }
    if (!this.password.validatePolicy(newPassword)) {
      throw new BusinessException(accountErrors.PASSWORD_POLICY_FAILED);
    }
    const newHash = await this.password.hash(newPassword);
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { passwordHash: newHash, sessionVersion: { increment: 1 } },
    });
    await this.securityLog.record('PASSWORD_CHANGED', 'SUCCESS', {
      actorId: userId,
      sourceIp: ip,
    });
  }

  /**
   * 钉钉扫码登录（A5 LOGIN 分支，base PRD §2）。
   * @returns 登录结果；unionId 未绑定任何账号返回 null（走扫码注册分流）
   */
  async loginWithDingtalk(
    input: { unionId: string; mobile: string; stateCode: string },
    ip: string,
  ): Promise<LoginResult | null> {
    // 查有效绑定（BOUND；含注销账号占用——注销后 unionId 不可再注册新账号）
    const binding = await this.prisma.client.dingtalkBinding.findFirst({
      where: { dingtalkUnionId: input.unionId, status: 'BOUND' },
      select: { userId: true },
    });
    if (!binding) {
      return null;
    }

    const user = await this.prisma.client.user.findUnique({
      where: { id: binding.userId },
      select: {
        id: true,
        name: true,
        gender: true,
        phone: true,
        status: true,
        isSuperAdmin: true,
        sessionVersion: true,
        deletedAt: true,
      },
    });
    if (!user || user.deletedAt !== null) {
      return null;
    }
    // 已注销账号：unionId 仍占用，提示走恢复（base PRD §2）
    if (user.status === 'DEACTIVATED') {
      await this.securityLog.record('LOGIN_FAILURE', 'FAILURE', {
        actorId: user.id,
        reason: '账号已注销（钉钉扫码）',
        sourceIp: ip,
      });
      throw new BusinessException(accountErrors.ACCOUNT_DEACTIVATED);
    }
    if (user.status === 'PENDING_ACTIVATION') {
      await this.securityLog.record('LOGIN_FAILURE', 'FAILURE', {
        actorId: user.id,
        reason: '账号待激活（钉钉扫码）',
        sourceIp: ip,
      });
      throw new BusinessException(accountErrors.ACCOUNT_PENDING_ACTIVATION);
    }

    // 手机号自动同步（当次事务内，base PRD §2；被占用则跳过不影响登录）
    await this.prisma.client.$transaction(async (tx) => {
      await this.phoneSync.syncFromDingtalk(tx, user.id, input.stateCode, input.mobile, ip);
    });

    await this.securityLog.record('LOGIN_SUCCESS', 'SUCCESS', {
      actorId: user.id,
      reason: '钉钉扫码登录',
      sourceIp: ip,
    });
    return this.createUserSession(user.id, false, ip);
  }

  /** 公共：为已认证账号创建全新会话（登录成功即轮换，防会话固定） */
  async createUserSession(userId: number, rememberMe: boolean, _ip: string): Promise<LoginResult> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        gender: true,
        phone: true,
        status: true,
        isSuperAdmin: true,
        sessionVersion: true,
      },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new BusinessException(frameworkErrors.UNAUTHORIZED);
    }
    const [idleMs, absMs] = await this.sessionTimeouts(rememberMe);
    const { sessionId, expiresAt } = await this.session.create({
      userId: user.id,
      sessionVersion: user.sessionVersion,
      rememberMe,
      idleTimeoutMs: idleMs,
      absoluteTimeoutMs: absMs,
    });
    return {
      user: {
        id: user.id,
        name: user.name,
        gender: user.gender,
        phoneMasked: maskPhone(user.phone),
        status: user.status,
        isSuperAdmin: user.isSuperAdmin,
      },
      sessionId,
      sessionExpiresAt: expiresAt,
      rememberMe,
      absTimeoutSeconds: Math.round(absMs / 1000),
      csrfToken: this.csrf.issue(),
    };
  }

  /** 按规范化手机号查找"待激活/正常"账号（注销账号为历史快照不参与登录） */
  private async findUserByPhone(phone: string): Promise<{
    id: number;
    name: string;
    gender: 'MALE' | 'FEMALE';
    phone: string;
    passwordHash: string | null;
    status: string;
    isSuperAdmin: boolean;
    sessionVersion: number;
  } | null> {
    const user = await this.prisma.client.user.findFirst({
      where: { phone, deletedAt: null, status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] } },
      select: {
        id: true,
        name: true,
        gender: true,
        phone: true,
        passwordHash: true,
        status: true,
        isSuperAdmin: true,
        sessionVersion: true,
      },
    });
    return user;
  }

  /** 会话时限（记住我延长空闲/绝对时限，base PRD §3） */
  private async sessionTimeouts(rememberMe: boolean): Promise<[number, number]> {
    const idleKey = rememberMe ? SETTING_KEYS.SESSION_IDLE_REMEMBER : SETTING_KEYS.SESSION_IDLE_TIMEOUT;
    const absKey = rememberMe ? SETTING_KEYS.SESSION_ABS_REMEMBER : SETTING_KEYS.SESSION_ABS_TIMEOUT;
    const [idleSec, absSec] = await Promise.all([this.settings.getNumber(idleKey), this.settings.getNumber(absKey)]);
    return [idleSec * 1000, absSec * 1000];
  }
}
