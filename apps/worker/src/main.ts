import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/** 优雅停机宽限（毫秒，主 PRD §9.13） */
const SHUTDOWN_GRACE_MS = 15_000;

/**
 * Worker 部署单元入口。
 * 不监听业务 HTTP 端口，承载 Outbox 调度与 BullMQ 消费者（主 PRD §9.1，T4-2）。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[worker] 收到 ${signal}，开始优雅停机 ...`);
    const timer = setTimeout(() => {
      console.error('[worker] 优雅停机超时，强制退出');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    try {
      await app.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      console.error('[worker] 停机失败', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
