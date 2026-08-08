import { getRequestContext } from '../request-context';
import { INTERNAL_CALLER_HEADER, INTERNAL_TOKEN_HEADER, INTERNAL_TRACE_HEADER } from './internal-rest.constants';
import type { InternalService } from './internal-rest.constants';

/** 内部调用客户端配置 */
export interface InternalHttpClientOptions {
  /** 目标服务基础地址（compose 私网服务名或 localhost:端口） */
  baseUrl: string;
  /** 全平台共享内部令牌 */
  token: string;
  /** 调用方服务名（白名单校验用） */
  caller: InternalService;
  /** 连接/响应超时（毫秒，默认 5s） */
  timeoutMs?: number;
  /** 有界重试次数上限（默认 2；仅幂等读取或携带幂等键的写入允许重试） */
  maxRetries?: number;
}

/** 内部调用失败（连接失败/超时/非预期响应），由调用方映射为 DEPENDENCY 错误 */
export class InternalRequestError extends Error {
  constructor(message: string, readonly causeDetail?: unknown) {
    super(message);
    this.name = 'InternalRequestError';
  }
}

/**
 * 内部 REST 客户端（主 PRD §9.4）。
 *
 * - 自动携带 Bearer 令牌、调用方服务名与当前请求 requestId/traceId；
 * - 设置明确超时（AbortController），只有幂等读取（GET/HEAD）或携带
 *   `idempotencyKey` 的写入才做有上限退避重试，不得无限重试；
 * - 目标服务返回的 4xx 业务错误（BUSINESS/VALIDATION/AUTHORIZATION/CONFLICT）原样透传，
 *   由调用方保留其业务域、错误码与安全文案；连接失败/超时/5xx 由调用方归为 DEPENDENCY。
 */
export class InternalHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly caller: InternalService;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: InternalHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.caller = options.caller;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** GET（幂等，允许有界重试） */
  async get(path: string, headers?: Record<string, string>): Promise<Response> {
    return this.fetch(path, { method: 'GET', headers });
  }

  /** 写请求：携带幂等键才允许重试 */
  async write(
    path: string,
    options: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; idempotencyKey?: string; headers?: Record<string, string> },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...options.headers,
    };
    return this.fetch(path, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }, { retryable: Boolean(options.idempotencyKey) });
  }

  private async fetch(
    path: string,
    init: RequestInit,
    options: { retryable?: boolean } = {},
  ): Promise<Response> {
    const retryable = options.retryable ?? (init.method === 'GET' || init.method === 'HEAD');
    const traceId = getRequestContext()?.traceId ?? getRequestContext()?.requestId;

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            [INTERNAL_TOKEN_HEADER]: `Bearer ${this.token}`,
            [INTERNAL_CALLER_HEADER]: this.caller,
            ...(traceId ? { [INTERNAL_TRACE_HEADER]: traceId } : {}),
            ...init.headers,
          },
        });
        // 4xx 为目标服务的业务/校验/授权/冲突响应，由调用方按错误结构处理，不重试
        if (response.ok || (response.status >= 400 && response.status < 500)) {
          return response;
        }
        // 5xx：仅可重试请求做有界退避重试
        if (!retryable || attempt >= this.maxRetries) {
          return response;
        }
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        const cause = aborted ? '超时' : error instanceof Error ? error.message : String(error);
        if (!retryable || attempt >= this.maxRetries) {
          throw new InternalRequestError(`内部调用失败（${cause}）：${init.method} ${path}`, cause);
        }
      } finally {
        clearTimeout(timer);
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
    }
  }
}
