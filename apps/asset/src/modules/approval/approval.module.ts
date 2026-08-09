import { forwardRef, Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { BorrowModule } from '../borrow/borrow.module';
import { ClaimModule } from '../claim/claim.module';
import { RequestModule } from '../request/request.module';
import { ApprovalController } from './approval.controller';
import { AssetApprovalService } from './asset-approval.service';
import { AssetApprovalSideEffect } from './asset-approval-side-effect';
import { InternalApprovalController } from './internal-approval.controller';

/**
 * asset 审批模块（审批头；接入业务副作用与部门闭包）。
 *
 * 副作用编排器注入各域服务（Request/Claim/Borrow 模块 forwardRef 互引打破构造循环，
 * 与 hr 的 ApprovalModule/OrgModule 互引模式一致）。
 */
@Module({
  imports: [
    InternalRestModule.forRoot({
      token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    }),
    forwardRef(() => RequestModule),
    forwardRef(() => ClaimModule),
    forwardRef(() => BorrowModule),
  ],
  controllers: [ApprovalController, InternalApprovalController],
  providers: [AssetApprovalService, AssetApprovalSideEffect],
  exports: [AssetApprovalService],
})
export class ApprovalModule {}
