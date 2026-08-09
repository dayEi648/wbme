import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import type { Prisma } from '../../generated/prisma/client';

/** 资产运行参数键（asset PRD §12；A-28；本期不提供消耗品审批期限配置） */
export const ASSET_SETTING_KEYS = {
  /** 二维码扫码入口地址（前端 /scan 页面完整地址） */
  SCAN_ENTRY_URL: 'asset.scan.entry.url',
  /** 申领上限重置日（1～28，默认 1 号；统一决定月/季/年上限的重置时点） */
  QUOTA_RESET_DAY: 'asset.quota.reset.day',
} as const;

/** 资产设置定义（键 → 默认值与说明） */
export const ASSET_SETTING_DEFINITIONS: Readonly<
  Record<(typeof ASSET_SETTING_KEYS)[keyof typeof ASSET_SETTING_KEYS], { defaultValue: string; valueType: 'STRING' | 'NUMBER'; label: string }>
> = {
  [ASSET_SETTING_KEYS.SCAN_ENTRY_URL]: {
    defaultValue: '',
    valueType: 'STRING',
    label: '二维码扫码入口地址',
  },
  [ASSET_SETTING_KEYS.QUOTA_RESET_DAY]: {
    defaultValue: '1',
    valueType: 'NUMBER',
    label: '申领上限重置日（1～28）',
  },
};

/** 资产设置项（对外输出） */
export interface AssetSettingItem {
  key: string;
  value: string;
  valueType: string;
  label: string;
  updatedAt: Date;
}

/**
 * 资产设置服务（asset PRD §12）：运行参数读写，改参数即时生效（快照规则不追溯——
 * 申领上限重置日变更只影响之后开始的周期）。
 */
@Injectable()
export class SettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 初始化默认设置（幂等 upsert；应用启动与测试前置调用）。
   */
  async ensureDefaults(): Promise<void> {
    for (const [key, definition] of Object.entries(ASSET_SETTING_DEFINITIONS)) {
      await this.prisma.client.assetSetting.upsert({
        where: { key },
        create: {
          key,
          value: definition.defaultValue,
          valueType: definition.valueType,
          label: definition.label,
        },
        update: {},
      });
    }
  }

  /**
   * 读取全部资产设置。
   *
   * @returns 设置项列表（按键排序）
   */
  async list(): Promise<{ items: AssetSettingItem[] }> {
    await this.ensureDefaults();
    const rows = await this.prisma.client.assetSetting.findMany({ orderBy: { key: 'asc' } });
    return {
      items: rows.map((row) => ({
        key: row.key,
        value: row.value,
        valueType: row.valueType,
        label: row.label,
        updatedAt: row.updatedAt,
      })),
    };
  }

  /**
   * 读取申领上限重置日（缺省 1 号；非法值回退 1）。
   *
   * @returns 重置日（1～28）
   */
  async getQuotaResetDay(): Promise<number> {
    await this.ensureDefaults();
    const row = await this.prisma.client.assetSetting.findUnique({ where: { key: ASSET_SETTING_KEYS.QUOTA_RESET_DAY } });
    const value = Number(row?.value);
    return Number.isInteger(value) && value >= 1 && value <= 28 ? value : 1;
  }

  /**
   * 更新单条运行参数（只接受已注册键；重置日限 1～28 保证每个自然月都存在该日）。
   *
   * @param key 设置键
   * @param value 新值字符串
   * @param updatedBy 操作人
   * @throws VALIDATION_FAILED 键未注册或值非法
   */
  async update(key: string, value: string, updatedBy: number, tx?: Prisma.TransactionClient): Promise<{ ok: true }> {
    const definition = ASSET_SETTING_DEFINITIONS[key as keyof typeof ASSET_SETTING_DEFINITIONS];
    if (!definition) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '未知的资产设置键' });
    }
    if (definition.valueType === 'NUMBER') {
      const numeric = Number(value);
      if (!Number.isInteger(numeric)) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '该设置必须为整数' });
      }
      if (key === ASSET_SETTING_KEYS.QUOTA_RESET_DAY && (numeric < 1 || numeric > 28)) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '申领上限重置日必须为 1～28' });
      }
    }
    // 传入事务客户端时与调用方（操作日志）同事务（主 PRD §9.3：日志随业务事务写入）
    const client = tx ?? this.prisma.client;
    await client.assetSetting.upsert({
      where: { key },
      create: { key, value, valueType: definition.valueType, label: definition.label, updatedBy },
      update: { value, updatedBy },
    });
    return { ok: true };
  }
}
