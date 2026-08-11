import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  CONSUMABLE_APPLY_FUNCTION_CODE,
  INVENTORY_MANAGE_FUNCTION_CODE,
  PROXY_APPLY_FUNCTION_CODE,
  STOCK_CHANGE_APPLY_FUNCTION_CODE,
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

  /**
   * 普通申领可选库存条目（仅在启用品种且有可用量时返回）。
   *
   * @param userId 当前用户
   * @param query 分页和受控库存筛选
   * @returns 分页库存条目
   */
  @Get('items/claim-options')
  async claimOptions(@CurrentUser() userId: number, @Query() query: InventoryItemQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPLY_FUNCTION_CODE);
    const result = await this.inventory.listItems({ ...query, availableOnly: true });
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /**
   * 代交申领可选库存条目（权限独立于普通申领）。
   *
   * @param userId 当前用户
   * @param query 分页和受控库存筛选
   * @returns 分页库存条目
   */
  @Get('items/agent-claim-options')
  async agentClaimOptions(@CurrentUser() userId: number, @Query() query: InventoryItemQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, PROXY_APPLY_FUNCTION_CODE);
    const result = await this.inventory.listItems({ ...query, availableOnly: true });
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /**
   * 库存变更可选库存条目（仅显示当前仍有可扣减数量的条目）。
   *
   * @param userId 当前用户
   * @param query 分页和受控库存筛选
   * @returns 分页库存条目
   */
  @Get('items/stock-change-options')
  async stockChangeOptions(@CurrentUser() userId: number, @Query() query: InventoryItemQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, STOCK_CHANGE_APPLY_FUNCTION_CODE);
    const result = await this.inventory.listItems({ ...query, availableOnly: true });
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
