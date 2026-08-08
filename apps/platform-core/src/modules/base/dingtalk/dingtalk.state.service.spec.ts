import { Test } from '@nestjs/testing';
import { BusinessException } from '@wbme/contracts';
import { redisKey, REDIS_NAMESPACE, REDIS_CLIENT } from '@wbme/server';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DingtalkStateService } from './dingtalk.state.service';

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('DingtalkStateService（base PRD §2 一次性 state）', () => {
  let redis: Redis;
  let service: DingtalkStateService;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL ?? 'redis://localhost:6379');
    const moduleRef = await Test.createTestingModule({
      providers: [DingtalkStateService, { provide: REDIS_CLIENT, useValue: redis }],
    }).compile();
    service = moduleRef.get(DingtalkStateService);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('签发后可消费一次，再消费拒绝（一次性）', async () => {
    const state = await service.issue('LOGIN', '/portal');
    const data = await service.consume(state, 'LOGIN');
    expect(data.purpose).toBe('LOGIN');
    expect(data.returnTo).toBe('/portal');
    await expect(service.consume(state, 'LOGIN')).rejects.toBeInstanceOf(BusinessException);
  });

  it('purpose 不匹配拒绝', async () => {
    const state = await service.issue('ACTIVATION');
    await expect(service.consume(state, 'RESET')).rejects.toBeInstanceOf(BusinessException);
  });

  it('不存在的 state 拒绝', async () => {
    await expect(service.consume('no-such-state', 'LOGIN')).rejects.toBeInstanceOf(BusinessException);
  });

  it('TTL 内存在、超时后消失', async () => {
    const state = await service.issue('LOGIN');
    const key = redisKey(REDIS_NAMESPACE.DINGTALK_STATE, state);
    expect(await redis.exists(key)).toBe(1);
    await redis.del(key);
    await expect(service.consume(state, 'LOGIN')).rejects.toBeInstanceOf(BusinessException);
  });
});
