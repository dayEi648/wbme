import { forwardRef, Module } from '@nestjs/common';
import { InternalRestModule, type InternalAuthRejection } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { recordInternalTokenFailure } from '@wbme/logging';
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
 * onReject 将内部令牌校验失败写入 backstage.security_logs（INTERNAL_TOKEN_FAILED）。
 */
@Module({
  imports: [
    InternalRestModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
        onReject: (rejection: InternalAuthRejection) => recordInternalTokenFailure(prisma.client, rejection),
      }),
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
