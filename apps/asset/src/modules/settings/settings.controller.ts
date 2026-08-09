import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { ASSET_CONFIG_FUNCTION_CODE, AssetSettingUpdateDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { SettingsService } from './settings.service';

/**
 * 资产配置-运行参数（asset PRD §12）：扫码入口地址、申领上限重置日。
 * 权限：asset 功能"资产配置"（asset_config，公司档）——服务内断言。
 */
@Controller('asset-settings')
export class SettingsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** 读取全部运行参数 */
  @Get()
  async list(@CurrentUser() userId: number): Promise<{ items: unknown[] }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    return this.settings.list();
  }

  /** 更新运行参数（写操作日志，变更可追溯操作者；重置日变更只影响之后开始的周期） */
  @Put()
  async update(@CurrentUser() userId: number, @Body() dto: AssetSettingUpdateDto): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    const updates: Array<{ key: string; value: string; label: string; valueType: 'STRING' | 'NUMBER' }> = [];
    if (dto.scanEntryUrl !== undefined) {
      updates.push({ key: 'asset.scan.entry.url', value: dto.scanEntryUrl, label: '二维码扫码入口地址', valueType: 'STRING' });
    }
    if (dto.quotaResetDay !== undefined) {
      updates.push({ key: 'asset.quota.reset.day', value: String(dto.quotaResetDay), label: '申领上限重置日（1～28）', valueType: 'NUMBER' });
    }
    if (updates.length === 0) {
      return { ok: true };
    }
    // 设置更新与操作日志同事务（主 PRD §9.3：日志随业务事务写入，日志失败整体回滚）
    return this.prisma.client.$transaction<{ ok: true }>(async (tx) => {
      for (const item of updates) {
        await this.settings.update(item.key, item.value, userId, tx);
      }
      await tx.assetOperationLog.create({
        data: {
          operatorId: operator.id,
          operatorName: operator.name,
          operatorDepartments: operator.departments as object,
          system: 'ASSET',
          feature: ASSET_CONFIG_FUNCTION_CODE,
          actionType: 'UPDATE',
          summary: `更新了资产配置：${updates.map((item) => `${item.label}=${item.value}`).join('，')}`,
        },
      });
      return { ok: true };
    });
  }
}
