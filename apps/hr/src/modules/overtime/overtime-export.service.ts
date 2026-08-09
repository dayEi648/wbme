import { Inject, Injectable } from '@nestjs/common';
import { RedisService, runExport } from '@wbme/server';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { formatTime } from './overtime-submission.service';
import { minutesToHours } from './overtime-summary.service';

/** 导出行 */
export interface OvertimeExportRow {
  application_no: string;
  user_name: string;
  department_names: string;
  overtime_date: Date;
  start_minute: number;
  end_minute: number;
  minutes: bigint;
  date_type: string;
  reason: string;
  status: string;
  applicant_name: string;
  proxy_name: string | null;
  processor_name: string | null;
  processed_at: Date | null;
}

/**
 * 加班管理视图导出（T6-5，复用 T4-11 runExport）：
 * Redis 互斥 + REPEATABLE READ 一致性快照 + 120s 超时；
 * 行数上限 = 平台设置 export.max.rows（经 backstage.platform_settings 视图读取）。
 * 范围过滤（DEPARTMENT 闭包 / COMPANY）由调用方传入员工 id 集合。
 */
@Injectable()
export class OvertimeExportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 导出范围内已批准加班明细。
   *
   * @param exporterUserId 导出会话用户（单用户并发互斥键）
   * @param userIds 范围内员工 id 集合（空 = 导出空表）
   * @param month YYYY-MM（缺省=本月）
   * @param res Express 响应（流式写回）
   */
  async export(exporterUserId: number, userIds: ReadonlySet<number>, month: string | undefined, res: Response): Promise<void> {
    const maxRows = await this.readExportMaxRows();
    const { start, end } = monthRange(month);
    const userIdArray = [...userIds];
    const whereSql =
      userIdArray.length > 0
        ? `WHERE r.status = 'APPROVED' AND oi.user_id = ANY($1) AND oi.overtime_date >= $2::date AND oi.overtime_date < $3::date`
        : `WHERE r.status = 'APPROVED' AND 1 = 0`;
    const params: unknown[] = userIdArray.length > 0 ? [userIdArray, start, end] : [];
    await runExport<OvertimeExportRow>({
      userId: exporterUserId,
      redis: this.redis.redis,
      maxRows,
      filename: 'overtime-records.xlsx',
      columns: [
        { header: '申请编号', value: (row) => row.application_no },
        { header: '员工姓名', value: (row) => row.user_name },
        { header: '部门', value: (row) => row.department_names },
        { header: '加班日期', value: (row) => formatDate(row.overtime_date) },
        { header: '开始时间', value: (row) => formatTime(row.start_minute) },
        { header: '结束时间', value: (row) => formatTime(row.end_minute) },
        { header: '时长(小时)', value: (row) => minutesToHours(Number(row.minutes)) },
        { header: '日期类型', value: (row) => row.date_type },
        { header: '事由', value: (row) => row.reason },
        { header: '状态', value: (row) => row.status },
        { header: '提交人', value: (row) => row.applicant_name },
        { header: '代提人', value: (row) => row.proxy_name ?? '' },
        { header: '审批人', value: (row) => row.processor_name ?? '' },
        { header: '审批时间', value: (row) => row.processed_at?.toISOString?.() ?? '' },
      ],
      transaction: (fn, options) =>
        this.prisma.client.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: options?.timeout,
        }),
      fetchCount: async (tx) => {
        const client = tx as PrismaService['client'];
        const result = await client.$queryRawUnsafe<Array<{ total: bigint }>>(
          `SELECT COUNT(*)::bigint AS total
           FROM hr.overtime_items oi INNER JOIN hr.approval_requests r ON r.id = oi.request_id
           ${whereSql}`,
          ...params,
        );
        return Number(result[0]?.total ?? 0);
      },
      fetchRows: async (tx, offset, limit) => {
        const client = tx as PrismaService['client'];
        const listParams = [...params, limit, offset];
        const sql = `
          SELECT r.application_no, oi.user_name,
                 (SELECT COALESCE(STRING_AGG(el->>'name', ', ' ORDER BY el->>'name'), '')
                  FROM jsonb_array_elements(oi.department_snapshot) el) AS department_names,
                 oi.overtime_date, oi.start_minute, oi.end_minute,
                 (oi.end_minute - oi.start_minute)::bigint AS minutes,
                 (oi.holiday_snapshot->>'dateType')::text AS date_type,
                 oi.reason, r.status::text, r.applicant_name, r.proxy_name, r.processor_name, r.processed_at
          FROM hr.overtime_items oi INNER JOIN hr.approval_requests r ON r.id = oi.request_id
          ${whereSql}
          ORDER BY oi.overtime_date DESC, oi.id DESC
          LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `;
        return client.$queryRawUnsafe<OvertimeExportRow[]>(sql, ...listParams);
      },
      res,
    });
  }

  /** 读平台设置 export.max.rows（经只读视图；缺省 100000） */
  private async readExportMaxRows(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<Array<{ value: string }>>`
      SELECT value FROM backstage.platform_settings WHERE key = 'export.max.rows' LIMIT 1
    `;
    const value = Number(rows[0]?.value ?? 100000);
    return Number.isFinite(value) && value > 0 ? value : 100000;
  }
}

/** YYYY-MM → [当月 1 日, 下月 1 日]（Date.UTC 构造） */
function monthRange(month?: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? currentMonth());
  const year = Number(match?.[1] ?? 1970);
  const monthIndex = Number(match?.[2] ?? 1) - 1;
  return { start: new Date(Date.UTC(year, monthIndex, 1)), end: new Date(Date.UTC(year, monthIndex + 1, 1)) };
}

/** 当前月 YYYY-MM（北京时间） */
function currentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}

/** Date → YYYY-MM-DD（UTC 日历值） */
function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
