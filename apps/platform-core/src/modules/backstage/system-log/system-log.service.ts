import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, frameworkErrors, PaginationQueryDto } from '@wbme/contracts';
import { desensitizeErrorSample } from '@wbme/logging';
import { buildTableSqlQuery, RedisService, runExport } from '@wbme/server';
import type { Response } from 'express';
import { SETTING_KEYS, SettingsService } from '../../base/settings/settings.service';
import { PrismaService } from '../../../prisma.service';
import {
  loadOperationLogOperator,
  writeBackstageOperationLog,
} from '../permission/operation-log.util';

/** 错误日志列表项（不含完整 sample） */
export interface ErrorLogListItem {
  id: number;
  level: string;
  service: string;
  source: string;
  errorCategory: string;
  deployCommit: string;
  fingerprint: string;
  bucketStart: Date;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
  status: string;
  handledBy: number | null;
  handledAt: Date | null;
}

/** 错误日志详情（含脱敏 sample） */
export interface ErrorLogDetail extends ErrorLogListItem {
  firstRequestId: string | null;
  lastRequestId: string | null;
  sample: string | null;
  remark: string | null;
}

/** 安全日志列表项 */
export interface SecurityLogListItem {
  id: number;
  eventType: string;
  actorId: number | null;
  targetUserId: number | null;
  result: string;
  reason: string | null;
  sourceIp: string | null;
  requestId: string | null;
  createdAt: Date;
}

interface ErrorLogRow {
  id: number;
  level: string;
  service: string;
  source: string;
  error_category: string;
  deploy_commit: string;
  fingerprint: string;
  bucket_start: Date;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrence_count: number;
  first_request_id: string | null;
  last_request_id: string | null;
  sample: string | null;
  status: string;
  handled_by: number | null;
  handled_at: Date | null;
  remark: string | null;
}

interface SecurityLogRow {
  id: number;
  event_type: string;
  actor_id: number | null;
  target_user_id: number | null;
  result: string;
  reason: string | null;
  source_ip: string | null;
  request_id: string | null;
  created_at: Date;
}

interface CountRow {
  total: bigint;
}

/** 错误日志查询过滤 */
export interface ErrorLogQuery extends PaginationQueryDto {
  level?: string;
  service?: string;
  source?: string;
  errorCategory?: string;
  fingerprint?: string;
  status?: string;
  from?: Date;
  to?: Date;
}

/** 安全日志查询过滤 */
export interface SecurityLogQuery extends PaginationQueryDto {
  eventType?: string;
  actorId?: number;
  targetUserId?: number;
  result?: string;
  from?: Date;
  to?: Date;
}

/**
 * 系统日志查询与处置服务（backstage PRD §8）。
 */
/** 系统日志查询（列表与导出共用） */
export interface SystemLogQuery {
  level?: string;
  service?: string;
  source?: string;
  errorCategory?: string;
  fingerprint?: string;
  status?: string;
  eventType?: string;
  actorId?: number;
  targetUserId?: number;
  result?: string;
  from?: Date;
  to?: Date;
  filters?: string;
  sorts?: string;
  page: number;
  pageSize: number;
}

/**
 * 导出安全摘要（backstage PRD §8 导出白名单）：
 * 仅取原始样本首行（剥离堆栈），再脱敏密码/令牌与内部文件路径、requestId；
 * 详情页可展示的完整 sample 不受影响（仅导出端重构）。
 */
function buildExportSummary(raw: string | null): string {
  if (!raw) {
    return '';
  }
  const firstLine = (raw.split('\n')[0] ?? '').trim();
  return desensitizeErrorSample(firstLine)
    .replace(/(?:[\w@./-]+\/)+[\w@.-]+\.(?:[cm]?[jt]s[x]?):\d+:\d+/g, '[REDACTED_PATH]')
    .replace(/\brequestId[=:\s]+[^\s,;]+/gi, 'requestId [REDACTED]');
}

