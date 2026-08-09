import { createHash } from 'node:crypto';
import type { HolidayDateType } from '../../generated/prisma/client';

/** 校验后的规范化节假日结果（写 holiday_results.normalized 与提交快照） */
export interface NormalizedHoliday {
  dateType: HolidayDateType;
  weekday: number;
  source: string;
  digest: string;
  fetchedAt: string;
}

/** 校验结果：成功携带规范化结果；失败携带原因（依赖失败，不落库） */
export type HolidayValidation =
  | { ok: true; normalized: NormalizedHoliday; rawDigest: string }
  | { ok: false; reason: string };

/** 供应商响应的原始结构（白名单字段；其余字段忽略） */
interface RawHolidayResponse {
  code?: number;
  type?: {
    type?: number;
    week?: number;
  } | null;
  holiday?: {
    holiday?: boolean;
    wage?: number;
    date?: string;
  } | null;
}

/**
 * 请求日期对应的真实星期（周一=1 … 周日=7）。
 * 以 Date.UTC 构造（日期字符串即日历值，不经时区换算）——若用 `T00:00:00+08:00`
 * 构造再 getUTCDay，北京 00:00 会落到前一日 UTC 而算错星期（主 PRD §9.10 按北京时间自然日）。
 *
 * @param date YYYY-MM-DD
 * @returns 1~7
 */
export function realWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * 严格校验节假日 API 响应（hr PRD §3）：
 * 成功码、请求日期回显、日期类型枚举、星期值与休息/补班语义的一致性。
 * 任一失败 → 依赖失败，不落库、不返回前端（第三方原始错误不得直接返回）。
 *
 * 供应商 type 语义（2026-08 实测）：
 *   type=0 普通工作日（holiday=null）
 *   type=1 普通周末（holiday.holiday=true, wage=2）
 *   type=2 休假日（wage=3 法定节假日 / wage=2 调休放假）
 *   type=4 调休补班（holiday.holiday=false, wage=1）
 *   type=3 未知语义 → 按非法响应拒绝（宁可降级不误判）
 *
 * @param raw 原始响应文本
 * @param requestedDate 请求日期 YYYY-MM-DD
 * @param source 来源标识（写入规范化结果）
 * @param fetchedAt 获取时间 ISO
 * @returns 校验结果
 */
export function validateHolidayResponse(raw: string, requestedDate: string, source: string, fetchedAt: string): HolidayValidation {
  const digest = createHash('sha256').update(raw).digest('hex');
  let parsed: RawHolidayResponse;
  try {
    parsed = JSON.parse(raw) as RawHolidayResponse;
  } catch {
    return { ok: false, reason: '响应不是合法 JSON' };
  }
  if (parsed.code !== 0) {
    return { ok: false, reason: `供应商返回错误码 ${String(parsed.code)}` };
  }
  const typeValue = parsed.type?.type;
  const weekday = parsed.type?.week;
  if (typeof typeValue !== 'number' || !Number.isInteger(typeValue) || typeValue < 0 || typeValue > 4) {
    return { ok: false, reason: `未知日期类型枚举 ${String(typeValue)}` };
  }
  if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    return { ok: false, reason: '星期值非法' };
  }
  if (weekday !== realWeekday(requestedDate)) {
    return { ok: false, reason: '星期值与请求日期不一致' };
  }
  if (typeValue === 0) {
    if (parsed.holiday !== null && parsed.holiday !== undefined) {
      return { ok: false, reason: '工作日响应携带 holiday 对象，语义矛盾' };
    }
    return { ok: true, normalized: { dateType: 'WORKDAY', weekday, source, digest, fetchedAt }, rawDigest: digest };
  }
  const holiday = parsed.holiday;
  if (!holiday || typeof holiday !== 'object') {
    return { ok: false, reason: '非工作日响应缺少 holiday 对象' };
  }
  if (holiday.date !== requestedDate) {
    return { ok: false, reason: '响应日期与请求日期不一致' };
  }
  if (typeValue === 1) {
    if (!(holiday.holiday === true && holiday.wage === 2 && (weekday === 6 || weekday === 7))) {
      return { ok: false, reason: '周末类型与休息/补班语义矛盾' };
    }
    return { ok: true, normalized: { dateType: 'WEEKEND', weekday, source, digest, fetchedAt }, rawDigest: digest };
  }
  if (typeValue === 2) {
    if (!(holiday.holiday === true && (holiday.wage === 2 || holiday.wage === 3))) {
      return { ok: false, reason: '休假日类型与休息/补班语义矛盾' };
    }
    return {
      ok: true,
      normalized: {
        dateType: holiday.wage === 3 ? 'HOLIDAY' : 'ADJUSTED_HOLIDAY',
        weekday,
        source,
        digest,
        fetchedAt,
      },
      rawDigest: digest,
    };
  }
  // typeValue === 4：调休补班
  if (!(holiday.holiday === false && holiday.wage === 1 && (weekday === 6 || weekday === 7))) {
    return { ok: false, reason: '补班类型与休息/补班语义矛盾' };
  }
  return { ok: true, normalized: { dateType: 'ADJUSTED_WORKDAY', weekday, source, digest, fetchedAt }, rawDigest: digest };
}
