import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { POSITION_MANAGE_FUNCTION_CODE, PositionCreateDto, PositionDeleteDto, PositionDepartmentsUpdateDto, PositionUpdateDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { PositionService } from './position.service';

/**
 * 岗位管理（hr PRD §7）：岗位档案维护、适用部门范围、批量硬删除。
 * 权限：hr 功能"岗位管理"（position_manage，公司档）——服务内断言。
 */
@Controller('positions')
export class PositionController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly positions: PositionService,
  ) {}

  /** 岗位列表（默认只含启用；含适用部门） */
  @Get()
  async list(@CurrentUser() userId: number, @Query('includeDisabled') includeDisabled?: string): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, POSITION_MANAGE_FUNCTION_CODE);
    return this.positions.list(includeDisabled === 'true');
  }

  /** 创建岗位（幂等；岗位名唯一） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: PositionCreateDto): Promise<{ id: number }> {
    await assertFunctionAccess(this.prisma.client, userId, POSITION_MANAGE_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.positions.create(operator, {
      name: dto.name,
      description: dto.description,
      status: dto.status,
      sort: dto.sort,
      allowSelfApply: dto.allowSelfApply,
      departmentIds: dto.departmentIds,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** 更新岗位（名称/说明/启停/排序/是否允许自助申请） */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PositionUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, POSITION_MANAGE_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.positions.update(operator, id, {
      name: dto.name,
      description: dto.description,
      status: dto.status,
      sort: dto.sort,
      allowSelfApply: dto.allowSelfApply,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** 更新岗位适用部门（修改前校验全部在岗员工兼容性，不兼容整次拒绝并返回受影响员工） */
  @Put(':id/departments')
  async updateDepartments(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PositionDepartmentsUpdateDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, POSITION_MANAGE_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.positions.updateDepartments(operator, id, dto.departmentIds, dto.idempotencyKey);
  }

  /** 删除前引用确认（在岗员工数/待审批岗位申请数/职称规则引用数） */
  @Get('delete-preview')
  async deletePreview(@CurrentUser() userId: number, @Query('ids') idsRaw: string): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, POSITION_MANAGE_FUNCTION_CODE);
    const ids = idsRaw
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1);
    return this.positions.deletePreview(ids);
  }

  /** 批量硬删除岗位（在岗员工岗位置空；待审批岗位申请保留但批准时失败） */
  @Delete('delete')
  async deleteBatch(@CurrentUser() userId: number, @Body() dto: PositionDeleteDto): Promise<{ deleted: number }> {
    await assertFunctionAccess(this.prisma.client, userId, POSITION_MANAGE_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.positions.deleteBatch(operator, dto.ids);
  }
}
