import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type { DataScope } from '@wbme/contracts';

/**
 * 请求上下文（主 PRD §9.6）：requestId/traceId、服务名与请求起始时间。
 *
 * 使用 AsyncLocalStorage 挂载：请求进入时创建上下文，链路内任意位置可读取；
 * 客户端携带的 X-Request-Id 仅当为合法 UUID 时沿用，否则服务端重新生成，
 * 不信任客户端提供的任意追踪值。
 */

/** 当前路由声明功能的授权数据范围（函数权限守卫写入，主 PRD §3.1/§9.6） */
export interface GrantedFunctionContext {
  /** 路由声明的稳定功能编码 */
  code: string;
  /** 当前用户对该功能的有效数据范围（多档位授权按最宽合并）；
   * null = 不受数据范围限制（超级管理员豁免，仅针对访问控制） */
  dataScope: DataScope | null;
}

export interface RequestContext {
  /** 请求追踪标识：响应头 X-Request-Id 返回同一值 */
  readonly requestId: string;
  /** 链路追踪标识：与 requestId 同值，为跨服务传播预留 */
  readonly traceId: string;
  /** 请求起始时间（毫秒时间戳） */
  readonly startedAt: number;
  /** 服务名（部署单元标识，由启动配置注入） */
  readonly service: string;
  /** 认证后的当前用户标识（由认证守卫写入） */
  userId?: number;
  /** 当前路由的授权功能与数据范围（由函数权限守卫写入；业务层据此做行级过滤，
   * 范围外记录视为不存在以 404 呈现；未声明功能要求的路由不写入） */
  grantedFunction?: GrantedFunctionContext;
  /** 请求级互斥锁（守卫在读取上传请求体前取得后写入；业务服务复用，响应结束统一释放） */
  importLockRelease?: () => Promise<void>;
  /** 单用户导入占用取得时刻（fin PRD §4：总时限从取得占用并开始接收请求体时计算） */
  importStartedAt?: number;
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

/**
 * 写入认证后的当前用户标识（由认证守卫调用，主 PRD §9.6）。
 * 业务代码只读上下文，不自行写入。
 */
export function setRequestUserId(userId: number): void {
  const context = REQUEST_CONTEXT_STORAGE.getStore();
  if (context) {
    context.userId = userId;
  }
}

/**
 * 写入当前路由的授权功能与数据范围（由函数权限守卫在功能校验通过后写入，主 PRD §9.6）。
 * 业务层只读：按 dataScope 做行级过滤，范围外记录视为不存在（404 呈现）。
 */
export function setGrantedFunction(granted: GrantedFunctionContext): void {
  const context = REQUEST_CONTEXT_STORAGE.getStore();
  if (context) {
    context.grantedFunction = granted;
  }
}

/**
 * 读取当前路由的授权功能与数据范围（函数权限守卫写入后可用）。
 *
 * @returns 授权上下文；未声明功能要求的路由返回 undefined
 */
export function getGrantedFunction(): GrantedFunctionContext | undefined {
  return getRequestContext()?.grantedFunction;
}

/**
 * 写入当前请求已持有的导入互斥锁（由守卫在读取上传请求体前取得后写入；fin PRD §4）。
 * 业务服务调用 getRequestImportLockRelease 复用同一句柄，避免重复获取；释放统一由守卫挂到响应关闭。
 */
export function setRequestImportLockRelease(release: () => Promise<void>): void {
  const context = REQUEST_CONTEXT_STORAGE.getStore();
  if (context) {
    context.importLockRelease = release;
  }
}

/** 读取当前请求已持有的导入互斥锁；守卫未获取时返回 undefined */
export function getRequestImportLockRelease(): (() => Promise<void>) | undefined {
  return getRequestContext()?.importLockRelease;
}

/**
 * 写入单用户导入占用取得时刻（由导入互斥守卫在取得占用后写入；fin PRD §4：
 * 总时限从取得占用并开始接收请求体时计算，覆盖上传读取阶段）。
 */
export function setRequestImportStartedAt(startedAt: number): void {
  const context = REQUEST_CONTEXT_STORAGE.getStore();
  if (context) {
    context.importStartedAt = startedAt;
  }
}

/** 读取导入占用取得时刻；守卫未写入时返回 undefined（兜底用当前时刻） */
export function getRequestImportStartedAt(): number | undefined {
  return getRequestContext()?.importStartedAt;
}
