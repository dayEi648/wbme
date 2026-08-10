import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  GlobalExceptionFilter,
  RateLimit,
  RateLimitGuard,
  RedisModule,
  REDIS_NAMESPACE,
  createRedisClient,
  redisKey,
} from '@wbme/server';
import { SharedModule } from './shared.module';

// 加载仓库根 .env（与 excel-cancel 集成测试一致：本地 Redis/PostgreSQL 默认可跑；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const SCOPE = `integration-test-${process.pid}`;

/** 探针端点：模拟生产 controller 的声明方式（M2 回归：守卫须真实执行并计数） */
@Controller('rate-limit-probe')
class RateLimitProbeController {
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: SCOPE, keyType: 'ip', limit: 2, windowSeconds: 60 })
  @Get('ping')
  ping(): string {
    return 'ok';
  }
}

describe('RateLimitGuard 注册与限流（M2 复核回归：未注册时 Nest 静默跳过守卫）', () => {
  let app: INestApplication;
  let redis: ReturnType<typeof createRedisClient>;

  beforeAll(async () => {
    redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const moduleRef: TestingModule = await Test.createTestingModule({
      // 经真实 SharedModule 装配：RateLimitGuard 由 @Global SharedModule 提供——
      // 若未来被移出 providers，此测试将失败（守卫未注册 → Nest 静默跳过 → 恒 200）
      imports: [RedisModule.forRoot(redis), SharedModule],
      controllers: [RateLimitProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    // 与生产 main.ts 一致：BusinessException → 统一错误体（RATE_LIMITED → 429）
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // 清理本测试的计数键（127.0.0.1 为 supertest 默认来源 IP）
    await redis.del(redisKey(REDIS_NAMESPACE.RATE_LIMIT, SCOPE, '127.0.0.1'));
    redis.disconnect();
  });

  it('窗口内第 3 次请求返回 429 RATE_LIMITED（守卫真实执行）', async () => {
    await request(app.getHttpServer()).get('/rate-limit-probe/ping').expect(200).expect('ok');
    await request(app.getHttpServer()).get('/rate-limit-probe/ping').expect(200).expect('ok');
    const res = await request(app.getHttpServer()).get('/rate-limit-probe/ping').expect(429);
    expect(res.body.error).toMatchObject({ type: 'RATE_LIMIT', code: 'RATE_LIMITED' });
  });
});
