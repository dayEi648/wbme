import { Inject, Injectable } from '@nestjs/common';
import {
  APPLICATION_NO_PREFIX_PROFILE_CHANGE,
  assertOpinionIfRequired,
  assertPending,
  assertTransitionAllowed,
  generateApplicationNo,
  isPrismaUniqueViolation,
  resolveProcessTransition,
  throwIfTransitionLost,
} from '@wbme/approval';
import { BusinessException, accountErrors, approvalErrors, frameworkErrors, USER_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadOperationLogOperator,
} from '../../backstage/permission/operation-log.util';

/**
 * 资料修改审批（base PRD §6、backstage PRD §5；统一审批内核）。
 *
 * - 员工提交姓名/性别修改 → 创建 PROFILE_CHANGE 审批头 + 明细 + SUBMIT 动作；
 * - 单待审批限制由条件唯一索引兜底（映射 PROFILE_CHANGE_PENDING_EXISTS）；
 * - 审批通过才生效；驳回须填原因；申请人可取消；注销自动取消见 UserLifecycleService。
 */
@Injectable()
export class ProfileChangeService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 提交资料修改（P3）。
   *
   * @param userId 申请人
   * @param isSuperAdmin 是否超管（超管直改）
   * @param input 姓名/性别（至少一项变更）
   * @param idempotencyKey 幂等键（同键重试返回原结果，不重复建单/直改）
   * @returns applied=true 超管直改；否则含 requestId
   */
  async submitProfileChange(
    userId: number,
    isSuperAdmin: boolean,
    input: { name?: string; gender?: 'MALE' | 'FEMALE' },
    idempotencyKey?: string,
  ): Promise<{ applied: boolean; requestId?: number }> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, gender: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new BusinessException(frameworkErrors.UNAUTHORIZED);
    }
    const newName = input.name ?? user.name;
    const newGender = input.gender ?? user.gender;
    if (newName === user.name && newGender === user.gender) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED);
    }

    const operator = await loadOperationLogOperator(this.prisma.client, userId);
    const fingerprint = fingerprintPayload({ name: newName, gender: newGender });
    return executeIdempotentOperation<{ applied: boolean; requestId?: number }>(this.prisma.client, {
      operator,
      feature: USER_MANAGE_FUNCTION_CODE,
      scope: 'base.profile-change.submit',
      idempotencyKey,
      fingerprint,
      run: async (tx) => {
        if (isSuperAdmin) {
          await tx.user.update({ where: { id: userId }, data: { name: newName, gender: newGender } });
          return {
            result: { applied: true },
            actionType: 'UPDATE' as const,
            summary: `在个人中心修改了自己的资料（姓名/性别）`,
          };
        }

        const applicationNo = generateApplicationNo(APPLICATION_NO_PREFIX_PROFILE_CHANGE);
        const now = new Date();
        try {
          const head = await tx.approvalRequest.create({
            data: {
              applicationNo,
              requestType: 'PROFILE_CHANGE',
              applicantId: userId,
              applicantName: user.name,
              status: 'PENDING',
              submittedAt: now,
              createdBy: userId,
            },
          });
          await tx.profileChangeRequest.create({
            data: {
              requestId: head.id,
              userId,
              userName: user.name,
              oldName: user.name,
              newName,
              oldGender: user.gender,
              newGender,
            },
          });
          await tx.approvalActionRecord.create({
            data: {
              requestId: head.id,
              action: 'SUBMIT',
              actorId: userId,
              actorName: user.name,
            },
          });
          return {
            result: { applied: false, requestId: head.id },
            actionType: 'CREATE' as const,
            summary: `在个人中心提交了资料修改申请（姓名/性别）`,
          };
        } catch (error) {
          if (error instanceof BusinessException) {
            throw error;
          }
          if (isPrismaUniqueViolation(error)) {
            throw new BusinessException(accountErrors.PROFILE_CHANGE_PENDING_EXISTS);
          }
          throw error;
        }
      },
    });
  }

  /**
   * 审批处理（APPROVE 生效 / REJECT 不改正式资料）。
   *
   * @param requestId 审批头 id
   * @param action APPROVE | REJECT
   * @param processorId 处理人
   * @param opinion 意见（驳回必填）
   * @param idempotencyKey 幂等键（同键重试返回原结果，不重复处理）
   */
  async processProfileChange(
    requestId: number,
    action: 'APPROVE' | 'REJECT',
    processorId: number,
    opinion?: string,
    idempotencyKey?: string,
  ): Promise<void> {
    const operator = await loadOperationLogOperator(this.prisma.client, processorId);
    await executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: USER_MANAGE_FUNCTION_CODE,
      scope: `base.approval.process/${requestId}`,
      idempotencyKey,
      fingerprint: fingerprintPayload({ action, opinion: opinion ?? null }),
      run: async (tx) => {
        const transition = resolveProcessTransition(action);
        assertOpinionIfRequired(transition.requiresOpinion, opinion);

        const head = await tx.approvalRequest.findUnique({ where: { id: requestId } });
        if (!head || head.requestType !== 'PROFILE_CHANGE') {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (head.status !== 'PENDING') {
          // 终态或并发已被处理：统一 STATUS_CONFLICT（主 PRD §3.2）
          throw new BusinessException(approvalErrors.STATUS_CONFLICT);
        }
        assertTransitionAllowed(head.status, transition.status);

        const processor = await tx.user.findUnique({ where: { id: processorId }, select: { name: true } });
        const now = new Date();
        const updated = await tx.approvalRequest.updateMany({
          where: { id: requestId, status: 'PENDING', version: head.version },
          data: {
            status: transition.status,
            version: { increment: 1 },
            processorId,
            processorName: processor?.name ?? '',
            processedAt: now,
            opinion: opinion ?? null,
          },
        });
        throwIfTransitionLost(updated.count);

        if (action === 'APPROVE') {
          const detail = await tx.profileChangeRequest.findUnique({ where: { requestId } });
          if (!detail) {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
          const target = await tx.user.findUnique({ where: { id: detail.userId }, select: { status: true } });
          if (!target || target.status !== 'ACTIVE') {
            throw new BusinessException(accountErrors.USER_NOT_ACTIVE);
          }
          await tx.user.update({
            where: { id: detail.userId },
            data: { name: detail.newName, gender: detail.newGender },
          });
        }

        await tx.approvalActionRecord.create({
          data: {
            requestId,
            action: transition.action,
            actorId: processorId,
            actorName: processor?.name ?? '',
            opinion: opinion ?? null,
          },
        });
        return {
          result: undefined as unknown as void,
          actionType: 'UPDATE' as const,
          summary: `处理了资料修改审批（${action}）`,
        };
      },
    });
  }

  /**
   * 申请人取消待审批资料修改（cancelSource=USER）。
   *
   * @param requestId 审批头 id
   * @param actorId 操作人（须为申请人）
   * @param idempotencyKey 幂等键（同键重试返回原结果，不重复取消）
   */
  async cancelProfileChange(requestId: number, actorId: number, idempotencyKey?: string): Promise<void> {
    const operator = await loadOperationLogOperator(this.prisma.client, actorId);
    await executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: USER_MANAGE_FUNCTION_CODE,
      scope: `base.approval.cancel/${requestId}`,
      idempotencyKey,
      fingerprint: fingerprintPayload({ cancel: true }),
      run: async (tx) => {
        const transition = resolveProcessTransition('CANCEL', 'USER');
        const head = await tx.approvalRequest.findUnique({ where: { id: requestId } });
        if (!head || head.requestType !== 'PROFILE_CHANGE') {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (head.applicantId !== actorId) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        assertPending(head.status);
        assertTransitionAllowed(head.status, transition.status);

        const actor = await tx.user.findUnique({ where: { id: actorId }, select: { name: true } });
        const now = new Date();
        const updated = await tx.approvalRequest.updateMany({
          where: { id: requestId, status: 'PENDING', version: head.version },
          data: {
            status: 'CANCELLED',
            version: { increment: 1 },
            cancelledBy: actorId,
            cancelledAt: now,
            cancelSource: 'USER',
          },
        });
        throwIfTransitionLost(updated.count);
        await tx.approvalActionRecord.create({
          data: {
            requestId,
            action: 'CANCEL',
            actorId,
            actorName: actor?.name ?? '',
            cancelSource: 'USER',
          },
        });
        return {
          result: undefined as unknown as void,
          actionType: 'UPDATE' as const,
          summary: '取消了资料修改审批',
        };
      },
    });
  }

  /**
   * 当前用户可见的资料修改待审批数量（user_manage 公司范围：全部 PENDING）。
   *
   * @returns 待办数
   */
  async countPendingVisible(): Promise<number> {
    return this.prisma.client.approvalRequest.count({
      where: { requestType: 'PROFILE_CHANGE', status: 'PENDING' },
    });
  }
}
