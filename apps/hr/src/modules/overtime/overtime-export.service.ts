import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, formatExportEnumLabel, frameworkErrors } from '@wbme/contracts';
import { buildTableSqlQuery, collectTableFilterFields, normalizeTableFilters, RedisService, runExport, type TableSqlField } from '@wbme/server';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { formatTime } from './overtime-submission.service';
import { minutesToHours } from './overtime-summary.service';

/** 报表筛选白名单：所有客户端值通过参数绑定，部门仅匹配申请时已保存的部门快照。 */
const OVERTIME_REPORT_FILTER_FIELDS: Readonly<Record<string, TableSqlField>> = {
  month: {
    type: 'text',
    compile: ({ condition, value, nextParam }) => {
      if (condition.operator !== 'EQUALS' || typeof value !== 'string') return undefined;
      const { start, end } = monthRange(value);
      return `oi.overtime_date >= ${nextParam(start)}::date AND oi.overtime_date < ${nextParam(end)}::date`;
    },
  },
  employeeName: { column: 'oi.user_name', type: 'text' },
  keyword: { column: 'oi.user_name', type: 'text' },
  applicantName: { column: 'r.applicant_name', type: 'text' },
  submitterName: { column: 'COALESCE(r.proxy_name, r.applicant_name)', type: 'text' },
  departmentId: {
    type: 'number',
    compile: ({ condition, value, nextParam }) => {
      if (typeof value !== 'number') return undefined;
      const snapshot = nextParam(JSON.stringify([{ id: value }]));
      if (condition.operator === 'EQUALS') return `oi.department_snapshot @> ${snapshot}::jsonb`;
      if (condition.operator === 'NOT_EQUALS') return `NOT (oi.department_snapshot @> ${snapshot}::jsonb)`;
      return undefined;
    },
  },
  positionName: { column: 'oi.position_name_snapshot', type: 'text' },
  overtimeDate: { column: 'oi.overtime_date', type: 'date' },
  startTime: { column: 'oi.start_minute', type: 'time' },
  endTime: { column: 'oi.end_minute', type: 'time' },
  dateType: { column: `(oi.holiday_snapshot->>'dateType')::text`, type: 'enum' },
  isBackfill: { column: `CASE WHEN oi.is_backfill THEN 'YES' ELSE 'NO' END`, type: 'enum' },
  reason: { column: 'oi.reason', type: 'text' },
  processorName: { column: 'r.processor_name', type: 'text' },
  approvalTime: { column: 'r.processed_at', type: 'date' },
};

export interface OvertimeReportQuery {
  month?: string;
  keyword?: string;
  /** 兼容具名部门参数；语义与结构化 departmentId 一致，均匹配申请时部门快照。 */
  departmentId?: number;
  filters?: string;
}

interface OvertimeReportSql {
  whereSql: string;
  params: unknown[];
  userIds: number[];
  includeZeroStatistics: boolean;
}

/** 明细导出行。 */
interface OvertimeRecordExportRow {
  id: number;
  application_no: string;
  user_name: string;
  department_names: string;
  position_name: string | null;
  reason: string;
  overtime_date: Date;
  start_minute: number;
  end_minute: number;
  minutes: bigint;
  date_type: string;
  is_backfill: boolean;
  applicant_name: string;
  proxy_name: string | null;
  submitted_at: Date | null;
  processor_name: string | null;
  processed_at: Date | null;
  status: string;
}

/** 加班历史明细：列表和两类导出共用同一受控筛选基集。 */
export interface OvertimeHistoryRecord {
  id: number;
  applicationNo: string;
  employeeName: string;
  departmentNames: string;
  positionName: string;
  reason: string;
  overtimeDate: string;
  startTime: string;
  endTime: string;
  timeRange: string;
  minutes: number;
  hours: number;
  dateType: string;
  isBackfill: boolean;
  applicantName: string;
  submitterName: string;
  submittedAt: string;
  processorName: string;
  processedAt: string;
  status: string;
}

/** 统计导出行：分钟只在 SQL 聚合，输出前统一换算小时，避免逐行舍入误差。 */
interface OvertimeStatisticsExportRow {
  user_name: string;
  position_names: string | null;
  department_names: string | null;
  workday_minutes: bigint;
  weekend_minutes: bigint;
  holiday_minutes: bigint;
  total_minutes: bigint;
  record_count: bigint;
}

