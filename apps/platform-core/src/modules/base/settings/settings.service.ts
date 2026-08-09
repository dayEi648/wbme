import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BusinessException, frameworkErrors, SYSTEM_SETTINGS_FUNCTION_CODE } from '@wbme/contracts';
import { REDIS_CLIENT, REDIS_NAMESPACE, redisKey, type Redis } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../../backstage/permission/operation-log.util';

/**
 * 系统设置读取与管理（主 PRD §1.4、backstage PRD §7；T4-5）。
 *
 * 键名清单为开发期契约（本文件常量 + PRD 文档同步维护）：
 * 管理员可调业务参数统一存 system_settings 表，本服务提供默认值 + DB 覆盖 +
 * 进程内秒级缓存；"即时生效"表示无需重新部署，不追溯改写已形成的业务快照。
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
  /** 默认查询时间窗口（天）：backstage PRD §7 */
  QUERY_DEFAULT_WINDOW_DAYS: 'query.default.window.days',
  /** 单次导出最大行数：backstage PRD §7 */
  EXPORT_MAX_ROWS: 'export.max.rows',
  /** 备份保留天数：backstage PRD §7 */
  BACKUP_RETENTION_DAYS: 'backup.retention.days',
  /** 未关联业务图片保留时长（小时）：backstage PRD §7 */
  UPLOAD_UNASSOCIATED_IMAGE_RETENTION_HOURS: 'upload.unassociated.image.retention.hours',
  /** 审批超时自动取消天数：backstage PRD §7 */
  APPROVAL_TIMEOUT_CANCEL_DAYS: 'approval.timeout.cancel.days',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** 平台设置页管理的键（PLATFORM 组） */
export const PLATFORM_SETTING_KEYS = [
  SETTING_KEYS.QUERY_DEFAULT_WINDOW_DAYS,
  SETTING_KEYS.EXPORT_MAX_ROWS,
  SETTING_KEYS.BACKUP_RETENTION_DAYS,
  SETTING_KEYS.UPLOAD_UNASSOCIATED_IMAGE_RETENTION_HOURS,
  SETTING_KEYS.APPROVAL_TIMEOUT_CANCEL_DAYS,
] as const;

export type PlatformSettingKey = (typeof PLATFORM_SETTING_KEYS)[number];

/** 平台设置元数据（默认值、展示名、校验边界） */
export interface PlatformSettingDefinition {
  key: PlatformSettingKey;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
}

/** 平台设置项（含当前值） */
export interface PlatformSettingItem extends PlatformSettingDefinition {
  value: number;
}

const PLATFORM_SETTING_DEFINITIONS: Readonly<Record<PlatformSettingKey, Omit<PlatformSettingDefinition, 'key'>>> = {
  [SETTING_KEYS.QUERY_DEFAULT_WINDOW_DAYS]: {
    label: '默认查询时间窗口（天）',
    defaultValue: 30,
    min: 1,
    max: 365,
  },
  [SETTING_KEYS.EXPORT_MAX_ROWS]: {
    label: '单次导出最大行数',
    defaultValue: 100_000,
    min: 1,
    max: 200_000,
  },
  [SETTING_KEYS.BACKUP_RETENTION_DAYS]: {
    label: '备份保留天数',
    defaultValue: 30,
    min: 7,
    max: 365,
  },
  [SETTING_KEYS.UPLOAD_UNASSOCIATED_IMAGE_RETENTION_HOURS]: {
    label: '未关联业务图片保留时长（小时）',
    defaultValue: 24,
    min: 1,
    max: 168,
  },
  [SETTING_KEYS.APPROVAL_TIMEOUT_CANCEL_DAYS]: {
    label: '审批超时自动取消天数',
    defaultValue: 30,
    min: 1,
    max: 365,
  },
};

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
  [SETTING_KEYS.QUERY_DEFAULT_WINDOW_DAYS]: 30,
  [SETTING_KEYS.EXPORT_MAX_ROWS]: 100_000,
  [SETTING_KEYS.BACKUP_RETENTION_DAYS]: 30,
  [SETTING_KEYS.UPLOAD_UNASSOCIATED_IMAGE_RETENTION_HOURS]: 24,
  [SETTING_KEYS.APPROVAL_TIMEOUT_CANCEL_DAYS]: 30,
};

