import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  ASSET_CONFIG_FUNCTION_CODE,
  AssetCategoryBatchDeleteDto,
  AssetCategoryCreateDto,
  AssetCategoryQueryDto,
  AssetCategoryUpdateDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { CategoryService } from './category.service';

/**
 * 资产分类（asset PRD §3/§12；A-1）。
 * 权限：asset 功能"资产配置"（asset_config，公司档）——服务内断言。
 */
@Controller('categories')
export class CategoryController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly categories: CategoryService,
  ) {}

  /** 分类全量列表（顶级 + 一级子分类） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: AssetCategoryQueryDto): Promise<{ items: unknown[] }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const result = await this.categories.list();
    if (query.status) {
      result.items = result.items.filter((item: { status: string }) => item.status === query.status);
    }
    return result;
  }

  /** 创建一级子分类（幂等；顶级分类为系统内置） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: AssetCategoryCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.categories.create(operator, dto);
  }

  /** 编辑分类 */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssetCategoryUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.categories.update(operator, id, dto, dto.idempotencyKey);
  }

  /** 批量硬删除（任一分类被资产/品种引用则整批回滚） */
  @Delete('batch')
  async batchDelete(@CurrentUser() userId: number, @Body() dto: AssetCategoryBatchDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.categories.batchDelete(operator, dto.ids, dto.idempotencyKey);
  }
}
