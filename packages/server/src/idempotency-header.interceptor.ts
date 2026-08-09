import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { IdempotentDto } from '@wbme/contracts';
import type { Observable } from 'rxjs';

interface RouteArgumentMetadata {
  index?: number;
}

type Constructor = { prototype: object };

/**
 * 将 HTTP `Idempotency-Key` 安全映射到声明了 IdempotentDto 的请求体。
 *
 * 浏览器和内部 HTTP 客户端均使用标准请求头传递同一次用户意图的幂等键，而既有业务 DTO
 * 将该键声明为 body 字段。本拦截器只在路由的 @Body() 参数类型继承 IdempotentDto 时补齐字段：
 * 非幂等 DTO（例如认证、扫码解析）不会收到未知字段，从而保持全局白名单严格生效。
 */
@Injectable()
export class IdempotencyHeaderInterceptor implements NestInterceptor {
  /**
   * 在参数校验前补齐幂等键。
   *
   * @param context 当前 HTTP 执行上下文
   * @param next 后续处理器
   * @returns 后续响应流
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ body?: unknown; headers: Record<string, string | string[] | undefined> }>();
    const header = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    if (!idempotencyKey || !this.acceptsIdempotencyKey(context)) {
      return next.handle();
    }

    if (!isRecord(request.body)) {
      request.body = { idempotencyKey };
    } else if (request.body.idempotencyKey === undefined) {
      request.body = { ...request.body, idempotencyKey };
    }
    return next.handle();
  }

  /** 判断控制器的 @Body 参数是否明确继承 IdempotentDto。 */
  private acceptsIdempotencyKey(context: ExecutionContext): boolean {
    const controller = context.getClass() as Constructor;
    const handler = context.getHandler();
    const routeArgs = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler.name) as Record<string, RouteArgumentMetadata> | undefined;
    const parameterTypes = Reflect.getMetadata('design:paramtypes', controller.prototype, handler.name) as unknown[] | undefined;
    if (!routeArgs || !parameterTypes) {
      return false;
    }
    return Object.entries(routeArgs).some(([key, metadata]) => {
      // Nest RouteParamtypes.BODY 当前为 3；此元数据格式由 Nest 的 @Body 装饰器生成。
      if (!key.startsWith('3:') || typeof metadata.index !== 'number') {
        return false;
      }
      const parameterType = parameterTypes[metadata.index];
      return typeof parameterType === 'function'
        && (parameterType === IdempotentDto || (parameterType as Constructor).prototype instanceof IdempotentDto);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
