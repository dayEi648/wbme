import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  INVENTORY_MANAGE_FUNCTION_CODE,
  createPaginationResponse,
  InventoryTransferCreateDto,
  InventoryTransferQueryDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { TransferService } from './transfer.service';

/**
 * 轻量库存调拨（asset PRD §6；A-14/A-15）。
 * 权限：asset 功能"消耗品库存管理"（inventory_manage，公司档）——服务内断言；
 * 前端是否显示按钮不构成授权依据，创建与查看接口都由服务端重新校验。
 */
@Controller('asset/inventory-transfers')
export class TransferController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly transfers: TransferService,
  ) {}

  /** 创建调拨（幂等；事务内重算可用量；超限/并发 CONFLICT） */
  @Post()
  async create(
    @CurrentUser() userId: number,
    @Body() dto: InventoryTransferCreateDto,
  ): Promise<{ transferId: number; fromInventoryItemId: number; toInventoryItemId: number; qty: number }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.transfers.create(operator, dto);
  }

  /** 调拨记录列表（按时间倒序） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: InventoryTransferQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const result = await this.transfers.list(query);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /** 调拨详情（批次分配明细 + 成对流水） */
  @Get(':id')
  async detail(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    return this.transfers.detail(id);
  }
}
