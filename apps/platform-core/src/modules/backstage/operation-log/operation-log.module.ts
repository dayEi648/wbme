import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { SettingsModule } from '../../base/settings/settings.module';
import { OperationLogController } from './operation-log.controller';
import { OperationLogService } from './operation-log.service';

/** 操作日志查询模块（主 PRD §3.3） */
@Module({
  imports: [PermissionModule, SettingsModule],
  controllers: [OperationLogController],
  providers: [OperationLogService],
  exports: [OperationLogService],
})
export class OperationLogModule {}
