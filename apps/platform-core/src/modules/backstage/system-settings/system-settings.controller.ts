import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IdempotentDto, SYSTEM_SETTINGS_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { IsObject } from 'class-validator';
import {
  SettingsService,
  type PlatformSettingKey,
} from '../../base/settings/settings.service';
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

/**
 * 系统设置管理（backstage PRD §7）。
 */
@ApiTags('系统设置')
@Controller('system-settings')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(SYSTEM_SETTINGS_FUNCTION_CODE)
export class SystemSettingsController {
  constructor(private readonly settings: SettingsService) {}

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
}
