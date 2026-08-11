import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  ASSET_CONFIG_FUNCTION_CODE,
  STOCK_CHANGE_APPLY_FUNCTION_CODE,
  STOCK_IN_APPLY_FUNCTION_CODE,
  createPaginationResponse,
  AssetDictItemBatchDeleteDto,
  AssetDictItemCreateDto,
  AssetDictItemQueryDto,
  AssetDictItemUpdateDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';
import { DictService } from './dict.service';

/**
 * 资产业务字典（asset PRD §12；A-2）。
 * 权限：asset 功能"资产配置"（asset_config，公司档）——服务内断言。
 */
@Controller('dict-items')
export class DictController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly dict: DictService,
  ) {}

  /** 字典列表（分页；类型/状态筛选） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: AssetDictItemQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const result = await this.dict.list(query);
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /**
   * 入库表单可选供应商/品牌字典项，类型由服务端固定，不能借 query 越权读取其它字典。
   *
   * @param userId 当前用户
   * @param query 分页参数
   * @param dictType 仅 SUPPLIER 或 BRAND
   * @returns 分页字典项
   */
  @Get('stock-in-options')
  async stockInOptions(
    @CurrentUser() userId: number,
    @Query() query: AssetDictItemQueryDto,
    @Query('dictType') dictType: string,
  ): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, STOCK_IN_APPLY_FUNCTION_CODE);
    if (dictType !== 'SUPPLIER' && dictType !== 'BRAND') {
      return createPaginationResponse([], 0, query.page ?? 1, query.pageSize ?? 20);
    }
    const result = await this.dict.list({ ...query, dictType, status: 'ACTIVE' });
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /**
   * 库存变更表单可选变更类型；服务端固定 CHANGE_TYPE，防止读取配置目录。
   *
   * @param userId 当前用户
   * @param query 分页参数
   * @returns 分页字典项
   */
  @Get('stock-change-options')
  async stockChangeOptions(@CurrentUser() userId: number, @Query() query: AssetDictItemQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, STOCK_CHANGE_APPLY_FUNCTION_CODE);
    const result = await this.dict.list({ ...query, dictType: 'CHANGE_TYPE', status: 'ACTIVE' });
    return createPaginationResponse(result.items, result.total, query.page ?? 1, query.pageSize ?? 20);
  }

  /** 创建字典项（幂等；同类型同名唯一） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: AssetDictItemCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.dict.create(operator, dto);
  }

  /** 编辑字典项 */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssetDictItemUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.dict.update(operator, id, dto, dto.idempotencyKey);
  }

  /** 删除前引用预览（对应业务表当前引用数；引用不阻断删除，确认后物理删除） */
  @Get('delete-preview')
  async deletePreview(@CurrentUser() userId: number, @Query('ids') idsRaw: string): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    return this.dict.deletePreview(this.parseIds(idsRaw));
  }

  /** 批量硬删除（主 PRD §2.6 确认式删除） */
  @Delete('batch')
  async batchDelete(@CurrentUser() userId: number, @Body() dto: AssetDictItemBatchDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, ASSET_CONFIG_FUNCTION_CODE);
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    return this.dict.batchDelete(operator, dto.ids, dto.idempotencyKey);
  }

  /** query 逗号分隔 ids → number[] */
  private parseIds(idsRaw: string): number[] {
    return idsRaw
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1);
  }
}
