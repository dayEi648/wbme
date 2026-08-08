import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { BusinessException } from '@wbme/contracts';
import { redisKey, REDIS_NAMESPACE, REDIS_CLIENT } from '@wbme/server';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTING_KEYS, SettingsService } from '../settings/settings.service';
import { SecurityLogService } from '../security-log/security-log.service';
import { LoginProtectionService } from './login-protection.service';

// 加载仓库根 .env（集成测试使用真实本地 Redis；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const REDIS_URL = process.env.REDIS_URL;

/** 账号锁焦点测试的设置：IP 阈值调高避免干扰账号锁判定 */
const ACCOUNT_FOCUS_SETTINGS: Record<string, number> = {
  [SETTING_KEYS.LOGIN_ACCOUNT_MAX_ATTEMPTS]: 3,
  [SETTING_KEYS.LOGIN_ACCOUNT_LOCK_SECONDS]: 60,
  [SETTING_KEYS.LOGIN_IP_WINDOW_SECONDS]: 120,
  [SETTING_KEYS.LOGIN_IP_MAX_ATTEMPTS]: 1000,
  [SETTING_KEYS.LOGIN_IP_LOCK_SECONDS]: 120,
};

/** IP 锁焦点测试的设置：账号阈值调高避免干扰 IP 锁判定 */
const IP_FOCUS_SETTINGS: Record<string, number> = {
  [SETTING_KEYS.LOGIN_ACCOUNT_MAX_ATTEMPTS]: 1000,
  [SETTING_KEYS.LOGIN_ACCOUNT_LOCK_SECONDS]: 60,
  [SETTING_KEYS.LOGIN_IP_WINDOW_SECONDS]: 120,
  [SETTING_KEYS.LOGIN_IP_MAX_ATTEMPTS]: 4,
  [SETTING_KEYS.LOGIN_IP_LOCK_SECONDS]: 120,
};

function fakeSettings(values: Record<string, number>): SettingsService {
  return { getNumber: async (key: string) => values[key] ?? 0 } as SettingsService;
}

describe.skipIf(!REDIS_URL)('LoginProtectionService（base PRD §4）', () => {
  let redis: Redis;
  let service: LoginProtectionService;
  let ipFocusService: LoginProtectionService;
  const securityLog = { record: () => Promise.resolve() } as unknown as SecurityLogService;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL ?? 'redis://localhost:6379');
    const moduleRef = await Test.createTestingModule({
      providers: [
        LoginProtectionService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: SettingsService, useValue: fakeSettings(ACCOUNT_FOCUS_SETTINGS) },
        { provide: SecurityLogService, useValue: securityLog },
      ],
    }).compile();
    service = moduleRef.get(LoginProtectionService);
    ipFocusService = new LoginProtectionService(redis, fakeSettings(IP_FOCUS_SETTINGS), securityLog);
  });

  afterAll(async () => {
    await redis.quit();
  });

  async function cleanKeys(userId: number, ip: string): Promise<void> {
    const keys = [
      redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'acct_fail', userId),
      redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'acct_lock', userId),
      redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'ip_fail', ip),
      redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'ip_lock', ip),
    ];
    await redis.del(...keys);
  }

  describe('账号锁', () => {
    it('未锁定时通过', async () => {
      await cleanKeys(1, '1.2.3.4');
      await expect(service.assertNotLocked(1, '1.2.3.4')).resolves.toBeUndefined();
    });

    it('连续失败达阈值后锁定，锁定期内拒绝', async () => {
      await cleanKeys(7, '10.0.0.1');
      await service.recordFailure(7, '10.0.0.1');
      await service.recordFailure(7, '10.0.0.1');
      await expect(service.assertNotLocked(7, '10.0.0.1')).resolves.toBeUndefined();
      await service.recordFailure(7, '10.0.0.1'); // 第 3 次达阈值
      await expect(service.assertNotLocked(7, '10.0.0.1')).rejects.toBeInstanceOf(BusinessException);
    });

    it('登录成功清除账号连续失败计数', async () => {
      await cleanKeys(30, '10.0.0.10');
      await service.recordFailure(30, '10.0.0.10');
      await service.recordFailure(30, '10.0.0.10');
      await service.recordSuccess(30); // 清账号计数
      await service.recordFailure(30, '10.0.0.10');
      await service.recordFailure(30, '10.0.0.10');
      await expect(service.assertNotLocked(30, '10.0.0.10')).resolves.toBeUndefined();
    });

    it('管理员解锁后立即恢复可登录', async () => {
      await cleanKeys(40, '10.0.0.11');
      await service.recordFailure(40, '10.0.0.11');
      await service.recordFailure(40, '10.0.0.11');
      await service.recordFailure(40, '10.0.0.11');
      await expect(service.assertNotLocked(40, '10.0.0.11')).rejects.toBeInstanceOf(BusinessException);
      await service.unlockByAdmin(40, 99);
      await expect(service.assertNotLocked(40, '10.0.0.11')).resolves.toBeUndefined();
    });
  });

  describe('IP 锁', () => {
    it('同 IP 累计失败达阈值锁定，且作用于该 IP 上所有账号', async () => {
      await cleanKeys(20, '10.0.0.9');
      await ipFocusService.recordFailure(20, '10.0.0.9');
      await ipFocusService.recordFailure(null, '10.0.0.9'); // 未注册手机号也计 IP
      await ipFocusService.recordFailure(21, '10.0.0.9');
      await ipFocusService.recordFailure(21, '10.0.0.9'); // 第 4 次达 IP 阈值
      await expect(ipFocusService.assertNotLocked(21, '10.0.0.9')).rejects.toBeInstanceOf(BusinessException);
      await expect(ipFocusService.assertNotLocked(22, '10.0.0.9')).rejects.toBeInstanceOf(BusinessException);
    });

    it('登录成功不清除 IP 计数（持续统计）', async () => {
      await cleanKeys(50, '10.0.0.12');
      await ipFocusService.recordFailure(50, '10.0.0.12');
      await ipFocusService.recordFailure(50, '10.0.0.12');
      await ipFocusService.recordSuccess(50); // 只清账号计数
      await ipFocusService.recordFailure(50, '10.0.0.12'); // ip=3
      await ipFocusService.recordFailure(50, '10.0.0.12'); // ip=4 → IP 锁
      await expect(ipFocusService.assertNotLocked(50, '10.0.0.12')).rejects.toBeInstanceOf(BusinessException);
    });
  });
});
