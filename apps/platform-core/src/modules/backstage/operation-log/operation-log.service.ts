import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, formatExportEnumLabel, frameworkErrors, OPERATION_LOG_VIEW_FUNCTION_CODE } from '@wbme/contracts';
import { buildTableSqlQuery, collectTableFilterFields, getGrantedFunction, getRequestContext, normalizeTableFilters, RedisService, runExport } from '@wbme/server';
import type { TableFilterTreeGroup, TableFilterTreeNode } from '@wbme/server';
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
  /** 部门筛选（含下级部门，按操作者操作时部门快照过滤，主 PRD §3.3） */
  departmentId?: number;
  actionType?: string;
  from?: Date;
  to?: Date;
  filters?: string;
  sorts?: string;
  page: number;
  pageSize: number;
}

/** 结构化筛选中剥离出来的部门条件（operator_departments 快照闭包过滤，非视图列） */
interface DepartmentFilterCondition {
  operator: string;
  value: string;
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
 * 操作日志查询服务（主 PRD §3.3）。
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
    const { whereSql, params, filters } = await this.buildWhereClause(query, false);
    const tableQuery = buildTableSqlQuery({ ...query, filters }, OPERATION_LOG_TABLE_FIELDS, { parameterOffset: params.length });
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
   * 导出操作日志为 xlsx 流（REPEATABLE READ 快照 + Redis 互斥）。
   *
   * @param userId 导出人
   * @param query 与列表相同的过滤条件
   * @param res Express 响应
   */
  async export(userId: number, query: Omit<OperationLogQuery, 'page' | 'pageSize'>, res: Response): Promise<void> {
    const maxRows = await this.settings.getNumber(SETTING_KEYS.EXPORT_MAX_ROWS);
    const exportQuery = { ...query, page: 1, pageSize: 1 };
    const { whereSql, params, filters } = await this.buildWhereClause(exportQuery, false);
    const tableQuery = buildTableSqlQuery({ ...exportQuery, filters }, OPERATION_LOG_TABLE_FIELDS, { parameterOffset: params.length });
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
        { header: '系统', value: (row) => formatExportEnumLabel('systemCode', row.system) },
        { header: '功能', value: (row) => row.feature },
        { header: '动作', value: (row) => formatExportEnumLabel('operationAction', row.action_type) },
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
  ): Promise<{ whereSql: string; params: unknown[]; filters?: string }> {
    // 结构化筛选已覆盖的字段，同名具名参数让位（departmentId 单独剥离处理）
    const structuredFields = query.filters ? collectTableFilterFields(normalizeTableFilters(query.filters)) : new Set<string>();
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (query.operatorId !== undefined && !structuredFields.has('operatorId')) {
      add('operator_id = ?', query.operatorId);
    }
    if (query.system && !structuredFields.has('system')) {
      add('system = ?', query.system);
    }
    if (query.feature && !structuredFields.has('feature')) {
      add('feature = ?', query.feature);
    }
    if (query.actionType && !structuredFields.has('actionType')) {
      add('action_type = ?', query.actionType);
    }
    if (query.from) {
      add('created_at >= ?', query.from);
    }
    if (query.to) {
      add('created_at <= ?', query.to);
    }
    // departmentId 非视图列：从具名参数与结构化筛选负载中汇集后统一按部门快照闭包过滤
    const { departmentConditions, filters } = extractDepartmentConditions(query.filters);
    if (query.departmentId !== undefined && !structuredFields.has('departmentId')) {
      departmentConditions.push({ operator: 'EQUALS', value: String(query.departmentId) });
    }
    for (const condition of departmentConditions) {
      await this.addDepartmentCondition(condition, conditions, params);
    }
    if (!mineOnly) {
      const scopeFilter = await this.buildDataScopeFilter(params);
      if (scopeFilter) {
        conditions.push(scopeFilter);
      }
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereSql, params, filters };
  }

