import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { createPaginationResponse, ORG_STRUCTURE_FUNCTION_CODE, PaginationQueryDto, POSITION_MANAGE_FUNCTION_CODE, PositionCreateDto, PositionDeleteDto, PositionDepartmentsUpdateDto, PositionUpdateDto, TITLE_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess, getFunctionAccess } from '../../shared/cross-schema-auth';
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

  /** 岗位列表（默认只含启用；含适用部门）。
   *  只读引用对「组织架构」开放（hr PRD §7：岗位管理为独立权限，组织架构可引用岗位档案）；
   *  写操作仍仅 position_manage。 */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: PaginationQueryDto, @Query('includeDisabled') includeDisabled?: string): Promise<unknown> {
    await this.assertEitherAccess(userId);
    const result = await this.positions.list(includeDisabled === 'true');
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return createPaginationResponse(result.slice((page - 1) * pageSize, page * pageSize), result.length, page, pageSize);
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
    return this.positions.deleteBatch(operator, dto.ids, dto.idempotencyKey);
  }

  /** 岗位、职称或组织管理均可读取岗位引用，写操作仍仅岗位管理。 */
  private async assertEitherAccess(userId: number): Promise<void> {
    const manageAccess = await getFunctionAccess(this.prisma.client, userId, POSITION_MANAGE_FUNCTION_CODE);
    if (manageAccess.registered && manageAccess.allowed && manageAccess.systemOpen) {
      return;
    }
    const titleAccess = await getFunctionAccess(this.prisma.client, userId, TITLE_MANAGE_FUNCTION_CODE);
    if (titleAccess.registered && titleAccess.allowed && titleAccess.systemOpen) {
      return;
    }
    await assertFunctionAccess(this.prisma.client, userId, ORG_STRUCTURE_FUNCTION_CODE);
  }
}
