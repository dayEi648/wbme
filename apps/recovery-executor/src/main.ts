import { NestFactory } from '@nestjs/core';
import { RecoveryExecutorModule } from './recovery-executor.module';

/**
 * 恢复执行器入口（backstage PRD §10）。
 * 本期仅占位：不承载普通业务页面或 API；恢复控制路由与外部清单逻辑 T10-3 实现。
 */
async function bootstrap(): Promise<void> {
  await NestFactory.createApplicationContext(RecoveryExecutorModule);
}

void bootstrap();
