import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, POSITION_MANAGE_FUNCTION_CODE, frameworkErrors, hrErrors } from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, type HrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { bumpUserOrgVersion } from '../../shared/org-version.service';

/**
 * 岗位管理服务（hr PRD §7）：
 * 岗位名称/说明/启停/排序/是否允许自助申请/适用部门范围维护；
 * 修改适用部门前校验全部在岗员工兼容性（岗位须同时适用于员工全部当前部门，
 * 不允许通过配置变更制造违反 hr PRD §5 的现存组织关系）；
 * 批量硬删除按主 PRD §2.6：在岗员工岗位置空（FK SET NULL）、待审批岗位申请保留但批准时失败。
 */
@Injectable()
export class PositionService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 岗位列表（含适用部门）。
   *
   * @param includeDisabled 是否包含停用岗位（默认只含启用）
   * @returns 岗位列表
   */
  async list(includeDisabled = false): Promise<unknown[]> {
    const positions = await this.prisma.client.position.findMany({
      where: includeDisabled ? undefined : { status: 'ACTIVE' },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      include: { positionDepartments: { select: { departmentId: true } } },
    });
    return positions.map((position) => ({
      id: position.id,
      name: position.name,
      description: position.description,
      status: position.status,
      sort: position.sort,
      allowSelfApply: position.allowSelfApply,
      departmentIds: position.positionDepartments.map((pd) => pd.departmentId),
    }));
  }

  /**
   * 创建岗位（幂等）。
   *
   * @param operator 操作人
   * @param input 岗位信息（含适用部门）
   * @returns 岗位 id
   * @throws VALIDATION_FAILED 岗位名已存在（唯一约束）
   */
  async create(
    operator: HrOperationLogOperator,
    input: {
      name: string;
      description?: string;
      status?: 'ACTIVE' | 'DISABLED';
      sort?: number;
      allowSelfApply?: boolean;
      departmentIds?: number[];
      idempotencyKey?: string;
    },
  ): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: POSITION_MANAGE_FUNCTION_CODE,
      scope: 'hr.position.create',
      idempotencyKey: input.idempotencyKey,
      fingerprint: JSON.stringify(input),
      run: async (tx) => {
        await this.assertDepartmentsExist(tx, input.departmentIds ?? []);
        try {
          const row = await tx.position.create({
            data: {
              name: input.name,
              description: input.description ?? null,
              status: input.status ?? 'ACTIVE',
              sort: input.sort ?? 0,
              allowSelfApply: input.allowSelfApply ?? false,
              createdBy: operator.id,
              positionDepartments: {
                create: (input.departmentIds ?? []).map((departmentId) => ({ departmentId })),
              },
            },
          });
          return {
            result: { id: row.id },
            actionType: 'CREATE' as const,
            summary: `在岗位管理中新增了岗位：${input.name}`,
          };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '岗位名称已存在' });
          }
          throw error;
        }
      },
    });
  }

  /**
   * 更新岗位（名称/说明/启停/排序/是否允许自助申请）。
   *
   * @param operator 操作人
   * @param id 岗位 id
   * @param input 更新内容
   */
  async update(
    operator: HrOperationLogOperator,
    id: number,
    input: {
      name?: string;
      description?: string;
      status?: 'ACTIVE' | 'DISABLED';
      sort?: number;
      allowSelfApply?: boolean;
      idempotencyKey?: string;
    },
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: POSITION_MANAGE_FUNCTION_CODE,
      scope: 'hr.position.update',
      idempotencyKey: input.idempotencyKey,
      fingerprint: JSON.stringify({ id, ...input }),
      run: async (tx) => {
        const existing = await tx.position.findUnique({ where: { id } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        try {
          await tx.position.update({
            where: { id },
            data: {
              name: input.name ?? existing.name,
              description: input.description !== undefined ? input.description : existing.description,
              status: input.status ?? existing.status,
              sort: input.sort ?? existing.sort,
              allowSelfApply: input.allowSelfApply ?? existing.allowSelfApply,
              updatedBy: operator.id,
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '岗位名称已存在' });
          }
          throw error;
        }
        return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `更新了岗位：${existing.name}` };
      },
    });
  }

  /**
   * 更新岗位适用部门（hr PRD §7）：
   * 修改前校验当前仍分配该岗位的全部员工——若修改后岗位不再同时适用于某员工
   * 的全部所属部门，则整次修改拒绝并返回受影响员工。
   *
   * @param operator 操作人
   * @param id 岗位 id
   * @param departmentIds 新的适用部门集合
   * @throws POSITION_DEPARTMENT_MISMATCH 存在受影响在岗员工（details 携带 affectedUserIds）
   */
  async updateDepartments(
    operator: HrOperationLogOperator,
    id: number,
    departmentIds: number[],
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: POSITION_MANAGE_FUNCTION_CODE,
      scope: 'hr.position.departments',
      idempotencyKey,
      fingerprint: JSON.stringify({ id, departmentIds }),
      run: async (tx) => {
        const existing = await tx.position.findUnique({ where: { id } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await this.assertDepartmentsExist(tx, departmentIds);
        const targetSet = new Set(departmentIds);
        // 当前分配该岗位的全部员工（在职视角：user_positions 行即分配事实）
        const holders = await tx.userPosition.findMany({
          where: { positionId: id },
          select: { userId: true },
        });
        const affected: number[] = [];
        for (const holder of holders) {
          const userDepartments = await tx.userDepartment.findMany({
            where: { userId: holder.userId },
            select: { departmentId: true },
          });
          // 无部门员工不受影响；岗位须同时适用于其全部当前部门
          if (userDepartments.length > 0 && userDepartments.some((ud) => !targetSet.has(ud.departmentId))) {
            affected.push(holder.userId);
          }
        }
        if (affected.length > 0) {
          throw new BusinessException(hrErrors.POSITION_DEPARTMENT_MISMATCH, { affectedUserIds: affected });
        }
        await tx.positionDepartment.deleteMany({ where: { positionId: id } });
        if (departmentIds.length > 0) {
          await tx.positionDepartment.createMany({
            data: departmentIds.map((departmentId) => ({ positionId: id, departmentId })),
          });
        }
        return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `更新了岗位适用部门：${existing.name}` };
      },
    });
  }

  /**
   * 删除前引用确认（hr PRD §7：当前分配员工数/待审批岗位申请数/职称规则引用数）。
   *
   * @param ids 岗位 id 列表
   * @returns 逐岗位引用统计
   */
  async deletePreview(
    ids: number[],
  ): Promise<{ items: Array<{ id: number; assignedEmployees: number; pendingRequests: number; titleRuleRefs: number }> }> {
    const items: Array<{ id: number; assignedEmployees: number; pendingRequests: number; titleRuleRefs: number }> = [];
    for (const id of ids) {
      const [assignedEmployees, pendingRequests, titleRuleRefs] = await Promise.all([
        this.prisma.client.userPosition.count({ where: { positionId: id } }),
        this.prisma.client.positionChangeRequest.count({
          where: { targetPositionId: id, request: { status: 'PENDING' } },
        }),
        this.prisma.client.titleRule.count({ where: { positionId: id, deletedAt: null } }),
      ]);
      items.push({ id, assignedEmployees, pendingRequests, titleRuleRefs });
    }
    return { items };
  }

  /**
   * 批量硬删除岗位（主 PRD §2.6，整批成功或整批回滚）：
   * 在岗员工岗位置空（H-8 FK ON DELETE SET NULL）、岗位适用部门级联删除；
   * 仍引用该岗位的待审批岗位申请保留——批准时校验"目标岗位仍存在且启用"失败，
   * 只能驳回或由申请人取消（删除确认中已提示）。
   *
   * @param operator 操作人
   * @param ids 目标 id 列表（1~100）
   * @returns 删除数量
   * @throws RESOURCE_NOT_FOUND 任一目标不存在（整批不变更）
   */
  async deleteBatch(operator: HrOperationLogOperator, ids: number[], idempotencyKey?: string): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: POSITION_MANAGE_FUNCTION_CODE,
      scope: 'hr.position.delete',
      idempotencyKey,
      fingerprint: JSON.stringify(ids),
      run: async (tx) => {
        const existing = await tx.position.findMany({ where: { id: { in: ids } } });
        if (existing.length !== ids.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        await tx.position.deleteMany({ where: { id: { in: ids } } });
        // 岗位删除经 FK SetNull 置空在岗员工岗位：用户组织事实变更，递增用户组织版本（base PRD §3）
        await bumpUserOrgVersion(tx);
        return {
          result: { deleted: ids.length },
          actionType: 'DELETE' as const,
          summary: `删除了 ${ids.length} 个岗位`,
        };
      },
    });
  }

  /** 断言适用部门均存在（创建/更新适用部门前置校验） */
  private async assertDepartmentsExist(tx: Prisma.TransactionClient, departmentIds: number[]): Promise<void> {
    if (departmentIds.length === 0) {
      return;
    }
    const found = await tx.department.findMany({ where: { id: { in: departmentIds } } });
    if (found.length !== departmentIds.length) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
  }
}
