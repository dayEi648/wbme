import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ShutdownStateService } from './shutdown-state';

/** 健康探针模块：提供 /healthz 与 /readyz（应用挂载时排除全局前缀） */
@Module({
  controllers: [HealthController],
  providers: [ShutdownStateService],
  exports: [ShutdownStateService],
})
export class HealthModule {}
