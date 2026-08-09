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

/**
 * 本测试独用的 Redis db（独立于其它包/文件的 db 0）。
 * 原因：会话测试的 afterEach 清理 `session:*` 键，若与其它集成测试
 * （platform-core 等同样写入 `session:*` 键）并行跑会互相清键导致偶发失败。
 */
const TEST_REDIS_DB = 1;

/** 测试专用 Redis 客户端提供者（真实 Redis，本地开发机与 CI 均可用） */
@Injectable()
class TestRedisProvider {
  static client = new Redis(REDIS_URL ?? 'redis://localhost:6379', { db: TEST_REDIS_DB });
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

  it('提权旋转：标记后旧会话透明轮换（数据平移），同一会话不重复旋转（base PRD §3）', async () => {
    const { sessionId } = await session.create(opts);
    const before = await session.read(sessionId);
    // 无标记：不旋转
    const untouched = await session.rotateIfElevated(sessionId, before!);
    expect(untouched.sessionId).toBe(sessionId);

    await session.markElevation(1);
    // 跨过毫秒边界，保证旋转后的 iat 严格晚于标记时间（同毫秒命中按安全侧会再旋转一次）
    await new Promise((r) => setTimeout(r, 2));
    const rotated = await session.rotateIfElevated(sessionId, before!);
    expect(rotated.sessionId).not.toBe(sessionId);
    // 旧标识失效，数据平移（rm/abs 不变，iat 刷新）
    expect(await session.read(sessionId)).toBeNull();
    expect(rotated.data.u).toBe(1);
    expect(rotated.data.rm).toBe(false);
    expect(rotated.data.abs).toBe(before!.abs);
    expect(rotated.data.iat).toBeGreaterThanOrEqual(before!.iat ?? 0);
    expect(await session.read(rotated.sessionId)).not.toBeNull();
    // 旋转后 iat 晚于标记：同一会话不重复旋转
    const again = await session.rotateIfElevated(rotated.sessionId, rotated.data);
    expect(again.sessionId).toBe(rotated.sessionId);
  });

  it('提权旋转：标记早于会话建立时间不旋转；其它用户的标记不影响', async () => {
    await session.markElevation(1);
    // 跨过毫秒边界，保证后续会话的建立时间严格晚于标记时间
    await new Promise((r) => setTimeout(r, 2));
    // 标记之后建立的会话（iat > 标记时间）：不旋转
    const { sessionId } = await session.create(opts);
    const data = await session.read(sessionId);
    const result = await session.rotateIfElevated(sessionId, data!);
    expect(result.sessionId).toBe(sessionId);
    // 其它用户（userId=2）的会话不受 userId=1 的标记影响
    const other = await session.create({ ...opts, userId: 2 });
    // 先把 userId=2 的会话 iat 调到标记之前来模拟"标记前建立"：直接重建一个无 iat 的旧会话数据
    await client.del(redisKey(REDIS_NAMESPACE.SESSION, other.sessionId));
    await client.set(
      redisKey(REDIS_NAMESPACE.SESSION, other.sessionId),
      JSON.stringify({ u: 2, sv: 0, pv: 0, ov: 0, otv: 0, dv: 0, rm: false, abs: Date.now() + 3600_000 }),
      'PX',
      3_600_000,
    );
    const legacy = await session.read(other.sessionId);
    const untouched = await session.rotateIfElevated(other.sessionId, legacy!);
    expect(untouched.sessionId).toBe(other.sessionId);
    // 而 userId=1 的无 iat 旧会话（缺省视为 0，早于标记）会被旋转一次
    const legacyOfMarked = await session.create({ ...opts });
    await client.del(redisKey(REDIS_NAMESPACE.SESSION, legacyOfMarked.sessionId));
    await client.set(
      redisKey(REDIS_NAMESPACE.SESSION, legacyOfMarked.sessionId),
      JSON.stringify({ u: 1, sv: 0, pv: 0, ov: 0, otv: 0, dv: 0, rm: false, abs: Date.now() + 3600_000 }),
      'PX',
      3_600_000,
    );
    const legacyData = await session.read(legacyOfMarked.sessionId);
    const rotated = await session.rotateIfElevated(legacyOfMarked.sessionId, legacyData!);
    expect(rotated.sessionId).not.toBe(legacyOfMarked.sessionId);
  });
});
