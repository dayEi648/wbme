/**
 * 统一请求层（主 PRD §9.5/§10.5，T9-1 前置落地）。
 *
 * - baseURL=/api/v1、credentials 携带 Cookie、自动附加 X-WBME-CSRF-Token（双提交）；
 * - 写请求默认 X-WBME-Active: 1；读请求仅页面导航/用户查询显式传 { active: true }
 *   （轮询/预取/静默刷新不得续期，base PRD §3）；
 * - 重要写操作自动生成幂等键（每次用户意图一个，网络重试保持不变）；
 * - 统一错误映射：会话失效 → 清理登录态并跳登录页。
 */

/** 统一错误结构（主 PRD §9.5） */
export interface ApiErrorBody {
  error: {
    type: 'BUSINESS' | 'VALIDATION' | 'AUTHENTICATION' | 'AUTHORIZATION' | 'CONFLICT' | 'RATE_LIMIT' | 'TIMEOUT' | 'DEPENDENCY' | 'SYSTEM';
    domain?: string;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

export class ApiError extends Error {
  constructor(
    readonly body: ApiErrorBody['error'],
    readonly httpStatus: number,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }

  get type(): string {
    return this.body.type;
  }

  get code(): string {
    return this.body.code;
  }
}

/** 会话失效处理回调（session.ts 注入，避免循环依赖） */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(handler: () => void): void {
  onSessionExpired = handler;
}

/** 幂等键生成（每次用户意图一个 UUID） */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** 是否视为"有效交互"（续期会话）；写请求默认 true，读请求按页面导航/查询显式传 */
  active?: boolean;
  /** 重要写操作幂等键（自动生成并缓存，网络重试保持不变） */
  idempotencyKey?: string;
}

/** 读 CSRF Cookie（双提交） */
function readCsrfCookie(): string {
  const match = document.cookie.match(/(?:^|; )wbme_csrf=([^;]*)/);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

/** 规范化错误结构（非 JSON 或意外结构 → SYSTEM 兜底） */
function parseErrorBody(raw: string, status: number, requestId: string): ApiError {
  try {
    const parsed = JSON.parse(raw) as ApiErrorBody;
    if (parsed.error?.code) {
      return new ApiError(parsed.error, status);
    }
  } catch {
    // 非 JSON 响应按系统错误处理
  }
  return new ApiError(
    { type: 'SYSTEM', code: 'INTERNAL_ERROR', message: '系统处理失败，请稍后重试', requestId },
    status,
  );
}

/** 请求体编码（null/undefined 不带 body） */
function encodeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  return JSON.stringify(body);
}

/**
 * 统一请求入口。
 * @param path 相对路径（自动加 /api/v1 前缀）
 * @returns 解析后的 JSON 响应；非 2xx 抛 ApiError
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const isWrite = method !== 'GET';
  const active = options.active ?? isWrite;
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  // CSRF 双提交：状态变更且已有会话 Cookie 时必须携带
  const csrf = readCsrfCookie();
  if (isWrite && csrf) {
    headers['x-wbme-csrf-token'] = csrf;
  }
  // 有效交互续期标记
  if (active) {
    headers['x-wbme-active'] = '1';
  }
  // 幂等键（重要写操作；每次用户意图生成一次）
  if (options.idempotencyKey) {
    headers['idempotency-key'] = options.idempotencyKey;
  }

  const requestId = crypto.randomUUID();
  headers['x-request-id'] = requestId;

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: encodeBody(options.body),
    });
  } catch {
    throw new ApiError(
      { type: 'DEPENDENCY', code: 'DEPENDENCY_UNAVAILABLE', message: '网络异常，请稍后重试', requestId },
      0,
    );
  }

  if (response.ok) {
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  const raw = await response.text();
  const error = parseErrorBody(raw, response.status, requestId);
  // 会话失效：统一清理并跳登录（主 PRD §10.5）
  if (error.type === 'AUTHENTICATION' && error.code === 'SESSION_EXPIRED') {
    onSessionExpired?.();
  }
  throw error;
}

export const http = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) => api<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'PUT', body }),
};