@Injectable()
export class SystemLogService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
  ) {}

  /** 分页查询错误日志 */
  async listErrors(query: ErrorLogQuery): Promise<{
    data: ErrorLogListItem[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const { whereSql, params } = this.buildErrorWhere(query);
    const tableQuery = buildTableSqlQuery(query, ERROR_LOG_TABLE_FIELDS, { parameterOffset: params.length });
    const effectiveWhereSql = appendWhereClause(whereSql, tableQuery.whereSql);
    const effectiveParams = [...params, ...tableQuery.params];
    const offset = (query.page - 1) * query.pageSize;
    const listParams = [...effectiveParams, query.pageSize, offset];
    const sql = `
      SELECT id, level, service, source, error_category, deploy_commit, fingerprint,
             bucket_start, first_seen_at, last_seen_at, occurrence_count,
             status, handled_by, handled_at
      FROM backstage.error_logs
      ${effectiveWhereSql}
      ORDER BY ${tableQuery.orderBySql ?? 'last_seen_at DESC, id DESC'}
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;
    const countSql = `SELECT COUNT(*)::bigint AS total FROM backstage.error_logs ${effectiveWhereSql}`;
    const rows = await this.prisma.client.$queryRawUnsafe<ErrorLogRow[]>(sql, ...listParams);
    const countResult = await this.prisma.client.$queryRawUnsafe<CountRow[]>(countSql, ...effectiveParams);
    const totalItems = Number(countResult[0]?.total ?? 0);
    return {
      data: rows.map(mapErrorListRow),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize) || 0,
      },
    };
  }

  /** 错误日志详情（含脱敏 sample） */
  async getErrorDetail(id: number): Promise<ErrorLogDetail> {
    const rows = await this.prisma.client.$queryRawUnsafe<ErrorLogRow[]>(
      `SELECT id, level, service, source, error_category, deploy_commit, fingerprint,
              bucket_start, first_seen_at, last_seen_at, occurrence_count,
              first_request_id, last_request_id, sample, status, handled_by, handled_at, remark
       FROM backstage.error_logs WHERE id = $1`,
      id,
    );
    const row = rows[0];
    if (!row) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    return mapErrorDetailRow(row);
  }

  /**
   * 处置错误日志（PENDING → HANDLED/IGNORED；并发返回 CONFLICT）。
   *
   * @param id 日志 id
   * @param operatorId 处置人
   * @param status 目标终态
   * @param remark 可选备注
   */
  async disposeError(
    id: number,
    operatorId: number,
    status: 'HANDLED' | 'IGNORED',
    remark?: string,
  ): Promise<{ id: number; status: string }> {
    const result = await this.prisma.client.$executeRawUnsafe(
      `UPDATE backstage.error_logs
       SET status = $2::backstage."ErrorStatus",
           handled_by = $3,
           handled_at = NOW(),
           remark = $4,
           updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING'`,
      id,
      status,
      operatorId,
      remark ?? null,
    );
    if (result === 0) {
      throw new BusinessException(frameworkErrors.CONFLICT);
    }
    return { id, status };
  }

  /** 分页查询安全日志 */
  async listSecurity(query: SecurityLogQuery): Promise<{
    data: SecurityLogListItem[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const { whereSql, params } = this.buildSecurityWhere(query);
    const tableQuery = buildTableSqlQuery(query, SECURITY_LOG_TABLE_FIELDS, { parameterOffset: params.length });
    const effectiveWhereSql = appendWhereClause(whereSql, tableQuery.whereSql);
    const effectiveParams = [...params, ...tableQuery.params];
    const offset = (query.page - 1) * query.pageSize;
    const listParams = [...effectiveParams, query.pageSize, offset];
    const sql = `
      SELECT id, event_type, actor_id, target_user_id, result, reason, source_ip, request_id, created_at
      FROM backstage.security_logs
      ${effectiveWhereSql}
      ORDER BY ${tableQuery.orderBySql ?? 'id DESC'}
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;
    const countSql = `SELECT COUNT(*)::bigint AS total FROM backstage.security_logs ${effectiveWhereSql}`;
    const rows = await this.prisma.client.$queryRawUnsafe<SecurityLogRow[]>(sql, ...listParams);
    const countResult = await this.prisma.client.$queryRawUnsafe<CountRow[]>(countSql, ...effectiveParams);
    const totalItems = Number(countResult[0]?.total ?? 0);
    return {
      data: rows.map(mapSecurityRow),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize) || 0,
      },
    };
  }

  /**
   * 错误日志导出为 xlsx（PRD §8 脱敏摘要导出：只含白名单字段，
   * 不含备注、堆栈、requestId、客户端 IP、数据库错误正文等排障详情）。
   *
   * @param userId 导出人（并发互斥维度）
   * @param query 与列表相同的过滤条件
   * @param res Express 响应
   */
  async exportErrors(userId: number, query: SystemLogQuery, res: Response): Promise<void> {
    const maxRows = await this.settings.getNumber(SETTING_KEYS.EXPORT_MAX_ROWS);
    const exportQuery = { ...query, page: 1, pageSize: 1 };
    const { whereSql, params } = this.buildErrorWhere(exportQuery);
    const tableQuery = buildTableSqlQuery(exportQuery, ERROR_LOG_TABLE_FIELDS, { parameterOffset: params.length });
    const effectiveWhereSql = appendWhereClause(whereSql, tableQuery.whereSql);
    const effectiveParams = [...params, ...tableQuery.params];
    await runExport<ErrorLogRow>({
      userId,
      redis: this.redis.redis,
      maxRows,
      filename: 'error-logs.xlsx',
      columns: [
        { header: '日志编号', value: (row) => row.id },
        { header: '级别', value: (row) => row.level },
        { header: '服务', value: (row) => row.service },
        { header: '来源', value: (row) => row.source },
        { header: '错误分类', value: (row) => row.error_category },
        { header: '部署 Commit', value: (row) => row.deploy_commit },
        { header: '异常指纹', value: (row) => row.fingerprint },
        { header: '首次发生', value: (row) => row.first_seen_at?.toISOString?.() ?? String(row.first_seen_at) },
        { header: '最后发生', value: (row) => row.last_seen_at?.toISOString?.() ?? String(row.last_seen_at) },
        { header: '发生次数', value: (row) => row.occurrence_count },
        { header: '安全摘要', value: (row) => buildExportSummary(row.sample) },
        { header: '状态', value: (row) => row.status },
        { header: '处理人', value: (row) => row.handled_by ?? '' },
        { header: '处理时间', value: (row) => row.handled_at?.toISOString?.() ?? '' },
      ],
      transaction: (fn, options) =>
        this.prisma.client.$transaction(fn, {
          isolationLevel: 'RepeatableRead',
          timeout: options?.timeout,
        }),
      fetchCount: async (tx) => {
        const client = tx as PrismaService['client'];
        const countSql = `SELECT COUNT(*)::bigint AS total FROM backstage.error_logs ${effectiveWhereSql}`;
        const result = await client.$queryRawUnsafe<Array<{ total: string }>>(countSql, ...effectiveParams);
        return Number(result[0]?.total ?? 0);
      },
      fetchRows: async (tx, offset, limit) => {
        const client = tx as PrismaService['client'];
        const listParams = [...effectiveParams, limit, offset];
        const sql = `
          SELECT id, level, service, source, error_category, deploy_commit, fingerprint,
                 bucket_start, first_seen_at, last_seen_at, occurrence_count,
                 sample, status, handled_by, handled_at
          FROM backstage.error_logs
          ${effectiveWhereSql}
          ORDER BY ${tableQuery.orderBySql ?? 'last_seen_at DESC, id DESC'}
          LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `;
        return client.$queryRawUnsafe<ErrorLogRow[]>(sql, ...listParams);
      },
      res,
    });
    // 系统日志导出本身按主 PRD §3.3 记录操作日志
    await this.recordExportLog(userId, '导出错误日志');
  }

  /**
   * 安全日志导出为 xlsx（PRD §8：可展示来源 IP，其余字段白名单）。
   *
   * @param userId 导出人
   * @param query 过滤条件
   * @param res Express 响应
   */
  async exportSecurity(userId: number, query: SystemLogQuery, res: Response): Promise<void> {
    const maxRows = await this.settings.getNumber(SETTING_KEYS.EXPORT_MAX_ROWS);
    const exportQuery = { ...query, page: 1, pageSize: 1 };
    const { whereSql, params } = this.buildSecurityWhere(exportQuery);
    const tableQuery = buildTableSqlQuery(exportQuery, SECURITY_LOG_TABLE_FIELDS, { parameterOffset: params.length });
    const effectiveWhereSql = appendWhereClause(whereSql, tableQuery.whereSql);
    const effectiveParams = [...params, ...tableQuery.params];
    await runExport<SecurityLogRow>({
      userId,
      redis: this.redis.redis,
      maxRows,
      filename: 'security-logs.xlsx',
      columns: [
        { header: '日志编号', value: (row) => row.id },
        { header: '事件类型', value: (row) => row.event_type },
        { header: '主体账号', value: (row) => row.actor_id ?? '' },
        { header: '目标账号', value: (row) => row.target_user_id ?? '' },
        { header: '结果', value: (row) => row.result },
        { header: '原因', value: (row) => row.reason ?? '' },
        { header: '来源 IP', value: (row) => row.source_ip ?? '' },
        { header: '时间', value: (row) => row.created_at?.toISOString?.() ?? String(row.created_at) },
      ],
      transaction: (fn, options) =>
        this.prisma.client.$transaction(fn, {
          isolationLevel: 'RepeatableRead',
          timeout: options?.timeout,
        }),
      fetchCount: async (tx) => {
        const client = tx as PrismaService['client'];
        const countSql = `SELECT COUNT(*)::bigint AS total FROM backstage.security_logs ${effectiveWhereSql}`;
        const result = await client.$queryRawUnsafe<Array<{ total: string }>>(countSql, ...effectiveParams);
        return Number(result[0]?.total ?? 0);
      },
      fetchRows: async (tx, offset, limit) => {
        const client = tx as PrismaService['client'];
        const listParams = [...effectiveParams, limit, offset];
        const sql = `
          SELECT id, event_type, actor_id, target_user_id, result, reason, source_ip, request_id, created_at
          FROM backstage.security_logs
          ${effectiveWhereSql}
          ORDER BY ${tableQuery.orderBySql ?? 'id DESC'}
          LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `;
        return client.$queryRawUnsafe<SecurityLogRow[]>(sql, ...listParams);
      },
      res,
    });
    await this.recordExportLog(userId, '导出安全日志');
  }

  /** 导出完成后写 EXPORT 操作日志（主 PRD §3.3） */
  private async recordExportLog(operatorId: number, summary: string): Promise<void> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    await this.prisma.client.$transaction((tx) =>
      writeBackstageOperationLog(tx, {
        operator,
        feature: 'system_log_view',
        actionType: 'EXPORT',
        summary,
      }),
    );
  }

  private buildErrorWhere(query: ErrorLogQuery): { whereSql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (query.level) add('level = ?::backstage."LogLevel"', query.level);
    if (query.service) add('service = ?', query.service);
    if (query.source) add('source = ?', query.source);
    if (query.errorCategory) add('error_category = ?', query.errorCategory);
    if (query.fingerprint) add('fingerprint = ?', query.fingerprint);
    if (query.status) add('status = ?::backstage."ErrorStatus"', query.status);
    if (query.from) add('last_seen_at >= ?', query.from);
    if (query.to) add('last_seen_at <= ?', query.to);
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereSql, params };
  }

  private buildSecurityWhere(query: SecurityLogQuery): { whereSql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (query.eventType) add('event_type = ?::backstage."SecurityEventType"', query.eventType);
    if (query.actorId !== undefined) add('actor_id = ?', query.actorId);
    if (query.targetUserId !== undefined) add('target_user_id = ?', query.targetUserId);
    if (query.result) add('result = ?::backstage."SecurityResult"', query.result);
    if (query.from) add('created_at >= ?', query.from);
    if (query.to) add('created_at <= ?', query.to);
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereSql, params };
  }
}

/** 错误日志表只读字段白名单；枚举统一转换为 text 后再比较，避免客户端影响 SQL 类型。 */
const ERROR_LOG_TABLE_FIELDS = {
  id: { column: 'id', type: 'number' },
  level: { column: 'level::text', type: 'enum' },
  service: { column: 'service', type: 'text' },
  source: { column: 'source', type: 'text' },
  errorCategory: { column: 'error_category', type: 'text' },
  fingerprint: { column: 'fingerprint', type: 'text' },
  status: { column: 'status::text', type: 'enum' },
  occurrenceCount: { column: 'occurrence_count', type: 'number' },
  firstSeenAt: { column: 'first_seen_at', type: 'date' },
  lastSeenAt: { column: 'last_seen_at', type: 'date' },
  handledAt: { column: 'handled_at', type: 'date' },
} as const;

/** 安全日志表只读字段白名单。 */
const SECURITY_LOG_TABLE_FIELDS = {
  id: { column: 'id', type: 'number' },
  eventType: { column: 'event_type::text', type: 'enum' },
  actorId: { column: 'actor_id', type: 'number' },
  targetUserId: { column: 'target_user_id', type: 'number' },
  result: { column: 'result::text', type: 'enum' },
  reason: { column: 'reason', type: 'text' },
  createdAt: { column: 'created_at', type: 'date' },
} as const;

/** 将结构化筛选追加到已有具名查询 WHERE 子句，始终保持 AND 组合。 */
function appendWhereClause(existing: string, structured?: string): string {
  if (!structured) return existing;
  return existing ? `${existing} AND ${structured}` : `WHERE ${structured}`;
}

function mapErrorListRow(row: ErrorLogRow): ErrorLogListItem {
  return {
    id: row.id,
    level: row.level,
    service: row.service,
    source: row.source,
    errorCategory: row.error_category,
    deployCommit: row.deploy_commit,
    fingerprint: row.fingerprint,
    bucketStart: row.bucket_start,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    occurrenceCount: row.occurrence_count,
    status: row.status,
    handledBy: row.handled_by,
    handledAt: row.handled_at,
  };
}

function mapErrorDetailRow(row: ErrorLogRow): ErrorLogDetail {
  return {
    ...mapErrorListRow(row),
    firstRequestId: row.first_request_id,
    lastRequestId: row.last_request_id,
    sample: row.sample,
    remark: row.remark,
  };
}

function mapSecurityRow(row: SecurityLogRow): SecurityLogListItem {
  return {
    id: row.id,
    eventType: row.event_type,
    actorId: row.actor_id,
    targetUserId: row.target_user_id,
    result: row.result,
    reason: row.reason,
    sourceIp: row.source_ip,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}
