import { describe, expect, it } from 'vitest';
import { BusinessException, approvalErrors } from '@wbme/contracts';
import {
  assertOpinionIfRequired,
  assertPending,
  assertTransitionAllowed,
  isTerminalApprovalStatus,
  resolveProcessTransition,
  throwIfTransitionLost,
} from './state-machine';

describe('isTerminalApprovalStatus', () => {
  it('终态为 APPROVED/REJECTED/CANCELLED', () => {
    expect(isTerminalApprovalStatus('APPROVED')).toBe(true);
    expect(isTerminalApprovalStatus('REJECTED')).toBe(true);
    expect(isTerminalApprovalStatus('CANCELLED')).toBe(true);
    expect(isTerminalApprovalStatus('PENDING')).toBe(false);
    expect(isTerminalApprovalStatus('DRAFT')).toBe(false);
  });
});

describe('assertTransitionAllowed', () => {
  it('允许 DRAFT→PENDING 与 PENDING→终态', () => {
    expect(() => assertTransitionAllowed('DRAFT', 'PENDING')).not.toThrow();
    expect(() => assertTransitionAllowed('PENDING', 'APPROVED')).not.toThrow();
    expect(() => assertTransitionAllowed('PENDING', 'REJECTED')).not.toThrow();
    expect(() => assertTransitionAllowed('PENDING', 'CANCELLED')).not.toThrow();
  });

  it('拒绝终态回退与非法迁移', () => {
    expect(() => assertTransitionAllowed('APPROVED', 'PENDING')).toThrow(BusinessException);
    expect(() => assertTransitionAllowed('DRAFT', 'APPROVED')).toThrow(BusinessException);
    try {
      assertTransitionAllowed('REJECTED', 'CANCELLED');
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessException);
      expect((error as BusinessException).entry.code).toBe(approvalErrors.STATUS_NOT_ALLOWED.code);
    }
  });
});

describe('resolveProcessTransition', () => {
  it('APPROVE/REJECT/CANCEL 映射正确', () => {
    expect(resolveProcessTransition('APPROVE')).toMatchObject({
      status: 'APPROVED',
      action: 'APPROVE',
      requiresOpinion: false,
    });
    expect(resolveProcessTransition('REJECT')).toMatchObject({
      status: 'REJECTED',
      action: 'REJECT',
      requiresOpinion: true,
    });
    expect(resolveProcessTransition('CANCEL')).toMatchObject({
      status: 'CANCELLED',
      action: 'CANCEL',
      cancelSource: 'USER',
    });
    expect(resolveProcessTransition('CANCEL', 'ACCOUNT_DEACTIVATED')).toMatchObject({
      cancelSource: 'ACCOUNT_DEACTIVATED',
    });
  });

  it('AUTO_CANCEL 必须携带 OVERDUE 或 ACCOUNT_DEACTIVATED', () => {
    expect(resolveProcessTransition('AUTO_CANCEL', 'OVERDUE').action).toBe('AUTO_CANCEL');
    expect(() => resolveProcessTransition('AUTO_CANCEL')).toThrow(BusinessException);
    expect(() => resolveProcessTransition('AUTO_CANCEL', 'USER')).toThrow(BusinessException);
  });
});

describe('assertOpinionIfRequired / throwIfTransitionLost / assertPending', () => {
  it('驳回空意见抛 REJECT_REASON_REQUIRED', () => {
    expect(() => assertOpinionIfRequired(true, '  ')).toThrow(BusinessException);
    expect(() => assertOpinionIfRequired(true, '原因')).not.toThrow();
    expect(() => assertOpinionIfRequired(false, undefined)).not.toThrow();
  });

  it('条件更新 0 行抛 STATUS_CONFLICT', () => {
    expect(() => throwIfTransitionLost(0)).toThrow(BusinessException);
    expect(() => throwIfTransitionLost(1)).not.toThrow();
  });

  it('非 PENDING 抛 STATUS_NOT_ALLOWED', () => {
    expect(() => assertPending('PENDING')).not.toThrow();
    expect(() => assertPending('APPROVED')).toThrow(BusinessException);
  });
});
