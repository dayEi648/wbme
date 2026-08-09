import { Module } from '@nestjs/common';
import { BorrowModule } from '../borrow/borrow.module';
import { DisposalController } from './disposal.controller';
import { DisposalService } from './disposal.service';

/**
 * 注销员工借还直接处置模块（T7-9；asset PRD §8/§9）。
 */
@Module({
  imports: [BorrowModule],
  controllers: [DisposalController],
  providers: [DisposalService],
  exports: [DisposalService],
})
export class DisposalModule {}
