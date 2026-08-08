import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './tokens';

/**
 * Redis 连接状态服务。
 *
 * - 提供就绪状态查询（/readyz 与降级判断使用，主 PRD §9.8）；
 * - 运行中连接失效时服务保持存活探针可用、就绪探针失败，依赖 Redis 的操作统一返回 503。
 */
@Injectable()
export class RedisService {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  /** 底层 ioredis 客户端（业务模块按命名空间约定使用） */
  get redis(): Redis {
    return this.client;
  }

  /** 就绪状态：连接可用且 PING 通过（ioredis status === 'ready'） */
  get isReady(): boolean {
    return this.client.status === 'ready';
  }
}
