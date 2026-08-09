import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { catchError, Observable, tap } from 'rxjs';
import { getRequestContext } from './request-context';

/**
 * 访问结果拦截器（主 PRD §9.6）：统一记录访问结果与耗时。
 *
 * 记录内容：requestId、服务、路由模板、方法、结果类别（成功/失败）与耗时；
 * 不记录密码、Cookie、凭证、完整手机号等敏感数据。
 * 输出到 stdout（由容器日志驱动接管）并接入集中系统日志模块。
 */
@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ method?: string; route?: { path?: string } }>();
    const ctx = getRequestContext();
    const method = req?.method ?? '?';
    const route = req?.route?.path ?? '?';

    return next.handle().pipe(
      tap(() => {
        console.log(`[access] service=${ctx?.service} method=${method} route=${route} requestId=${ctx?.requestId} result=success cost=${Date.now() - (ctx?.startedAt ?? Date.now())}ms`);
      }),
      catchError((error: unknown) => {
        console.log(`[access] service=${ctx?.service} method=${method} route=${route} requestId=${ctx?.requestId} result=failed cost=${Date.now() - (ctx?.startedAt ?? Date.now())}ms error=${getErrorName(error)}`);
        throw error;
      }),
    );
  }
}

/** 只记录异常类名，不透传内部消息 */
function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