  /**
   * 部门筛选（主 PRD §3.3）：所选部门经 hr.department_closure 展开为含全部下级的闭包，
   * 与日志 operator_departments JSON 快照求交集——与 DEPARTMENT 数据范围同一口径。
   *
   * @param condition 部门条件（仅支持 EQUALS/NOT_EQUALS）
   * @param conditions 累积的 WHERE 条件
   * @param params 累积的参数化值
   * @throws BusinessException 操作符或部门值不合法时抛出校验错误
   */
  private async addDepartmentCondition(
    condition: DepartmentFilterCondition,
    conditions: string[],
    params: unknown[],
  ): Promise<void> {
    if (condition.operator !== 'EQUALS' && condition.operator !== 'NOT_EQUALS') {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: [{ field: 'filters', reason: `字段 departmentId 不支持 ${condition.operator} 操作符` }],
      });
    }
    if (!/^\d+$/.test(condition.value)) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        fields: [{ field: 'filters', reason: '部门筛选值必须为正整数' }],
      });
    }
    const rows = await this.prisma.client.$queryRaw<Array<{ descendant_id: number }>>`
      SELECT descendant_id
      FROM hr.department_closure
      WHERE ancestor_id = ${Number(condition.value)}
    `;
    const closureIds = rows.map((row) => row.descendant_id);
    if (closureIds.length === 0) {
      // 部门不存在（已物理删除）：等于条件恒空集，不等条件恒全集
      conditions.push(condition.operator === 'EQUALS' ? '1 = 0' : '1 = 1');
      return;
    }
    params.push(closureIds);
    const existsSql = `EXISTS (
        SELECT 1 FROM jsonb_array_elements(operator_departments) od
        WHERE (od->>'id')::int = ANY($${params.length}::int[])
      )`;
    conditions.push(condition.operator === 'EQUALS' ? existsSql : `NOT ${existsSql}`);
  }

  /**
   * 部门筛选树选项（扁平 parentId 列表，供前端组装部门树）。
   *
   * 部门名称经 hr.departments_view 只读视图读取（视图无 parent_id，
   * 直接父级由 hr.department_closure 按「深度差 1 的祖先」推导）；
   * DEPARTMENT 档裁剪为本人部门闭包及其祖先链（保证树可组装），其余档返回全部部门。
   */
  async departmentOptions(): Promise<{
    data: Array<{ id: number; name: string; parentId: number | null; status: string }>;
  }> {
    const scopedIds = await this.visibleDepartmentIds();
    const rows = await this.prisma.client.$queryRawUnsafe<Array<{
      id: number;
      name: string;
      status: string;
      parent_id: number | null;
    }>>(
      `
      WITH depth AS (
        SELECT descendant_id AS id, COUNT(*)::int AS depth
        FROM hr.department_closure
        GROUP BY descendant_id
      ),
      parent AS (
        SELECT d.id, c.ancestor_id AS parent_id
        FROM depth d
        INNER JOIN hr.department_closure c ON c.descendant_id = d.id
        INNER JOIN depth pd ON pd.id = c.ancestor_id AND pd.depth = d.depth - 1
      )
      SELECT v.id, v.name, v.status, p.parent_id
      FROM hr.departments_view v
      INNER JOIN depth d ON d.id = v.id
      LEFT JOIN parent p ON p.id = v.id
      ${scopedIds ? 'WHERE v.id = ANY($1::int[])' : ''}
      ORDER BY v.id
      `,
      ...(scopedIds ? [scopedIds] : []),
    );
    return {
      data: rows.map((row) => ({ id: row.id, name: row.name, parentId: row.parent_id, status: row.status })),
    };
  }

  /** DEPARTMENT 档可见部门 id（本人部门闭包 ∪ 祖先链）；其它档返回 null 表示不裁剪。 */
  private async visibleDepartmentIds(): Promise<number[] | null> {
    const granted = getGrantedFunction();
    if (!granted || granted.dataScope !== 'DEPARTMENT') {
      return null;
    }
    const context = getRequestContext();
    if (!context?.userId) {
      return [];
    }
    const rows = await this.prisma.client.$queryRaw<Array<{ id: number }>>`
      SELECT DISTINCT c.ancestor_id AS id
      FROM hr.department_closure c
      INNER JOIN hr.user_org uo ON uo.department_id = c.descendant_id
      WHERE uo.user_id = ${context.userId}
      UNION
      SELECT DISTINCT c.descendant_id AS id
      FROM hr.department_closure c
      INNER JOIN hr.user_org uo ON uo.department_id = c.ancestor_id
      WHERE uo.user_id = ${context.userId}
    `;
    return rows.map((row) => row.id);
  }

  /**
   * 数据范围行级过滤（主 PRD §3.1）：
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

/**
 * 从结构化筛选负载中剥离 departmentId 条件（该字段不是视图列，改由部门快照闭包过滤），
 * 其余条件保持原负载结构留待 buildTableSqlQuery 白名单编译。
 *
 * 协议已升级为树形条件组：先经 normalizeTableFilters 归一化，再递归剥离任意层级的
 * departmentId 条件。被剥离的 departmentId 条件统一上提为顶层 AND 约束，与既有行为一致；
 * 剥离后变空的子组会被剪除。非法 JSON 输入保留原样，由后续编译器统一报校验错误。
 *
 * @param raw 原始 filters 查询参数
 * @returns 剥离出的部门条件与净化后的 filters 负载；负载无法解析时原样保留，由编译器统一报校验错误
 */
export function extractDepartmentConditions(raw: string | undefined): {
  departmentConditions: DepartmentFilterCondition[];
  filters?: string;
} {
  if (!raw) {
    return { departmentConditions: [] };
  }
  let tree: TableFilterTreeGroup;
  try {
    tree = normalizeTableFilters(raw);
  } catch {
    return { departmentConditions: [], filters: raw };
  }
  const departmentConditions: DepartmentFilterCondition[] = [];

  /** 递归剥离条件中的 departmentId，并剪除变空的子组。 */
  const transformNode = (node: TableFilterTreeNode): TableFilterTreeNode | undefined => {
    if (!isTreeGroup(node)) {
      if (node.field === 'departmentId') {
        departmentConditions.push({ operator: node.operator, value: node.value });
        return undefined;
      }
      return node;
    }
    const keptConditions = node.conditions
      .map(transformNode)
      .filter((item): item is TableFilterTreeNode => item !== undefined);
    return keptConditions.length > 0 ? { logic: node.logic, conditions: keptConditions } : undefined;
  };

  const conditions = tree.conditions
    .map(transformNode)
    .filter((item): item is TableFilterTreeNode => item !== undefined);
  return {
    departmentConditions,
    filters: conditions.length > 0 ? JSON.stringify({ logic: tree.logic, conditions }) : undefined,
  };
}

function isTreeGroup(node: TableFilterTreeNode): node is TableFilterTreeGroup {
  return 'conditions' in node;
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
