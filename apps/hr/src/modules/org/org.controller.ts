import { Body, Controller, Get, Inject, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { EmployeeDepartmentsAssignDto, EmployeePositionAssignDto, ORG_STRUCTURE_FUNCTION_CODE, OrgEmployeeQueryDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { OrgStructureService } from './org-structure.service';

/**
 * 组织架构（hr PRD §5）：全体员工列表 + 用户部门/岗位编排。
 * 部门树的维护操作由"部门管理"功能权限控制（见 department.controller），
 * 本控制器负责用户编排与员工列表。
 * 权限：hr 功能"组织架构"（org_structure，公司档；含岗位申请审批权）——服务内断言。
 */
@Controller('org')
export class OrgController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly org: OrgStructureService,
  ) {}

  /** 全体员工列表（含部门/岗位/职称派生；关键字/部门/岗位筛选） */
  @Get('employees')
  async employees(@CurrentUser() userId: number, @Query() query: OrgEmployeeQueryDto): Promise<unknown> {
    await assertFunctionAccess(this.prisma.client, userId, ORG_STRUCTURE_FUNCTION_CODE);
    const { items, total } = await this.org.listEmployees(query);
    return {
      data: items,
      pagination: { page: query.page ?? 1, pageSize: query.pageSize ?? 20, totalItems: total, totalPages: Math.ceil(total / (query.pageSize ?? 20)) },
    };
  }

  /** 调整员工所属部门（多部门并列；岗位须适用于全部新部门） */
  @Put('employees/:userId/departments')
  async assignDepartments(
    @CurrentUser() userId: number,
    @Param('userId', ParseIntPipe) targetUserId: number,
    @Body() dto: EmployeeDepartmentsAssignDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, ORG_STRUCTURE_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.org.assignDepartments(operator, targetUserId, dto.departmentIds, dto.idempotencyKey);
  }

  /** 调整员工岗位（单岗位；须适用于其全部当前部门） */
  @Put('employees/:userId/position')
  async assignPosition(
    @CurrentUser() userId: number,
    @Param('userId', ParseIntPipe) targetUserId: number,
    @Body() dto: EmployeePositionAssignDto,
  ): Promise<{ ok: true }> {
    await assertFunctionAccess(this.prisma.client, userId, ORG_STRUCTURE_FUNCTION_CODE);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.org.assignPosition(operator, targetUserId, dto.positionId, dto.idempotencyKey);
  }
}
