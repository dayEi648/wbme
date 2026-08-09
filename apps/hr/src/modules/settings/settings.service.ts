import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import type { Prisma } from '../../generated/prisma/client';

/** 人事设置键名清单（hr PRD §9；默认值受版本控制，24h 缓存等固定工程参数不入设置） */
export const HR_SETTING_KEYS = {
  /** 加班提前申请窗口（天），默认 30 */
  OVERTIME_ADVANCE_DAYS: 'overtime.advance.days',
  /** 加班补交窗口（天），默认 7 */
  OVERTIME_BACKFILL_DAYS: 'overtime.backfill.days',
} as const;

/** 人事设置定义（键 → 默认值与说明） */
export const HR_SETTING_DEFINITIONS: Readonly<
  Record<(typeof HR_SETTING_KEYS)[keyof typeof HR_SETTING_KEYS], { defaultValue: string; label: string }>
> = {
  [HR_SETTING_KEYS.OVERTIME_ADVANCE_DAYS]: {
    defaultValue: '30',
    label: '加班提前申请窗口（天）',
  },
  [HR_SETTING_KEYS.OVERTIME_BACKFILL_DAYS]: {
    defaultValue: '7',
    label: '加班补交窗口（天）',
  },
};

/** 人事设置项（对外输出） */
export interface HrSettingItem {
  key: string;
  value: string;
  valueType: string;
  label: string;
}

/**
 * 人事设置服务（hr PRD §9）：运行参数读写，改参数即时生效（快照规则不追溯）。
 * 初始化时按定义 upsert 默认值，保证加班窗口读取总有值。
 */
@Injectable()
export class SettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 初始化默认设置（幂等 upsert；应用启动与测试前置调用）。
   */
  async ensureDefaults(): Promise<void> {
    for (const [key, definition] of Object.entries(HR_SETTING_DEFINITIONS)) {
      await this.prisma.client.hrSetting.upsert({
        where: { key },
        create: {
          key,
          value: definition.defaultValue,
          valueType: 'NUMBER',
          label: definition.label,
        },
        update: {},
      });
    }
  }

  /**
   * 读取全部人事设置。
   *
   * @returns 设置项列表（按键排序）
   */
  async list(): Promise<{ items: HrSettingItem[] }> {
    await this.ensureDefaults();
    const rows = await this.prisma.client.hrSetting.findMany({ orderBy: { key: 'asc' } });
    return { items: rows.map((row) => ({ key: row.key, value: row.value, valueType: row.valueType, label: row.label })) };
  }

  /**
   * 读取数值型设置（缺失时返回默认值）。
   *
   * @param key 设置键（HR_SETTING_KEYS）
   * @returns 数值；定义不存在返回默认值对应数值
   */
  async getNumber(key: (typeof HR_SETTING_KEYS)[keyof typeof HR_SETTING_KEYS]): Promise<number> {
    await this.ensureDefaults();
    const row = await this.prisma.client.hrSetting.findUnique({ where: { key } });
    const raw = row?.value ?? HR_SETTING_DEFINITIONS[key]?.defaultValue ?? '0';
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }

  /**
   * 更新单条设置（值须为有限数值；本期人事参数均为数值）。
   *
   * @param key 设置键
   * @param value 新值字符串
   * @param updatedBy 操作人
   * @throws VALIDATION_FAILED 键未注册或值非法
   */
  async update(key: string, value: string, updatedBy: number, tx?: Prisma.TransactionClient): Promise<{ ok: true }> {
    const definition = HR_SETTING_DEFINITIONS[key as keyof typeof HR_SETTING_DEFINITIONS];
    if (!definition) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '未知的人事设置键' });
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '人事设置值必须为非负数值' });
    }
    // 传入事务客户端时与调用方（操作日志）同事务（主 PRD §9.3：日志随业务事务写入）
    const client = tx ?? this.prisma.client;
    await client.hrSetting.upsert({
      where: { key },
      create: { key, value, valueType: 'NUMBER', label: definition.label, updatedBy },
      update: { value, updatedBy },
    });
    return { ok: true };
  }
}
