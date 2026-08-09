import { Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { APPROVAL_SIDE_EFFECT } from '../approval/approval-side-effect';
import { ApprovalModule } from '../approval/approval.module';
import { DepartmentController } from './department.controller';
import { DepartmentService } from './department.service';
import { InternalPositionApplicationController } from './internal-position-application.controller';
import { OrgController } from './org.controller';
import { OrgStructureService } from './org-structure.service';
import { PositionApplicationService } from './position-application.service';
import { PositionController } from './position.controller';
import { PositionService } from './position.service';

/**
 * 组织模块（T6-1/T6-2/T6-6）：部门树、岗位档案、用户组织编排、
 * 岗位申请（提交 + 批准副作用注册到统一审批内核）。
 */
@Module({
  imports: [
    ApprovalModule,
    InternalRestModule.forRoot({
      token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    }),
  ],
  controllers: [OrgController, DepartmentController, PositionController, InternalPositionApplicationController],
  providers: [
    OrgStructureService,
    DepartmentService,
    PositionService,
    PositionApplicationService,
    // 岗位申请批准副作用：process 事务内生效（组织变更 + 版本递增）
    { provide: APPROVAL_SIDE_EFFECT, useExisting: PositionApplicationService },
  ],
  exports: [OrgStructureService, DepartmentService, PositionService],
})
export class OrgModule {}
