import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IdempotentDto, SYSTEM_SETTINGS_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  SettingsService,
  type PlatformSettingKey,
} from '../../base/settings/settings.service';
import { DingtalkConfigService } from '../../base/dingtalk/dingtalk-config.service';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';

class UpdatePlatformSettingsDto extends IdempotentDto {
  /** 键值补丁（仅允许 PLATFORM 组键） */
  @ApiProperty({
    description: '键值补丁（仅允许 PLATFORM 组键）',
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  @IsObject()
  patches!: Partial<Record<PlatformSettingKey, number>>;
}

/** 钉钉导入敏感配置：空字符串表示保持现有值，接口绝不返回已保存的明文。 */
class UpdateDingtalkImportSettingsDto extends IdempotentDto {
  @ApiPropertyOptional({ description: '钉钉企业内部应用 AppKey', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  appKey?: string;

  @ApiPropertyOptional({ description: '钉钉企业内部应用 AppSecret', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  appSecret?: string;

  @ApiPropertyOptional({ description: '钉钉组织 CorpId', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  corpId?: string;

  @ApiPropertyOptional({ description: '导入员工时使用的默认密码（8～32 位）', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  defaultPassword?: string;
}

/**
 * 系统设置管理（backstage PRD §7）。
 */
@ApiTags('系统设置')
@Controller('system-settings')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(SYSTEM_SETTINGS_FUNCTION_CODE)
export class SystemSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly dingtalkConfig: DingtalkConfigService,
  ) {}

  /** 列出全部平台设置项 */
  @Get()
  list(): Promise<unknown> {
    return this.settings.listPlatformSettings();
  }

  /** 批量更新平台设置 */
  @Put()
  update(@CurrentUser() operatorId: number, @Body() dto: UpdatePlatformSettingsDto): Promise<unknown> {
    return this.settings.updatePlatformSettings(operatorId, dto.patches, dto.idempotencyKey);
  }

  /** 获取钉钉导入配置状态；仅返回是否已配置，不泄露 AppSecret 或默认密码。 */
  @Get('dingtalk-import')
  getDingtalkImportSettings(): Promise<unknown> {
    return this.dingtalkConfig.getImportSettingsStatus();
  }

  /** 更新钉钉导入配置；接口不回传已保存的明文。 */
  @Put('dingtalk-import')
  updateDingtalkImportSettings(
    @CurrentUser() operatorId: number,
    @Body() dto: UpdateDingtalkImportSettingsDto,
  ): Promise<unknown> {
    return this.dingtalkConfig.updateImportSettings(operatorId, dto);
  }
}
