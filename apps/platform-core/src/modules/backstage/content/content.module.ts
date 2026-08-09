import { Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { PermissionModule } from '../permission/permission.module';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';
import { InternalReleaseLogController } from './internal-release-log.controller';
import { ReleaseLogController } from './release-log.controller';
import { ReleaseLogService } from './release-log.service';

/** 内容管理：更新日志 + 系统公告 */
@Module({
  imports: [
    PermissionModule,
    // 内部路由认证（发布脚本追加更新日志；主 PRD §9.4 共享内部令牌）
    InternalRestModule.forRoot({
      token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    }),
  ],
  controllers: [ReleaseLogController, AnnouncementController, InternalReleaseLogController],
  providers: [ReleaseLogService, AnnouncementService],
  exports: [ReleaseLogService],
})
export class ContentModule {}