/** 加班报表的轻量样式：匹配历史报表的浅绿色表头，同时避免逐单元格复杂样式。 */
const OVERTIME_REPORT_SHEET_STYLE = {
  freezeHeader: true,
  autoFilter: true,
  headerFillArgb: 'FFD9EAD3',
} as const;

/**
 * 加班记录/统计导出：两个报表始终复用同一权限范围和筛选 SQL。
 *
 * 导出不使用当前页数据；runExport 负责单用户互斥、行数上限、一致性快照和安全单元格转义。
 */
@Injectable()
export class OvertimeExportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 加班历史列表：按单条加班明细分页，避免把员工汇总误当作可审计的历史记录。
   * 列表与导出复用完全相同的权限范围和筛选 SQL，防止“页面看到的”和“导出的”不一致。
   */
  async listRecords(
    userIds: ReadonlySet<number>,
    query: OvertimeReportQuery,
    page: number,
    pageSize: number,
  ): Promise<{ data: OvertimeHistoryRecord[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } }> {
    const report = buildOvertimeReportSql(userIds, query);
    const { total, rows } = await this.transaction(async (tx) => {
      const [total, rows] = await Promise.all([
        this.countRows(tx, report),
        this.fetchRecordRows(tx, report, (page - 1) * pageSize, pageSize),
      ]);
      return { total, rows };
    });
    return {
      data: rows.map(toHistoryRecord),
      pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /** 导出符合筛选的已批准加班明细。 */
  async exportRecords(
    exporterUserId: number,
    userIds: ReadonlySet<number>,
    query: OvertimeReportQuery,
    res: Response,
  ): Promise<void> {
    const report = buildOvertimeReportSql(userIds, query);
    const maxRows = await this.readExportMaxRows();
    await runExport<OvertimeRecordExportRow>({
      userId: exporterUserId,
      redis: this.redis.redis,
      maxRows,
      filename: '加班记录.xlsx',
      sheet: { ...OVERTIME_REPORT_SHEET_STYLE, name: '加班记录', columnWidths: [18, 14, 22, 14, 28, 14, 12, 12, 16, 16, 10, 14, 14, 20, 14, 20] },
      columns: [
        { header: '批次号', value: (row) => row.application_no },
        { header: '申请人', value: (row) => row.user_name },
        { header: '部门', value: (row) => row.department_names },
        { header: '岗位', value: (row) => row.position_name ?? '未记录' },
        { header: '加班事由', value: (row) => row.reason },
        { header: '加班日期', value: (row) => formatDate(row.overtime_date) },
        { header: '开始时间', value: (row) => formatTime(row.start_minute) },
        { header: '结束时间', value: (row) => formatTime(row.end_minute) },
        { header: '加班时长（小时）', value: (row) => minutesToHours(Number(row.minutes)) },
        { header: '日期类型', value: (row) => formatExportEnumLabel('holidayDateType', row.date_type) },
        { header: '是否补交', value: (row) => (row.is_backfill ? '是' : '否') },
        { header: '提交人', value: (row) => row.proxy_name ?? row.applicant_name },
        { header: '申请提交时间', value: (row) => formatBeijingDateTime(row.submitted_at) },
        { header: '审批人', value: (row) => row.processor_name ?? '' },
        { header: '审批时间', value: (row) => formatBeijingDateTime(row.processed_at) },
        { header: '审批状态', value: (row) => formatExportEnumLabel('approvalStatus', row.status) },
      ],
      transaction: (fn, options) => this.transaction(fn, options),
      fetchCount: async (tx) => this.countRows(tx, report),
      fetchRows: async (tx, offset, limit) => this.fetchRecordRows(tx, report, offset, limit),
      res,
    });
  }

  /** 导出按员工汇总的工作日/休息日/节假日统计。 */
  async exportStatistics(
    exporterUserId: number,
    userIds: ReadonlySet<number>,
    query: OvertimeReportQuery,
    res: Response,
  ): Promise<void> {
    const report = buildOvertimeReportSql(userIds, query);
    const maxRows = await this.readExportMaxRows();
    await runExport<OvertimeStatisticsExportRow>({
      userId: exporterUserId,
      redis: this.redis.redis,
      maxRows,
      filename: '加班统计.xlsx',
      sheet: { ...OVERTIME_REPORT_SHEET_STYLE, name: '加班统计', columnWidths: [14, 16, 24, 16, 16, 16, 14, 12] },
      columns: [
        { header: '姓名', value: (row) => row.user_name },
        { header: '岗位', value: (row) => row.position_names ?? '未记录' },
        { header: '部门', value: (row) => row.department_names ?? '未记录' },
        { header: '工作日加班（小时）', value: (row) => minutesToHours(Number(row.workday_minutes)) },
        { header: '休息日加班（小时）', value: (row) => minutesToHours(Number(row.weekend_minutes)) },
        { header: '节假日加班（小时）', value: (row) => minutesToHours(Number(row.holiday_minutes)) },
        { header: '合计（小时）', value: (row) => minutesToHours(Number(row.total_minutes)) },
        { header: '记录数', value: (row) => Number(row.record_count) },
      ],
      transaction: (fn, options) => this.transaction(fn, options),
      fetchCount: async (tx) => this.countStatisticsRows(tx, report),
      fetchRows: async (tx, offset, limit) => this.fetchStatisticsRows(tx, report, offset, limit),
      res,
    });
  }

  private transaction<R>(fn: (tx: unknown) => Promise<R>, options?: { isolationLevel?: string; timeout?: number }): Promise<R> {
    return this.prisma.client.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: options?.timeout,
    });
  }

  private async countRows(tx: unknown, report: OvertimeReportSql): Promise<number> {
    const client = tx as PrismaService['client'];
    const rows = await client.$queryRawUnsafe<Array<{ total: bigint }>>(
      `SELECT COUNT(*)::bigint AS total
       FROM hr.overtime_items oi
       INNER JOIN hr.approval_requests r ON r.id = oi.request_id
       ${report.whereSql}`,
      ...report.params,
    );
    return Number(rows[0]?.total ?? 0);
  }

  private async fetchRecordRows(tx: unknown, report: OvertimeReportSql, offset: number, limit: number): Promise<OvertimeRecordExportRow[]> {
    const client = tx as PrismaService['client'];
    const params = [...report.params, limit, offset];
    return client.$queryRawUnsafe<OvertimeRecordExportRow[]>(`
      SELECT oi.id, r.application_no, oi.user_name,
             (SELECT COALESCE(STRING_AGG(el->>'name', '、' ORDER BY el->>'name'), '')
              FROM jsonb_array_elements(oi.department_snapshot) el) AS department_names,
             oi.position_name_snapshot AS position_name,
             oi.reason, oi.overtime_date, oi.start_minute, oi.end_minute,
             (oi.end_minute - oi.start_minute)::bigint AS minutes,
             (oi.holiday_snapshot->>'dateType')::text AS date_type,
             oi.is_backfill, r.applicant_name, r.proxy_name, r.submitted_at,
             r.processor_name, r.processed_at, r.status::text
      FROM hr.overtime_items oi
      INNER JOIN hr.approval_requests r ON r.id = oi.request_id
      ${report.whereSql}
      ORDER BY oi.overtime_date DESC, oi.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, ...params);
  }

  private async countStatisticsRows(tx: unknown, report: OvertimeReportSql): Promise<number> {
    const client = tx as PrismaService['client'];
    if (report.includeZeroStatistics) {
      const rows = await client.$queryRawUnsafe<Array<{ total: bigint }>>(
        `SELECT COUNT(*)::bigint AS total
         FROM backstage.user_accounts ua
         WHERE ua.user_id = ANY($1) AND ua.status = 'ACTIVE' AND ua.deleted_at IS NULL`,
        report.userIds,
      );
      return Number(rows[0]?.total ?? 0);
    }
    const rows = await client.$queryRawUnsafe<Array<{ total: bigint }>>(
      `SELECT COUNT(DISTINCT oi.user_id)::bigint AS total
       FROM hr.overtime_items oi
       INNER JOIN hr.approval_requests r ON r.id = oi.request_id
       ${report.whereSql}`,
      ...report.params,
    );
    return Number(rows[0]?.total ?? 0);
  }

  private async fetchStatisticsRows(tx: unknown, report: OvertimeReportSql, offset: number, limit: number): Promise<OvertimeStatisticsExportRow[]> {
    const client = tx as PrismaService['client'];
    if (report.includeZeroStatistics) {
      const params = [...report.params, limit, offset];
      return client.$queryRawUnsafe<OvertimeStatisticsExportRow[]>(`
        WITH filtered AS (
          SELECT oi.user_id, oi.user_name, oi.position_name_snapshot,
                 (SELECT COALESCE(STRING_AGG(el->>'name', '、' ORDER BY el->>'name'), '')
                  FROM jsonb_array_elements(oi.department_snapshot) el) AS department_names,
                 (oi.holiday_snapshot->>'dateType')::text AS date_type,
                 (oi.end_minute - oi.start_minute)::bigint AS minutes
          FROM hr.overtime_items oi
          INNER JOIN hr.approval_requests r ON r.id = oi.request_id
          ${report.whereSql}
        ),
        scoped AS (
          SELECT ua.user_id, ua.name AS user_name, p.name AS position_name,
                 COALESCE(STRING_AGG(DISTINCT uo.department_name, '、'), '') AS department_names
          FROM backstage.user_accounts ua
          LEFT JOIN hr.user_positions up ON up.user_id = ua.user_id
          LEFT JOIN hr.positions p ON p.id = up.position_id
          LEFT JOIN hr.user_org uo ON uo.user_id = ua.user_id
          WHERE ua.user_id = ANY($1) AND ua.status = 'ACTIVE' AND ua.deleted_at IS NULL
          GROUP BY ua.user_id, ua.name, p.name
        )
        SELECT scoped.user_name,
               COALESCE(STRING_AGG(DISTINCT NULLIF(filtered.position_name_snapshot, ''), '、'), MAX(scoped.position_name)) AS position_names,
               COALESCE(STRING_AGG(DISTINCT NULLIF(filtered.department_names, ''), '、'), MAX(scoped.department_names)) AS department_names,
               COALESCE(SUM(CASE WHEN filtered.date_type IN ('WORKDAY', 'ADJUSTED_WORKDAY') THEN filtered.minutes ELSE 0 END), 0)::bigint AS workday_minutes,
               COALESCE(SUM(CASE WHEN filtered.date_type = 'WEEKEND' THEN filtered.minutes ELSE 0 END), 0)::bigint AS weekend_minutes,
               COALESCE(SUM(CASE WHEN filtered.date_type IN ('HOLIDAY', 'ADJUSTED_HOLIDAY') THEN filtered.minutes ELSE 0 END), 0)::bigint AS holiday_minutes,
               COALESCE(SUM(filtered.minutes), 0)::bigint AS total_minutes,
               COUNT(filtered.user_id)::bigint AS record_count
        FROM scoped
        LEFT JOIN filtered ON filtered.user_id = scoped.user_id
        GROUP BY scoped.user_id, scoped.user_name
        ORDER BY scoped.user_name, scoped.user_id
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, ...params);
    }
    const params = [...report.params, limit, offset];
    return client.$queryRawUnsafe<OvertimeStatisticsExportRow[]>(`
      WITH filtered AS (
        SELECT oi.user_id, oi.user_name, oi.position_name_snapshot,
               (SELECT COALESCE(STRING_AGG(el->>'name', '、' ORDER BY el->>'name'), '')
                FROM jsonb_array_elements(oi.department_snapshot) el) AS department_names,
               (oi.holiday_snapshot->>'dateType')::text AS date_type,
               (oi.end_minute - oi.start_minute)::bigint AS minutes
        FROM hr.overtime_items oi
        INNER JOIN hr.approval_requests r ON r.id = oi.request_id
        ${report.whereSql}
      )
      SELECT MAX(user_name) AS user_name,
             STRING_AGG(DISTINCT NULLIF(position_name_snapshot, ''), '、') AS position_names,
             STRING_AGG(DISTINCT NULLIF(department_names, ''), '、') AS department_names,
             COALESCE(SUM(CASE WHEN date_type IN ('WORKDAY', 'ADJUSTED_WORKDAY') THEN minutes ELSE 0 END), 0)::bigint AS workday_minutes,
             COALESCE(SUM(CASE WHEN date_type = 'WEEKEND' THEN minutes ELSE 0 END), 0)::bigint AS weekend_minutes,
             COALESCE(SUM(CASE WHEN date_type IN ('HOLIDAY', 'ADJUSTED_HOLIDAY') THEN minutes ELSE 0 END), 0)::bigint AS holiday_minutes,
             COALESCE(SUM(minutes), 0)::bigint AS total_minutes,
             COUNT(*)::bigint AS record_count
      FROM filtered
      GROUP BY user_id
      ORDER BY MAX(user_name), user_id
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, ...params);
  }

  /** 读取平台设置 export.max.rows（经只读视图；缺省 100000）。 */
  private async readExportMaxRows(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<Array<{ value: string }>>`
      SELECT value FROM backstage.platform_settings WHERE key = 'export.max.rows' LIMIT 1
    `;
    const value = Number(rows[0]?.value ?? 100000);
    return Number.isFinite(value) && value > 0 ? value : 100000;
  }
}

/** 构建两类报表共用的安全过滤基集；无筛选即为当前权限范围内全部已批准历史。 */
export function buildOvertimeReportSql(userIds: ReadonlySet<number>, query: OvertimeReportQuery): OvertimeReportSql {
  const where = [`r.status = 'APPROVED'`];
  const params: unknown[] = [];
  if (userIds.size === 0) {
    where.push('1 = 0');
    return { whereSql: `WHERE ${where.join(' AND ')}`, params, userIds: [], includeZeroStatistics: false };
  }
  const scopedUserIds = [...userIds];
  params.push(scopedUserIds);
  where.push(`oi.user_id = ANY($${params.length})`);
  const fields = query.filters ? collectTableFilterFields(normalizeTableFilters(query.filters)) : new Set<string>();
  if (query.month && !fields.has('month') && !fields.has('overtimeDate')) {
    const { start, end } = monthRange(query.month);
    params.push(start, end);
    where.push(`oi.overtime_date >= $${params.length - 1}::date AND oi.overtime_date < $${params.length}::date`);
  }
  if (query.keyword && !fields.has('keyword') && !fields.has('employeeName')) {
    params.push(`%${escapeLike(query.keyword)}%`);
    where.push(`oi.user_name ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (query.departmentId !== undefined && !fields.has('departmentId')) {
    params.push(JSON.stringify([{ id: query.departmentId }]));
    where.push(`oi.department_snapshot @> $${params.length}::jsonb`);
  }
  if (query.filters) {
    const compiled = buildTableSqlQuery({ filters: query.filters }, OVERTIME_REPORT_FILTER_FIELDS, { parameterOffset: params.length });
    if (compiled.whereSql) {
      where.push(compiled.whereSql);
      params.push(...compiled.params);
    }
  }
  const cohortFilterFields = ['employeeName', 'keyword', 'applicantName', 'submitterName', 'departmentId', 'positionName', 'reason', 'processorName'];
  return {
    whereSql: `WHERE ${where.join(' AND ')}`,
    params,
    userIds: scopedUserIds,
    includeZeroStatistics: !query.keyword && !cohortFilterFields.some((field) => fields.has(field)),
  };
}

