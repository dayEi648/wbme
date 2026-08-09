import { forwardRef, Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { StockChangeController } from './stock-change.controller';
import { StockChangeService } from './stock-change.service';
import { StockInController } from './stock-in.controller';
import { StockInService } from './stock-in.service';

/**
 * 入库/库存变更申请模块（asset PRD §6）。
 */
@Module({
  imports: [forwardRef(() => ApprovalModule)],
  controllers: [StockInController, StockChangeController],
  providers: [StockInService, StockChangeService],
  exports: [StockInService, StockChangeService],
})
export class RequestModule {}
