import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 Redis；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { HealthModule } from '../health/health.module';
import { REDIS_NAMESPACE, redisKey } from './redis-constants';
import { assertRedisAvailable, createRedisClient, RedisModule } from './redis.module';

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('Redis 启动探测与健康探针（主 PRD §9.8/§9.13）', () => {
  let redis: Redis;
  let app: INestApplication;

  beforeAll(async () => {
    redis = createRedisClient(REDIS_URL!);
    await assertRedisAvailable(redis);
    const moduleRef = await Test.createTestingModule({
      imports: [RedisModule.forRoot(redis), HealthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    redis.disconnect();
  });

  it('命名空间键生成互不覆盖（主 PRD §9.8）', () => {
    expect(redisKey(REDIS_NAMESPACE.SESSION, 1)).toBe('session:1');
    expect(redisKey(REDIS_NAMESPACE.QUEUE, 'backup')).toBe('queue:backup');
    expect(redisKey(REDIS_NAMESPACE.SESSION, 1)).not.toBe(redisKey(REDIS_NAMESPACE.RATE_LIMIT, 1));
  });

  it('启动探测通过后可读写删除', async () => {
    await redis.set('spec:probe', 'v', 'EX', 10);
    await expect(redis.get('spec:probe')).resolves.toBe('v');
    await redis.del('spec:probe');
  });

  it('不可达 Redis 的探测在限定时间内失败（进程应退出，不降级）', async () => {
    const unreachable = createRedisClient('redis://127.0.0.1:59999');
    await expect(assertRedisAvailable(unreachable, 1_200)).rejects.toThrow(/Redis 启动探测失败/);
    unreachable.disconnect();
  });

  it('/healthz 免登录返回存活状态', async () => {
    const res = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('/readyz 依赖就绪时返回 200 最小状态（不暴露依赖地址）', async () => {
    const res = await request(app.getHttpServer()).get('/readyz').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(JSON.stringify(res.body)).not.toContain('localhost');
  });
});
