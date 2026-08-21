import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, ORG_STRUCTURE_FUNCTION_CODE, OrgEmployeeQueryDto, frameworkErrors, hrErrors } from '@wbme/contracts';
import { buildTableSqlQuery, collectTableFilterFields, normalizeTableFilters, type TableSqlConditionContext, type TableSqlField } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, type HrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { bumpUserOrgVersion } from '../../shared/org-version.service';

/**
 * 员工列表结构化筛选白名单：keyword/name/status 走列表达式；
 * 部门/岗位是关联表成员关系（一人多部门），无独立列可映射，走 EXISTS 自定义谓词。
 *
 * 导出供单元测试验证字段注册与编译行为。
 */
export const ORG_EMPLOYEE_FILTER_FIELDS: Readonly<Record<string, TableSqlField>> = {
  keyword: { column: 'ua.name', type: 'text' },
  name: { column: 'ua.name', type: 'text' },
  status: { column: 'ua.status::text', type: 'enum' },
  departmentId: { type: 'number', compile: existsMembershipCompiler('hr.user_org', 'uo', 'department_id') },
  positionId: { type: 'number', compile: existsMembershipCompiler('hr.user_positions', 'up', 'position_id') },
};

/**
 * 生成「当前用户存在/不存在某关联行」的 EXISTS 谓词编译器。
 * 仅支持等于/不等于/为空/不为空；其余操作符返回 undefined，由编译器统一抛校验错误。
 *
 * @param table 关联表（带 schema 前缀）
 * @param alias 关联表别名
 * @param idColumn 关联表中的目标 id 列
 */
function existsMembershipCompiler(table: string, alias: string, idColumn: string) {
  return (context: TableSqlConditionContext): string | undefined => {
    const membership = (match?: string): string =>
      `EXISTS (SELECT 1 FROM ${table} ${alias} WHERE ${alias}.user_id = ua.user_id${match ? ` AND ${match}` : ''})`;
    const { condition, value, nextParam } = context;
    if (condition.operator === 'IS_EMPTY') return `NOT ${membership()}`;
    if (condition.operator === 'IS_NOT_EMPTY') return membership();
    if (condition.operator === 'EQUALS' || condition.operator === 'NOT_EQUALS') {
      if (typeof value !== 'number') return undefined;
      const predicate = membership(`${alias}.${idColumn} = ${nextParam(value)}`);
      return condition.operator === 'EQUALS' ? predicate : `NOT ${predicate}`;
    }
    return undefined;
  };
}

/** 组织架构员工行（经只读视图组装） */
export interface OrgEmployeeRow {
  id: number;
  userId: number;
  name: string;
  status: string;
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
   * 结构化筛选（filters）与具名参数按字段互斥：树中出现的字段以树为准，
   * 未出现的字段保持具名兼容（RemoteSelect 等直连调用方仍用具名参数）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async listEmployees(query: OrgEmployeeQueryDto): Promise<{ items: OrgEmployeeRow[]; total: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const structuredFields = query.filters ? collectTableFilterFields(normalizeTableFilters(query.filters)) : new Set<string>();
    const where: string[] = ['ua.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (query.keyword && !structuredFields.has('keyword')) {
      params.push(`%${escapeLike(query.keyword)}%`);
      where.push(`ua.name ILIKE $${params.length} ESCAPE '\\'`);
    }
    if (query.departmentId !== undefined && !structuredFields.has('departmentId')) {
      params.push(query.departmentId);
      where.push(`EXISTS (SELECT 1 FROM hr.user_org uo WHERE uo.user_id = ua.user_id AND uo.department_id = $${params.length})`);
    }
    if (query.positionId !== undefined && !structuredFields.has('positionId')) {
      params.push(query.positionId);
      // 岗位独立走 user_positions（无部门员工的岗位在 user_org 视图中无行，B4 修复）
      where.push(`EXISTS (SELECT 1 FROM hr.user_positions up WHERE up.user_id = ua.user_id AND up.position_id = $${params.length})`);
    }
    if (!structuredFields.has('status')) {
      params.push(query.status ?? 'ACTIVE');
      where.push(`ua.status::text = $${params.length}`);
    }
    let orderBySql: string | undefined;
    if (query.filters || query.sorts) {
      const compiled = buildTableSqlQuery({ filters: query.filters, sorts: query.sorts }, ORG_EMPLOYEE_FILTER_FIELDS, { parameterOffset: params.length });
      if (compiled.whereSql) {
        where.push(compiled.whereSql);
        params.push(...compiled.params);
      }
      orderBySql = compiled.orderBySql;
    }
    const whereSql = where.join(' AND ');
    const totalSql = `
      SELECT COUNT(*)::int AS c
      FROM backstage.user_accounts ua
      WHERE ${whereSql}
    `;
    const listSql = `
      SELECT ua.user_id,
             ua.name,
             ua.status::text AS status,
             ut.title_name,
             ARRAY_AGG(DISTINCT uo.department_id) FILTER (WHERE uo.department_id IS NOT NULL) AS department_ids,
             ARRAY_AGG(DISTINCT uo.department_name) FILTER (WHERE uo.department_name IS NOT NULL) AS department_names,
             MAX(up.position_id) AS position_id,
             MAX(p.name) AS position_name,
             MAX(p.status::text) AS position_status
      FROM backstage.user_accounts ua
      LEFT JOIN hr.user_titles ut ON ut.user_id = ua.user_id
      LEFT JOIN hr.user_org uo ON uo.user_id = ua.user_id
      LEFT JOIN hr.user_positions up ON up.user_id = ua.user_id
      LEFT JOIN hr.positions p ON p.id = up.position_id
      WHERE ${whereSql}
      GROUP BY ua.user_id, ua.name, ua.status, ut.title_name
      ORDER BY ${orderBySql ?? 'ua.user_id'}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const [totalRows, rows] = await Promise.all([
      this.prisma.client.$queryRawUnsafe<Array<{ c: number }>>(totalSql, ...params).then((r) => r[0]?.c ?? 0),
      this.prisma.client.$queryRawUnsafe<Array<Record<string, unknown>>>(listSql, ...params, pageSize, (page - 1) * pageSize),
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
      id: row.user_id as number,
      userId: row.user_id as number,
      name: row.name as string,
      status: row.status as string,
      departmentIds: (row.department_ids as number[] | null) ?? [],
      departmentNames: (row.department_names as string[] | null) ?? [],
      positionId: (row.position_id as number | null) ?? null,
      positionName: (row.position_name as string | null) ?? null,
      positionStatus: (row.position_status as string | null) ?? null,
      titleName: (row.title_name as string | null) ?? null,
    };
  }
}

/** LIKE 模式把通配符按字面量比较，避免关键字扩大查询语义。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
