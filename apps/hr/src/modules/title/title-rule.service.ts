import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, TITLE_MANAGE_FUNCTION_CODE, TitleRuleQueryDto, frameworkErrors } from '@wbme/contracts';
import { buildTablePrismaQuery, collectTableFilterFields, normalizeTableFilters } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, type HrOperationLogOperator } from '../../shared/hr-operation-log.util';

/**
 * 职称规则服务（hr PRD §8）：
 * 维护"部门、岗位、站点角色"与职称名称之间的匹配规则（条件可部分填写，
 * 一条规则中全部非空条件须同时成立；部门条件对多部门员工任一命中即匹配）。
 * 当前职称是派生值，经 hr.user_titles 只读视图实时计算（组织/角色/规则变更后
 * 下一次查询立即得到新结果），本服务只维护规则实体。
 * 规则作为普通实体仅支持批量软删除（软删不参与匹配），不提供硬删除。
 */
@Injectable()
export class TitleRuleService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 规则列表（分页；关键字/状态筛选；含软删排除）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async list(query: TitleRuleQueryDto): Promise<{ items: unknown[]; total: number }> {
    // 结构化筛选与具名参数按字段互斥：filters 树中出现的字段以树为准（具名镜像让位）
    const structuredFields = query.filters ? collectTableFilterFields(normalizeTableFilters(query.filters)) : new Set<string>();
    const where: Prisma.TitleRuleWhereInput = { deletedAt: null };
    if (query.status && !structuredFields.has('status')) {
      where.status = query.status;
    }
    if (query.keyword && !structuredFields.has('keyword')) {
      where.titleName = { contains: query.keyword };
    }
    const tableQuery = buildTablePrismaQuery(query, {
      id: { prismaField: 'id', type: 'number' },
      titleName: { prismaField: 'titleName', type: 'text' },
      departmentId: { prismaField: 'departmentId', type: 'number' },
      positionId: { prismaField: 'positionId', type: 'number' },
      roleCondition: { prismaField: 'roleCondition', type: 'enum' },
      status: { prismaField: 'status', type: 'enum' },
      sort: { prismaField: 'sort', type: 'number' },
      createdAt: { prismaField: 'createdAt', type: 'date' },
      updatedAt: { prismaField: 'updatedAt', type: 'date' },
      // 关键字与具名 keyword 同口径：匹配职称名称
      keyword: { prismaField: 'titleName', type: 'text' },
    });
    const effectiveWhere: Prisma.TitleRuleWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.TitleRuleWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.titleRule.count({ where: effectiveWhere }),
      this.prisma.client.titleRule.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.TitleRuleOrderByWithRelationInput[] | undefined) ?? [{ sort: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /**
   * 创建规则（幂等；条件目标须存在——部门/岗位删除后条件永不命中，创建时校验）。
   *
   * @param operator 操作人
   * @param input 规则内容
   * @returns 规则 id
   */
  async create(
    operator: HrOperationLogOperator,
    input: {
      titleName: string;
      departmentId?: number;
      positionId?: number;
      roleCondition?: 'SUPER_ADMIN' | 'EMPLOYEE';
      status?: 'ACTIVE' | 'DISABLED';
      sort?: number;
      idempotencyKey?: string;
    },
  ): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: TITLE_MANAGE_FUNCTION_CODE,
      scope: 'hr.title-rule.create',
      idempotencyKey: input.idempotencyKey,
      fingerprint: JSON.stringify(input),
      run: async (tx) => {
        await this.assertConditionsExist(tx, input.departmentId, input.positionId);
        const row = await tx.titleRule.create({
          data: {
            titleName: input.titleName,
            departmentId: input.departmentId ?? null,
            positionId: input.positionId ?? null,
            roleCondition: input.roleCondition ?? null,
            status: input.status ?? 'ACTIVE',
            sort: input.sort ?? 0,
            createdBy: operator.id,
          },
        });
        return {
          result: { id: row.id },
          actionType: 'CREATE' as const,
          summary: `在职称管理中新增了规则：${input.titleName}`,
        };
      },
    });
  }

  /**
   * 更新规则。
   *
   * @param operator 操作人
   * @param id 规则 id
   * @param input 更新内容
   */
  async update(
    operator: HrOperationLogOperator,
    id: number,
    input: {
      titleName?: string;
      departmentId?: number;
      positionId?: number;
      roleCondition?: 'SUPER_ADMIN' | 'EMPLOYEE';
      status?: 'ACTIVE' | 'DISABLED';
      sort?: number;
      idempotencyKey?: string;
    },
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: TITLE_MANAGE_FUNCTION_CODE,
      scope: 'hr.title-rule.update',
      idempotencyKey: input.idempotencyKey,
      fingerprint: JSON.stringify({ id, ...input }),
      run: async (tx) => {
        const existing = await tx.titleRule.findFirst({ where: { id, deletedAt: null } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 未显式提交的条件保留原引用（既有停用部门引用不阻断其它字段编辑，hr PRD §6）
        await this.assertConditionsExist(
          tx,
          input.departmentId ?? existing.departmentId ?? undefined,
          input.positionId ?? existing.positionId ?? undefined,
          existing.departmentId ?? undefined,
        );
        await tx.titleRule.update({
          where: { id },
          data: {
            titleName: input.titleName ?? existing.titleName,
            departmentId: input.departmentId !== undefined ? input.departmentId : existing.departmentId,
            positionId: input.positionId !== undefined ? input.positionId : existing.positionId,
            roleCondition: input.roleCondition !== undefined ? input.roleCondition : existing.roleCondition,
            status: input.status ?? existing.status,
            sort: input.sort ?? existing.sort,
            updatedBy: operator.id,
          },
        });
        return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `更新了职称规则：${existing.titleName}` };
      },
    });
  }

  /**
   * 批量软删除规则（hr PRD §8：不提供硬删除；软删规则不再参与匹配）。
   *
   * @param operator 操作人
   * @param ids 目标 id 列表（1~100）
   * @returns 删除数量
   * @throws RESOURCE_NOT_FOUND 任一目标不存在或已软删（整批不变更）
   */
  async deleteBatch(operator: HrOperationLogOperator, ids: number[], idempotencyKey?: string): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: TITLE_MANAGE_FUNCTION_CODE,
      scope: 'hr.title-rule.delete',
      idempotencyKey,
      fingerprint: JSON.stringify(ids),
      run: async (tx) => {
        const existing = await tx.titleRule.findMany({ where: { id: { in: ids }, deletedAt: null } });
        if (existing.length !== ids.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await tx.titleRule.updateMany({
          where: { id: { in: ids } },
          data: { deletedAt: new Date(), deletedBy: operator.id },
        });
        return {
          result: { deleted: ids.length },
          actionType: 'DELETE' as const,
          summary: `删除了 ${ids.length} 条职称规则`,
        };
      },
    });
  }

  /** 断言条件目标存在且启用（部门被物理删除或停用后条件不再合法，创建/更新时校验；
   *  停用部门不得作为新业务归属选择目标，hr PRD §6；编辑时原引用可往返保留） */
  private async assertConditionsExist(
    tx: Prisma.TransactionClient,
    departmentId?: number,
    positionId?: number,
    currentDepartmentId?: number,
  ): Promise<void> {
    if (departmentId !== undefined) {
      const department = await tx.department.findUnique({ where: { id: departmentId } });
      if (!department) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      if (department.status !== 'ACTIVE' && departmentId !== currentDepartmentId) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '停用部门不能作为职称规则条件' });
      }
    }
    if (positionId !== undefined) {
      const position = await tx.position.findUnique({ where: { id: positionId } });
      if (!position) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
    }
  }
}
