import { Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../../backstage/permission/operation-log.util';

/** 钉钉导入配置在 system_settings 中的稳定键名。 */
const DINGTALK_IMPORT_SETTING_KEYS = {
  appKey: 'integration.dingtalk.app-key',
  appSecret: 'integration.dingtalk.app-secret',
  corpId: 'integration.dingtalk.corp-id',
  defaultPassword: 'integration.dingtalk.import-default-password',
} as const;

type DingtalkImportSettingField = keyof typeof DINGTALK_IMPORT_SETTING_KEYS;

const ALL_DINGTALK_IMPORT_SETTING_KEYS = Object.values(DINGTALK_IMPORT_SETTING_KEYS);
const IDENTITY_VALUE_MAX_LENGTH = 128;
const APP_SECRET_MAX_LENGTH = 512;
const DEFAULT_PASSWORD_MIN_LENGTH = 8;
const DEFAULT_PASSWORD_MAX_LENGTH = 32;
const IDEMPOTENCY_SCOPE = 'settings.dingtalk-import.update';

/** 供网关使用的 OAuth 凭证；不会通过 HTTP 响应返回。 */
export interface DingtalkOAuthCredentials {
  appKey: string;
  appSecret: string;
  corpId: string;
}

/** 管理端可安全展示的配置状态，绝不含凭证或默认密码本身。 */
export interface DingtalkImportSettingsStatus {
  appKeyConfigured: boolean;
  appSecretConfigured: boolean;
  corpIdConfigured: boolean;
  defaultPasswordConfigured: boolean;
  ready: boolean;
}

export interface UpdateDingtalkImportSettingsInput {
  appKey?: string;
  appSecret?: string;
  corpId?: string;
  defaultPassword?: string;
  idempotencyKey?: string;
}

/**
 * 钉钉导入的运行配置。
 *
 * 管理员通过系统设置写入的值直接保存；GET 接口仅返回是否已配置。旧环境变量只作为
 * 尚未迁移到系统设置前的 OAuth 兼容兜底，不会写回数据库。
 */
@Injectable()
export class DingtalkConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /** 获取 OAuth 所需应用凭证；设置中任一凭证已存在时必须三项齐全，避免混用来源。 */
  async getOAuthCredentials(): Promise<DingtalkOAuthCredentials | null> {
    const configured = await this.readConfiguredValues();
    const hasStoredValue = Object.values(configured).some((value) => value !== null);
    if (hasStoredValue) {
      if (!configured.appKey || !configured.appSecret || !configured.corpId) {
        return null;
      }
      return {
        appKey: configured.appKey,
        appSecret: configured.appSecret,
        corpId: configured.corpId,
      };
    }

    const appKey = process.env.DINGTALK_APP_KEY?.trim() ?? '';
    const appSecret = process.env.DINGTALK_APP_SECRET?.trim() ?? '';
    const corpId = process.env.DINGTALK_CORP_ID?.trim() ?? '';
    return appKey && appSecret && corpId ? { appKey, appSecret, corpId } : null;
  }

  /** 获取导入所需的应用凭证和默认密码；默认密码仅允许来自系统设置。 */
  async getImportCredentials(): Promise<(DingtalkOAuthCredentials & { defaultPassword: string }) | null> {
    const [oauth, configured] = await Promise.all([this.getOAuthCredentials(), this.readConfiguredValues()]);
    if (!oauth || !configured.defaultPassword) {
      return null;
    }
    return { ...oauth, defaultPassword: configured.defaultPassword };
  }

  /** 返回管理端配置状态，任何情况下都不回传敏感值。 */
  async getImportSettingsStatus(): Promise<DingtalkImportSettingsStatus> {
    const values = await this.readConfiguredValues();
    const appKeyConfigured = Boolean(values.appKey);
    const appSecretConfigured = Boolean(values.appSecret);
    const corpIdConfigured = Boolean(values.corpId);
    const defaultPasswordConfigured = Boolean(values.defaultPassword);
    return {
      appKeyConfigured,
      appSecretConfigured,
      corpIdConfigured,
      defaultPasswordConfigured,
      ready: appKeyConfigured && appSecretConfigured && corpIdConfigured && defaultPasswordConfigured,
    };
  }

  /**
   * 更新钉钉导入设置。空字段代表保持原值；未配置完整时无法保存不完整的凭证集，
   * 操作日志只记录变更字段名，不记录具体配置值。
   */
  async updateImportSettings(
    operatorId: number,
    input: UpdateDingtalkImportSettingsInput,
  ): Promise<DingtalkImportSettingsStatus> {
    const patches = this.normalizePatches(input);
    if (Object.keys(patches).length === 0) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: [{ field: 'patches', errors: ['请至少填写一项钉钉导入配置'] }],
      });
    }
    const current = await this.readConfiguredValues();
    const next = { ...current, ...patches };
    if (!next.appKey || !next.appSecret || !next.corpId || !next.defaultPassword) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: [{ field: 'patches', errors: ['请完整填写 AppKey、AppSecret、组织 CorpId 和默认密码'] }],
      });
    }

    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    const changedKeys = Object.keys(patches).sort();
    await executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: 'system_settings',
      scope: IDEMPOTENCY_SCOPE,
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprintPayload({ changedKeys }),
      run: async (tx) => {
        for (const [field, value] of Object.entries(patches) as Array<[DingtalkImportSettingField, string]>) {
          const key = DINGTALK_IMPORT_SETTING_KEYS[field];
          await tx.systemSetting.upsert({
            where: { key },
            create: {
              key,
              value,
              valueType: 'STRING',
              group: 'PLATFORM',
              label: this.settingLabel(field),
              sensitive: true,
              updatedBy: operatorId,
            },
            update: {
              value,
              sensitive: true,
              updatedBy: operatorId,
            },
          });
        }
        return {
          result: { updated: true as const },
          actionType: 'UPDATE' as const,
          summary: `更新了钉钉导入设置：${changedKeys.join('、')}`,
        };
      },
    });
    return this.getImportSettingsStatus();
  }

  private async readConfiguredValues(): Promise<Record<DingtalkImportSettingField, string | null>> {
    const result: Record<DingtalkImportSettingField, string | null> = {
      appKey: null,
      appSecret: null,
      corpId: null,
      defaultPassword: null,
    };
    const rows = await this.prisma.client.systemSetting.findMany({
      where: { key: { in: ALL_DINGTALK_IMPORT_SETTING_KEYS } },
      select: { key: true, value: true },
    });
    if (rows.length === 0) {
      return result;
    }
    const fieldByKey = new Map<string, DingtalkImportSettingField>(
      Object.entries(DINGTALK_IMPORT_SETTING_KEYS).map(([field, key]) => [key, field as DingtalkImportSettingField]),
    );
    for (const row of rows) {
      const field = fieldByKey.get(row.key as (typeof ALL_DINGTALK_IMPORT_SETTING_KEYS)[number]);
      if (!field) {
        continue;
      }
      result[field] = row.value;
    }
    return result;
  }

  private normalizePatches(input: UpdateDingtalkImportSettingsInput): Partial<Record<DingtalkImportSettingField, string>> {
    const entries: Array<[DingtalkImportSettingField, string | undefined, number]> = [
      ['appKey', input.appKey, IDENTITY_VALUE_MAX_LENGTH],
      ['appSecret', input.appSecret, APP_SECRET_MAX_LENGTH],
      ['corpId', input.corpId, IDENTITY_VALUE_MAX_LENGTH],
      ['defaultPassword', input.defaultPassword, DEFAULT_PASSWORD_MAX_LENGTH],
    ];
    const patches: Partial<Record<DingtalkImportSettingField, string>> = {};
    for (const [field, rawValue, maxLength] of entries) {
      if (rawValue === undefined || rawValue.trim() === '') {
        continue;
      }
      const value = rawValue.trim();
      if (value.length > maxLength) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
          fields: [{ field, errors: [`长度不能超过 ${maxLength} 个字符`] }],
        });
      }
      if (field === 'defaultPassword' && (value.length < DEFAULT_PASSWORD_MIN_LENGTH || value.length > DEFAULT_PASSWORD_MAX_LENGTH)) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
          fields: [{ field, errors: ['默认密码长度须为 8～32 位'] }],
        });
      }
      patches[field] = value;
    }
    return patches;
  }

  private settingLabel(field: DingtalkImportSettingField): string {
    const labels: Record<DingtalkImportSettingField, string> = {
      appKey: '钉钉 AppKey',
      appSecret: '钉钉 AppSecret',
      corpId: '钉钉组织 CorpId',
      defaultPassword: '钉钉导入默认密码',
    };
    return labels[field];
  }
}
