import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { TITLE_MANAGE_FUNCTION_CODE, TitleRuleCreateDto, TitleRuleDeleteDto, TitleRuleQueryDto, TitleRuleUpdateDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { TitleRuleService } from './title-rule.service';

/**
 * 职称管理（hr PRD §8）：职称匹配规则维护（软删除；当前职称经 hr.user_titles 视图实时派生）。
 * 权限：hr 功能"职称管理"（title_manage，公司档）——服务内断言。
 */
@Controller('title-rules')
export class TitleController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly rules: TitleRuleService,
  ) {}

  /** 规则列表（分页） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: TitleRuleQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, TITLE_MANAGE_FUNCTION_CODE);
    const { items, total } = await this.rules.list(query);
    return {
      data: items,
      pagination: { page: query.page ?? 1, pageSize: query.pageSize ?? 20, totalItems: total, totalPages: Math.ceil(total / (query.pageSize ?? 20)) },
    };
  }

  /** 创建规则（幂等；条件目标须存在） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: TitleRuleCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, TITLE_MANAGE_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.rules.create(operator, {
      titleName: dto.titleName,
      departmentId: dto.departmentId,
      positionId: dto.positionId,
      roleCondition: dto.roleCondition,
      status: dto.status,
      sort: dto.sort,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** 更新规则 */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TitleRuleUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, TITLE_MANAGE_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.rules.update(operator, id, {
      titleName: dto.titleName,
      departmentId: dto.departmentId,
      positionId: dto.positionId,
      roleCondition: dto.roleCondition,
      status: dto.status,
      sort: dto.sort,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** 批量软删除规则（软删不参与匹配；不提供硬删除） */
  @Delete('delete')
  async deleteBatch(@CurrentUser() userId: number, @Body() dto: TitleRuleDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, TITLE_MANAGE_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.rules.deleteBatch(operator, dto.ids, dto.idempotencyKey);
  }
}
