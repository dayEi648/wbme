import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { createPaginationResponse, DEPARTMENT_MANAGE_FUNCTION_CODE, DepartmentCreateDto, DepartmentDeleteDto, DepartmentMoveDto, DepartmentUpdateDto, FIXED_ASSET_MAINTAIN_FUNCTION_CODE, ORG_STRUCTURE_FUNCTION_CODE, PaginationQueryDto, POSITION_MANAGE_FUNCTION_CODE, TITLE_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess, getFunctionAccess } from '../../shared/cross-schema-auth';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { DepartmentClosureService } from '../../shared/department-closure.service';
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
    private readonly closures: DepartmentClosureService,
  ) {}

  /** 部门树（组织架构与部门管理功能任一可见；含负责人与状态） */
  @Get('tree')
  async tree(@CurrentUser() userId: number, @Query() query: PaginationQueryDto): Promise<unknown> {
    await this.assertEitherAccess(userId);
    const result = await this.departments.listTree();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return createPaginationResponse(result.slice((page - 1) * pageSize, page * pageSize), result.length, page, pageSize);
  }

  /**
   * 固定资产维护可选部门树，按固定资产维护的数据范围裁剪，只返回表单所需字段。
   *
   * @param userId 当前用户
   * @returns 扁平部门树节点
   */
  @Get('asset-options')
  async assetOptions(@CurrentUser() userId: number): Promise<{ data: unknown[] }> {
    const access = await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const items = await this.departments.listTree() as Array<{ id: number }>;
    if (access.dataScope === 'DEPARTMENT') {
      const closure = await this.closures.closureOfUser(userId);
      return { data: items.filter((item) => closure.has(item.id)) };
    }
    if (access.dataScope === 'SELF') return { data: [] };
    return { data: items };
  }

  /**
   * 部门负责人选择器（仅在职员工的最小展示字段）。
   *
   * @param userId 当前用户
   * @returns 员工选项
   */
  @Get('leader-options')
  async leaderOptions(@CurrentUser() userId: number): Promise<{ data: Array<{ id: number; name: string }> }> {
    await this.assertDepartmentManage(userId);
    const rows = await this.prisma.client.$queryRaw<Array<{ id: number; name: string }>>`
      SELECT user_id AS id, name
      FROM backstage.user_accounts
      WHERE status = 'ACTIVE' AND deleted_at IS NULL
      ORDER BY name ASC, user_id ASC
    `;
    return { data: rows };
  }

  /** 创建部门（幂等；停用部门不能作为新建下级目标；可设置多名负责人） */
  @Post()
  async create(@CurrentUser() userId: number, @Body() dto: DepartmentCreateDto): Promise<{ id: number }> {
    await this.assertDepartmentManage(userId);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.departments.create(operator, {
      name: dto.name,
      parentId: dto.parentId,
      sort: dto.sort,
      leaders: dto.leaders,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** 更新部门（名称/排序/启停/负责人；停用后不可作为新选择目标） */
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
      leaders: dto.leaders,
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
    return this.departments.deleteBatch(operator, dto.ids, dto.idempotencyKey);
  }

  /** 断言持有部门管理功能 */
  private async assertDepartmentManage(userId: number): Promise<void> {
    await assertFunctionAccess(this.prisma.client, userId, DEPARTMENT_MANAGE_FUNCTION_CODE);
  }

  /** 需要引用部门树的组织、部门、岗位或职称管理功能均可读取；写操作仍仅部门管理。 */
  private async assertEitherAccess(userId: number): Promise<void> {
    for (const functionCode of [DEPARTMENT_MANAGE_FUNCTION_CODE, POSITION_MANAGE_FUNCTION_CODE, TITLE_MANAGE_FUNCTION_CODE]) {
      const access = await getFunctionAccess(this.prisma.client, userId, functionCode);
      if (access.registered && access.allowed && access.systemOpen) return;
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
