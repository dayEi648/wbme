import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  CONSUMABLE_APPLY_FUNCTION_CODE,
  createPaginationResponse,
  ConsumableBatchDeleteDto,
  ConsumableCreateDto,
  ConsumableQueryDto,
  ConsumableUpdateDto,
  INVENTORY_MANAGE_FUNCTION_CODE,
  STOCK_IN_APPLY_FUNCTION_CODE,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { ConsumableService, type ConsumableInput } from './consumable.service';

/**
 * 消耗品品种（asset PRD §5；A-8）。
 * 权限：asset 功能"库存管理"（inventory_manage，公司档）——服务内断言。
 */
@Controller('consumables')
export class ConsumableController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly consumables: ConsumableService,
  ) {}

  /** 品种列表（配置管理；hasAvailableStock=true 时供申领页展示品种汇总） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: ConsumableQueryDto): Promise<unknown> {
    await assertFunctionAccess(
      this.prisma.client,
      userId,
      query.hasAvailableStock ? CONSUMABLE_APPLY_FUNCTION_CODE : INVENTORY_MANAGE_FUNCTION_CODE,
    );
    const result = await this.consumables.list(query);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /**
   * 入库申请可选品种（只返回启用品种，读取权限不等同于库存管理）。
   *
   * @param userId 当前用户
   * @param query 分页及受控筛选条件
   * @returns 分页品种列表
   */
  @Get('stock-in-options')
  async stockInOptions(@CurrentUser() userId: number, @Query() query: ConsumableQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, STOCK_IN_APPLY_FUNCTION_CODE);
    const result = await this.consumables.list({ ...query, status: 'ACTIVE', hasAvailableStock: undefined });
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /** 创建品种（幂等；名称唯一；类型创建后不可变） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: ConsumableCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.consumables.create(operator, dto as unknown as ConsumableInput);
  }

  /** 编辑品种（类型与有业务事实后的单位不可变） */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConsumableUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.consumables.update(operator, id, dto as unknown as ConsumableInput, dto.idempotencyKey);
  }

  /** 批量硬删除（存在当前库存/未结清借还/待审批引用时整批拒绝） */
  @Delete('batch')
  async batchDelete(@CurrentUser() userId: number, @Body() dto: ConsumableBatchDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.consumables.batchDelete(operator, dto.ids, dto.idempotencyKey);
  }
}
