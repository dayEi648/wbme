import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { HR_CONFIG_FUNCTION_CODE, HrDictCreateDto, HrDictDeleteDto, HrDictQueryDto, HrDictUpdateDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { DictService } from './dict.service';

/**
 * 人事字典（hr PRD §9）：表单只能使用启用选项；选项可新增、编辑、排序、停用，
 * 按主 PRD §2.6 批量硬删除未被引用的字典项（任一目标被引用整批拒绝）。
 * 权限：hr 功能"人事配置"（hr_config，公司档）——服务内断言。
 */
@Controller('dicts')
export class DictController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly dicts: DictService,
  ) {}

  /** 字典列表（分页） */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: HrDictQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, HR_CONFIG_FUNCTION_CODE);
    const { total, items } = await this.dicts.list(query);
    return {
      data: items,
      pagination: { page: query.page ?? 1, pageSize: query.pageSize ?? 20, totalItems: total, totalPages: Math.ceil(total / (query.pageSize ?? 20)) },
    };
  }

  /** 新增字典项（幂等） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: HrDictCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, HR_CONFIG_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.dicts.create(operator, {
      dictType: dto.dictType,
      name: dto.name,
      sort: dto.sort,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** 更新字典项（名称/排序/启停） */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: HrDictUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, HR_CONFIG_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.dicts.update(operator, id, {
      name: dto.name,
      sort: dto.sort,
      status: dto.status,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** 批量硬删除字典项（未被引用；任一目标不存在/被引用整批不变更） */
  @Delete('delete')
  async deleteBatch(@CurrentUser() userId: number, @Body() dto: HrDictDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, HR_CONFIG_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.dicts.deleteBatch(operator, dto.ids, dto.idempotencyKey);
  }
}
