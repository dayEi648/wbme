import { Module } from '@nestjs/common';
import { InternalRestModule, type InternalAuthRejection } from '@wbme/server';
import { SecurityLogModule } from '../../base/security-log/security-log.module';
import { SecurityLogService } from '../../base/security-log/security-log.service';
import { PermissionModule } from '../permission/permission.module';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';
import { InternalReleaseLogController } from './internal-release-log.controller';
import { ReleaseLogController } from './release-log.controller';
import { ReleaseLogService } from './release-log.service';

/** 将内部令牌拒绝写入安全日志（backstage PRD §8） */
function recordInternalTokenFailure(securityLog: SecurityLogService, rejection: InternalAuthRejection): void {
  void securityLog.record('INTERNAL_TOKEN_FAILED', 'FAILURE', {
    reason: rejection.reason,
    sourceIp: rejection.sourceIp ?? null,
    context: rejection.caller ? { caller: rejection.caller } : undefined,
  });
}

/** 内容管理：更新日志 + 系统公告 */
@Module({
  imports: [
    PermissionModule,
    SecurityLogModule,
    // 内部路由认证（发布脚本追加更新日志；主 PRD §9.4 共享内部令牌）
    InternalRestModule.forRootAsync({
      imports: [SecurityLogModule],
      inject: [SecurityLogService],
      useFactory: (securityLog: SecurityLogService) => ({
        token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
        onReject: (rejection: InternalAuthRejection) => recordInternalTokenFailure(securityLog, rejection),
      }),
    }),
  ],
  controllers: [ReleaseLogController, AnnouncementController, InternalReleaseLogController],
  providers: [ReleaseLogService, AnnouncementService],
  exports: [ReleaseLogService],
})
export class ContentModule {}
