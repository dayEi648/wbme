import { Module } from '@nestjs/common';
import { InternalRestModule } from '@wbme/server';
import { PermissionModule } from '../permission/permission.module';
import { BackupController } from './backup.controller';
import { InternalBackupController } from './internal-backup.controller';
import { BackupService } from './backup.service';
import { RecoverySessionClient } from './recovery-session.client';

/** 数据备份与恢复 API（含恢复控制会话签发） */
@Module({
  imports: [
    PermissionModule,
    // 内部路由认证（migration-runner 迁移前立即备份；主 PRD §9.4 共享内部令牌）
    InternalRestModule.forRoot({
      token: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    }),
  ],
  controllers: [BackupController, InternalBackupController],
  providers: [BackupService, RecoverySessionClient],
  exports: [BackupService],
})
export class BackupModule {}
