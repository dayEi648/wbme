import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, DEPARTMENT_MANAGE_FUNCTION_CODE, frameworkErrors, hrErrors } from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, type HrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { bumpOrgTreeVersion, bumpUserOrgVersion } from '../../shared/org-version.service';
import { AssetDepartmentClient } from './asset-department.client';

/**
 * 部门管理服务（hr PRD §6）：
 * 部门树维护（创建/编辑/移动/停用/批量硬删除），配置类数据按主 PRD §2.6 确认式硬删除；
 * 有未删除下级时禁止删除；组织关系调整不能形成循环；
 * 父子关系/停用/删除等改变部门范围闭包的事务递增 org_tree_version（base PRD §3）。
 * 停用部门不可作为新建下级/新组织关系的选择目标（应用层 ACTIVE 过滤），
 * 但既有关系与部门范围授权继续有效（闭包视图含 DISABLED，两套逻辑分离）。
 */
@Injectable()
export class DepartmentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly assetDepartments: AssetDepartmentClient,
  ) {}

  /**
   * 查询部门树（全部部门含负责人与状态；前端组装树）。
   *
   * @returns 部门列表（含负责人快照）
   */
  async listTree(): Promise<unknown[]> {
    const departments = await this.prisma.client.department.findMany({
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      include: { departmentLeaders: { select: { userId: true, userName: true } } },
    });
    return departments.map((department) => ({
      id: department.id,
      parentId: department.parentId,
      name: department.name,
      sort: department.sort,
      status: department.status,
      leaders: department.departmentLeaders.map((leader) => ({ userId: leader.userId, name: leader.userName })),
    }));
  }

  /**
   * 创建部门（幂等）。
   *
   * @param operator 操作人
   * @param input 部门信息
   * @returns 部门 id
   * @throws RESOURCE_NOT_FOUND 父部门不存在；VALIDATION_FAILED 父部门已停用
   */
  async create(
    operator: HrOperationLogOperator,
    input: { name: string; parentId?: number; sort?: number; idempotencyKey?: string },
  ): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: DEPARTMENT_MANAGE_FUNCTION_CODE,
      scope: 'hr.department.create',
      idempotencyKey: input.idempotencyKey,
      fingerprint: JSON.stringify(input),
      run: async (tx) => {
        if (input.parentId !== undefined) {
          const parent = await tx.department.findUnique({ where: { id: input.parentId } });
          if (!parent) {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
          if (parent.status !== 'ACTIVE') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '停用部门不能作为新建下级的选择目标' });
          }
        }
        const row = await tx.department.create({
          data: {
            name: input.name,
            parentId: input.parentId ?? null,
            sort: input.sort ?? 0,
            createdBy: operator.id,
          },
        });
        await bumpOrgTreeVersion(tx);
        return {
          result: { id: row.id },
          actionType: 'CREATE' as const,
          summary: `在部门管理中新增了部门：${input.name}`,
        };
      },
    });
  }

  /**
   * 更新部门（名称/排序/启停）。
   *
   * @param operator 操作人
   * @param id 部门 id
   * @param input 更新内容
   */
  async update(
    operator: HrOperationLogOperator,
    id: number,
    input: { name?: string; sort?: number; status?: 'ACTIVE' | 'DISABLED'; idempotencyKey?: string },
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: DEPARTMENT_MANAGE_FUNCTION_CODE,
      scope: 'hr.department.update',
      idempotencyKey: input.idempotencyKey,
      fingerprint: JSON.stringify({ id, ...input }),
      run: async (tx) => {
        const existing = await tx.department.findUnique({ where: { id } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await tx.department.update({
          where: { id },
          data: {
            name: input.name ?? existing.name,
            sort: input.sort ?? existing.sort,
            status: input.status ?? existing.status,
            updatedBy: operator.id,
          },
        });
        await bumpOrgTreeVersion(tx);
        return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `更新了部门：${existing.name}` };
      },
    });
  }

  /**
   * 移动部门节点（换父级；移动前展示受影响子树由前端二次确认）。
   * 环校验：目标父级不能是自身或自身后代。
   *
   * @param operator 操作人
   * @param id 被移动部门
   * @param parentId 新父级（null/undefined 表示移到根）
   */
  async move(
    operator: HrOperationLogOperator,
    id: number,
    parentId?: number,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: DEPARTMENT_MANAGE_FUNCTION_CODE,
      scope: 'hr.department.move',
      idempotencyKey,
      fingerprint: JSON.stringify({ id, parentId }),
      run: async (tx) => {
        const existing = await tx.department.findUnique({ where: { id } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (parentId === undefined) {
          await tx.department.update({ where: { id }, data: { parentId: null, updatedBy: operator.id } });
          await bumpOrgTreeVersion(tx);
          return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `移动了部门：${existing.name}` };
        }
        const parent = await tx.department.findUnique({ where: { id: parentId } });
        if (!parent) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (parent.status !== 'ACTIVE') {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '停用部门不能作为新建下级的选择目标' });
        }
        if (parentId === id || (await this.isDescendant(tx, parentId, id))) {
          throw new BusinessException(hrErrors.ORGANIZATION_CYCLE);
        }
        await tx.department.update({ where: { id }, data: { parentId, updatedBy: operator.id } });
        await bumpOrgTreeVersion(tx);
        return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `移动了部门：${existing.name}` };
      },
    });
  }

  /**
   * 删除前引用确认（hr PRD §6：展示在职员工数/固定资产归属数/待审批申请数/职称规则引用数）。
   * 固定资产归属数经 asset 内部接口统计（M12）；asset 不可用时降级为 0 并在响应注明。
   *
   * @param ids 部门 id 列表
   * @returns 逐部门引用统计
   */
  async deletePreview(
    ids: number[],
  ): Promise<{ items: Array<{ id: number; activeEmployees: number; assetCount: number; pendingRequests: number; titleRuleRefs: number }>; assetUnavailable: boolean }> {
    const items: Array<{ id: number; activeEmployees: number; assetCount: number; pendingRequests: number; titleRuleRefs: number }> = [];
    let assetUnavailable = false;
    for (const id of ids) {
      const [activeEmployees, pendingRequests, titleRuleRefs, assetCount] = await Promise.all([
        this.prisma.client.$queryRaw<Array<{ c: number }>>`
          SELECT COUNT(*)::int AS c
          FROM hr.user_org
          WHERE department_id = ${id}
        `,
        // 申请人部门快照为 JSON 数组 [{id, name}]：jsonb_array_elements 逐元素匹配
        this.prisma.client.$queryRaw<Array<{ c: number }>>`
          SELECT COUNT(*)::int AS c
          FROM hr.approval_requests r
          WHERE r.request_type = 'POSITION_CHANGE'
            AND r.status = 'PENDING'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(r.applicant_department_snapshot) el
              WHERE (el->>'id')::int = ${id}
            )
        `,
        this.prisma.client.titleRule.count({ where: { departmentId: id, deletedAt: null } }),
        this.assetDepartments.countAssets(id),
      ]);
      if (assetCount === null) {
        assetUnavailable = true;
      }
      items.push({
        id,
        activeEmployees: activeEmployees[0]?.c ?? 0,
        assetCount: assetCount ?? 0,
        pendingRequests: pendingRequests[0]?.c ?? 0,
        titleRuleRefs: titleRuleRefs,
      });
    }
    return { items, assetUnavailable };
  }

  /**
   * 批量硬删除部门（主 PRD §2.6 配置类规则，整批成功或整批回滚）：
   * 有未删除下级时禁止删除；同一事务物理删除并递增 org_tree_version。
   * 引用清理由外键级联完成：user_departments（H-7 CASCADE）、department_leaders（H-3 CASCADE）、
   * position_departments（H-5 CASCADE）——员工变为无部门员工、岗位适用范围同步收缩；
   * 历史审批快照等不受影响（快照展示原名称）。
   *
   * @param operator 操作人
   * @param ids 目标 id 列表（1~100）
   * @returns 删除数量
   * @throws DEPARTMENT_HAS_CHILDREN 任一目标有未删除下级（整批不变更）
   */
  async deleteBatch(operator: HrOperationLogOperator, ids: number[], idempotencyKey?: string): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: DEPARTMENT_MANAGE_FUNCTION_CODE,
      scope: 'hr.department.delete',
      idempotencyKey,
      fingerprint: JSON.stringify(ids),
      run: async (tx) => {
        const existing = await tx.department.findMany({ where: { id: { in: ids } } });
        if (existing.length !== ids.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const children = await tx.department.findMany({ where: { parentId: { in: ids } } });
        if (children.length > 0) {
          throw new BusinessException(hrErrors.DEPARTMENT_HAS_CHILDREN, { departmentIds: children.map((c) => c.id) });
        }
        await tx.department.deleteMany({ where: { id: { in: ids } } });
        // 部门删除级联清空员工部门关系（用户组织事实变更）+ 部门范围闭包变更
        await bumpOrgTreeVersion(tx);
        await bumpUserOrgVersion(tx);
        // 置空固定资产的所属部门（hr PRD §6：确认后在删除事务中把业务引用置空）。
        // 必须放在事务最后一个语句：它是对 asset 的 HTTP 调用，不在本事务原子性内——
        // 若置空之前任何本地步骤失败，事务回滚且置空尚未执行，两侧保持一致；
        // 置空成功后立即提交，不一致窗口仅剩"提交瞬间失败"（跨服务原子性物理极限，M12）
        for (const id of ids) {
          await this.assetDepartments.clearAssignments(id);
        }
        return {
          result: { deleted: ids.length },
          actionType: 'DELETE' as const,
          summary: `删除了 ${ids.length} 个部门`,
        };
      },
    });
  }

  /**
   * 判断 candidateId 是否是 ancestorId 的后代（沿父链上溯）。
   *
   * @param tx 事务客户端
   * @param candidateId 候选后代
   * @param ancestorId 候选祖先
   * @returns 是否后代
   */
  private async isDescendant(tx: Prisma.TransactionClient, candidateId: number, ancestorId: number): Promise<boolean> {
    let current: number | null = candidateId;
    let guard = 0;
    while (current !== null && guard < 20) {
      if (current === ancestorId) {
        return true;
      }
      const row: { parentId: number | null } | null = await tx.department.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      current = row?.parentId ?? null;
      guard += 1;
    }
    return false;
  }
}
