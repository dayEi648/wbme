import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  FIXED_ASSET_MAINTAIN_FUNCTION_CODE,
  createPaginationResponse,
  RepairCancelDto,
  RepairOrderCreateDto,
  RepairOrderQueryDto,
  RepairStartDto,
  RepairCompleteDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { RepairService } from './repair.service';

/**
 * 固定资产维修管理（asset PRD §4；A-6/A-7）。
 * 权限：「固定资产维护」（fixed_asset_maintain，部门/公司档）——服务内断言。
 */
@Controller('repair-orders')
export class RepairController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly repairs: RepairService,
  ) {}

  /** 登记维修（幂等；仅闲置/使用中资产；同一资产最多一张进行中维修单） */
  @Post()
  async register(@CurrentUser() userId: number, @Body() dto: RepairOrderCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.repairs.register(operator, userId, dto);
  }

  /** 取消登记（待维修 → 已取消终态；资产恢复登记前状态） */
  @Post(':id/cancel')
  async cancel(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RepairCancelDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.repairs.cancel(operator, userId, id, dto.idempotencyKey);
  }

  /** 开始维修（待维修 → 维修中；资产转维修中） */
  @Post(':id/start')
  async start(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number, @Body() dto: RepairStartDto): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.repairs.start(operator, userId, id, dto.startedAt, dto.idempotencyKey);
  }

  /** 维修完成（维修中 → 已完成；填写结果/费用并选择恢复状态） */
  @Post(':id/complete')
  async complete(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RepairCompleteDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.repairs.complete(operator, userId, id, dto, dto.idempotencyKey);
  }

  /** 维修单列表（按资产/状态筛选） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: RepairOrderQueryDto): Promise<unknown> {
    const result = await this.repairs.list(userId, query);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /** 维修单详情（含状态流转历史） */
  @Get(':id')
  async detail(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.repairs.detail(userId, id);
  }
}
