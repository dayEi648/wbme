/** 平台业务时区（主 PRD §9.10） */
export const PLATFORM_TIMEZONE = 'Asia/Shanghai';

/**
 * 将时间格式化为北京时间日历日 YYYY-MM-DD。
 *
 * @param date 时间点
 * @returns 北京时间日期字符串
 */
export function beijingDateString(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PLATFORM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/**
 * 获取北京时间当前小时（0-23）。
 *
 * @param date 时间点
 * @returns 小时
 */
export function beijingHour(date: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: PLATFORM_TIMEZONE,
    hour: 'numeric',
    hour12: false,
  }).format(date);
  return Number.parseInt(hour, 10);
}

/**
 * 判断是否已过北京时间 02:00 调度边界（用于每日备份）。
 *
 * @param date 当前时间
 * @returns 是否应尝试创建当日定时备份任务
 */
export function isPastScheduledBackupBoundary(date: Date = new Date()): boolean {
  return beijingHour(date) >= 2;
}
