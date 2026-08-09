import { Module } from '@nestjs/common';
import { RecoveryControlController } from './recovery-control.controller';
import { RecoveryExecutorService } from './recovery-executor.service';

/** 恢复执行器模块 */
@Module({
  controllers: [RecoveryControlController],
  providers: [RecoveryExecutorService],
  exports: [RecoveryExecutorService],
})
export class RecoveryExecutorModule {}
