import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 Redis；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { redisKey, REDIS_NAMESPACE } from '../redis/redis-constants';
import { REDIS_CLIENT } from '../redis/tokens';
import { SessionService } from './session.service';

const REDIS_URL = process.env.REDIS_URL;

/** 测试专用 Redis 客户端提供者（真实 Redis，本地开发机与 CI 均可用） */
@Injectable()
class TestRedisProvider {
  static client = new Redis(REDIS_URL ?? 'redis://localhost:6379');
}

describe.skipIf(!REDIS_URL)('SessionService（主 PRD §9.8、base PRD §3）', () => {
  const client = TestRedisProvider.client;
  let session: SessionService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: REDIS_CLIENT, useValue: client },
      ],
    }).compile();
    session = moduleRef.get(SessionService);
  });

  afterEach(async () => {
    // 清理测试键（前缀 session:）
    const keys = await client.keys(redisKey(REDIS_NAMESPACE.SESSION, '*'));
    if (keys.length > 0) {
      await client.del(...keys);
    }
  });

  const opts = {
    userId: 1,
    sessionVersion: 0,
    rememberMe: false,
    idleTimeoutMs: 60_000,
    absoluteTimeoutMs: 3600_000,
  };

  it('创建会话：TTL = min(空闲, 绝对)', async () => {
    const { sessionId } = await session.create(opts);
    const ttl = await client.pttl(redisKey(REDIS_NAMESPACE.SESSION, sessionId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('读取会话：返回数据并校验绝对过期', async () => {
    const { sessionId } = await session.create(opts);
    const data = await session.read(sessionId);
    expect(data?.u).toBe(1);
    expect(data?.sv).toBe(0);
  });

  it('读取不存在的会话返回 null', async () => {
    expect(await session.read('no-such-session')).toBeNull();
  });

  it('空闲续期：重算 TTL 仍不超过绝对剩余', async () => {
    const { sessionId } = await session.create({ ...opts, absoluteTimeoutMs: 10_000 });
    await session.touch(sessionId, { u: 1, sv: 0, pv: 0, ov: 0, otv: 0, dv: 0, rm: false, abs: Date.now() + 10_000 }, 60_000);
    const ttl = await client.pttl(redisKey(REDIS_NAMESPACE.SESSION, sessionId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });

  it('绝对过期后读取返回 null 并删除键', async () => {
    const { sessionId } = await session.create({ ...opts, absoluteTimeoutMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    expect(await session.read(sessionId)).toBeNull();
    expect(await client.exists(redisKey(REDIS_NAMESPACE.SESSION, sessionId))).toBe(0);
  });

  it('销毁会话', async () => {
    const { sessionId } = await session.create(opts);
    await session.destroy(sessionId);
    expect(await session.read(sessionId)).toBeNull();
  });

  it('轮换：删除旧会话并创建新会话（防会话固定）', async () => {
    const { sessionId } = await session.create(opts);
    const rotated = await session.rotate(sessionId, { ...opts, sessionVersion: 1 });
    expect(rotated.sessionId).not.toBe(sessionId);
    expect(await session.read(sessionId)).toBeNull();
    const data = await session.read(rotated.sessionId);
    expect(data?.sv).toBe(1);
  });
});
