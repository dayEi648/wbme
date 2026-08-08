import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { getRequestContext } from '../request-context';
import { redisKey, REDIS_NAMESPACE } from '../redis/redis-constants';
import { REDIS_CLIENT } from '../redis/tokens';

/**
 * 通用 Redis 限流守卫（主 PRD §9.7：登录、钉钉回调、激活兑换等接口限流）。
 *
 * 用法：`@UseGuards(RateLimitGuard) @RateLimit({ keyType: 'ip', limit: 20, windowSeconds: 60 })`
 * 计数键 `ratelimit:{scope}:{key}`，INCR 首次设置 TTL；超限返回统一 `RATE_LIMITED`。
 * Redis 故障时按主 PRD §9.8 返回 DEPENDENCY（不放行未计数请求）。
 */

export const RATE_LIMIT_KEY = 'wbme_rate_limit';

export interface RateLimitOptions {
  /** 限流作用域（键前缀，如 login / dingtalk-callback / redeem） */
  scope: string;
  /** 计数键来源：ip=来源 IP；user=已认证用户；raw=装饰器给定值 */
  keyType: 'ip' | 'user' | 'raw';
  /** keyType='raw' 时的固定键值 */
  key?: string;
  /** 窗口内允许次数 */
  limit: number;
  /** 窗口长度（秒） */
  windowSeconds: number;
}

/** 路由级限流声明装饰器 */
export function RateLimit(options: RateLimitOptions): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    SetMetadata(RATE_LIMIT_KEY, options)(descriptor.value as object, propertyKey as string | symbol, descriptor);
    return descriptor;
  };
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<RateLimitOptions>(RATE_LIMIT_KEY, context.getHandler());
    if (!options) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.resolveKey(options, request);
    const redisKeyName = redisKey(REDIS_NAMESPACE.RATE_LIMIT, options.scope, key);

    const count = await this.redis.incr(redisKeyName);
    if (count === 1) {
      await this.redis.expire(redisKeyName, options.windowSeconds);
    }
    if (count > options.limit) {
      throw new BusinessException(frameworkErrors.RATE_LIMITED);
    }
    return true;
  }

  private resolveKey(options: RateLimitOptions, request: Request): string {
    switch (options.keyType) {
      case 'ip':
        return request.ip ?? 'unknown';
      case 'user': {
        const userId = getRequestContext()?.userId;
        return userId === undefined ? 'anonymous' : String(userId);
      }
      case 'raw':
        return options.key ?? 'fixed';
    }
  }
}
