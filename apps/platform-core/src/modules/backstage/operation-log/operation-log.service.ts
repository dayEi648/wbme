import { Inject, Injectable } from '@nestjs/common';
import { OPERATION_LOG_VIEW_FUNCTION_CODE } from '@wbme/contracts';
import { buildTableSqlQuery, getGrantedFunction, getRequestContext, RedisService, runExport } from '@wbme/server';
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
  filters?: string;
  sorts?: string;
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
    const { whereSql, params } = await this.buildWhereClause(query, false);
    const tableQuery = buildTableSqlQuery(query, OPERATION_LOG_TABLE_FIELDS, { parameterOffset: params.length });
    const effectiveWhereSql = appendWhereClause(whereSql, tableQuery.whereSql);
    const effectiveParams = [...params, ...tableQuery.params];
    const offset = (query.page - 1) * query.pageSize;
    const listParams = [...effectiveParams, query.pageSize, offset];
    const countParams = [...effectiveParams];
    const baseSql = `
      SELECT id, operator_id, operator_name, operator_departments,
             system, feature, action_type, summary, request_id, created_at
      FROM backstage.operation_logs_union
      ${effectiveWhereSql}
      ORDER BY ${tableQuery.orderBySql ?? 'created_at DESC, id DESC'}
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;
    const countSql = `
      SELECT COUNT(*)::bigint AS total
      FROM backstage.operation_logs_union
      ${effectiveWhereSql}
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
    query: Pick<OperationLogQuery, 'page' | 'pageSize' | 'filters' | 'sorts'>,
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
    const exportQuery = { ...query, page: 1, pageSize: 1 };
    const { whereSql, params } = await this.buildWhereClause(exportQuery, false);
    const tableQuery = buildTableSqlQuery(exportQuery, OPERATION_LOG_TABLE_FIELDS, { parameterOffset: params.length });
    const effectiveWhereSql = appendWhereClause(whereSql, tableQuery.whereSql);
    const effectiveParams = [...params, ...tableQuery.params];
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
        const countSql = `SELECT COUNT(*)::bigint AS total FROM backstage.operation_logs_union ${effectiveWhereSql}`;
        const result = await client.$queryRawUnsafe<CountRow[]>(countSql, ...effectiveParams);
        return Number(result[0]?.total ?? 0);
      },
      fetchRows: async (tx, offset, limit) => {
        const client = tx as PrismaService['client'];
        const listParams = [...effectiveParams, limit, offset];
        const sql = `
          SELECT id, operator_id, operator_name, operator_departments,
                 system, feature, action_type, summary, request_id, created_at
          FROM backstage.operation_logs_union
          ${effectiveWhereSql}
          ORDER BY ${tableQuery.orderBySql ?? 'created_at DESC, id DESC'}
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

  /** 构建 WHERE 子句与参数（含数据范围过滤；DEPARTMENT 档按 hr 部门闭包过滤） */
  private async buildWhereClause(
    query: OperationLogQuery,
    mineOnly: boolean,
  ): Promise<{ whereSql: string; params: unknown[] }> {
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
      const scopeFilter = await this.buildDataScopeFilter(params);
      if (scopeFilter) {
        conditions.push(scopeFilter);
      }
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereSql, params };
  }

  /**
   * 数据范围行级过滤（主 PRD §3.1，T6-6 接入）：
   * DEPARTMENT 档按当前用户部门闭包（hr.department_closure 视图，含下级、多部门并集）
   * 与日志 operator_departments JSON 数组求交集——日志中任一部门 ∈ 闭包即可见。
   * 经只读视图读取（hr 容器停止不使既有数据范围读取失效，主 PRD §9.4）。
   */
  private async buildDataScopeFilter(params: unknown[]): Promise<string | null> {
    const granted = getGrantedFunction();
    if (!granted || granted.dataScope === null || granted.dataScope === 'COMPANY') {
      return null;
    }
    if (granted.dataScope === 'DEPARTMENT') {
      const context = getRequestContext();
      if (!context?.userId) {
        return null;
      }
      const rows = await this.prisma.client.$queryRaw<Array<{ descendant_id: number }>>`
        SELECT DISTINCT c.descendant_id
        FROM hr.department_closure c
        INNER JOIN hr.user_org uo ON uo.department_id = c.ancestor_id
        WHERE uo.user_id = ${context.userId}
      `;
      if (rows.length === 0) {
        // 无部门员工：部门档无可见日志（与主 PRD §3.1 部门档语义一致）
        return '1 = 0';
      }
      const closureIds = rows.map((row) => row.descendant_id);
      params.push(closureIds);
      return `EXISTS (
        SELECT 1 FROM jsonb_array_elements(operator_departments) od
        WHERE (od->>'id')::int = ANY($${params.length}::int[])
      )`;
    }
    return null;
  }
}

/** 操作日志只读视图的字段白名单：列名来自开发者常量，绝不采用客户端输入。 */
const OPERATION_LOG_TABLE_FIELDS = {
  id: { column: 'id', type: 'number' },
  operatorId: { column: 'operator_id', type: 'number' },
  operatorName: { column: 'operator_name', type: 'text' },
  system: { column: 'system', type: 'enum' },
  feature: { column: 'feature', type: 'text' },
  actionType: { column: 'action_type', type: 'enum' },
  summary: { column: 'summary', type: 'text' },
  createdAt: { column: 'created_at', type: 'date' },
} as const;

/** 将结构化筛选追加到已有权限/具名查询 WHERE 子句，不改变其既有 AND 语义。 */
function appendWhereClause(existing: string, structured?: string): string {
  if (!structured) return existing;
  return existing ? `${existing} AND ${structured}` : `WHERE ${structured}`;
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
