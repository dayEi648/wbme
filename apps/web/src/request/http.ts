/**
 * 统一请求层（主 PRD §9.5/§10.5）。
 *
 * - 平台核心使用 /api/v1；独立业务服务使用稳定网关前缀 /api/{service}/v1；
 *   credentials 携带 Cookie、自动附加 X-WBME-CSRF-Token（双提交）；
 * - 写请求默认 X-WBME-Active: 1；读请求仅页面导航/用户查询显式传 { active: true }
 *   （轮询/预取/静默刷新不得续期，base PRD §3）；
 * - 重要写操作为每次用户意图生成随机幂等键；调用方在网络重试时显式复用同一键（主 PRD §9.5）；
 * - 统一错误映射：会话失效/账号状态异常 → 清理登录态并带提示跳登录页（base PRD §3）。
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

/** 会话失效处理回调（session.ts 注入，避免循环依赖）；可携带提示文案；silent=true 时仅跳转不弹提示 */
let onSessionExpired: ((message?: string, silent?: boolean) => void) | null = null;
export function setSessionExpiredHandler(handler: (message?: string, silent?: boolean) => void): void {
  onSessionExpired = handler;
}

/**
 * 是否处于已登录态（区分"从未登录"与"会话中途失效"，base PRD §3）。
 * 会话 Cookie（wbme_session）为 HttpOnly，前端不可读，故以同生命周期下发的 CSRF Cookie（wbme_csrf，
 * 非 HttpOnly）作为登录标记：登录成功/激活/注册/钉钉登录后均有该 Cookie，登出即清除；
 * "记住我"时两者同持久化、未勾选时同为浏览器会话级，生命周期始终一致。
 */
function hasSessionCookie(): boolean {
  return document.cookie.split(';').some((part) => part.trim().startsWith('wbme_csrf='));
}

/**
 * 为一次请求生成高熵幂等键。
 *
 * 不能按请求体哈希：两次独立但内容相同的业务意图必须分别执行。确需重试时，页面持有并显式
 * 传回第一次的键；失败请求不产生幂等记录，重试时后端按首次成功结果去重。
 */
function createIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** 目标公开服务；平台核心为默认值，业务服务经同源网关前缀路由。 */
  service?: ApiService;
  /** 是否视为"有效交互"（续期会话）；写请求默认 true，读请求按页面导航/查询显式传 */
  active?: boolean;
  /** 重要写操作幂等键；调用方在重试同一用户意图时显式复用。 */
  idempotencyKey?: string;
}

/** 二进制下载或 multipart 上传的选项。 */
export interface ServiceRequestOptions {
  service?: ApiService;
  active?: boolean;
  idempotencyKey?: string;
  /** 仅导出端点需要 POST 时复用与普通请求一致的 CSRF 与幂等约定。 */
  method?: 'GET' | 'POST';
  body?: unknown;
}

/**
 * 面向浏览器的公开 API 服务标识。
 *
 * 后端容器内部仍保留各自的 /api/v1 契约；前端只消费此处定义的同源网关路径，
 * 以消除 asset/hr/fin 中同名资源的路由歧义。
 */
export type ApiService = 'platform' | 'asset' | 'hr' | 'fin';

const SERVICE_PREFIX: Readonly<Record<ApiService, string>> = {
  platform: '/api/v1',
  asset: '/api/asset/v1',
  hr: '/api/hr/v1',
  fin: '/api/fin/v1',
};

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

/** 对所有请求形式统一处理会话与账号状态失效，避免下载/上传绕过会话清理。 */
function handleSessionError(error: ApiError): void {
  if (error.type === 'AUTHENTICATION' && error.code === 'SESSION_EXPIRED') {
    onSessionExpired?.(undefined, !hasSessionCookie());
  } else if ((error.code === 'ACCOUNT_DEACTIVATED' || error.code === 'ACCOUNT_PENDING_ACTIVATION') && hasSessionCookie()) {
    onSessionExpired?.(error.message);
  }
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
  const service = options.service ?? 'platform';
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
  // 幂等键：每次独立写入意图都有新键；调用方只有在重试同一次意图时才复用显式键。
  const idempotencyKey = options.idempotencyKey ?? (isWrite ? createIdempotencyKey() : undefined);
  if (idempotencyKey) {
    headers['idempotency-key'] = idempotencyKey;
  }

  const requestId = crypto.randomUUID();
  headers['x-request-id'] = requestId;

  let response: Response;
  try {
    response = await fetch(`${SERVICE_PREFIX[service]}${path}`, {
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
  // 会话失效：统一清理并跳登录（主 PRD §10.5，base PRD §3 明确提示）。
  // 持有会话 Cookie 却返回 SESSION_EXPIRED = 会话中途失效（明确提示）；
  // 无会话 Cookie（未登录首访）静默跳转，不弹误导性提示。
  handleSessionError(error);
  throw error;
}

/**
 * 下载受保护的附件。
 *
 * @returns 二进制内容；由调用页以临时 Object URL 触发浏览器下载，不写入本地持久存储。
 */
export async function download(path: string, options: ServiceRequestOptions = {}): Promise<Blob> {
  const requestId = crypto.randomUUID();
  const method = options.method ?? 'GET';
  const isWrite = method !== 'GET';
  const csrf = readCsrfCookie();
  const idempotencyKey = options.idempotencyKey ?? (isWrite ? createIdempotencyKey() : undefined);
  let response: Response;
  try {
    response = await fetch(`${SERVICE_PREFIX[options.service ?? 'platform']}${path}`, {
      method,
      headers: {
        'x-request-id': requestId,
        ...(isWrite ? { 'content-type': 'application/json' } : {}),
        ...(isWrite && csrf ? { 'x-wbme-csrf-token': csrf } : {}),
        ...(options.active ?? isWrite ? { 'x-wbme-active': '1' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      credentials: 'same-origin',
      body: isWrite ? encodeBody(options.body) : undefined,
    });
  } catch {
    throw new ApiError(
      { type: 'DEPENDENCY', code: 'DEPENDENCY_UNAVAILABLE', message: '网络异常，请稍后重试', requestId },
      0,
    );
  }
  if (!response.ok) {
    const error = parseErrorBody(await response.text(), response.status, requestId);
    handleSessionError(error);
    throw error;
  }
  return response.blob();
}

/**
 * 上传 multipart 表单（例如财务 Excel）。
 *
 * 浏览器自动生成 multipart boundary；禁止手动设置 Content-Type，以免破坏服务端文件解析。
 */
export async function upload<T>(path: string, formData: FormData, options: ServiceRequestOptions = {}): Promise<T> {
  const requestId = crypto.randomUUID();
  const headers: Record<string, string> = { 'x-request-id': requestId, ...(options.active === false ? {} : { 'x-wbme-active': '1' }) };
  const csrf = readCsrfCookie();
  if (csrf) {
    headers['x-wbme-csrf-token'] = csrf;
  }
  if (options.idempotencyKey) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  let response: Response;
  try {
    response = await fetch(`${SERVICE_PREFIX[options.service ?? 'platform']}${path}`, { method: 'POST', headers, credentials: 'same-origin', body: formData });
  } catch {
    throw new ApiError({ type: 'DEPENDENCY', code: 'DEPENDENCY_UNAVAILABLE', message: '网络异常，请稍后重试', requestId }, 0);
  }
  if (!response.ok) {
    const error = parseErrorBody(await response.text(), response.status, requestId);
    handleSessionError(error);
    throw error;
  }
  return response.status === 204 ? (undefined as T) : (await response.json()) as T;
}

export const http = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) => api<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'DELETE', body }),
};
