/**
 * 日期、时间与时区传输约定（主 PRD §9.10）。
 *
 * - 业务时区固定 `Asia/Shanghai`，不提供个人时区切换；
 * - 时间点（timestamptz）以 UTC 存储，API 使用带 Z 或明确偏移量的 RFC 3339 字符串；
 * - 自然日（date）不表示具体瞬间，不经 UTC 换算；
 * - 业务调度（额度周期、备份、节假日）边界按北京时间计算。
 */

/** 平台固定业务时区（主 PRD §9.10） */
export const BUSINESS_TIMEZONE = 'Asia/Shanghai';

/** API 时间点序列化格式说明：RFC 3339 / ISO 8601（带 Z 或明确偏移量） */
export const RFC3339 = 'RFC3339';

/**
 * 校验时间点为 UTC 表示的 RFC 3339 字符串（带 Z 或明确偏移量）。
 * @param value 时间字符串
 * @returns 是否可解析为合法时间点
 */
export function isRfc3339Utc(value: string): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  // 要求明确时区偏移（Z 或 ±hh:mm），拒绝无时区语义的本地时间
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}