/** LIKE 模糊匹配将通配符按字面量解释，避免用户输入改变筛选语义。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** YYYY-MM → [当月 1 日, 下月 1 日]；兼容既有具名 month 查询。 */
function monthRange(month: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { message: '月份格式非法：YYYY-MM' });
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return { start: new Date(Date.UTC(year, monthIndex, 1)), end: new Date(Date.UTC(year, monthIndex + 1, 1)) };
}

/** 业务导出统一按北京时间展示时刻，避免向用户输出 ISO/UTC 技术格式。 */
function formatBeijingDateTime(value: Date | null): string {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

/** Date → YYYY-MM-DD（@db.Date 日历值）。 */
function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** 将数据库明细转换为只包含历史表所需字段的 JSON 安全响应。 */
function toHistoryRecord(row: OvertimeRecordExportRow): OvertimeHistoryRecord {
  const startTime = formatTime(row.start_minute);
  const endTime = formatTime(row.end_minute);
  return {
    id: row.id,
    applicationNo: row.application_no,
    employeeName: row.user_name,
    departmentNames: row.department_names || '未记录',
    positionName: row.position_name ?? '未记录',
    reason: row.reason,
    overtimeDate: formatDate(row.overtime_date),
    startTime,
    endTime,
    timeRange: `${startTime} - ${endTime}`,
    minutes: Number(row.minutes),
    hours: minutesToHours(Number(row.minutes)),
    dateType: row.date_type,
    isBackfill: row.is_backfill,
    applicantName: row.applicant_name,
    submitterName: row.proxy_name ?? row.applicant_name,
    submittedAt: formatBeijingDateTime(row.submitted_at),
    processorName: row.processor_name ?? '',
    processedAt: formatBeijingDateTime(row.processed_at),
    status: row.status,
  };
}
