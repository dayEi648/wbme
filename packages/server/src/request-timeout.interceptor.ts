import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { catchError, Observable, throwError, timeout, TimeoutError } from 'rxjs';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { REQUEST_TIMEOUT_METADATA } from './request-timeout.decorator';

/** 请求固定总超时（集中常量，受版本控制；主 PRD §1.4 安全常量不进设置页） */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 请求超时拦截器（主 PRD §9.6）：超过固定总时限返回统一 TIMEOUT 错误。
 *
 * 到期返回 `503 TIMEOUT + REQUEST_TIMEOUT`（由全局过滤器映射）；
 * 路由级 `@RequestTimeout(ms)` 装饰器可覆盖全局默认值（长任务路由显式放宽）；
 * 流式下载、SSE 与备份/恢复等长任务应使用单独超时策略，不挂载本拦截器。
 */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(private readonly timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const routeTimeout = Reflect.getMetadata(REQUEST_TIMEOUT_METADATA, context.getHandler()) as number | undefined;
    const effectiveTimeout = typeof routeTimeout === 'number' && routeTimeout > 0 ? routeTimeout : this.timeoutMs;
    return next.handle().pipe(
      timeout(effectiveTimeout),
      catchError((error: unknown) => {
        if (error instanceof TimeoutError) {
          return throwError(() => new BusinessException(frameworkErrors.REQUEST_TIMEOUT));
        }
        return throwError(() => error);
      }),
    );
  }
}
