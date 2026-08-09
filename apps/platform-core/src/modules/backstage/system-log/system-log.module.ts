import { Module } from '@nestjs/common';
import { SettingsModule } from '../../base/settings/settings.module';
import { PermissionModule } from '../permission/permission.module';
import { SystemLogController } from './system-log.controller';
import { SystemLogService } from './system-log.service';

/** 系统日志管理模块（backstage PRD §8） */
@Module({
  imports: [PermissionModule, SettingsModule],
  controllers: [SystemLogController],
  providers: [SystemLogService],
})
export class SystemLogModule {}
