import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { BusinessException, frameworkErrors, hrErrors, ORG_STRUCTURE_FUNCTION_CODE } from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, type HrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { bumpUserOrgVersion } from '../../shared/org-version.service';
import type { ApprovalHeadForSideEffect, ApprovalSideEffect } from '../approval/approval-side-effect';
import { HrApprovalService } from '../approval/hr-approval.service';

/**
 * 岗位申请服务（hr PRD §5 / base PRD §6）：
 * 员工个人中心提交岗位变更申请（每张申请固定一个目标部门 + 一个目标岗位；
 * 仅面向无部门或单部门员工）；审批通过后把员工的所属部门更新为唯一的目标部门、
 * 岗位更新为唯一的目标岗位；批准时再次校验（任一条件不再成立保持待审批并明确提示不能批准）。
 * 同一员工同时最多一条待审批岗位申请（部分唯一索引兜底并发）。
 */
@Injectable()
export class PositionApplicationService implements ApprovalSideEffect {
  /** 审批头服务（Nest DI 自动注入；测试手工构造时经 bindApprovalService 绑定——两者互相引用） */
  private approval: HrApprovalService | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // 显式 @Inject：TS 对带默认值的类类型参数发射 Object（design:paramtypes 丢失类型），
    // 无 @Inject 时 Nest 无法解析该依赖；
    // forwardRef 打破与 HrApprovalService 的构造循环（两者互相引用）
    @Optional() @Inject(forwardRef(() => HrApprovalService)) approval: HrApprovalService | null = null,
  ) {
    this.approval = approval;
  }

  /** 绑定审批头服务（测试构造顺序：先建本服务再绑定；生产 DI 自动注入无需调用） */
  bindApprovalService(approval: HrApprovalService): void {
    this.approval = approval;
  }

  /**
   * 提交岗位变更申请（幂等；内部接口/前端个人中心共用）。
   *
   * @param operator 操作人（申请人本人）
   * @param targetDepartmentId 目标部门
   * @param targetPositionId 目标岗位
   * @param idempotencyKey 幂等键
   * @returns { requestId, applicationNo }
   * @throws MULTI_DEPARTMENT_APPLY_FORBIDDEN 多部门员工不可自助申请
   * @throws POSITION_APPLY_TARGET_UNAVAILABLE 目标部门/岗位当前不可申请
   */
  async submit(
    operator: HrOperationLogOperator,
    targetDepartmentId: number,
    targetPositionId: number,
    idempotencyKey?: string,
  ): Promise<{ requestId: number; applicationNo: string }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ORG_STRUCTURE_FUNCTION_CODE,
      scope: 'hr.position-application.submit',
      idempotencyKey,
      fingerprint: JSON.stringify({ targetDepartmentId, targetPositionId }),
      run: async (tx) => {
        await this.assertSubmittable(tx, operator.id, targetDepartmentId, targetPositionId);
        const departments = await this.loadDepartments(tx, operator.id);
        if (!this.approval) {
          throw new BusinessException(frameworkErrors.INTERNAL_ERROR);
        }
        const head = await this.approval.createRequestHead(tx, {
          requestType: 'POSITION_CHANGE',
          applicantId: operator.id,
          applicantName: operator.name,
          applicantDepartmentSnapshot: departments as Prisma.InputJsonValue,
        });
        const [targetDepartment, targetPosition] = await Promise.all([
          tx.department.findUnique({ where: { id: targetDepartmentId } }),
          tx.position.findUnique({ where: { id: targetPositionId } }),
        ]);
        await tx.positionChangeRequest.create({
          data: {
            requestId: head.id,
            userId: operator.id,
            userName: operator.name,
            departmentSnapshot: departments as Prisma.InputJsonValue,
            targetDepartmentId,
            targetDepartmentName: targetDepartment!.name,
            targetPositionId,
            targetPositionName: targetPosition!.name,
          },
        });
        return {
          result: { requestId: head.id, applicationNo: head.applicationNo },
          actionType: 'CREATE' as const,
          summary: `提交了岗位变更申请：${targetDepartment!.name} / ${targetPosition!.name}`,
        };
      },
    });
  }

  /**
   * 批准副作用（ApprovalSideEffect）：事务内重校验后应用组织变更。
   * 任一条件不再成立 → 抛 POSITION_APPLY_STALE，整个 process 事务回滚、申请保持待审批。
   */
  async apply(tx: Prisma.TransactionClient, head: ApprovalHeadForSideEffect, processorId: number): Promise<void> {
    const detail = await tx.positionChangeRequest.findUnique({ where: { requestId: head.id } });
    if (!detail) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    // 1) 员工仍为无部门或单部门状态（待审批期间被管理员调整为多部门 → 不可批准）
    const currentDepartments = await tx.userDepartment.findMany({ where: { userId: detail.userId } });
    if (currentDepartments.length > 1) {
      throw new BusinessException(hrErrors.POSITION_APPLY_STALE, { reason: '员工已变为多部门归属，请由组织管理员处理' });
    }
    // 2) 目标部门仍存在且启用
    const targetDepartment = await tx.department.findUnique({ where: { id: detail.targetDepartmentId } });
    if (!targetDepartment || targetDepartment.status !== 'ACTIVE') {
      throw new BusinessException(hrErrors.POSITION_APPLY_STALE, { reason: '目标部门已停用或不存在' });
    }
    // 3) 目标岗位仍存在、启用、允许自助申请且适用于目标部门
    const targetPosition = await tx.position.findUnique({ where: { id: detail.targetPositionId } });
    if (!targetPosition || targetPosition.status !== 'ACTIVE' || !targetPosition.allowSelfApply) {
      throw new BusinessException(hrErrors.POSITION_APPLY_STALE, { reason: '目标岗位已停用或不再允许自助申请' });
    }
    const applicable = await tx.positionDepartment.findUnique({
      where: { positionId_departmentId: { positionId: detail.targetPositionId, departmentId: detail.targetDepartmentId } },
    });
    if (!applicable) {
      throw new BusinessException(hrErrors.POSITION_APPLY_STALE, { reason: '目标岗位不再适用于目标部门' });
    }
    // 生效：所属部门更新为唯一的目标部门、岗位更新为唯一的目标岗位
    await tx.userDepartment.deleteMany({ where: { userId: detail.userId } });
    await tx.userDepartment.create({
      data: { userId: detail.userId, departmentId: detail.targetDepartmentId, createdBy: processorId },
    });
    await tx.userPosition.upsert({
      where: { userId: detail.userId },
      create: { userId: detail.userId, positionId: detail.targetPositionId, assignedBy: processorId },
      update: { positionId: detail.targetPositionId, assignedBy: processorId },
    });
    await bumpUserOrgVersion(tx);
  }

  /** 提交前置校验（事务内；任一失败整批拒绝） */
  private async assertSubmittable(
    tx: Prisma.TransactionClient,
    userId: number,
    targetDepartmentId: number,
    targetPositionId: number,
  ): Promise<void> {
    const departments = await tx.userDepartment.findMany({ where: { userId } });
    if (departments.length > 1) {
      throw new BusinessException(hrErrors.MULTI_DEPARTMENT_APPLY_FORBIDDEN);
    }
    const targetDepartment = await tx.department.findUnique({ where: { id: targetDepartmentId } });
    if (!targetDepartment || targetDepartment.status !== 'ACTIVE') {
      throw new BusinessException(hrErrors.POSITION_APPLY_TARGET_UNAVAILABLE);
    }
    const targetPosition = await tx.position.findUnique({ where: { id: targetPositionId } });
    if (!targetPosition || targetPosition.status !== 'ACTIVE' || !targetPosition.allowSelfApply) {
      throw new BusinessException(hrErrors.POSITION_APPLY_TARGET_UNAVAILABLE);
    }
    const applicable = await tx.positionDepartment.findUnique({
      where: { positionId_departmentId: { positionId: targetPositionId, departmentId: targetDepartmentId } },
    });
    if (!applicable) {
      throw new BusinessException(hrErrors.POSITION_APPLY_TARGET_UNAVAILABLE);
    }
  }

  /** 员工当前部门快照 [{id, name}]（提交时快照） */
  private async loadDepartments(tx: Prisma.TransactionClient, userId: number): Promise<Array<{ id: number; name: string }>> {
    const rows = await tx.$queryRaw<Array<{ department_id: number; department_name: string }>>`
      SELECT department_id, department_name FROM hr.user_org WHERE user_id = ${userId}
    `;
    return rows.map((row) => ({ id: row.department_id, name: row.department_name }));
  }
}
