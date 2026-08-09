import { BusinessException, approvalErrors, type ApprovalStatus } from '@wbme/contracts';
import type { ProcessAction, ResolvedTransition } from './types';

/** 终态集合（主 PRD §3.2：已批准/已驳回/已取消不可回退） */
export const TERMINAL_APPROVAL_STATUSES: readonly ApprovalStatus[] = ['APPROVED', 'REJECTED', 'CANCELLED'];

/**
 * 判断审批状态是否为终态。
 *
 * @param status 当前状态
 * @returns 是否终态
 */
export function isTerminalApprovalStatus(status: ApprovalStatus): boolean {
  return TERMINAL_APPROVAL_STATUSES.includes(status);
}

/**
 * 校验状态迁移是否合法（主 PRD §3.2）。
 * 合法：DRAFT→PENDING；PENDING→APPROVED|REJECTED|CANCELLED。
 *
 * @param from 当前状态
 * @param to 目标状态
 * @throws STATUS_NOT_ALLOWED 非法迁移
 */
export function assertTransitionAllowed(from: ApprovalStatus, to: ApprovalStatus): void {
  const allowed =
    (from === 'DRAFT' && to === 'PENDING') ||
    (from === 'PENDING' && (to === 'APPROVED' || to === 'REJECTED' || to === 'CANCELLED'));
  if (!allowed) {
    throw new BusinessException(approvalErrors.STATUS_NOT_ALLOWED, { from, to });
  }
}

/**
 * 将处理意图解析为目标状态与动作流水字段。
 *
 * @param action 处理意图
 * @param cancelSource AUTO_CANCEL 时必填（OVERDUE / ACCOUNT_DEACTIVATED）；CANCEL 默认 USER
 * @returns 解析结果
 * @throws STATUS_NOT_ALLOWED 未知动作或 AUTO_CANCEL 缺少 cancelSource
 */
export function resolveProcessTransition(
  action: ProcessAction,
  cancelSource?: 'USER' | 'ACCOUNT_DEACTIVATED' | 'OVERDUE' | null,
): ResolvedTransition {
  switch (action) {
    case 'APPROVE':
      return { status: 'APPROVED', action: 'APPROVE', cancelSource: null, requiresOpinion: false };
    case 'REJECT':
      return { status: 'REJECTED', action: 'REJECT', cancelSource: null, requiresOpinion: true };
    case 'CANCEL':
      return {
        status: 'CANCELLED',
        action: 'CANCEL',
        cancelSource: cancelSource === 'ACCOUNT_DEACTIVATED' ? 'ACCOUNT_DEACTIVATED' : 'USER',
        requiresOpinion: false,
      };
    case 'AUTO_CANCEL': {
      if (cancelSource !== 'OVERDUE' && cancelSource !== 'ACCOUNT_DEACTIVATED') {
        throw new BusinessException(approvalErrors.STATUS_NOT_ALLOWED, {
          reason: 'AUTO_CANCEL_REQUIRES_CANCEL_SOURCE',
        });
      }
      return {
        status: 'CANCELLED',
        action: 'AUTO_CANCEL',
        cancelSource,
        requiresOpinion: false,
      };
    }
    default: {
      const _exhaustive: never = action;
      throw new BusinessException(approvalErrors.STATUS_NOT_ALLOWED, { action: _exhaustive });
    }
  }
}

/**
 * 驳回必须填写原因（主 PRD §3.2）。
 *
 * @param requiresOpinion 是否强制意见
 * @param opinion 处理意见
 * @throws REJECT_REASON_REQUIRED
 */
export function assertOpinionIfRequired(requiresOpinion: boolean, opinion?: string | null): void {
  if (!requiresOpinion) {
    return;
  }
  if (opinion === undefined || opinion === null || opinion.trim().length === 0) {
    throw new BusinessException(approvalErrors.REJECT_REASON_REQUIRED);
  }
}

/**
 * 条件更新未命中时抛出状态冲突（并发仅一个成功，主 PRD §3.2）。
 *
 * @param updatedCount updateMany / UPDATE 影响行数
 * @throws STATUS_CONFLICT
 */
export function throwIfTransitionLost(updatedCount: number): void {
  if (updatedCount === 0) {
    throw new BusinessException(approvalErrors.STATUS_CONFLICT);
  }
}

/**
 * 断言当前头为 PENDING，否则 STATUS_NOT_ALLOWED 或按缺失处理由调用方决定。
 *
 * @param status 当前状态
 * @throws STATUS_NOT_ALLOWED
 */
export function assertPending(status: ApprovalStatus): void {
  if (status !== 'PENDING') {
    throw new BusinessException(approvalErrors.STATUS_NOT_ALLOWED, { status });
  }
}
