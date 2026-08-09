import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { RecoverySessionClient } from './recovery-session.client';

/** 数据备份与恢复 API（T4-7；T4-8 接线恢复控制会话签发） */
@Module({
  imports: [PermissionModule],
  controllers: [BackupController],
  providers: [BackupService, RecoverySessionClient],
  exports: [BackupService],
})
export class BackupModule {}