/** DB 覆盖值缓存条目 */
interface CachedOverride {
  value: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5_000;
const IDEMPOTENCY_SCOPE = 'settings.platform.update';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<SettingKey, CachedOverride>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

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
      this.logger.warn(`读取系统设置 ${key} 失败，使用默认值`, error instanceof Error ? error.message : String(error));
    }
    const value = override ?? DEFAULT_VALUES[key] ?? 0;
    this.cache.set(key, { value, fetchedAt: Date.now() });
    return value;
  }

  /**
   * 列出全部平台设置项（含当前值、默认值、展示名与边界）。
   *
   * @returns 平台设置列表
   */
  async listPlatformSettings(): Promise<{ settings: PlatformSettingItem[] }> {
    const rows = await this.prisma.client.systemSetting.findMany({
      where: { key: { in: [...PLATFORM_SETTING_KEYS] } },
      select: { key: true, value: true },
    });
    const overrideMap = new Map(rows.map((row) => [row.key, Number(row.value)]));
    const settings: PlatformSettingItem[] = PLATFORM_SETTING_KEYS.map((key) => {
      const def = PLATFORM_SETTING_DEFINITIONS[key];
      return {
        key,
        label: def.label,
        defaultValue: def.defaultValue,
        min: def.min,
        max: def.max,
        value: overrideMap.get(key) ?? def.defaultValue,
      };
    });
    return { settings };
  }

  /**
   * 批量更新平台设置（校验边界、写库、失效缓存、广播配置变更、记操作日志）。
   *
   * @param operatorId 操作人 id
   * @param patches 键值补丁（仅允许 PLATFORM 组键）
   * @param idempotencyKey 可选幂等键
   * @returns 更新后的设置列表
   */
  async updatePlatformSettings(
    operatorId: number,
    patches: Partial<Record<PlatformSettingKey, number>>,
    idempotencyKey?: string,
  ): Promise<{ settings: PlatformSettingItem[] }> {
    const entries = Object.entries(patches) as Array<[PlatformSettingKey, number]>;
    if (entries.length === 0) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: [{ field: 'patches', errors: ['至少提供一项设置'] }],
      });
    }
    for (const [key, value] of entries) {
      if (!PLATFORM_SETTING_KEYS.includes(key)) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
          fields: [{ field: key, errors: ['不允许修改该设置键'] }],
        });
      }
      const def = PLATFORM_SETTING_DEFINITIONS[key];
      if (!Number.isFinite(value) || value < def.min || value > def.max) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
          fields: [{ field: key, errors: [`取值须在 ${def.min}～${def.max} 之间`] }],
        });
      }
    }
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const fingerprint = fingerprintPayload({ patches });
    await executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: SYSTEM_SETTINGS_FUNCTION_CODE,
      scope: IDEMPOTENCY_SCOPE,
      idempotencyKey,
      fingerprint,
      run: async (tx) => {
        for (const [key, value] of entries) {
          const def = PLATFORM_SETTING_DEFINITIONS[key];
          await tx.systemSetting.upsert({
            where: { key },
            create: {
              key,
              value: String(value),
              valueType: 'NUMBER',
              group: 'PLATFORM',
              label: def.label,
              updatedBy: operatorId,
            },
            update: { value: String(value), updatedBy: operatorId },
          });
        }
        return {
          result: { updatedKeys: entries.map(([key]) => key) },
          actionType: 'UPDATE' as const,
          summary: `更新了平台设置：${entries.map(([key]) => key).join('、')}`,
        };
      },
    });
    for (const [key] of entries) {
      this.cache.delete(key);
    }
    await this.publishConfigBroadcast(entries.map(([key]) => key));
    return this.listPlatformSettings();
  }

  /** 发布 Redis 配置变更广播（各服务失效本地缓存） */
  private async publishConfigBroadcast(keys: string[]): Promise<void> {
    if (!this.redis || this.redis.status !== 'ready') {
      return;
    }
    try {
      await this.redis.publish(
        redisKey(REDIS_NAMESPACE.CONFIG, 'broadcast'),
        JSON.stringify({ keys, at: new Date().toISOString() }),
      );
    } catch (error) {
      this.logger.warn('配置变更广播失败', error instanceof Error ? error.message : String(error));
    }
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
