import { Prisma } from '../../generated/prisma/client';

/** 审批头最小视图（副作用实现只读字段） */
export interface ApprovalHeadForSideEffect {
  id: number;
  requestType: string;
  applicantId: number;
  applicantName: string;
}

/**
 * asset 审批业务副作用接口（主 PRD §3.2：批准/驳回/取消时在同一数据库事务内
 * 执行业务占用转换或释放）。
 *
 * - applyApprove：批准时把待审批占用转换为正式结果（出库/回库/核销/结清/建批次），
 *   事务内重校验前置条件，不成立抛业务异常使整个 process 事务回滚、申请保持 PENDING；
 * - applyRelease：驳回或取消时释放占用（库存 reserved_qty / 额度 RESERVED→RELEASED；
 *   借还与结清占用为派生值，无数据回写），与申请转终态同一事务。
 */
export interface ApprovalSideEffect {
  /**
   * 批准副作用（process 事务内调用；抛错 → 事务回滚、申请保持 PENDING）。
   *
   * @param tx 事务客户端（与审批状态更新同事务）
   * @param head 审批头
   * @param processorId 处理人
   */
  applyApprove(tx: Prisma.TransactionClient, head: ApprovalHeadForSideEffect, processorId: number): Promise<void>;

  /**
   * 驳回/取消释放（与申请转终态同一事务）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   */
  applyRelease(tx: Prisma.TransactionClient, head: ApprovalHeadForSideEffect): Promise<void>;
}
