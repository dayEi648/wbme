import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  INVENTORY_MANAGE_FUNCTION_CODE,
  WarehouseBatchDeleteDto,
  WarehouseCreateDto,
  WarehouseQueryDto,
  WarehouseUpdateDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { WarehouseService } from './warehouse.service';

/**
 * 库位树（asset PRD §5；A-9）。
 * 权限：asset 功能"资产配置"（asset_config，公司档）——服务内断言。
 */
@Controller('warehouses')
export class WarehouseController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly warehouses: WarehouseService,
  ) {}

  /** 库位树全量列表（状态过滤） */
  @Get('tree')
  async tree(@CurrentUser() userId: number, @Query() query: WarehouseQueryDto): Promise<{ items: unknown[] }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const result = await this.warehouses.tree();
    if (query.status) {
      result.items = result.items.filter((node: { status: string }) => node.status === query.status);
    }
    return result;
  }

  /** 创建库位（幂等；禁止形成父子循环） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: WarehouseCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.warehouses.create(operator, dto);
  }

  /** 编辑库位（含移动节点） */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: WarehouseUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.warehouses.update(operator, id, dto, dto.idempotencyKey);
  }

  /** 批量硬删除（存在子库位或库存/业务引用时整批拒绝） */
  @Delete('batch')
  async batchDelete(@CurrentUser() userId: number, @Body() dto: WarehouseBatchDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.warehouses.batchDelete(operator, dto.ids, dto.idempotencyKey);
  }
}
