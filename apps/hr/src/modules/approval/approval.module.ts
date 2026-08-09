import { forwardRef, Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { ApprovalController } from './approval.controller';
import { HrApprovalService } from './hr-approval.service';
import { InternalApprovalController } from './internal-approval.controller';
import { OrgModule } from '../org/org.module';

/**
 * hr 审批模块（T5-3 审批头 + 审批中心 API + 内部 pending-count；
 * T6 接入部门闭包过滤与批准副作用钩子）。
 *
 * 批准副作用：HrApprovalService 直接注入 OrgModule 的 PositionApplicationService
 * （@Inject(forwardRef(...))，两者构造互相引用）。OrgModule 反向 import 本模块
 * 需 forwardRef 打破模块级循环（修复：原 APPROVAL_SIDE_EFFECT 定义于 OrgModule，
 * 生产 DI 无法解析导致 hr 应用启动失败、副作用从未注入——见 T6 完成备注）。
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
