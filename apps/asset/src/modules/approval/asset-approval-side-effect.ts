import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { AgentSettlementService } from '../borrow/agent-settlement.service';
import { BorrowService } from '../borrow/borrow.service';
import { AgentClaimService } from '../claim/agent-claim.service';
import { ClaimService } from '../claim/claim.service';
import { StockChangeService } from '../request/stock-change.service';
import { StockInService } from '../request/stock-in.service';
import type { ApprovalHeadForSideEffect, ApprovalSideEffect } from './approval-side-effect';

/**
 * asset 审批业务副作用编排器（T7：六类申请副作用接线）。
 *
 * 按审批头 requestType 分派到各域服务的 applyApproved / applyRelease；
 * 批准失败 → 整个 process 事务回滚、申请保持待审批；驳回/取消 → 同一事务释放占用。
 * 各域服务经 forwardRef 注入（模块互引由 ApprovalModule 与业务模块共同解决）。
 */
@Injectable()
export class AssetApprovalSideEffect implements ApprovalSideEffect {
  constructor(
    // 循环模块中跨模块 provider 注入须显式 forwardRef（与 hr PositionApplicationService 注入模式一致）
    @Inject(forwardRef(() => StockInService)) private readonly stockIn: StockInService,
    @Inject(forwardRef(() => StockChangeService)) private readonly stockChange: StockChangeService,
    @Inject(forwardRef(() => ClaimService)) private readonly claim: ClaimService,
    @Inject(forwardRef(() => AgentClaimService)) private readonly agentClaim: AgentClaimService,
    @Inject(forwardRef(() => BorrowService)) private readonly borrow: BorrowService,
    @Inject(forwardRef(() => AgentSettlementService)) private readonly agentSettlement: AgentSettlementService,
  ) {}

  /**
   * 批准副作用（按类型分派；抛错 → 事务回滚、申请保持 PENDING）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   * @param processorId 处理人
   */
  async applyApprove(tx: Parameters<ApprovalSideEffect['applyApprove']>[0], head: ApprovalHeadForSideEffect, processorId: number): Promise<void> {
    switch (head.requestType) {
      case 'STOCK_IN':
        await this.stockIn.applyApproved(tx, head);
        return;
      case 'STOCK_CHANGE':
        await this.stockChange.applyApproved(tx, head);
        return;
      case 'CONSUMABLE_REQUEST':
        await this.claim.applyApproved(tx, head, processorId);
        return;
      case 'AGENT_REQUEST':
        await this.agentClaim.applyApproved(tx, head, processorId);
        return;
      case 'RETURN':
        await this.borrow.applyReturnApproved(tx, head);
        return;
      case 'WRITE_OFF':
        await this.borrow.applyWriteOffApproved(tx, head);
        return;
      case 'AGENT_SETTLEMENT':
        await this.agentSettlement.applyApproved(tx, head, processorId);
        return;
      default:
        // 未知类型无副作用（审批头类型为封闭常量，防御性兜底）
        return;
    }
  }

  /**
   * 驳回/取消释放（按类型分派；与申请转终态同一事务）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   */
  async applyRelease(tx: Parameters<ApprovalSideEffect['applyRelease']>[0], head: ApprovalHeadForSideEffect): Promise<void> {
    switch (head.requestType) {
      case 'STOCK_IN':
        await this.stockIn.applyRelease(tx, head);
        return;
      case 'STOCK_CHANGE':
        await this.stockChange.applyRelease(tx, head);
        return;
      case 'CONSUMABLE_REQUEST':
        await this.claim.applyRelease(tx, head);
        return;
      case 'AGENT_REQUEST':
        await this.agentClaim.applyRelease(tx, head);
        return;
      case 'RETURN':
        await this.borrow.applyRelease(tx, head);
        return;
      case 'WRITE_OFF':
        await this.borrow.applyRelease(tx, head);
        return;
      case 'AGENT_SETTLEMENT':
        await this.agentSettlement.applyRelease(tx, head);
        return;
      default:
        return;
    }
  }
}
