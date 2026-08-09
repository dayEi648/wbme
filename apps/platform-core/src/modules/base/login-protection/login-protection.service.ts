import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors, frameworkErrors } from '@wbme/contracts';
import { redisKey, REDIS_NAMESPACE } from '@wbme/server';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
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
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * 登录前检查：账号锁或 IP 锁命中 → 统一"尝试过多"提示（不泄露锁维度）。
   * userId 为 null（未注册手机号）时只检查 IP 锁——IP 锁对全部来源失败计数生效（base PRD §4）。
   */
  async assertNotLocked(userId: number | null, ip: string): Promise<void> {
    const [accountLocked, ipLocked] = await Promise.all([
      userId !== null ? this.redis.exists(this.accountLockKey(userId)) : Promise.resolve(0),
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
      // 记录该账号触发过的被锁 IP：管理员解锁账号时顺带解除（base PRD §4「解锁后立即恢复可登录」）
      if (userId !== null) {
        await this.redis.sadd(this.accountLockedIpsKey(userId), ip);
        await this.redis.expire(this.accountLockedIpsKey(userId), ipLockSeconds);
      }
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

  /**
   * 管理员解锁（M4，幂等）：清计数与账号锁，并解除该账号触发过的 IP 锁（若存在），
   * 分别写 ACCOUNT_UNLOCK 与 IP_UNLOCK 安全日志（backstage PRD §8 事件清单）。
   */
  async unlockByAdmin(userId: number, operatorId: number): Promise<void> {
    // 超管账号只能由另一名超管解锁（backstage PRD §3；与 M2 重置邀请同一保护语义）
    const target = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true },
    });
    if (target?.isSuperAdmin) {
      const operator = await this.prisma.client.user.findUnique({
        where: { id: operatorId },
        select: { isSuperAdmin: true },
      });
      if (!operator?.isSuperAdmin) {
        throw new BusinessException(frameworkErrors.FORBIDDEN);
      }
    }
    await this.redis.del(this.accountFailKey(userId));
    await this.redis.del(this.accountLockKey(userId));
    await this.securityLog.record('ACCOUNT_UNLOCK', 'SUCCESS', {
      actorId: operatorId,
      targetUserId: userId,
    });

    // 解除该账号触发过的 IP 锁：只有实际存在锁的 IP 才写 IP_UNLOCK（幂等，未锁则无事件）
    const lockedIps = await this.redis.smembers(this.accountLockedIpsKey(userId));
    let released = 0;
    for (const ip of lockedIps) {
      if ((await this.redis.del(this.ipLockKey(ip))) === 1) {
        released += 1;
        await this.securityLog.record('IP_UNLOCK', 'SUCCESS', {
          actorId: operatorId,
          targetUserId: userId,
          sourceIp: ip,
        });
      }
    }
    await this.redis.del(this.accountLockedIpsKey(userId));
    if (released > 0) {
      // 一并清该 IP 的失败计数：IP 锁解除后计数窗口内的历史失败不再累计到新锁
      for (const ip of lockedIps) {
        await this.redis.del(this.ipFailKey(ip));
      }
    }
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

  /** 账号触发过的被锁 IP 集合（供 M4 解锁时顺带解除 IP 锁） */
  private accountLockedIpsKey(userId: number): string {
    return redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'acct_locked_ips', userId);
  }

  private ipLockKey(ip: string): string {
    return redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'ip_lock', ip);
  }
}
