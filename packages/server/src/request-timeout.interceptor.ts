import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { catchError, Observable, throwError, timeout, TimeoutError } from 'rxjs';
import { BusinessException, frameworkErrors } from '@wbme/contracts';

/** 请求固定总超时（集中常量，受版本控制；主 PRD §1.4 安全常量不进设置页） */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 请求超时拦截器（主 PRD §9.6）：超过固定总时限返回统一 TIMEOUT 错误。
 *
 * 到期返回 `503 TIMEOUT + REQUEST_TIMEOUT`（由全局过滤器映射）；
 * 流式下载、SSE 与备份/恢复等长任务应使用单独超时策略，不挂载本拦截器。
 */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(private readonly timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.timeoutMs),
      catchError((error: unknown) => {
        if (error instanceof TimeoutError) {
          return throwError(() => new BusinessException(frameworkErrors.REQUEST_TIMEOUT));
        }
        return throwError(() => error);
      }),
    );
  }
}
