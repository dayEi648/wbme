import { NestFactory } from '@nestjs/core';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import { RecoveryExecutorModule } from './recovery-executor.module';
import { RecoveryExecutorService } from './recovery-executor.service';

/** 优雅停机宽限（毫秒，主 PRD §9.13：固定有界时间，超时强制退出） */
const SHUTDOWN_GRACE_MS = 30_000;

try {
  loadEnvFile(resolve(__dirname, '../../../.env'));
} catch {
  // 生产由部署注入
}

/**
 * 恢复执行器入口（backstage PRD §10）。
 * 不依赖 Redis 启动；承载 /recovery 内部控制路由。
 *
 * 优雅停机（主 PRD §9.13）：SIGTERM/SIGINT → 就绪探针立即失败（beginShutdown）→
 * app.close（HTTP 停止 + 客户端关闭）→ 退出。
 * 恢复管道为后台 fire-and-forget：停机只置位阶段边界检查（阶段间不再推进、停写轮询中止），
 * 不等待在途 stage 结束；安全性由"恢复清单先落盘后执行、重启按清单 stage 续跑"保证
 * （服务恢复后未完成的恢复保持维护状态，清单保留供超管重试）。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(RecoveryExecutorModule);
  app.use(cookieParser());
  const port = Number(process.env.RECOVERY_EXECUTOR_PORT ?? 3090);
  await app.listen(port);
  console.log(`recovery-executor listening on http://localhost:${port}`);

  const recovery = app.get(RecoveryExecutorService);
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    recovery.beginShutdown();
    console.log(`[recovery-executor] 收到 ${signal}，开始优雅停机 ...`);
    const timer = setTimeout(() => {
      console.error('[recovery-executor] 优雅停机超时，强制退出');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    try {
      await app.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      console.error('[recovery-executor] 停机失败', error);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  console.error('recovery-executor 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
