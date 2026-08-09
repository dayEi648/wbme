import { forwardRef, Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { ApprovalModule } from '../approval/approval.module';
import { DepartmentController } from './department.controller';
import { DepartmentService } from './department.service';
import { InternalPositionApplicationController } from './internal-position-application.controller';
import { OrgController } from './org.controller';
import { OrgStructureService } from './org-structure.service';
import { PositionApplicationService } from './position-application.service';
import { PositionController } from './position.controller';
import { PositionService } from './position.service';
import { SelfServiceController } from './self-service.controller';

/**
 * 组织模块：部门树、岗位档案、用户组织编排、
 * 岗位申请（提交 + 批准副作用注册到统一审批内核）。
 */
@Module({
  imports: [
    forwardRef(() => ApprovalModule),
    InternalRestModule.forRoot({
      token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    }),
  ],
  controllers: [OrgController, DepartmentController, PositionController, InternalPositionApplicationController, SelfServiceController],
  providers: [
    OrgStructureService,
    DepartmentService,
    PositionService,
    PositionApplicationService,
  ],
  exports: [OrgStructureService, DepartmentService, PositionService, PositionApplicationService],
})
export class OrgModule {}
