import { forwardRef, Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { DepartmentClosureService } from '../../shared/department-closure.service';
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
 */
@Module({
  imports: [
    InternalRestModule.forRoot({
      token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    }),
    forwardRef(() => OrgModule),
  ],
  controllers: [ApprovalController, InternalApprovalController],
  providers: [HrApprovalService, DepartmentClosureService],
  exports: [HrApprovalService],
})
export class ApprovalModule {}
