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

/** fin 应用入口（T8 业务模块落地时接入集中错误日志：RawSqlErrorLogWriter.from(PrismaService)） */
async function bootstrap(): Promise<void> {
  // Redis 启动强依赖（主 PRD §9.8）：探测失败以非零状态退出，不监听业务端口
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = createRedisClient(redisUrl);
  await assertRedisAvailable(redis);

  const app = await NestFactory.create(AppModule.register({ redis }));
  app.use(createRequestContextMiddleware('fin'));
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new AccessLogInterceptor(), new RequestTimeoutInterceptor());

  const port = Number(process.env.FIN_PORT ?? 3004);
  await app.listen(port);
  console.log(`fin listening on http://localhost:${port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error('fin 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
