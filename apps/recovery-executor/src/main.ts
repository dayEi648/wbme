import { NestFactory } from '@nestjs/core';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import { RecoveryExecutorModule } from './recovery-executor.module';

try {
  loadEnvFile(resolve(__dirname, '../../../.env'));
} catch {
  // 生产由部署注入
}

/**
 * 恢复执行器入口（backstage PRD §10）。
 * 不依赖 Redis 启动；承载 /recovery 内部控制路由。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(RecoveryExecutorModule);
  app.use(cookieParser());
  const port = Number(process.env.RECOVERY_EXECUTOR_PORT ?? 3010);
  await app.listen(port);
  console.log(`recovery-executor listening on http://localhost:${port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error('recovery-executor 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
