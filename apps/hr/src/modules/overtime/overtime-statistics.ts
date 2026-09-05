/**
 * 加班日期类型汇总口径。
 *
 * 申请明细保存的是稳定的枚举编码；此处集中维护各统计类别包含的编码，避免个人汇总、
 * 统计列表和导出因调休日期被归入不同类别而产生不一致的数据。
 */
export const OVERTIME_DATE_TYPE_SQL_LITERALS = {
  workday: "'WORKDAY', 'ADJUSTED_WORKDAY'",
  restDay: "'WEEKEND'",
  holiday: "'HOLIDAY', 'ADJUSTED_HOLIDAY'",
} as const;

/** 数据库存储分钟，所有面向用户的小时数在最后一步统一转换，避免累计舍入误差。 */
export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}
