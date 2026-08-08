import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, accountErrors, frameworkErrors } from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';

/**
 * 资料修改审批最小实现（base PRD §6、backstage PRD §3/§5；T5 统一审批内核接管完整规则）。
 *
 * - 员工提交姓名/性别修改 → 创建 PROFILE_CHANGE 审批头 + 明细（S-16/S-18，同一事务），
 *   单待审批限制由条件唯一索引 `(applicant_id) WHERE request_type='PROFILE_CHANGE' AND status='PENDING'` 兜底；
 * - 审批通过才生效（X1 APPROVE：状态+版本条件更新，同一事务内生效修改；驳回不改正式资料）；
 * - 审批权：持有"用户管理"功能者（本期最小校验；T3 完整守卫接管）；
 * - 超级管理员修改立即生效（不走审批）。
 */

@Injectable()
export class ProfileChangeService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 提交资料修改（P3）。
   * @returns applied=true 超管直改生效；applied=false 已创建审批单（含 requestId）
   */
  async submitProfileChange(
    userId: number,
    isSuperAdmin: boolean,
    input: { name?: string; gender?: 'MALE' | 'FEMALE' },
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

    if (isSuperAdmin) {
      // 超管立即生效（base PRD §6）
      await this.prisma.client.user.update({ where: { id: userId }, data: { name: newName, gender: newGender } });
      return { applied: true };
    }

    // 员工：创建 PROFILE_CHANGE 审批单（头 + 明细同一事务；单待审批限制由条件唯一索引兜底）
    const applicationNo = `PC${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
    try {
      const request = await this.prisma.client.$transaction(async (tx) => {
        const head = await tx.approvalRequest.create({
          data: {
            applicationNo,
            requestType: 'PROFILE_CHANGE',
            applicantId: userId,
            applicantName: user.name,
            status: 'PENDING',
            submittedAt: new Date(),
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
        return head;
      });
      return { applied: false, requestId: request.id };
    } catch (error) {
      // 条件唯一索引冲突（已有待审批单）→ 409；其余错误原样上抛
      if (error instanceof BusinessException) {
        throw error;
      }
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
        throw new BusinessException(accountErrors.PROFILE_CHANGE_PENDING_EXISTS);
      }
      throw error;
    }
  }

  /**
   * 审批处理（X1，仅 PROFILE_CHANGE；状态+版本条件更新防并发）。
   * APPROVE：同一事务内生效姓名/性别修改；REJECT：不改正式资料。
   */
  async processProfileChange(
    requestId: number,
    action: 'APPROVE' | 'REJECT',
    processorId: number,
    opinion?: string,
  ): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      // 条件更新：仅 PENDING 可处理（版本 + 状态条件，并发仅一个成功）
      const head = await tx.approvalRequest.findUnique({ where: { id: requestId } });
      if (!head || head.requestType !== 'PROFILE_CHANGE') {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      if (head.status !== 'PENDING') {
        throw new BusinessException(frameworkErrors.CONFLICT);
      }
      const updated = await tx.approvalRequest.updateMany({
        where: { id: requestId, status: 'PENDING', version: head.version },
        data: {
          status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          version: { increment: 1 },
          processorId,
          processedAt: new Date(),
          opinion: opinion ?? null,
        },
      });
      if (updated.count === 0) {
        throw new BusinessException(frameworkErrors.CONFLICT);
      }
      if (action === 'APPROVE') {
        const detail = await tx.profileChangeRequest.findUnique({ where: { requestId } });
        if (!detail) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 通过时重新校验目标数据有效性（backstage PRD §5）
        const target = await tx.user.findUnique({ where: { id: detail.userId }, select: { status: true } });
        if (!target || target.status !== 'ACTIVE') {
          throw new BusinessException(accountErrors.USER_NOT_ACTIVE);
        }
        await tx.user.update({
          where: { id: detail.userId },
          data: { name: detail.newName, gender: detail.newGender },
        });
      }
      // 审批动作流水（S-17 approval_actions：审批记录作为审计信息保留，base PRD §6）
      const processor = await tx.user.findUnique({ where: { id: processorId }, select: { name: true } });
      await tx.approvalActionRecord.create({
        data: {
          requestId,
          action,
          actorId: processorId,
          actorName: processor?.name ?? '',
          opinion: opinion ?? null,
        },
      });
    });
  }
}
