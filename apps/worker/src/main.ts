import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Worker 部署单元入口。
 * 不监听业务 HTTP 端口，仅创建应用上下文承载 BullMQ 消费者（主 PRD §9.1，T4-2 实现）。
 */
async function bootstrap(): Promise<void> {
  await NestFactory.createApplicationContext(WorkerModule);
}

void bootstrap();
