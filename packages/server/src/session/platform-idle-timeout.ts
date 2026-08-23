import type { IdleTimeoutProvider } from './session.guard';

/** 平台端持久化的会话空闲超时设置键；业务服务通过只读视图读取。 */
export const PLATFORM_SESSION_IDLE_TIMEOUT_KEYS = {
  DEFAULT: 'session.idle.timeout.seconds',
  REMEMBER_ME: 'session.idle.remember.seconds',
} as const;

/** 配置缺失或跨 schema 读取失败时，与平台默认会话策略保持一致。 */
const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MINIMUM_IDLE_TIMEOUT_SECONDS = 60;
const PLATFORM_SETTING_CACHE_TTL_MS = 5_000;

/** 由部署单元实现：从 backstage.platform_settings 只读视图读取一个设置值。 */
export type PlatformSettingReader = (key: string) => Promise<string | null>;

/**
 * 创建供业务系统会话守卫使用的空闲超时提供者。
 *
 * 业务系统不直连平台 ORM，通过各自 Prisma Client 的只读视图提供读取函数；
 * 短缓存避免每次有效交互都增加一次跨 schema 查询，同时与平台设置服务的缓存窗口一致。
 */
export function createPlatformSessionIdleTimeoutProvider(readSetting: PlatformSettingReader): IdleTimeoutProvider {
  const cache = new Map<string, { value: number; fetchedAt: number }>();

  return async (rememberMe: boolean): Promise<number> => {
    const key = rememberMe ? PLATFORM_SESSION_IDLE_TIMEOUT_KEYS.REMEMBER_ME : PLATFORM_SESSION_IDLE_TIMEOUT_KEYS.DEFAULT;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < PLATFORM_SETTING_CACHE_TTL_MS) {
      return cached.value;
    }
    try {
      const seconds = Number(await readSetting(key));
      if (!Number.isInteger(seconds) || seconds < MINIMUM_IDLE_TIMEOUT_SECONDS) {
        return cached?.value ?? DEFAULT_IDLE_TIMEOUT_MS;
      }
      const value = seconds * 1_000;
      cache.set(key, { value, fetchedAt: Date.now() });
      return value;
    } catch {
      // 设置读取短暂失败不应让已认证请求不可用；有缓存优先使用最新有效配置。
      return cached?.value ?? DEFAULT_IDLE_TIMEOUT_MS;
    }
  };
}
