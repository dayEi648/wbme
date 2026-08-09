import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';
import { ReleaseLogController } from './release-log.controller';
import { ReleaseLogService } from './release-log.service';

/** 内容管理：更新日志 + 系统公告（T4-6） */
@Module({
  imports: [PermissionModule],
  controllers: [ReleaseLogController, AnnouncementController],
  providers: [ReleaseLogService, AnnouncementService],
  exports: [ReleaseLogService],
})
export class ContentModule {}
