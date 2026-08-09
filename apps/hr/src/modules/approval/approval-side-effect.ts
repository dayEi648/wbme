import { Prisma } from '../../generated/prisma/client';

/** 审批副作用注入 token（process 事务内按申请类型分发；未注册=无副作用，如 OVERTIME） */
export const APPROVAL_SIDE_EFFECT = 'HR_APPROVAL_SIDE_EFFECT';

/** 审批头最小视图（副作用实现只读字段） */
export interface ApprovalHeadForSideEffect {
  id: number;
  requestType: string;
  applicantId: number;
}

/**
 * 审批批准副作用接口（主 PRD §3.2：批准时在同一数据库事务内执行业务副作用）。
 * 实现必须：先重校验业务前置条件（不成立则抛业务异常，使整个 process 事务回滚、
 * 申请保持待审批），再应用副作用。驳回/取消无副作用。
 */
export interface ApprovalSideEffect {
  /**
   * 批准副作用（process 事务内调用；抛错 → 事务回滚、申请保持 PENDING）。
   *
   * @param tx 事务客户端（与审批状态更新同事务）
   * @param head 审批头
   * @param processorId 处理人
   */
  apply(tx: Prisma.TransactionClient, head: ApprovalHeadForSideEffect, processorId: number): Promise<void>;
}
