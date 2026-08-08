/**
 * 统一错误契约类型定义（主 PRD §9.5/§9.6）。
 *
 * 错误响应统一为 `error { type, domain?, code, message, details?, requestId }`：
 * - type：稳定错误大类，固定 9 种；
 * - domain：业务域，仅 BUSINESS 类型必须返回；
 * - code：该 (type, domain) 内稳定的机器可读编码；
 * - message：服务端控制、可向当前用户展示的文案；
 * - details：只承载经过白名单定义的结构化信息。
 */

/** 稳定错误大类（主 PRD §9.5） */
export const ERROR_TYPES = [
  'BUSINESS',
  'VALIDATION',
  'AUTHENTICATION',
  'AUTHORIZATION',
  'CONFLICT',
  'RATE_LIMIT',
  'TIMEOUT',
  'DEPENDENCY',
  'SYSTEM',
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

/** MVP 业务域（主 PRD §9.6） */
export const BUSINESS_DOMAINS = [
  'ACCOUNT',
  'PERMISSION',
  'APPROVAL',
  'ASSET',
  'INVENTORY',
  'HR',
  'FINANCE',
  'EXPORT',
  'BACKUP',
  'INTEGRATION',
] as const;

export type BusinessDomain = (typeof BUSINESS_DOMAINS)[number];

/** 各错误类型允许的 HTTP 状态（主 PRD §9.5 HTTP 语义） */
export const HTTP_STATUS_BY_TYPE: Readonly<Record<ErrorType, readonly number[]>> = {
  BUSINESS: [404, 409, 422],
  VALIDATION: [400, 413],
  AUTHENTICATION: [401],
  AUTHORIZATION: [403, 404],
  CONFLICT: [409],
  RATE_LIMIT: [429],
  TIMEOUT: [503],
  DEPENDENCY: [503],
  SYSTEM: [500],
};

/**
 * 错误目录项：集中定义唯一 code、默认安全文案、HTTP 状态与可公开的详情白名单。
 * 业务代码只抛出目录中已注册的错误，不能临时拼接错误码（主 PRD §9.6）。
 */
export interface ErrorEntry {
  /** 机器可读稳定编码，在 (type, domain) 内唯一；删除或复用属于破坏性契约变更 */
  readonly code: string;
  /** 稳定错误大类 */
  readonly type: ErrorType;
  /** 业务域；BUSINESS 类型必须提供，其余类型可选 */
  readonly domain?: BusinessDomain;
  /** 默认安全文案（服务端控制，可面向当前用户展示） */
  readonly message: string;
  /** 由全局异常过滤器使用的 HTTP 状态（主 PRD §9.5） */
  readonly httpStatus: number;
  /** 允许公开的详情键白名单；未声明时抛出的 details 不会进入响应 */
  readonly detailsFields?: readonly string[];
}
