import { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { getRequestContext } from './request-context';

/** 非业务 GET 路由前缀：健康探针、内部接口、认证流程。 */
const EXCLUDED_ROUTE_PREFIXES = [
  '/healthz',
  '/readyz',
  '/internal/',
  '/auth/',
  '/api/v1/healthz',
  '/api/v1/readyz',
  '/api/v1/internal/',
  '/api/v1/auth/',
];

/**
 * 判断 GET 路由是否应记录查询操作日志。
 *
 * @param route 路由模板
 * @returns true=不记录
 */
export function isExcludedQueryLogRoute(route: string): boolean {
  return EXCLUDED_ROUTE_PREFIXES.some((prefix) => route.startsWith(prefix));
}

/**
 * 查询操作日志拦截器工厂。
 *
 * 对成功返回的 GET 请求异步写入一条 QUERY 操作日志；不阻塞业务响应，
 * 写入失败只记录 stderr，不改变原请求结果。
 *
 * @param writeLog 写入函数（由各部署单元注入 Prisma 与操作日志写入实现）
 * @returns NestInterceptor
 */
export function createQueryOperationLogInterceptor(
  writeLog: (route: string, userId: number) => Promise<void>,
): NestInterceptor {
  return new QueryOperationLogInterceptor(writeLog);
}

class QueryOperationLogInterceptor implements NestInterceptor {
  constructor(private readonly writeLog: (route: string, userId: number) => Promise<void>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ method?: string; route?: { path?: string } }>();
    if (req?.method !== 'GET') {
      return next.handle();
    }
    const route = req.route?.path ?? '?';
    const userId = getRequestContext()?.userId;
    if (!userId) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        void this.writeLog(route, userId).catch((error: unknown) => {
          console.error(
            `[query-log] 写入查询操作日志失败 route=${route} userId=${userId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }),
    );
  }
}
