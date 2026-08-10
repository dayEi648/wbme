import { Module } from '@nestjs/common';
import {
  DiskStatusInternalTokenGuard,
  PlatformCoreInternalTokenGuard,
  WorkerInternalTokenGuard,
} from './internal-token.guard';
import { InternalSecurityLogService } from './internal-security-log.service';
import { RecoveryControlController } from './recovery-control.controller';
import { RecoveryExecutorService } from './recovery-executor.service';

/** 恢复执行器模块 */
@Module({
  controllers: [RecoveryControlController],
  providers: [
    RecoveryExecutorService,
    InternalSecurityLogService,
    WorkerInternalTokenGuard,
    PlatformCoreInternalTokenGuard,
    DiskStatusInternalTokenGuard,
  ],
  exports: [RecoveryExecutorService],
})
export class RecoveryExecutorModule {}
