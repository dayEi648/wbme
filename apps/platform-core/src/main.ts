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
} from '@wbme/server';
import { AppModule } from './app.module';
import { PlatformErrorLogWriter } from './modules/base/security-log/platform-error-log.writer';

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
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  const errorLogWriter = app.get(PlatformErrorLogWriter);
  app.useGlobalFilters(new GlobalExceptionFilter(defaultDependencyDetector, errorLogWriter));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new IdempotencyHeaderInterceptor(), new AccessLogInterceptor(), new RequestTimeoutInterceptor());

  const port = Number(process.env.PLATFORM_CORE_PORT ?? 3001);
  await app.listen(port);
  console.log(`platform-core listening on http://localhost:${port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error('platform-core 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
