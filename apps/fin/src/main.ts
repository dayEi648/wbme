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
} from '@wbme/server';
import { AppModule } from './app.module';
import { PrismaService } from './prisma.service';

/** fin 应用入口 */
async function bootstrap(): Promise<void> {
  // Redis 启动强依赖（主 PRD §9.8）：探测失败以非零状态退出，不监听业务端口
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = createRedisClient(redisUrl);
  await assertRedisAvailable(redis);

  const app = await NestFactory.create(AppModule.register({ redis }));
  app.use(createRequestContextMiddleware('fin'));
  // 内部 REST 不挂 api/v1 前缀（主 PRD §9.4；与 healthz/readyz 同级排除）
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'internal/(.*)'] });
  // 集中错误日志聚合（T4-3 / backstage PRD §8）：未知/依赖异常写入 backstage.error_logs
  const prisma = app.get(PrismaService);
  const errorLogWriter = RawSqlErrorLogWriter.from(prisma.client as unknown as RawSqlClient);
  app.useGlobalFilters(new GlobalExceptionFilter(defaultDependencyDetector, errorLogWriter));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new IdempotencyHeaderInterceptor(), new AccessLogInterceptor(), new RequestTimeoutInterceptor());

  const port = Number(process.env.FIN_PORT ?? 3004);
  await app.listen(port);
  console.log(`fin listening on http://localhost:${port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error('fin 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
