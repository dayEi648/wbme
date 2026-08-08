import { Module } from '@nestjs/common';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';
import { MeController } from '../me/me.controller';
import { ProfileChangeService } from '../approval-proxy/profile-change.service';
import { ApprovalController } from '../approval-proxy/approval.controller';

/** 门户与个人中心模块（base PRD §5/§6，T2-6/T2-7） */
@Module({
  providers: [PortalService, ProfileChangeService],
  controllers: [PortalController, MeController, ApprovalController],
  exports: [ProfileChangeService],
})
export class PortalModule {}
