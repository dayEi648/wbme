import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

/** 月度汇总行（按日分组） */
export interface DailyOvertimeSummary {
  overtimeDate: string;
  minutes: number;
  hours: number;
  dateType: string;
}

/** 员工月度统计行（管理视图） */
export interface EmployeeMonthlyStat {
  userId: number;
  name: string;
  minutes: number;
  hours: number;
  count: number;
}

/**
 * 加班汇总服务（hr PRD §3）：
 * 展示与汇总以"分钟数 ÷ 60"计算小时并按十进制四舍五入保留两位小数，
 * 数据库保留原始分钟数作为计算依据，避免多次汇总舍入误差。
 * 个人视图=本人已批准记录+月度汇总；管理视图（加班历史记录功能）=
 * 员工列表+月度统计+下钻，数据范围 DEPARTMENT（闭包）或 COMPANY。
 */
@Injectable()
export class OvertimeSummaryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 个人月度汇总（已批准明细按日分组）。
   *
   * @param userId 员工 id
   * @param month YYYY-MM（缺省=本月）
   * @returns 按日汇总（含日期类型快照）
   */
  async summaryMine(userId: number, month?: string): Promise<{ items: DailyOvertimeSummary[]; totalMinutes: number; totalHours: number }> {
    const { start, end } = monthRange(month);
    const rows = await this.prisma.client.$queryRaw<
      Array<{ overtime_date: Date; minutes: bigint; date_type: string }>
    >`
      SELECT oi.overtime_date,
             SUM(oi.end_minute - oi.start_minute)::bigint AS minutes,
             (oi.holiday_snapshot->>'dateType')::text AS date_type
      FROM hr.overtime_items oi
      INNER JOIN hr.approval_requests r ON r.id = oi.request_id
      WHERE r.status = 'APPROVED'
        AND oi.user_id = ${userId}
        AND oi.overtime_date >= ${start}::date
        AND oi.overtime_date < ${end}::date
      GROUP BY oi.overtime_date, oi.holiday_snapshot->>'dateType'
      ORDER BY oi.overtime_date
    `;
    const items = rows.map((row) => ({
      overtimeDate: formatDbDate(row.overtime_date),
      minutes: Number(row.minutes),
      hours: minutesToHours(Number(row.minutes)),
      dateType: row.date_type,
    }));
    const totalMinutes = items.reduce((sum, item) => sum + item.minutes, 0);
    return { items, totalMinutes, totalHours: minutesToHours(totalMinutes) };
  }

  /**
   * 管理视图员工月度统计（加班历史记录功能；数据范围过滤由调用方传入员工 id 集合）。
   *
   * @param userIds 范围内员工 id 集合（DEPARTMENT 闭包或 COMPANY 全量）
   * @param month YYYY-MM（缺省=本月）
   * @returns 员工统计列表
   */
  async statsForUsers(userIds: ReadonlySet<number>, month?: string): Promise<EmployeeMonthlyStat[]> {
    if (userIds.size === 0) {
      return [];
    }
    const { start, end } = monthRange(month);
    const rows = await this.prisma.client.$queryRaw<
      Array<{ user_id: number; user_name: string; minutes: bigint; count: number }>
    >`
      SELECT oi.user_id,
             MAX(oi.user_name) AS user_name,
             SUM(oi.end_minute - oi.start_minute)::bigint AS minutes,
             COUNT(*)::int AS count
      FROM hr.overtime_items oi
      INNER JOIN hr.approval_requests r ON r.id = oi.request_id
      WHERE r.status = 'APPROVED'
        AND oi.user_id = ANY(${[...userIds] as number[]})
        AND oi.overtime_date >= ${start}::date
        AND oi.overtime_date < ${end}::date
      GROUP BY oi.user_id
      ORDER BY oi.user_id
    `;
    return rows.map((row) => ({
      userId: row.user_id,
      name: row.user_name,
      minutes: Number(row.minutes),
      hours: minutesToHours(Number(row.minutes)),
      count: row.count,
    }));
  }

  /**
   * 员工月度明细（下钻）。
   *
   * @param userId 员工 id
   * @param month YYYY-MM（缺省=当前月）
   * @returns 明细列表（含申请编号/日期/时间段/时长/事由/日期类型）
   */
  async detailForUser(userId: number, month?: string): Promise<unknown[]> {
    const { start, end } = monthRange(month);
    return this.prisma.client.$queryRaw<unknown[]>`
      SELECT oi.id,
             r.application_no,
             oi.overtime_date,
             oi.start_minute,
             oi.end_minute,
             (oi.end_minute - oi.start_minute)::bigint AS minutes,
             oi.reason,
             (oi.holiday_snapshot->>'dateType')::text AS date_type,
             r.processed_at,
             r.processor_name
      FROM hr.overtime_items oi
      INNER JOIN hr.approval_requests r ON r.id = oi.request_id
      WHERE r.status = 'APPROVED'
        AND oi.user_id = ${userId}
        AND oi.overtime_date >= ${start}::date
        AND oi.overtime_date < ${end}::date
      ORDER BY oi.overtime_date, oi.id
    `;
  }
}

/** 分钟 → 小时（两位小数，十进制四舍五入；主 PRD §9.11 金额/数值精度约定） */
export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/** YYYY-MM → [当月 1 日, 下月 1 日]（Date.UTC 构造，@db.Date 日历值） */
function monthRange(month?: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? currentMonth());
  const year = Number(match?.[1] ?? 1970);
  const monthIndex = Number(match?.[2] ?? 1) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return { start, end };
}

/** 当前月 YYYY-MM（北京时间） */
function currentMonth(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}

/** Date → YYYY-MM-DD（UTC 日历值；@db.Date 读取无时区偏移） */
function formatDbDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
