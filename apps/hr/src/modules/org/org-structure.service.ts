import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, ORG_STRUCTURE_FUNCTION_CODE, OrgEmployeeQueryDto, frameworkErrors, hrErrors } from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, type HrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { bumpUserOrgVersion } from '../../shared/org-version.service';

/** 组织架构员工行（经只读视图组装） */
export interface OrgEmployeeRow {
  userId: number;
  name: string;
  departmentIds: number[];
  departmentNames: string[];
  positionId: number | null;
  positionName: string | null;
  positionStatus: string | null;
  titleName: string | null;
}

/**
 * 组织架构服务（hr PRD §5）：
 * 查看全体员工（部门树维护由"部门管理"功能权限控制，本功能负责用户编排）；
 * 直接调整任意用户的所属部门（多部门并列）与岗位（单岗位）；
 * 岗位必须同时适用于其全部当前部门；员工调岗不影响历史记录查看（快照）。
 */
@Injectable()
export class OrgStructureService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 员工列表（分页；关键字/部门/岗位筛选；职称经 hr.user_titles 视图实时派生）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async listEmployees(query: OrgEmployeeQueryDto): Promise<{ items: OrgEmployeeRow[]; total: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.keyword) {
      params.push(`%${query.keyword}%`);
      where.push(`ua.name ILIKE $${params.length}`);
    }
    if (query.departmentId !== undefined) {
      params.push(query.departmentId);
      where.push(`EXISTS (SELECT 1 FROM hr.user_org uo WHERE uo.user_id = ua.user_id AND uo.department_id = $${params.length})`);
    }
    if (query.positionId !== undefined) {
      params.push(query.positionId);
      where.push(`EXISTS (SELECT 1 FROM hr.user_org uo WHERE uo.user_id = ua.user_id AND uo.position_id = $${params.length})`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const [totalRows, rows] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c
        FROM backstage.user_accounts ua
        WHERE ua.deleted_at IS NULL ${whereSql ? `AND ${whereSql.replace(/^WHERE /, '')}` : ''}
      `.then((r) => r[0]?.c ?? 0),
      this.prisma.client.$queryRaw<Array<Record<string, unknown>>>`
        SELECT ua.user_id,
               ua.name,
               ut.title_name,
               ARRAY_AGG(DISTINCT uo.department_id) FILTER (WHERE uo.department_id IS NOT NULL) AS department_ids,
               ARRAY_AGG(DISTINCT uo.department_name) FILTER (WHERE uo.department_name IS NOT NULL) AS department_names,
               MAX(uo.position_id) AS position_id,
               MAX(uo.position_name) AS position_name,
               MAX(uo.position_status) AS position_status
        FROM backstage.user_accounts ua
        LEFT JOIN hr.user_titles ut ON ut.user_id = ua.user_id
        LEFT JOIN hr.user_org uo ON uo.user_id = ua.user_id
        WHERE ua.deleted_at IS NULL ${whereSql ? `AND ${whereSql.replace(/^WHERE /, '')}` : ''}
        GROUP BY ua.user_id, ua.name, ut.title_name
        ORDER BY ua.user_id
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `,
    ]);
    return {
      total: totalRows,
      items: rows.map((row) => this.toEmployeeRow(row)),
    };
  }

  /**
   * 调整员工所属部门（多部门并列，hr PRD §5）：
   * 目标部门须存在且启用；员工当前岗位须同时适用于全部新部门。
   *
   * @param operator 操作人（组织管理员）
   * @param userId 目标员工
   * @param departmentIds 新部门集合（1~N）
   * @throws POSITION_DEPARTMENT_MISMATCH 岗位不适用于全部新部门
   */
  async assignDepartments(
    operator: HrOperationLogOperator,
    userId: number,
    departmentIds: number[],
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ORG_STRUCTURE_FUNCTION_CODE,
      scope: 'hr.org.assign-departments',
      idempotencyKey,
      fingerprint: JSON.stringify({ userId, departmentIds }),
      run: async (tx) => {
        await this.assertActiveDepartments(tx, departmentIds);
        const position = await tx.userPosition.findUnique({ where: { userId } });
        if (position?.positionId !== null && position?.positionId !== undefined) {
          const applicable = await tx.positionDepartment.findMany({
            where: { positionId: position.positionId },
            select: { departmentId: true },
          });
          const applicableSet = new Set(applicable.map((pd) => pd.departmentId));
          if (departmentIds.some((departmentId) => !applicableSet.has(departmentId))) {
            throw new BusinessException(hrErrors.POSITION_DEPARTMENT_MISMATCH);
          }
        }
        await tx.userDepartment.deleteMany({ where: { userId } });
        await tx.userDepartment.createMany({
          data: departmentIds.map((departmentId) => ({ userId, departmentId, createdBy: operator.id })),
        });
        await bumpUserOrgVersion(tx);
        return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `调整了员工 ${userId} 的所属部门` };
      },
    });
  }

  /**
   * 调整员工岗位（单岗位，hr PRD §5）：岗位须存在、启用且适用于其全部当前部门。
   *
   * @param operator 操作人（组织管理员）
   * @param userId 目标员工
   * @param positionId 新岗位
   * @throws POSITION_DEPARTMENT_MISMATCH 岗位不适用于全部当前部门
   */
  async assignPosition(
    operator: HrOperationLogOperator,
    userId: number,
    positionId: number,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ORG_STRUCTURE_FUNCTION_CODE,
      scope: 'hr.org.assign-position',
      idempotencyKey,
      fingerprint: JSON.stringify({ userId, positionId }),
      run: async (tx) => {
        const position = await tx.position.findUnique({ where: { id: positionId } });
        if (!position) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (position.status !== 'ACTIVE') {
          throw new BusinessException(hrErrors.POSITION_DEPARTMENT_MISMATCH, { reason: '岗位已停用' });
        }
        const userDepartments = await tx.userDepartment.findMany({
          where: { userId },
          select: { departmentId: true },
        });
        if (userDepartments.length > 0) {
          const applicable = await tx.positionDepartment.findMany({
            where: { positionId },
            select: { departmentId: true },
          });
          const applicableSet = new Set(applicable.map((pd) => pd.departmentId));
          if (userDepartments.some((ud) => !applicableSet.has(ud.departmentId))) {
            throw new BusinessException(hrErrors.POSITION_DEPARTMENT_MISMATCH);
          }
        }
        await tx.userPosition.upsert({
          where: { userId },
          create: { userId, positionId, assignedBy: operator.id },
          update: { positionId, assignedBy: operator.id },
        });
        await bumpUserOrgVersion(tx);
        return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `调整了员工 ${userId} 的岗位` };
      },
    });
  }

  /** 断言目标部门均存在且启用（停用部门不能作为新组织关系选择目标） */
  private async assertActiveDepartments(tx: Prisma.TransactionClient, departmentIds: number[]): Promise<void> {
    const found = await tx.department.findMany({ where: { id: { in: departmentIds } } });
    if (found.length !== departmentIds.length) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    if (found.some((department) => department.status !== 'ACTIVE')) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '停用部门不能作为新组织关系的选择目标' });
    }
  }

  /** 原始行 → 员工行（int[] 列可能为 null） */
  private toEmployeeRow(row: Record<string, unknown>): OrgEmployeeRow {
    return {
      userId: row.user_id as number,
      name: row.name as string,
      departmentIds: (row.department_ids as number[] | null) ?? [],
      departmentNames: (row.department_names as string[] | null) ?? [],
      positionId: (row.position_id as number | null) ?? null,
      positionName: (row.position_name as string | null) ?? null,
      positionStatus: (row.position_status as string | null) ?? null,
      titleName: (row.title_name as string | null) ?? null,
    };
  }
}
