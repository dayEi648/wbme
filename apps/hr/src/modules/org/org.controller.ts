import { Body, Controller, Get, Inject, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { BusinessException, EmployeeDepartmentsAssignDto, EmployeePositionAssignDto, FIXED_ASSET_MAINTAIN_FUNCTION_CODE, ORG_STRUCTURE_FUNCTION_CODE, OrgEmployeeQueryDto, frameworkErrors } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess } from '../../shared/cross-schema-auth';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { DepartmentClosureService } from '../../shared/department-closure.service';
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
    private readonly closures: DepartmentClosureService,
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

  /**
   * 固定资产维护可选在职员工；部门维护者只能读取其授权闭包中的员工。
   *
   * @param userId 当前用户
   * @param departmentId 可选目标部门；传入时只返回该部门成员
   * @returns 员工选择器最小字段
   * @throws VALIDATION_FAILED departmentId 非法
   */
  @Get('asset-options')
  async assetOptions(
    @CurrentUser() userId: number,
    @Query('departmentId') departmentIdRaw?: string,
  ): Promise<{ data: Array<{ id: number; name: string }> }> {
    const departmentId = this.parseOptionalPositiveId(departmentIdRaw);
    const access = await assertFunctionAccess(this.prisma.client, userId, FIXED_ASSET_MAINTAIN_FUNCTION_CODE);
    const closure = access.dataScope === 'DEPARTMENT' ? await this.closures.closureOfUser(userId) : null;
    if (access.dataScope === 'SELF') return { data: [] };
    if (departmentId !== undefined && closure && !closure.has(departmentId)) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    if (departmentId !== undefined) {
      const rows = await this.prisma.client.$queryRaw<Array<{ id: number; name: string }>>`
        SELECT ua.user_id AS id, ua.name
        FROM backstage.user_accounts ua
        INNER JOIN hr.user_org uo ON uo.user_id = ua.user_id
        WHERE ua.status = 'ACTIVE' AND ua.deleted_at IS NULL
          AND uo.department_id = ${departmentId}
        ORDER BY ua.name ASC, ua.user_id ASC
      `;
      return { data: rows };
    }
    if (closure) {
      if (closure.size === 0) return { data: [] };
      const rows = await this.prisma.client.$queryRaw<Array<{ id: number; name: string }>>`
        SELECT DISTINCT ua.user_id AS id, ua.name
        FROM backstage.user_accounts ua
        INNER JOIN hr.user_org uo ON uo.user_id = ua.user_id
        WHERE ua.status = 'ACTIVE' AND ua.deleted_at IS NULL
          AND uo.department_id = ANY(${[...closure] as number[]})
        ORDER BY ua.name ASC, ua.user_id ASC
      `;
      return { data: rows };
    }
    const rows = await this.prisma.client.$queryRaw<Array<{ id: number; name: string }>>`
      SELECT user_id AS id, name
      FROM backstage.user_accounts
      WHERE status = 'ACTIVE' AND deleted_at IS NULL
      ORDER BY name ASC, user_id ASC
    `;
    return { data: rows };
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

  /** 解析可选正整数 query，禁止 NaN、负数与小数进入跨表查询。 */
  private parseOptionalPositiveId(raw: string | undefined): number | undefined {
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: 'departmentId 必须为正整数' });
    }
    return value;
  }
}
