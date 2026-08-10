import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { FINANCE_CONFIG_FUNCTION_CODE, FinDictItemBatchDeleteDto, FinDictItemCreateDto, FinDictItemQueryDto, FinDictItemUpdateDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadFinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { DictService } from './dict.service';

/**
 * 财务业务字典（fin PRD §6；F-6）。
 * 权限：fin 功能“财务配置”（finance_config，公司档）——服务内断言。
 */
@Controller('finance-dict-items')
export class DictController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly dict: DictService,
  ) {}

  /** 字典列表（分页；类型/状态筛选） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: FinDictItemQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, FINANCE_CONFIG_FUNCTION_CODE);
    return this.dict.list(query);
  }

  /** 创建字典项（PROGRESS 必填金额语义；业务分类不得叫“未分类”） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: FinDictItemCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, FINANCE_CONFIG_FUNCTION_CODE);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.dict.create(operator, dto);
  }

  /** 编辑字典项（名称/语义/排序/启停；进度语义被引用后不可修改） */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FinDictItemUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, FINANCE_CONFIG_FUNCTION_CODE);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.dict.update(operator, id, dto);
  }

  /** 批量硬删除（任一被项目引用则整批拒绝；地区为跨系统唯一维护点） */
  @Delete('batch')
  async batchDelete(@CurrentUser() userId: number, @Body() dto: FinDictItemBatchDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, FINANCE_CONFIG_FUNCTION_CODE);
    const operator = await loadFinOperationLogOperator(this.prisma.client, userId);
    return this.dict.batchDelete(operator, dto.ids, dto.idempotencyKey);
  }
}
