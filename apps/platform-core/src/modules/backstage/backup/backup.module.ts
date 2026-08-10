import { Module } from '@nestjs/common';
import { InternalRestModule, type InternalAuthRejection } from '@wbme/server';
import { SecurityLogModule } from '../../base/security-log/security-log.module';
import { SecurityLogService } from '../../base/security-log/security-log.service';
import { PermissionModule } from '../permission/permission.module';
import { BackupController } from './backup.controller';
import { InternalBackupController } from './internal-backup.controller';
import { BackupService } from './backup.service';
import { RecoverySessionClient } from './recovery-session.client';

/** 将内部令牌拒绝写入安全日志（backstage PRD §8） */
function recordInternalTokenFailure(securityLog: SecurityLogService, rejection: InternalAuthRejection): void {
  void securityLog.record('INTERNAL_TOKEN_FAILED', 'FAILURE', {
    reason: rejection.reason,
    sourceIp: rejection.sourceIp ?? null,
    context: rejection.caller ? { caller: rejection.caller } : undefined,
  });
}

/** 数据备份与恢复 API（含恢复控制会话签发） */
@Module({
  imports: [
    PermissionModule,
    SecurityLogModule,
    // 内部路由认证（migration-runner 迁移前立即备份；主 PRD §9.4 共享内部令牌）
    InternalRestModule.forRootAsync({
      imports: [SecurityLogModule],
      inject: [SecurityLogService],
      useFactory: (securityLog: SecurityLogService) => ({
        token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
        onReject: (rejection: InternalAuthRejection) => recordInternalTokenFailure(securityLog, rejection),
      }),
    }),
  ],
  controllers: [BackupController, InternalBackupController],
  providers: [BackupService, RecoverySessionClient],
  exports: [BackupService],
})
export class BackupModule {}
