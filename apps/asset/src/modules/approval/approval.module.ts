import { Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { ApprovalController } from './approval.controller';
import { AssetApprovalService } from './asset-approval.service';
import { InternalApprovalController } from './internal-approval.controller';

/**
 * asset 审批模块（T5-3：审批头 + 审批中心 API + 内部 pending-count）。
 */
@Module({
  imports: [
    InternalRestModule.forRoot({
      token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    }),
  ],
  controllers: [ApprovalController, InternalApprovalController],
  providers: [AssetApprovalService],
  exports: [AssetApprovalService],
})
export class ApprovalModule {}
