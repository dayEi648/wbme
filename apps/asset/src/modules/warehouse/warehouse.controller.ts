import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  INVENTORY_MANAGE_FUNCTION_CODE,
  STOCK_IN_APPLY_FUNCTION_CODE,
  createPaginationResponse,
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
 * 权限：asset 功能"库存管理"（inventory_manage，公司档）——服务内断言。
 */
@Controller('warehouses')
export class WarehouseController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly warehouses: WarehouseService,
  ) {}

  @Get('tree')
  async tree(@CurrentUser() userId: number, @Query() query: WarehouseQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const result = await this.warehouses.tree(query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return createPaginationResponse(result.items.slice((page - 1) * pageSize, page * pageSize), result.items.length, page, pageSize);
  }

  /**
   * 入库申请可选库位树（只读引用；不放开库存管理权限）。
   *
   * @param userId 当前用户
   * @param query 分页参数
   * @returns 分页树根节点
   */
  @Get('stock-in-tree')
  async stockInTree(@CurrentUser() userId: number, @Query() query: WarehouseQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, STOCK_IN_APPLY_FUNCTION_CODE);
    const result = await this.warehouses.tree();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return createPaginationResponse(result.items.slice((page - 1) * pageSize, page * pageSize), result.items.length, page, pageSize);
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

  /** 删除前引用预览（现存库存条目/未结清借还/待审批引用数；引用不阻断删除，确认后物理删除） */
  @Get('delete-preview')
  async deletePreview(@CurrentUser() userId: number, @Query('ids') idsRaw: string): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    return this.warehouses.deletePreview(this.parseIds(idsRaw));
  }

  /** 批量硬删除（主 PRD §2.6 确认式删除；存在未删除子库位时整批拒绝） */
  @Delete('batch')
  async batchDelete(@CurrentUser() userId: number, @Body() dto: WarehouseBatchDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, INVENTORY_MANAGE_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.warehouses.batchDelete(operator, dto.ids, dto.idempotencyKey);
  }

  /** query 逗号分隔 ids → number[] */
  private parseIds(idsRaw: string): number[] {
    return idsRaw
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1);
  }
}
