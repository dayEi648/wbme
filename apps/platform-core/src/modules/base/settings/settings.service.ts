import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

/**
 * 系统设置读取侧（主 PRD §1.4、backstage PRD §7；管理界面 T4-5 实现）。
 *
 * 键名清单为开发期契约（本文件常量 + PRD 文档同步维护）：
 * 管理员可调业务参数统一存 system_settings 表，本服务提供默认值 + DB 覆盖 +
 * 进程内秒级缓存；"即时生效"表示无需重新部署，不追溯改写已形成的业务快照。
 * 版本化工程常量与部署级机密不进入本表（主 PRD §1.4）。
 */

/** 设置键名清单（唯一性由 system_settings.key 的 UNIQUE 约束保证） */
export const SETTING_KEYS = {
  /** 普通会话空闲超时（秒）：默认 1 天（base PRD §3） */
  SESSION_IDLE_TIMEOUT: 'session.idle.timeout.seconds',
  /** "记住我"会话空闲超时（秒）：默认 30 天 */
  SESSION_IDLE_REMEMBER: 'session.idle.remember.seconds',
  /** 普通会话绝对过期（秒）：默认 1 周 */
  SESSION_ABS_TIMEOUT: 'session.abs.timeout.seconds',
  /** "记住我"会话绝对过期（秒）：默认 90 天 */
  SESSION_ABS_REMEMBER: 'session.abs.remember.seconds',
  /** 账号锁连续失败次数上限：默认 10（base PRD §4） */
  LOGIN_ACCOUNT_MAX_ATTEMPTS: 'login.account.max.attempts',
  /** 账号锁定时长（秒）：默认 10 分钟 */
  LOGIN_ACCOUNT_LOCK_SECONDS: 'login.account.lock.seconds',
  /** IP 锁计数窗口（秒）：默认 60 分钟 */
  LOGIN_IP_WINDOW_SECONDS: 'login.ip.window.seconds',
  /** IP 锁窗口内失败次数上限：默认 120 */
  LOGIN_IP_MAX_ATTEMPTS: 'login.ip.max.attempts',
  /** IP 锁定时长（秒）：默认 1 小时 */
  LOGIN_IP_LOCK_SECONDS: 'login.ip.lock.seconds',
  /** 激活/重置凭证有效期（秒）：默认 7 天（base PRD §2） */
  INVITATION_VALID_SECONDS: 'invitation.valid.seconds',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** 键 → 默认值（数值型；设置变更即时生效，不追溯历史快照） */
const DEFAULT_VALUES: Readonly<Record<SettingKey, number>> = {
  [SETTING_KEYS.SESSION_IDLE_TIMEOUT]: 24 * 60 * 60,
  [SETTING_KEYS.SESSION_IDLE_REMEMBER]: 30 * 24 * 60 * 60,
  [SETTING_KEYS.SESSION_ABS_TIMEOUT]: 7 * 24 * 60 * 60,
  [SETTING_KEYS.SESSION_ABS_REMEMBER]: 90 * 24 * 60 * 60,
  [SETTING_KEYS.LOGIN_ACCOUNT_MAX_ATTEMPTS]: 10,
  [SETTING_KEYS.LOGIN_ACCOUNT_LOCK_SECONDS]: 10 * 60,
  [SETTING_KEYS.LOGIN_IP_WINDOW_SECONDS]: 60 * 60,
  [SETTING_KEYS.LOGIN_IP_MAX_ATTEMPTS]: 120,
  [SETTING_KEYS.LOGIN_IP_LOCK_SECONDS]: 60 * 60,
  [SETTING_KEYS.INVITATION_VALID_SECONDS]: 7 * 24 * 60 * 60,
};

/** DB 覆盖值缓存条目 */
interface CachedOverride {
  value: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5_000;

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<SettingKey, CachedOverride>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 读取数值型设置：默认值 + DB 覆盖（秒级缓存） */
  async getNumber(key: SettingKey): Promise<number> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.value;
    }
    let override: number | null = null;
    try {
      const row = await this.prisma.client.systemSetting.findUnique({ where: { key } });
      if (row) {
        override = Number(row.value);
      }
    } catch (error) {
      // 设置读取失败不阻断认证链路，回退默认值并记录（主 PRD §1.4 即时生效语义不适用于 DB 故障）
      this.logger.warn(`读取系统设置 ${key} 失败，使用默认值`, error instanceof Error ? error.message : String(error));
    }
    const value = override ?? DEFAULT_VALUES[key] ?? 0;
    this.cache.set(key, { value, fetchedAt: Date.now() });
    return value;
  }

  /** 返回键名清单（T4-5 设置管理页与文档核对使用） */
  static keys(): readonly SettingKey[] {
    return Object.values(SETTING_KEYS);
  }

  /** 返回默认值（测试与文档核对使用） */
  static defaultOf(key: SettingKey): number {
    return DEFAULT_VALUES[key] ?? 0;
  }
}
