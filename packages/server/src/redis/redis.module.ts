import { DynamicModule, Global, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_NAMESPACE, redisKey } from './redis-constants';
import { RedisService } from './redis.service';
import { REDIS_CLIENT } from './tokens';

/** Redis 启动前置检查超时（毫秒，集中常量；主 PRD §9.8 限定时间内完成） */
export const REDIS_PROBE_TIMEOUT_MS = 5_000;

/**
 * 创建 ioredis 客户端：lazyConnect 由首次命令触发连接。
 * 挂载默认 error 监听器，避免连接失败产生 unhandled error 事件导致进程崩溃；
 * 运行期失联由就绪探针与降级逻辑（主 PRD §9.8）处理。
 * @param url REDIS_URL
 * @returns 未连接的 Redis 实例（由 assertRedisAvailable 触发连接）
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  // 连接错误只记录不崩溃：启动探测与就绪探针负责决策
  client.on('error', (error: Error) => {
    console.error(`[redis] 连接错误：${error.message}`);
  });
  return client;
}

/**
 * Redis 启动前置检查（主 PRD §9.8）：
 * 连接 + PING + 带短 TTL 的读写删除探测；检查未通过时调用方必须以非零状态退出进程，
 * 不得退化为进程内会话/限流/队列。
 * @param client 待探测客户端
 * @param timeoutMs 限定时间（默认 5s）
 * @throws 探测失败（超时/无法读写删除）
 */
export async function assertRedisAvailable(client: Redis, timeoutMs: number = REDIS_PROBE_TIMEOUT_MS): Promise<void> {
  const probeKey = redisKey(REDIS_NAMESPACE.LOCK, 'startup-probe', randomUUID());
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.ping();
      const probeValue = randomUUID();
      await client.set(probeKey, probeValue, 'EX', 10);
      const readBack = await client.get(probeKey);
      await client.del(probeKey);
      if (readBack === probeValue) {
        return;
      }
      lastError = new Error('探测值回读不一致');
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Redis 启动探测失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

@Global()
@Module({})
export class RedisModule {
  /**
   * 注册全局 Redis 模块（应用启动时创建并探测通过后传入）。
   * @param client 已通过 assertRedisAvailable 探测的客户端
   */
  static forRoot(client: Redis): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      providers: [
        { provide: REDIS_CLIENT, useValue: client },
        RedisService,
      ],
      exports: [REDIS_CLIENT, RedisService],
    };
  }
}
