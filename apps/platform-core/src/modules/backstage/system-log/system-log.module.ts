import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { SystemLogController } from './system-log.controller';
import { SystemLogService } from './system-log.service';

/** 系统日志管理模块（backstage PRD §8；T4-3/T4-4） */
@Module({
  imports: [PermissionModule],
  controllers: [SystemLogController],
  providers: [SystemLogService],
})
export class SystemLogModule {}
