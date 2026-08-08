import { NestFactory } from '@nestjs/core';
import {
  AccessLogInterceptor,
  assertRedisAvailable,
  createRedisClient,
  createRequestContextMiddleware,
  createValidationPipe,
  GlobalExceptionFilter,
  RequestTimeoutInterceptor,
} from '@wbme/server';
import { AppModule } from './app.module';

/** platform-core 应用入口：base 与 backstage 逻辑模块共同运行的部署单元（主 PRD §1.3） */
async function bootstrap(): Promise<void> {
  // Redis 启动强依赖（主 PRD §9.8）：探测失败以非零状态退出，不监听业务端口
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = createRedisClient(redisUrl);
  await assertRedisAvailable(redis);

  const app = await NestFactory.create(AppModule.register({ redis }));
  app.use(createRequestContextMiddleware('platform-core'));
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new AccessLogInterceptor(), new RequestTimeoutInterceptor());

  const port = Number(process.env.PLATFORM_CORE_PORT ?? 3001);
  await app.listen(port);
  console.log(`platform-core listening on http://localhost:${port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error('platform-core 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
