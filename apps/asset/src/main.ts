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

/** asset 应用入口 */
async function bootstrap(): Promise<void> {
  // Redis 启动强依赖（主 PRD §9.8）：探测失败以非零状态退出，不监听业务端口
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = createRedisClient(redisUrl);
  await assertRedisAvailable(redis);

  const app = await NestFactory.create(AppModule.register({ redis }));
  app.use(createRequestContextMiddleware('asset'));
  // 内部 REST 不挂 api/v1 前缀（主 PRD §9.4；与 healthz/readyz 同级排除）
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'internal/(.*)'] });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new AccessLogInterceptor(), new RequestTimeoutInterceptor());

  const port = Number(process.env.ASSET_PORT ?? 3002);
  await app.listen(port);
  console.log(`asset listening on http://localhost:${port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error('asset 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
