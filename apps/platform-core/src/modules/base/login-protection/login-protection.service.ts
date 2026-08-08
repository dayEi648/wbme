import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors } from '@wbme/contracts';
import { redisKey, REDIS_NAMESPACE } from '@wbme/server';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '@wbme/server';
import { SETTING_KEYS, SettingsService } from '../settings/settings.service';
import { SecurityLogService } from '../security-log/security-log.service';

/**
 * 登录保护（base PRD §4）：账号锁 + IP 锁两级锁定。
 *
 * - 账号锁：同账号连续失败达上限锁定（默认 10 次 / 10 分钟）；
 * - IP 锁：同来源 IP 在计数窗口内累计失败达上限锁定（默认 60 分钟 / 120 次 / 1 小时）；
 * - 计数与锁定期限均读系统设置，可调；
 * - 账号计数需要先按规范化手机号解析出 userId（未注册手机号不记账号锁，防撞库放大）；
 * - 锁定/解锁事件写安全日志；解锁（M4）后立即恢复可登录。
 */
@Injectable()
export class LoginProtectionService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly settings: SettingsService,
    private readonly securityLog: SecurityLogService,
  ) {}

  /** 登录前检查：账号锁或 IP 锁命中 → 统一"尝试过多"提示（不泄露锁维度） */
  async assertNotLocked(userId: number, ip: string): Promise<void> {
    const [accountLocked, ipLocked] = await Promise.all([
      this.redis.exists(this.accountLockKey(userId)),
      this.redis.exists(this.ipLockKey(ip)),
    ]);
    if (accountLocked === 1 || ipLocked === 1) {
      throw new BusinessException(accountErrors.ACCOUNT_LOCKED);
    }
  }

  /** 记录一次失败尝试：IP 计数（全部失败）+ 账号计数（已解析 userId 时） */
  async recordFailure(userId: number | null, ip: string): Promise<void> {
    const [accountMax, accountLockSeconds, ipMax, ipLockSeconds, ipWindowSeconds] = await Promise.all([
      this.settings.getNumber(SETTING_KEYS.LOGIN_ACCOUNT_MAX_ATTEMPTS),
      this.settings.getNumber(SETTING_KEYS.LOGIN_ACCOUNT_LOCK_SECONDS),
      this.settings.getNumber(SETTING_KEYS.LOGIN_IP_MAX_ATTEMPTS),
      this.settings.getNumber(SETTING_KEYS.LOGIN_IP_LOCK_SECONDS),
      this.settings.getNumber(SETTING_KEYS.LOGIN_IP_WINDOW_SECONDS),
    ]);

    // IP 锁：固定窗口计数
    const ipFailKey = this.ipFailKey(ip);
    const ipCount = await this.redis.incr(ipFailKey);
    if (ipCount === 1) {
      await this.redis.expire(ipFailKey, ipWindowSeconds);
    }
    if (ipCount >= ipMax && (await this.redis.exists(this.ipLockKey(ip))) === 0) {
      await this.redis.set(this.ipLockKey(ip), '1', 'EX', ipLockSeconds);
      await this.securityLog.record('IP_LOCK', 'SUCCESS', {
        actorId: userId ?? undefined,
        context: { lockSeconds: ipLockSeconds, windowSeconds: ipWindowSeconds, threshold: ipMax },
        sourceIp: ip,
      });
    }

    // 账号锁：连续失败计数（滑动窗口）
    if (userId !== null) {
      const accountFailKey = this.accountFailKey(userId);
      const accountCount = await this.redis.incr(accountFailKey);
      if (accountCount === 1) {
        await this.redis.expire(accountFailKey, accountLockSeconds);
      }
      if (accountCount >= accountMax && (await this.redis.exists(this.accountLockKey(userId))) === 0) {
        await this.redis.set(this.accountLockKey(userId), '1', 'EX', accountLockSeconds);
        await this.securityLog.record('ACCOUNT_LOCK', 'SUCCESS', {
          actorId: userId,
          context: { lockSeconds: accountLockSeconds, threshold: accountMax },
          sourceIp: ip,
        });
      }
    }
  }

  /** 登录成功：清除账号连续失败计数（IP 计数保留持续统计，base PRD §4） */
  async recordSuccess(userId: number): Promise<void> {
    await this.redis.del(this.accountFailKey(userId));
  }

  /** 管理员解锁（M4，幂等）：清计数与锁，写 ACCOUNT_UNLOCK 安全日志 */
  async unlockByAdmin(userId: number, operatorId: number): Promise<void> {
    await this.redis.del(this.accountFailKey(userId));
    await this.redis.del(this.accountLockKey(userId));
    await this.securityLog.record('ACCOUNT_UNLOCK', 'SUCCESS', {
      actorId: operatorId,
      targetUserId: userId,
    });
  }

  private accountFailKey(userId: number): string {
    return redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'acct_fail', userId);
  }

  private accountLockKey(userId: number): string {
    return redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'acct_lock', userId);
  }

  private ipFailKey(ip: string): string {
    return redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'ip_fail', ip);
  }

  private ipLockKey(ip: string): string {
    return redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'ip_lock', ip);
  }
}
