import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
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
  /**
   * 计数键来源：ip=来源 IP；user=已认证用户；raw=装饰器给定值；
   * cookie/query=从请求提取的动态值（keyName 指定名称），用于按会话/一次性状态值限流
   */
  keyType: 'ip' | 'user' | 'raw' | 'cookie' | 'query';
  /** keyType='raw' 时的固定键值 */
  key?: string;
  /** keyType='cookie'/'query' 时读取的 cookie/query 参数名 */
  keyName?: string;
  /** 窗口内允许次数 */
  limit: number;
  /** 窗口长度（秒） */
  windowSeconds: number;
}

/**
 * 路由级限流声明装饰器（可叠加多个 @RateLimit 实现多维限流）。
 * SetMetadata 重复定义同一键会互相覆盖，故此处按数组累加，
 * 使 guard 侧 getAllAndMerge 总能取到完整维度列表。
 */
export function RateLimit(options: RateLimitOptions): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    // TS6 PropertyDescriptor.value 为可选泛型，装饰器场景 handler 必然存在
    const handler = descriptor.value as unknown as object;
    const existing = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitOptions[] | undefined;
    Reflect.defineMetadata(RATE_LIMIT_KEY, existing ? [...existing, options] : [options], handler);
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
    const merged = this.reflector.getAllAndMerge<RateLimitOptions[]>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    // NestJS getAllAndMerge 对单条 metadata 返回对象而非数组（reflector.service.ts），统一规整为数组
    const options = (Array.isArray(merged) ? merged : [merged]).filter((o): o is RateLimitOptions => o !== undefined);
    if (options.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    // 多维限流逐项判定：任一维度超限即拒绝（base PRD §4：钉钉授权按 IP/会话/一次性状态值限流）
    for (const option of options) {
      const key = this.resolveKey(option, request);
      if (!key) {
        // 动态键缺失（如无流程 Cookie 的扫码登录）——该维度无从计数，跳过（由 IP 维度兜底）
        continue;
      }
      const redisKeyName = redisKey(REDIS_NAMESPACE.RATE_LIMIT, option.scope, key);
      const count = await this.redis.incr(redisKeyName);
      if (count === 1) {
        await this.redis.expire(redisKeyName, option.windowSeconds);
      }
      if (count > option.limit) {
        throw new BusinessException(frameworkErrors.RATE_LIMITED);
      }
    }
    return true;
  }

  private resolveKey(options: RateLimitOptions, request: Request): string | undefined {
    switch (options.keyType) {
      case 'ip':
        return request.ip ?? 'unknown';
      case 'user': {
        const userId = getRequestContext()?.userId;
        return userId === undefined ? 'anonymous' : String(userId);
      }
      case 'raw':
        return options.key ?? 'fixed';
      case 'cookie': {
        const value = parseCookies(request.headers.cookie)[options.keyName ?? ''];
        return value || undefined;
      }
      case 'query': {
        const value = (request.query[options.keyName ?? ''] as string | undefined) ?? undefined;
        return value || undefined;
      }
    }
  }
}

/** 轻量 Cookie 解析（request.headers.cookie；仅取值不做签名校验） */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      result[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return result;
}
