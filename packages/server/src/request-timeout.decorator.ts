import { SetMetadata } from '@nestjs/common';

/** 路由级请求超时元数据键（RequestTimeoutInterceptor 读取覆盖全局默认值） */
export const REQUEST_TIMEOUT_METADATA = 'wbme:request-timeout';

/**
 * 路由级请求超时覆盖（毫秒）。
 *
 * 全局 RequestTimeoutInterceptor 默认 30s（主 PRD §9.6）；长任务路由
 * （如 fin Excel 导入/导出 120s 上限）挂本装饰器显式放宽，避免被全局
 * 固定超时提前截断，同时保持其它路由的默认保护不变。
 *
 * @param ms 该路由的固定总超时毫秒数
 */
export function RequestTimeout(ms: number): MethodDecorator {
  return SetMetadata(REQUEST_TIMEOUT_METADATA, ms);
}
