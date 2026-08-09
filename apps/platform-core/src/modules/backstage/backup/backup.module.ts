import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { RecoverySessionClient } from './recovery-session.client';

/** 数据备份与恢复 API（含恢复控制会话签发） */
@Module({
  imports: [PermissionModule],
  controllers: [BackupController],
  providers: [BackupService, RecoverySessionClient],
  exports: [BackupService],
})
export class BackupModule {}
