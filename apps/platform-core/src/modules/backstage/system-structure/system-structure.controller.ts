import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { IdempotentDto, SYSTEM_SETTINGS_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { IsIn } from 'class-validator';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { SystemStructureService } from './system-structure.service';

/** 系统状态调整入参 */
class UpdateSystemStatusDto extends IdempotentDto {
  /** 目标开放状态（asset/hr/fin 可调；backstage 恒开放） */
  @ApiProperty({
    description: '目标开放状态（asset/hr/fin 可调；backstage 恒开放）',
    enum: ['OPEN', 'COMING_SOON'],
  })
  @IsIn(['OPEN', 'COMING_SOON'])
  productStatus!: 'OPEN' | 'COMING_SOON';
}

/**
 * 系统开放状态管理（批次 4 起归入「系统设置」书签，权限随迁 system_settings；
 * 原「系统与业务结构」页面与说明维护接口已删除）。
 * 全部路由要求持有"系统设置"功能授权或超级管理员。
 */
@ApiTags('系统状态')
@Controller('systems')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(SYSTEM_SETTINGS_FUNCTION_CODE)
export class SystemStructureController {
  constructor(private readonly structure: SystemStructureService) {}

  /** 系统列表（编码/名称/开放状态；供系统设置书签切换状态） */
  @Get()
  listSystems(): Promise<unknown> {
    return this.structure.listSystems();
  }

  /** 调整系统开放状态（asset/hr/fin；backstage 恒开放不可调；BASE 不在目录 404） */
  @Put(':code/status')
  updateSystemStatus(
    @Param('code') systemCode: string,
    @CurrentUser() operatorId: number,
    @Body() dto: UpdateSystemStatusDto,
  ): Promise<unknown> {
    return this.structure.updateSystemStatus(operatorId, systemCode, dto.productStatus, dto.idempotencyKey);
  }
}
