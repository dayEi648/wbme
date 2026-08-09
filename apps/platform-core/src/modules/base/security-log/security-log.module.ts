import { Module } from '@nestjs/common';
import { PlatformErrorLogWriter } from './platform-error-log.writer';
import { SecurityLogService } from './security-log.service';

/** 安全日志模块（共享日志写入例外；T4-4 迁入 @wbme/logging 统一受限语句） */
@Module({
  providers: [SecurityLogService, PlatformErrorLogWriter],
  exports: [SecurityLogService, PlatformErrorLogWriter],
})
export class SecurityLogModule {}
