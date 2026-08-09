/**
 * 加班时间段重叠校验（hr PRD §3：同一员工同一天可提交多条不重叠的加班时间段，
 * 与已有待审批/已批准记录禁止重叠计时）。
 *
 * 时间以"当日第 N 分钟"表达（0-1439 / 1-1440），`24:00`=1440 表示当日结束的开边界。
 * 区间 [aStart, aEnd) 与 [bStart, bEnd) 重叠 ⇔ aStart < bEnd && bStart < aEnd。
 */

/**
 * 判断两个分钟区间是否重叠。
 *
 * @param aStart 区间 A 开始分钟
 * @param aEnd 区间 A 结束分钟（开边界）
 * @param bStart 区间 B 开始分钟
 * @param bEnd 区间 B 结束分钟（开边界）
 * @returns 是否重叠
 */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 判断新时间段与既有时间段集合是否重叠。
 *
 * @param start 新时间段开始分钟
 * @param end 新时间段结束分钟
 * @param existing 既有时间段（含 PENDING/APPROVED 记录）
 * @returns 命中的既有时间段（空数组 = 无重叠）
 */
export function findOverlapping(
  start: number,
  end: number,
  existing: ReadonlyArray<{ startMinute: number; endMinute: number }>,
): Array<{ startMinute: number; endMinute: number }> {
  return existing.filter((item) => overlaps(start, end, item.startMinute, item.endMinute));
}
