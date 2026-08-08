import type { ErrorEntry } from './types';

/**
 * 与 HTTP 传输解耦的业务异常基类（主 PRD §9.6）。
 *
 * - 不继承 HttpException：HTTP 状态由全局过滤器按目录项映射，调用处不能任意指定；
 * - 只携带目录项与经过白名单过滤的详情参数；
 * - 属于预期业务结果：写请求访问日志与必要业务审计，但默认不追加系统日志。
 */
export class BusinessException extends Error {
  /** 目录项：code / type / domain / httpStatus / message 的唯一来源 */
  readonly entry: ErrorEntry;

  /** 按目录项 detailsFields 白名单过滤后的详情；未声明白名单时恒为 undefined */
  readonly details: Record<string, unknown> | undefined;

  /**
   * @param entry  错误目录项（必须来自目录，不能临时构造）
   * @param details 结构化详情；仅保留目录项 detailsFields 白名单内的键，防止泄露内部信息
   */
  constructor(entry: ErrorEntry, details?: Record<string, unknown>) {
    super(entry.message);
    this.name = 'BusinessException';
    this.entry = entry;
    this.details = filterDetails(entry, details);
  }
}

/** 按白名单过滤详情键：未声明白名单或详情为空时返回 undefined */
function filterDetails(
  entry: ErrorEntry,
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!entry.detailsFields || !details) {
    return undefined;
  }
  const allowed = new Set(entry.detailsFields);
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (allowed.has(key)) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
