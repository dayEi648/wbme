import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { IdempotentDto, SYSTEM_STRUCTURE_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { IsIn, IsString, MaxLength } from 'class-validator';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { SystemStructureService } from './system-structure.service';

/** 系统状态调整入参 */
class UpdateSystemStatusDto extends IdempotentDto {
  /** 目标开放状态（asset/hr/fin 可调；backstage 恒开放） */
  @IsIn(['OPEN', 'COMING_SOON'])
  productStatus!: 'OPEN' | 'COMING_SOON';
}

/** 业务说明维护入参（板块/功能共用；空白 = 清除） */
class UpdateDescriptionDto extends IdempotentDto {
  /** 业务说明（≤500；空白字符串清除为 NULL） */
  @IsString()
  @MaxLength(500)
  description!: string;
}

/**
 * 系统与业务结构管理（backstage PRD §6；实现规划 T3-7）。
 * 全部路由要求持有"系统与业务结构管理"功能授权或超级管理员。
 */
@ApiTags('系统与业务结构')
@Controller('systems')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(SYSTEM_STRUCTURE_MANAGE_FUNCTION_CODE)
export class SystemStructureController {
  constructor(private readonly structure: SystemStructureService) {}

  /** 系统与业务结构树（系统 → 板块 → 功能，按目录排序） */
  @Get()
  listStructure(): Promise<unknown> {
    return this.structure.listStructure();
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

  /** 维护业务板块的业务说明 */
  @Put(':systemCode/sections/:sectionCode/description')
  updateSectionDescription(
    @Param('systemCode') systemCode: string,
    @Param('sectionCode') sectionCode: string,
    @CurrentUser() operatorId: number,
    @Body() dto: UpdateDescriptionDto,
  ): Promise<unknown> {
    return this.structure.updateSectionDescription(operatorId, systemCode, sectionCode, dto.description, dto.idempotencyKey);
  }

  /** 维护功能的业务说明 */
  @Put('functions/:functionCode/description')
  updateFunctionDescription(
    @Param('functionCode') functionCode: string,
    @CurrentUser() operatorId: number,
    @Body() dto: UpdateDescriptionDto,
  ): Promise<unknown> {
    return this.structure.updateFunctionDescription(operatorId, functionCode, dto.description, dto.idempotencyKey);
  }
}
