import { Module } from '@nestjs/common';
import { PermissionModule } from '../../backstage/permission/permission.module';
import { OperationLogModule } from '../../backstage/operation-log/operation-log.module';
import { SettingsModule } from '../settings/settings.module';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';
import { MeController } from '../me/me.controller';
import { ProfileChangeService } from '../approval-proxy/profile-change.service';
import { ApprovalCenterService } from '../approval-proxy/approval-center.service';
import { ApprovalController } from '../approval-proxy/approval.controller';
import { PendingBadgeClient } from './pending-badge.client';
import { HrOrgClient } from '../me/hr-org.client';

/** 门户与个人中心模块（base PRD §5/§6，含岗位申请） */
@Module({
  imports: [PermissionModule, OperationLogModule, SettingsModule],
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
