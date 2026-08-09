import { Inject, Injectable } from '@nestjs/common';
import { OPERATION_LOG_VIEW_FUNCTION_CODE } from '@wbme/contracts';
import { getGrantedFunction, RedisService, runExport } from '@wbme/server';
import type { Response } from 'express';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import { SETTING_KEYS, SettingsService } from '../../base/settings/settings.service';
import {
  loadOperationLogOperator,
  writeBackstageOperationLog,
} from '../permission/operation-log.util';

/** 操作日志列表项（不含幂等/指纹/结果引用） */
export interface OperationLogListItem {
  id: number;
  operatorId: number | null;
  operatorName: string | null;
  operatorDepartments: unknown;
  system: string;
  feature: string;
  actionType: string;
  summary: string;
  requestId: string | null;
  createdAt: Date;
}

/** 操作日志查询过滤 */
export interface OperationLogQuery {
  system?: string;
  feature?: string;
  operatorId?: number;
  actionType?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

interface OperationLogRow {
  id: number;
  operator_id: number | null;
  operator_name: string | null;
  operator_departments: unknown;
  system: string;
  feature: string;
  action_type: string;
  summary: string;
  request_id: string | null;
  created_at: Date;
}

interface CountRow {
  total: bigint;
}

/**
 * 操作日志查询服务（主 PRD §3.3；T4-1）。
 *
 * 经 backstage.operation_logs_union 只读视图统一查询各模块日志。
 */
@Injectable()
export class OperationLogService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 分页查询操作日志（管理后台；按授权数据范围过滤）。
   *
   * @param query 过滤与分页参数
   * @returns 列表与分页元数据
   */
  async list(query: OperationLogQuery): Promise<{
    data: OperationLogListItem[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const { whereSql, params } = this.buildWhereClause(query, false);
    const offset = (query.page - 1) * query.pageSize;
    const listParams = [...params, query.pageSize, offset];
    const countParams = [...params];
    const baseSql = `
      SELECT id, operator_id, operator_name, operator_departments,
             system, feature, action_type, summary, request_id, created_at
      FROM backstage.operation_logs_union
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;
    const countSql = `
      SELECT COUNT(*)::bigint AS total
      FROM backstage.operation_logs_union
      ${whereSql}
    `;
    const rows = await this.prisma.client.$queryRawUnsafe<OperationLogRow[]>(baseSql, ...listParams);
    const countResult = await this.prisma.client.$queryRawUnsafe<CountRow[]>(countSql, ...countParams);
    const totalItems = Number(countResult[0]?.total ?? 0);
    return {
      data: rows.map(mapRow),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize) || 0,
      },
    };
  }

  /**
   * 查询当前用户本人的操作日志（个人中心 P6）。
   *
   * @param operatorId 当前用户 id
   * @param query 分页参数
   */
  async listMine(
    operatorId: number,
    query: Pick<OperationLogQuery, 'page' | 'pageSize'>,
  ): Promise<{
    data: OperationLogListItem[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    return this.list({ ...query, operatorId });
  }

  /**
   * 导出操作日志为 xlsx 流（T4-11；REPEATABLE READ 快照 + Redis 互斥）。
   *
   * @param userId 导出人
   * @param query 与列表相同的过滤条件
   * @param res Express 响应
   */
  async export(userId: number, query: Omit<OperationLogQuery, 'page' | 'pageSize'>, res: Response): Promise<void> {
    const maxRows = await this.settings.getNumber(SETTING_KEYS.EXPORT_MAX_ROWS);
    const { whereSql, params } = this.buildWhereClause({ ...query, page: 1, pageSize: 1 }, false);
    await runExport<OperationLogRow>({
      userId,
      redis: this.redis.redis,
      maxRows,
      filename: 'operation-logs.xlsx',
      columns: [
        { header: 'ID', value: (row) => row.id },
        { header: '操作人', value: (row) => row.operator_name },
        { header: '系统', value: (row) => row.system },
        { header: '功能', value: (row) => row.feature },
        { header: '动作', value: (row) => row.action_type },
        { header: '摘要', value: (row) => row.summary },
        { header: '时间', value: (row) => row.created_at?.toISOString?.() ?? String(row.created_at) },
      ],
      transaction: (fn, options) =>
        this.prisma.client.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: options?.timeout,
        }),
      fetchCount: async (tx) => {
        const client = tx as PrismaService['client'];
        const countSql = `SELECT COUNT(*)::bigint AS total FROM backstage.operation_logs_union ${whereSql}`;
        const result = await client.$queryRawUnsafe<CountRow[]>(countSql, ...params);
        return Number(result[0]?.total ?? 0);
      },
      fetchRows: async (tx, offset, limit) => {
        const client = tx as PrismaService['client'];
        const listParams = [...params, limit, offset];
        const sql = `
          SELECT id, operator_id, operator_name, operator_departments,
                 system, feature, action_type, summary, request_id, created_at
          FROM backstage.operation_logs_union
          ${whereSql}
          ORDER BY created_at DESC, id DESC
          LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `;
        return client.$queryRawUnsafe<OperationLogRow[]>(sql, ...listParams);
      },
      res,
    });
    await this.recordExportLog(userId);
  }

  /** 导出完成后写 EXPORT 操作日志（主 PRD §3.3：全站导出统一记录，与系统日志导出一致） */
  private async recordExportLog(operatorId: number): Promise<void> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    await this.prisma.client.$transaction((tx) =>
      writeBackstageOperationLog(tx, {
        operator,
        feature: OPERATION_LOG_VIEW_FUNCTION_CODE,
        actionType: 'EXPORT',
        summary: '导出操作日志',
      }),
    );
  }

  /** 构建 WHERE 子句与参数（含数据范围过滤） */
  private buildWhereClause(
    query: OperationLogQuery,
    mineOnly: boolean,
  ): { whereSql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (query.operatorId !== undefined) {
      add('operator_id = ?', query.operatorId);
    }
    if (query.system) {
      add('system = ?', query.system);
    }
    if (query.feature) {
      add('feature = ?', query.feature);
    }
    if (query.actionType) {
      add('action_type = ?', query.actionType);
    }
    if (query.from) {
      add('created_at >= ?', query.from);
    }
    if (query.to) {
      add('created_at <= ?', query.to);
    }
    if (!mineOnly) {
      const scopeFilter = this.buildDataScopeFilter(params);
      if (scopeFilter) {
        conditions.push(scopeFilter);
      }
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereSql, params };
  }

  /**
   * 数据范围行级过滤（主 PRD §3.1）。
   * DEPARTMENT 档待 hr 组织视图接入后按 operator_departments 交集过滤；
   * 本期 hr 未就绪时 DEPARTMENT 与 COMPANY 行为相同（TODO）。
   */
  private buildDataScopeFilter(_params: unknown[]): string | null {
    const granted = getGrantedFunction();
    if (!granted || granted.dataScope === null || granted.dataScope === 'COMPANY') {
      return null;
    }
    if (granted.dataScope === 'DEPARTMENT') {
      // TODO(T6-6): hr 组织数据就绪后，按当前用户部门与 operator_departments JSON 数组求交集过滤
      return null;
    }
    return null;
  }
}

function mapRow(row: OperationLogRow): OperationLogListItem {
  return {
    id: row.id,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    operatorDepartments: row.operator_departments,
    system: row.system,
    feature: row.feature,
    actionType: row.action_type,
    summary: row.summary,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}
