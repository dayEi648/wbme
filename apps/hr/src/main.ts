import { NestFactory } from '@nestjs/core';
import { RawSqlErrorLogWriter, type RawSqlClient } from '@wbme/logging';
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
import { PrismaService } from './prisma.service';

/** 优雅停机宽限（毫秒，主 PRD §9.13：固定有界时间，超时强制退出） */
const SHUTDOWN_GRACE_MS = 30_000;

/** hr 应用入口 */
async function bootstrap(): Promise<void> {
  // Redis 启动强依赖（主 PRD §9.8）：探测失败以非零状态退出，不监听业务端口
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = createRedisClient(redisUrl);
  await assertRedisAvailable(redis);

  const app = await NestFactory.create(AppModule.register({ redis }));
  app.use(createRequestContextMiddleware('hr'));
  // 内部 REST 不挂 api/v1 前缀（主 PRD §9.4；与 healthz/readyz 同级排除）
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'internal/(.*)'] });
  // 集中错误日志聚合（backstage PRD §8）：未知/依赖异常写入 backstage.error_logs
  const prisma = app.get(PrismaService);
  const errorLogWriter = RawSqlErrorLogWriter.from(prisma.client as unknown as RawSqlClient);
  app.useGlobalFilters(new GlobalExceptionFilter(defaultDependencyDetector, errorLogWriter));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new IdempotencyHeaderInterceptor(), new AccessLogInterceptor(), new RequestTimeoutInterceptor());

  const port = Number(process.env.HR_PORT ?? 3003);
  await app.listen(port);
  console.log(`hr listening on http://localhost:${port}`);

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
    console.log(`[hr] 收到 ${signal}，开始优雅停机 ...`);
    const timer = setTimeout(() => {
      console.error('[hr] 优雅停机超时，强制退出');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    try {
      await app.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      console.error('[hr] 停机失败', error);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  console.error('hr 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
