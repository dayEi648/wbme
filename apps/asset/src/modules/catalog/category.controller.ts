import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  ASSET_CONFIG_FUNCTION_CODE,
  AssetCategoryBatchDeleteDto,
  AssetCategoryCreateDto,
  AssetCategoryQueryDto,
  AssetCategoryUpdateDto,
  createPaginationResponse,
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
  async list(@CurrentUser() userId: number, @Query() query: AssetCategoryQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const result = await this.categories.list();
    if (query.status) {
      result.items = result.items.filter((item: { status: string }) => item.status === query.status);
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return createPaginationResponse(result.items.slice((page - 1) * pageSize, page * pageSize), result.items.length, page, pageSize);
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

  /** 删除前引用预览（现存资产/品种数；引用不阻断删除，确认后物理删除） */
  @Get('delete-preview')
  async deletePreview(@CurrentUser() userId: number, @Query('ids') idsRaw: string): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    return this.categories.deletePreview(this.parseIds(idsRaw));
  }

  /** 批量硬删除（主 PRD §2.6 确认式删除） */
  @Delete('batch')
  async batchDelete(@CurrentUser() userId: number, @Body() dto: AssetCategoryBatchDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.categories.batchDelete(operator, dto.ids, dto.idempotencyKey);
  }

  /** query 逗号分隔 ids → number[] */
  private parseIds(idsRaw: string): number[] {
    return idsRaw
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1);
  }
}
