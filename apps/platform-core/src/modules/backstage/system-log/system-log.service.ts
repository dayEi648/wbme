import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, exportErrors, frameworkErrors, PaginationQueryDto } from '@wbme/contracts';
import { PrismaService } from '../../../prisma.service';

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
 * 系统日志查询与处置服务（backstage PRD §8；T4-3/T4-4）。
 */
@Injectable()
export class SystemLogService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 分页查询错误日志 */
  async listErrors(query: ErrorLogQuery): Promise<{
    data: ErrorLogListItem[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const { whereSql, params } = this.buildErrorWhere(query);
    const offset = (query.page - 1) * query.pageSize;
    const listParams = [...params, query.pageSize, offset];
    const sql = `
      SELECT id, level, service, source, error_category, deploy_commit, fingerprint,
             bucket_start, first_seen_at, last_seen_at, occurrence_count,
             status, handled_by, handled_at
      FROM backstage.error_logs
      ${whereSql}
      ORDER BY last_seen_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;
    const countSql = `SELECT COUNT(*)::bigint AS total FROM backstage.error_logs ${whereSql}`;
    const rows = await this.prisma.client.$queryRawUnsafe<ErrorLogRow[]>(sql, ...listParams);
    const countResult = await this.prisma.client.$queryRawUnsafe<CountRow[]>(countSql, ...params);
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
    const offset = (query.page - 1) * query.pageSize;
    const listParams = [...params, query.pageSize, offset];
    const sql = `
      SELECT id, event_type, actor_id, target_user_id, result, reason, source_ip, request_id, created_at
      FROM backstage.security_logs
      ${whereSql}
      ORDER BY id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;
    const countSql = `SELECT COUNT(*)::bigint AS total FROM backstage.security_logs ${whereSql}`;
    const rows = await this.prisma.client.$queryRawUnsafe<SecurityLogRow[]>(sql, ...listParams);
    const countResult = await this.prisma.client.$queryRawUnsafe<CountRow[]>(countSql, ...params);
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

  /** 错误日志导出（stub：后续 T4-11 实现） */
  exportErrorsStub(): never {
    throw new BusinessException(exportErrors.ROW_LIMIT_EXCEEDED);
  }

  /** 安全日志导出（stub：后续 T4-11 实现） */
  exportSecurityStub(): never {
    throw new BusinessException(exportErrors.ROW_LIMIT_EXCEEDED);
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
