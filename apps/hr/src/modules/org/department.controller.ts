import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { DEPARTMENT_MANAGE_FUNCTION_CODE, DepartmentCreateDto, DepartmentDeleteDto, DepartmentMoveDto, DepartmentUpdateDto, ORG_STRUCTURE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess, getFunctionAccess } from '../../shared/cross-schema-auth';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { DepartmentService } from './department.service';

/**
 * 部门管理（hr PRD §6）：部门树维护（创建/编辑/移动/停用/批量硬删除），
 * 配置类数据按主 PRD §2.6 确认式硬删除。
 * 权限：hr 功能"部门管理"（department_manage，公司档）——服务内断言。
 */
@Controller('departments')
export class DepartmentController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly departments: DepartmentService,
  ) {}

  /** 部门树（组织架构与部门管理功能任一可见；含负责人与状态） */
  @Get('tree')
  async tree(@CurrentUser() userId: number): Promise<unknown> {
    await this.assertEitherAccess(userId);
    return this.departments.listTree();
  }

  /** 创建部门（幂等；停用部门不能作为新建下级目标） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: DepartmentCreateDto): Promise<{ id: number }> {
    await this.assertDepartmentManage(userId);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.departments.create(operator, {
      name: dto.name,
      parentId: dto.parentId,
      sort: dto.sort,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** 更新部门（名称/排序/启停；停用后不可作为新选择目标） */
  @Put(':id')
  async update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DepartmentUpdateDto,
  ): Promise<{ ok: true }> {
    await this.assertDepartmentManage(userId);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.departments.update(operator, id, {
      name: dto.name,
      sort: dto.sort,
      status: dto.status,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** 移动部门节点（换父级；页面展示受影响子树并二次确认） */
  @Put(':id/move')
  async move(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DepartmentMoveDto,
  ): Promise<{ ok: true }> {
    await this.assertDepartmentManage(userId);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.departments.move(operator, id, dto.parentId, dto.idempotencyKey);
  }

  /** 删除前引用确认（在职员工数/资产数/待审批数/职称规则引用数） */
  @Get('delete-preview')
  async deletePreview(@CurrentUser() userId: number, @Query('ids') idsRaw: string): Promise<unknown> {
    await this.assertDepartmentManage(userId);
    return this.departments.deletePreview(this.parseIds(idsRaw));
  }

  /** 批量硬删除部门（有未删除下级时整批不变更） */
  @Delete('delete')
  async deleteBatch(@CurrentUser() userId: number, @Body() dto: DepartmentDeleteDto): Promise<{ deleted: number }> {
    await this.assertDepartmentManage(userId);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.departments.deleteBatch(operator, dto.ids);
  }

  /** 断言持有部门管理功能 */
  private async assertDepartmentManage(userId: number): Promise<void> {
    await assertFunctionAccess(this.prisma.client, userId, DEPARTMENT_MANAGE_FUNCTION_CODE);
  }

  /** 组织架构或部门管理任一功能即可查看部门树（hr PRD §5 功能入口规则） */
  private async assertEitherAccess(userId: number): Promise<void> {
    const departmentAccess = await getFunctionAccess(this.prisma.client, userId, DEPARTMENT_MANAGE_FUNCTION_CODE);
    if (departmentAccess.registered && departmentAccess.allowed && departmentAccess.systemOpen) {
      return;
    }
    await assertFunctionAccess(this.prisma.client, userId, ORG_STRUCTURE_FUNCTION_CODE);
  }

  /** query 逗号分隔 ids → number[] */
  private parseIds(idsRaw: string): number[] {
    return idsRaw
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1);
  }
}
