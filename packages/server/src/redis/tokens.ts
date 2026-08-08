import type { Redis } from 'ioredis';

/** Redis 客户端注入令牌（RedisModule 全局提供） */
export const REDIS_CLIENT = Symbol('WBME_REDIS_CLIENT');

export type { Redis };
