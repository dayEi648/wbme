import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
  AssetBatchDeleteDto,
  AssetCreateDto,
  AssetQueryDto,
  AssetScheduleDto,
  AssetScrapDto,
  AssetUpdateDto,
  MyAssetQueryDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { AssetService } from './asset.service';

/**
 * 固定资产台账（asset PRD §4；A-3/A-4/A-5）。
 * 权限：我的资产（my_assets，本人）/ 固定资产查看（fixed_asset_view，部门/公司）/
 * 固定资产维护（fixed_asset_maintain，部门/公司）——服务内断言。
 */
@Controller('assets')
export class AssetController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly assets: AssetService,
  ) {}

  /** 我的资产（本人档：我负责的 / 我使用的 / 全部） */
  @Get('mine')
  async listMine(@CurrentUser() userId: number, @Query() query: MyAssetQueryDto): Promise<{ items: unknown[]; total: number }> {
    return this.assets.listMine(userId, query);
  }

  /** 台账分页列表（固定资产查看/维护，部门/公司档） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: AssetQueryDto): Promise<{ items: unknown[]; total: number }> {
    return this.assets.list(userId, query);
  }

  /** 台账导出（固定资产查看/维护；导出所有未逻辑删除或全部筛选结果） */
  @Get('export')
  async export(@CurrentUser() userId: number, @Query() query: AssetQueryDto, @Res() res: Response): Promise<void> {
    await this.assets.export(userId, query, res);
  }

  /** 资产详情（含调度/变更/维修历史） */
  @Get(':id')
  async detail(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.assets.detail(userId, id);
  }

  /** 建档（幂等；金额必填；固定资产维护） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: AssetCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.assets.create(operator, userId, dto);
  }

  /** 编辑基础资料（责任人与所属部门走调度；状态仅 IDLE/IN_USE 互切或报废恢复） */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssetUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.assets.update(operator, userId, id, dto, dto.idempotencyKey);
  }

  /** 调度（责任人 + 所属部门变化强制调度记录；目标责任人须属于目标部门） */
  @Post(':id/schedule')
  async schedule(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssetScheduleDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.assets.schedule(operator, userId, id, dto, dto.idempotencyKey);
  }

  /** 报废（二次确认；业务状态非删除） */
  @Post(':id/scrap')
  async scrap(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssetScrapDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.assets.scrap(operator, userId, id, dto.confirm, dto.idempotencyKey);
  }

  /** 批量软删除（仍在使用或有业务关联整批拒绝） */
  @Delete('batch')
  async batchDelete(@CurrentUser() userId: number, @Body() dto: AssetBatchDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.assets.batchDelete(operator, userId, dto, dto.idempotencyKey);
  }
}
