import { Module } from '@nestjs/common';
import { PermissionModule } from '../../backstage/permission/permission.module';
import { OperationLogModule } from '../../backstage/operation-log/operation-log.module';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';
import { MeController } from '../me/me.controller';
import { ProfileChangeService } from '../approval-proxy/profile-change.service';
import { ApprovalCenterService } from '../approval-proxy/approval-center.service';
import { ApprovalController } from '../approval-proxy/approval.controller';
import { PendingBadgeClient } from './pending-badge.client';
import { HrOrgClient } from '../me/hr-org.client';

/** 门户与个人中心模块（base PRD §5/§6，T2-6/T2-7 / T5 / T6-6 岗位申请接通） */
@Module({
  imports: [PermissionModule, OperationLogModule],
  providers: [
    PortalService,
    ProfileChangeService,
    ApprovalCenterService,
    { provide: PendingBadgeClient, useFactory: () => PendingBadgeClient.fromEnv() },
    { provide: HrOrgClient, useFactory: () => HrOrgClient.fromEnv() },
  ],
  controllers: [PortalController, MeController, ApprovalController],
  exports: [ProfileChangeService, ApprovalCenterService],
})
export class PortalModule {}
