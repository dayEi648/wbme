import { NestFactory } from '@nestjs/core';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import {
  AccessLogInterceptor,
  assertRedisAvailable,
  createRedisClient,
  createRequestContextMiddleware,
  createValidationPipe,
  defaultDependencyDetector,
  GlobalExceptionFilter,
  IdempotencyHeaderInterceptor,
  RequestTimeoutInterceptor,
  ShutdownStateService,
} from '@wbme/server';
import { AppModule } from './app.module';
import { PlatformErrorLogWriter } from './modules/base/security-log/platform-error-log.writer';

/** 优雅停机宽限（毫秒，主 PRD §9.13：固定有界时间，超时强制退出） */
const SHUTDOWN_GRACE_MS = 30_000;

// 加载仓库根 .env（开发环境本地变量；生产/CI 由部署环境注入，缺失时跳过）
// dist/main.js → apps/platform-core/dist → 仓库根需要上三级
try {
  loadEnvFile(resolve(__dirname, '../../../.env'));
} catch {
  // .env 不存在时使用进程环境变量（CI / 部署注入场景）
}

/** platform-core 应用入口：base 与 backstage 逻辑模块共同运行的部署单元（主 PRD §1.3） */
async function bootstrap(): Promise<void> {
  // Redis 启动强依赖（主 PRD §9.8）：探测失败以非零状态退出，不监听业务端口
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = createRedisClient(redisUrl);
  await assertRedisAvailable(redis);

  const app = await NestFactory.create(AppModule.register({ redis }));
  app.use(createRequestContextMiddleware('platform-core'));
  // 内部 REST 不挂 api/v1 前缀（主 PRD §9.4；与 healthz/readyz 同级排除）
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'internal/(.*)'] });
  const errorLogWriter = app.get(PlatformErrorLogWriter);
  app.useGlobalFilters(new GlobalExceptionFilter(defaultDependencyDetector, errorLogWriter));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new IdempotencyHeaderInterceptor(), new AccessLogInterceptor(), new RequestTimeoutInterceptor());

  const port = Number(process.env.PLATFORM_CORE_PORT ?? 3001);
  await app.listen(port);
  console.log(`platform-core listening on http://localhost:${port}`);

  // 优雅停机（主 PRD §9.13）：SIGTERM/SIGINT → 就绪探针立即 503 → 有界宽限内
  // 等待请求到达安全事务边界 → app.close（HTTP 停止 + Prisma/Redis 客户端关闭）→ 退出
  const shutdownState = app.get(ShutdownStateService);
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    shutdownState.beginShutdown();
    console.log(`[platform-core] 收到 ${signal}，开始优雅停机 ...`);
    const timer = setTimeout(() => {
      console.error('[platform-core] 优雅停机超时，强制退出');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    try {
      await app.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      console.error('[platform-core] 停机失败', error);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  console.error('platform-core 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
