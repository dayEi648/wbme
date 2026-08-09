import { forwardRef, Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { AgentSettlementController } from './agent-settlement.controller';
import { AgentSettlementService } from './agent-settlement.service';
import { BorrowController } from './borrow.controller';
import { BorrowService } from './borrow.service';

/**
 * 借还/归还/核销/代领结清模块（asset PRD §8）。
 */
@Module({
  imports: [forwardRef(() => ApprovalModule)],
  controllers: [BorrowController, AgentSettlementController],
  providers: [BorrowService, AgentSettlementService],
  exports: [BorrowService, AgentSettlementService],
})
export class BorrowModule {}
