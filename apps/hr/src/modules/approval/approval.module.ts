import { forwardRef, Module } from '@nestjs/common';
import { InternalRestModule, type InternalAuthRejection } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { recordInternalTokenFailure } from '@wbme/logging';
import { ApprovalController } from './approval.controller';
import { HrApprovalService } from './hr-approval.service';
import { InternalApprovalController } from './internal-approval.controller';
import { OrgModule } from '../org/org.module';

/**
 * hr 审批模块：审批头 + 审批中心 API + 内部 pending-count；
 * 部门闭包过滤与批准副作用钩子。
 *
 * 批准副作用：HrApprovalService 直接注入 OrgModule 的 PositionApplicationService
 * （@Inject(forwardRef(...))，两者构造互相引用）。OrgModule 反向 import 本模块
 * 需 forwardRef 打破模块级循环。
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
    forwardRef(() => OrgModule),
  ],
  controllers: [ApprovalController, InternalApprovalController],
  providers: [HrApprovalService, DepartmentClosureService],
  exports: [HrApprovalService],
})
export class ApprovalModule {}
