/**
 * 加班日期窗口计算（hr PRD §3）：加班日期必须位于
 * "当前日期 − 补交窗口 ～ 当前日期 + 提前申请窗口" 区间内（按主 PRD §9.10 北京时间计算）。
 * 提前申请窗口（默认 30 天）与补交窗口（默认 7 天）在人事配置中设置。
 */

/** 北京时区标识（主 PRD §9.10：业务时区固定为 Asia/Shanghai） */
const BEIJING_TZ = 'Asia/Shanghai';

/**
 * 取北京时间的自然日（YYYY-MM-DD）。
 * 用 Intl.DateTimeFormat 按 Asia/Shanghai 取日期部件，避免服务器/容器时区影响。
 *
 * @param now 当前时刻
 * @returns YYYY-MM-DD
 */
export function beijingDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BEIJING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/**
 * 计算允许申请窗口 [minDate, maxDate]。
 * 中国无夏令时，按固定 86400000ms 平移一天（北京时间日界）。
 *
 * @param settings 窗口参数
 * @param now 当前时刻（默认现在）
 * @returns { minDate, maxDate }（YYYY-MM-DD 字符串比较安全）
 */
export function windowRange(
  settings: { advanceDays: number; backfillDays: number },
  now: Date = new Date(),
): { minDate: string; maxDate: string } {
  const minDate = beijingDate(new Date(now.getTime() - settings.backfillDays * 86_400_000));
  const maxDate = beijingDate(new Date(now.getTime() + settings.advanceDays * 86_400_000));
  return { minDate, maxDate };
}

/**
 * 判断日期是否在窗口内（YYYY-MM-DD 字符串比较）。
 *
 * @param date 加班日期
 * @param range 窗口
 * @returns 是否在窗口内
 */
export function isWithinWindow(date: string, range: { minDate: string; maxDate: string }): boolean {
  return date >= range.minDate && date <= range.maxDate;
}
