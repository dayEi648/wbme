import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  CONSUMABLE_APPLY_FUNCTION_CODE,
  INVENTORY_MANAGE_FUNCTION_CODE,
  BatchCorrectionDto,
  BatchQueryDto,
  createPaginationResponse,
  InventoryItemQueryDto,
  StockFlowQueryDto,
} from '@wbme/contracts';
import { CurrentUser, EXPORT_TIMEOUT_MS, RequestTimeout } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { InventoryService } from './inventory.service';
import { StockFlowService } from './stock-flow.service';

/**
 * 消耗品库存管理（asset PRD §5；A-10/A-11/A-12/A-13）。
 * 权限：asset 功能"消耗品库存管理"（inventory_manage，公司档）——服务内断言。
 */
@Controller('inventory')
export class InventoryController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly stockFlows: StockFlowService,
  ) {}

  /** 库存条目列表（库存管理；availableOnly=true 时为员工申领目录） */
  @Get('items')
  async listItems(@CurrentUser() userId: number, @Query() query: InventoryItemQueryDto): Promise<unknown> {
    await assertFunctionAccess(
      this.prisma.client,
      userId,
      query.availableOnly ? CONSUMABLE_APPLY_FUNCTION_CODE : INVENTORY_MANAGE_FUNCTION_CODE,
    );
    const result = await this.inventory.listItems(query);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /** 批次列表（条目/品种/库位筛选；含剩余数量与追溯来源） */
  @Get('batches')
  async listBatches(@CurrentUser() userId: number, @Query() query: BatchQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const result = await this.inventory.listBatches(query);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /** 批次资料纠正（供应商/品牌/单价/备注直接纠正；规格/库位条件纠正并归并账面） */
  @Post('batches/:id/corrections')
  async correctBatch(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BatchCorrectionDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.inventory.correctBatch(operator, id, dto);
  }

  /** 库存流水列表（只追加；按品种/类型/来源/时间查询） */
  @Get('stock-flows')
  async listStockFlows(@CurrentUser() userId: number, @Query() query: StockFlowQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const result = await this.stockFlows.list(query);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /** 库存流水导出（runExport；导出全部筛选结果） */
  @Get('stock-flows/export')
  @RequestTimeout(EXPORT_TIMEOUT_MS)
  async exportStockFlows(
    @CurrentUser() userId: number,
    @Query() query: StockFlowQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    await this.stockFlows.export(userId, query, res);
  }
}
