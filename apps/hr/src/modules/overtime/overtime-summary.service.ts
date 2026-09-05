import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { minutesToHours, OVERTIME_DATE_TYPE_SQL_LITERALS } from './overtime-statistics';

/**
 * 加班汇总服务（hr PRD §3）：
 * 展示与汇总以"分钟数 ÷ 60"计算小时并按十进制四舍五入保留两位小数，
 * 数据库保留原始分钟数作为计算依据，避免多次汇总舍入误差。
 * 个人视图=本人已批准记录+月度汇总；管理视图的按员工统计由导出服务统一处理，
 * 以便列表和导出共享相同的筛选、权限和聚合口径。
 */
@Injectable()
export class OvertimeSummaryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 个人月度汇总。
   *
   * 汇总卡片只需要天数和分类时长，不读取每日明细，避免无上限的按日结果集进入页面。
   *
   * @param userId 员工 id
   * @param month YYYY-MM（缺省=本月）
   * @returns 加班天数，以及工作日、休息日、节假日和合计的分钟/小时
   */
  async summaryMine(userId: number, month?: string): Promise<{
    dayCount: number;
    workdayMinutes: number;
    workdayHours: number;
    restDayMinutes: number;
    restDayHours: number;
    holidayMinutes: number;
    holidayHours: number;
    totalMinutes: number;
    totalHours: number;
  }> {
    const { start, end } = monthRange(month);
    const rows = await this.prisma.client.$queryRaw<
      Array<{
        day_count: bigint;
        workday_minutes: bigint;
        rest_day_minutes: bigint;
        holiday_minutes: bigint;
        total_minutes: bigint;
      }>
    >`
      SELECT COUNT(DISTINCT oi.overtime_date)::bigint AS day_count,
             COALESCE(SUM(CASE WHEN (oi.holiday_snapshot->>'dateType')::text IN (${Prisma.raw(OVERTIME_DATE_TYPE_SQL_LITERALS.workday)})
                               THEN oi.end_minute - oi.start_minute ELSE 0 END), 0)::bigint AS workday_minutes,
             COALESCE(SUM(CASE WHEN (oi.holiday_snapshot->>'dateType')::text IN (${Prisma.raw(OVERTIME_DATE_TYPE_SQL_LITERALS.restDay)})
                               THEN oi.end_minute - oi.start_minute ELSE 0 END), 0)::bigint AS rest_day_minutes,
             COALESCE(SUM(CASE WHEN (oi.holiday_snapshot->>'dateType')::text IN (${Prisma.raw(OVERTIME_DATE_TYPE_SQL_LITERALS.holiday)})
                               THEN oi.end_minute - oi.start_minute ELSE 0 END), 0)::bigint AS holiday_minutes,
             COALESCE(SUM(oi.end_minute - oi.start_minute), 0)::bigint AS total_minutes
      FROM hr.overtime_items oi
      INNER JOIN hr.approval_requests r ON r.id = oi.request_id
      WHERE r.status = 'APPROVED'
        AND oi.user_id = ${userId}
        AND oi.overtime_date >= ${start}::date
        AND oi.overtime_date < ${end}::date
    `;
    const row = rows[0];
    const dayCount = Number(row?.day_count ?? 0);
    const workdayMinutes = Number(row?.workday_minutes ?? 0);
    const restDayMinutes = Number(row?.rest_day_minutes ?? 0);
    const holidayMinutes = Number(row?.holiday_minutes ?? 0);
    const totalMinutes = Number(row?.total_minutes ?? 0);
    return {
      dayCount,
      workdayMinutes,
      workdayHours: minutesToHours(workdayMinutes),
      restDayMinutes,
      restDayHours: minutesToHours(restDayMinutes),
      holidayMinutes,
      holidayHours: minutesToHours(holidayMinutes),
      totalMinutes,
      totalHours: minutesToHours(totalMinutes),
    };
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
    const rows = await this.prisma.client.$queryRaw<Array<Record<string, unknown> & { minutes: bigint }>>`
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
    // minutes 为 ::bigint 列：原样返回会让 res.json() 的 JSON.stringify 抛 TypeError（500），
    // 与 summaryMine 同口径转 number
    return rows.map((row) => ({ ...row, minutes: Number(row.minutes) }));
  }
}

/** YYYY-MM → [当月 1 日, 下月 1 日]（Date.UTC 构造，@db.Date 日历值）；非法月份显式抛校验错误（L14，不静默进位） */
function monthRange(month?: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month ?? currentMonth());
  if (!match) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { message: '月份格式非法：YYYY-MM' });
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
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
