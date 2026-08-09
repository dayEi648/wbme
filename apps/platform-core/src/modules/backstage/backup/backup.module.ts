import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

/** 数据备份与恢复 API（T4-7） */
@Module({
  imports: [PermissionModule],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
