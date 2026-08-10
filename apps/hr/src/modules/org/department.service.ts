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
   * 创建部门（幂等；hr PRD §6 一个部门可有多名负责人）。
   *
   * @param operator 操作人
   * @param input 部门信息（leaders = 负责人用户 id 列表，须为在职员工）
   * @returns 部门 id
   * @throws RESOURCE_NOT_FOUND 父部门不存在；VALIDATION_FAILED 父部门已停用/负责人不合法
   */
  async create(
    operator: HrOperationLogOperator,
    input: { name: string; parentId?: number; sort?: number; leaders?: number[]; idempotencyKey?: string },
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
        const leaders = await this.loadLeaders(tx, input.leaders ?? []);
        const row = await tx.department.create({
          data: {
            name: input.name,
            parentId: input.parentId ?? null,
            sort: input.sort ?? 0,
            createdBy: operator.id,
            departmentLeaders: {
              create: leaders.map((leader) => ({ userId: leader.userId, userName: leader.userName, createdBy: operator.id })),
            },
          },
        });
        await bumpOrgTreeVersion(tx);
        return {
          result: { id: row.id },
          actionType: 'CREATE' as const,
          summary: `在部门管理中新增了部门：${input.name}${leaders.length > 0 ? `（负责人 ${leaders.length} 人）` : ''}`,
        };
      },
    });
  }

  /**
   * 更新部门（名称/排序/启停/负责人；leaders 缺省 = 不改动既有负责人，显式 [] = 清空）。
   *
   * @param operator 操作人
   * @param id 部门 id
   * @param input 更新内容
   */
  async update(
    operator: HrOperationLogOperator,
    id: number,
    input: { name?: string; sort?: number; status?: 'ACTIVE' | 'DISABLED'; leaders?: number[]; idempotencyKey?: string },
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
        if (input.leaders !== undefined) {
          const leaders = await this.loadLeaders(tx, input.leaders);
          // 整组替换负责人关系（H-3 无唯一性外键约束问题：先删后建，事务内原子）
          await tx.departmentLeader.deleteMany({ where: { departmentId: id } });
          if (leaders.length > 0) {
            await tx.departmentLeader.createMany({
              data: leaders.map((leader) => ({ departmentId: id, userId: leader.userId, userName: leader.userName, createdBy: operator.id })),
            });
          }
        }
        await bumpOrgTreeVersion(tx);
        return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `更新了部门：${existing.name}` };
      },
    });
  }

  /**
   * 加载并校验负责人（须为在职员工；名称快照落库，注销后负责人名单仍按快照展示）。
   *
   * @param tx 事务客户端
   * @param userIds 负责人用户 id 列表
   * @returns 负责人快照（去重）
   * @throws VALIDATION_FAILED 任一负责人不存在或已注销
   */
  private async loadLeaders(
    tx: Prisma.TransactionClient,
    userIds: number[],
  ): Promise<Array<{ userId: number; userName: string }>> {
    if (userIds.length === 0) {
      return [];
    }
    const uniqueIds = [...new Set(userIds)];
    const rows = await tx.$queryRaw<Array<{ user_id: number; name: string }>>`
      SELECT user_id, name
      FROM backstage.user_accounts
      WHERE user_id = ANY(${uniqueIds as number[]})
        AND status = 'ACTIVE' AND deleted_at IS NULL
    `;
    if (rows.length !== uniqueIds.length) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '负责人必须为在职员工' });
    }
    return rows.map((row) => ({ userId: row.user_id, userName: row.name }));
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
   * 待审批申请数口径（L13）：按「申请人部门快照」匹配——部门是申请的**发起地**，
   * 与岗位删除预览（按 targetPositionId 变更目标）维度不同，两者对各自删除场景语义均合理。
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
        // 在职员工数口径：user_org 保留已注销行，须 JOIN 账号状态过滤（hr PRD §6）
        this.prisma.client.$queryRaw<Array<{ c: number }>>`
          SELECT COUNT(*)::int AS c
          FROM hr.user_org uo
          INNER JOIN backstage.user_accounts ua ON ua.user_id = uo.user_id
            AND ua.status = 'ACTIVE' AND ua.deleted_at IS NULL
          WHERE uo.department_id = ${id}
        `,
        // 待审批申请口径：
        // 1) 岗位变更（POSITION_CHANGE）按申请人部门快照 [{id, name}] 匹配（申请发起地）；
        // 2) 加班批次（OVERTIME）按明细部门快照匹配（hr PRD §3：加班明细快照为逐人部门）
        this.prisma.client.$queryRaw<Array<{ c: number }>>`
          SELECT COUNT(*)::int AS c
          FROM (
            SELECT r.id
            FROM hr.approval_requests r
            WHERE r.request_type = 'POSITION_CHANGE'
              AND r.status = 'PENDING'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(r.applicant_department_snapshot) el
                WHERE (el->>'id')::int = ${id}
              )
            UNION
            SELECT r.id
            FROM hr.approval_requests r
            INNER JOIN hr.overtime_items oi ON oi.request_id = r.id
            WHERE r.request_type = 'OVERTIME'
              AND r.status = 'PENDING'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(oi.department_snapshot) el
                WHERE (el->>'id')::int = ${id}
              )
          ) pending
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
   * 部门负责人关系随部门物理删除而消失，即 hr PRD §6「把部门负责人关系置空」语义
   * （部门已不存在，负责人不再属于任何被删部门；负责人用户本身不受影响）；
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
   * 判断 candidateId 是否是 ancestorId 的后代（沿父链上溯；visited 集合防环，
   * 不依赖深度上限——部门树深度超过 20 层时同样正确判定）。
   *
   * @param tx 事务客户端
   * @param candidateId 候选后代
   * @param ancestorId 候选祖先
   * @returns 是否后代
   */
  private async isDescendant(tx: Prisma.TransactionClient, candidateId: number, ancestorId: number): Promise<boolean> {
    let current: number | null = candidateId;
    const visited = new Set<number>();
    while (current !== null && !visited.has(current)) {
      if (current === ancestorId) {
        return true;
      }
      visited.add(current);
      const row: { parentId: number | null } | null = await tx.department.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      current = row?.parentId ?? null;
    }
    return false;
  }
}
