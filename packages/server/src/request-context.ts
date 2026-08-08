import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * 请求上下文（主 PRD §9.6）：requestId/traceId、服务名与请求起始时间。
 *
 * 使用 AsyncLocalStorage 挂载：请求进入时创建上下文，链路内任意位置可读取；
 * 客户端携带的 X-Request-Id 仅当为合法 UUID 时沿用，否则服务端重新生成，
 * 不信任客户端提供的任意追踪值。
 */

export interface RequestContext {
  /** 请求追踪标识：响应头 X-Request-Id 返回同一值 */
  readonly requestId: string;
  /** 链路追踪标识：本期与 requestId 同值，为跨服务传播预留 */
  readonly traceId: string;
  /** 请求起始时间（毫秒时间戳） */
  readonly startedAt: number;
  /** 服务名（部署单元标识，由启动配置注入） */
  readonly service: string;
  /** 认证后的当前用户标识（由认证守卫写入） */
  userId?: number;
}

/** 全局请求上下文存储 */
export const REQUEST_CONTEXT_STORAGE = new AsyncLocalStorage<RequestContext>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 客户端 X-Request-Id 仅当格式为合法 UUID 时沿用 */
function resolveRequestId(header: unknown): string {
  return typeof header === 'string' && UUID_PATTERN.test(header) ? header : randomUUID();
}

/**
 * 创建请求上下文中间件。
 * @param service 本部署单元服务名
 * @returns Express/NestJS 中间件：生成上下文、设置响应头并进入 AsyncLocalStorage
 */
export function createRequestContextMiddleware(
  service: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const context: RequestContext = {
      requestId: resolveRequestId(req.headers['x-request-id']),
      traceId: randomUUID(),
      startedAt: Date.now(),
      service,
    };
    res.setHeader('X-Request-Id', context.requestId);
    REQUEST_CONTEXT_STORAGE.run(context, next);
  };
}

/** 读取当前请求上下文；在请求链路之外（后台任务等）调用返回 undefined */
export function getRequestContext(): RequestContext | undefined {
  return REQUEST_CONTEXT_STORAGE.getStore();
}
