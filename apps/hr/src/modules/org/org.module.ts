import { forwardRef, Module } from '@nestjs/common';
import { InternalRestModule, type InternalAuthRejection } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { recordInternalTokenFailure } from '@wbme/logging';
import { ApprovalModule } from '../approval/approval.module';
import { AssetDepartmentClient } from './asset-department.client';
import { DepartmentController } from './department.controller';
import { DepartmentService } from './department.service';
import { InternalPositionApplicationController } from './internal-position-application.controller';
import { OrgController } from './org.controller';
import { OrgStructureService } from './org-structure.service';
import { PositionApplicationService } from './position-application.service';
import { PositionController } from './position.controller';
import { PositionService } from './position.service';
import { SelfServiceController } from './self-service.controller';
import { DepartmentClosureService } from '../../shared/department-closure.service';

/**
 * 组织模块：部门树、岗位档案、用户组织编排、
 * 岗位申请（提交 + 批准副作用注册到统一审批内核）。
 * onReject 将内部令牌校验失败写入 backstage.security_logs（INTERNAL_TOKEN_FAILED）。
 */
@Module({
  imports: [
    forwardRef(() => ApprovalModule),
    InternalRestModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
        onReject: (rejection: InternalAuthRejection) => recordInternalTokenFailure(prisma.client, rejection),
      }),
    }),
  ],
  controllers: [OrgController, DepartmentController, PositionController, InternalPositionApplicationController, SelfServiceController],
  providers: [
    OrgStructureService,
    DepartmentService,
    PositionService,
    PositionApplicationService,
    AssetDepartmentClient,
    DepartmentClosureService,
  ],
  exports: [OrgStructureService, DepartmentService, PositionService, PositionApplicationService],
})
export class OrgModule {}
