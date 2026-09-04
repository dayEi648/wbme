import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { formatExportEnumLabel, INVENTORY_MANAGE_FUNCTION_CODE, StockFlowQueryDto } from '@wbme/contracts';
import { buildTablePrismaQuery, buildTableSqlQuery, collectTableFilterFields, normalizeTableFilters, RedisService, runExport, type TableSqlField } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';

/** 库存流水结构化筛选字段（JOIN inventory_items 后支持 consumableId/warehouseId）。 */
const STOCK_FLOW_FILTER_FIELDS: Readonly<Record<string, TableSqlField>> = {
  id: { column: 'sf.id', type: 'number' },
  inventoryItemId: { column: 'sf.inventory_item_id', type: 'number' },
  consumableId: { column: 'ii.consumable_id', type: 'number' },
  flowType: { column: 'sf.flow_type::text', type: 'enum' },
  direction: { column: 'sf.direction::text', type: 'enum' },
  consumableName: { column: 'sf.consumable_name', type: 'text' },
  spec: { column: 'sf.spec', type: 'text' },
  warehouseId: { column: 'ii.warehouse_id', type: 'number' },
  warehouseName: { column: 'sf.warehouse_name', type: 'text' },
  qty: { column: 'sf.qty', type: 'number' },
  refType: { column: 'sf.ref_type', type: 'text' },
  refId: { column: 'sf.ref_id', type: 'number' },
  operatorName: { column: 'sf.operator_name', type: 'text' },
  createdAt: { column: 'sf.created_at', type: 'date' },
};

/** 库存流水导出行（Prisma 模型行，camelCase） */
type StockFlowExportRow = Prisma.StockFlowGetPayload<object>;

/**
 * 构建库存流水列表 SQL 查询条件与排序（纯函数，便于单测）。
 *
 * @param query 查询参数
 * @returns WHERE 子句（不含 WHERE 关键字）、ORDER BY 子句、参数列表
 */
export function buildStockFlowListQuery(query: StockFlowQueryDto): {
  whereSql: string;
  orderBySql: string;
  params: unknown[];
} {
  const structuredFields = query.filters ? collectTableFilterFields(normalizeTableFilters(query.filters)) : new Set<string>();
  const conditions: string[] = ['TRUE'];
  const params: unknown[] = [];
  if (query.inventoryItemId && !structuredFields.has('inventoryItemId')) {
    params.push(query.inventoryItemId);
    conditions.push(`sf.inventory_item_id = $${params.length}`);
  }
  if (query.consumableId && !structuredFields.has('consumableId')) {
    params.push(query.consumableId);
    conditions.push(`ii.consumable_id = $${params.length}`);
  }
  if (query.warehouseId && !structuredFields.has('warehouseId')) {
    params.push(query.warehouseId);
    conditions.push(`ii.warehouse_id = $${params.length}`);
  }
  if (query.flowType && !structuredFields.has('flowType')) {
    params.push(query.flowType);
    conditions.push(`sf.flow_type = $${params.length}`);
  }
  if (query.refType && !structuredFields.has('refType')) {
    params.push(query.refType);
    conditions.push(`sf.ref_type = $${params.length}`);
  }
  if (query.refId !== undefined && !structuredFields.has('refId')) {
    params.push(query.refId);
    conditions.push(`sf.ref_id = $${params.length}`);
  }
  const compiled = buildTableSqlQuery(query, STOCK_FLOW_FILTER_FIELDS, { parameterOffset: params.length });
  if (compiled.whereSql) {
    conditions.push(compiled.whereSql);
    params.push(...compiled.params);
  }
  const whereSql = conditions.join(' AND ');
  const orderBySql = compiled.orderBySql ? `ORDER BY ${compiled.orderBySql}` : 'ORDER BY sf.created_at DESC, sf.id DESC';
  return { whereSql, orderBySql, params };
}

/**
 * 库存流水服务（asset PRD §5/§6；A-13 只追加）。
 *
 * 流水按品种/类型/来源/时间查询并导出（runExport 复用）；
 * 流水记录不可编辑、不可删除，只追加。
 */
@Injectable()
export class StockFlowService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 流水分页列表（关联品种名快照；按发生时间倒序）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async list(query: StockFlowQueryDto): Promise<{ items: unknown[]; total: number }> {
    const { whereSql, orderBySql, params } = buildStockFlowListQuery(query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    interface StockFlowListRow {
      id: number;
      flowType: string;
      direction: string;
      inventoryItemId: number;
      batchId: number | null;
      consumableName: string;
      spec: string;
      warehouseName: string;
      warehousePath: string;
      qty: number;
      bookBefore: number;
      bookAfter: number;
      refType: string | null;
      refId: number | null;
      operatorId: number;
      operatorName: string;
      createdAt: Date;
    }
    const [countRows, rows] = await Promise.all([
      this.prisma.client.$queryRawUnsafe<Array<{ total: bigint }>>(
        `SELECT COUNT(*)::bigint AS total
         FROM asset.stock_flows sf
         INNER JOIN asset.inventory_items ii ON ii.id = sf.inventory_item_id
         WHERE ${whereSql}`,
        ...params,
      ),
      this.prisma.client.$queryRawUnsafe<StockFlowListRow[]>(
        `SELECT
          sf.id,
          sf.flow_type AS "flowType",
          sf.direction,
          sf.inventory_item_id AS "inventoryItemId",
          sf.batch_id AS "batchId",
          sf.consumable_name AS "consumableName",
          sf.spec,
          sf.warehouse_name AS "warehouseName",
          sf.warehouse_path AS "warehousePath",
          sf.qty,
          sf.book_before AS "bookBefore",
          sf.book_after AS "bookAfter",
          sf.ref_type AS "refType",
          sf.ref_id AS "refId",
          sf.operator_id AS "operatorId",
          sf.operator_name AS "operatorName",
          sf.created_at AS "createdAt"
        FROM asset.stock_flows sf
        INNER JOIN asset.inventory_items ii ON ii.id = sf.inventory_item_id
        WHERE ${whereSql}
        ${orderBySql}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...params,
        pageSize,
        offset,
      ),
    ]);
    return { total: Number(countRows[0]?.total ?? 0), items: rows };
  }

  /**
   * 流水导出（runExport：Redis 互斥 + REPEATABLE READ + 120s 超时；
   * 行数上限 = 平台设置 export.max.rows；导出完成写 EXPORT 操作日志）。
   *
   * @param exporterUserId 导出会话用户
   * @param query 筛选（与列表一致；导出全部筛选结果）
   * @param res Express 响应（流式写回）
   */
  async export(exporterUserId: number, query: StockFlowQueryDto, res: Response): Promise<void> {
    const maxRows = await this.readExportMaxRows();
    const where = await this.buildWhere(query);
    const tableQuery = this.tableQuery(query);
    const effectiveWhere: Prisma.StockFlowWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.StockFlowWhereInput] }
      : where;
    await runExport<StockFlowExportRow>({
      userId: exporterUserId,
      redis: this.redis.redis,
      maxRows,
      filename: 'stock-flows.xlsx',
      columns: [
        { header: '流水ID', value: (row) => row.id },
        { header: '类型', value: (row) => formatExportEnumLabel('stockFlowType', row.flowType) },
        { header: '方向', value: (row) => formatExportEnumLabel('flowDirection', row.direction) },
        { header: '品种', value: (row) => row.consumableName },
        { header: '规格', value: (row) => row.spec },
        { header: '库位', value: (row) => row.warehousePath },
        { header: '数量', value: (row) => row.qty },
        { header: '变动前账面', value: (row) => row.bookBefore },
        { header: '变动后账面', value: (row) => row.bookAfter },
        { header: '业务来源', value: (row) => formatExportEnumLabel('stockFlowReference', row.refType) },
        { header: '操作人', value: (row) => row.operatorName },
        { header: '发生时间', value: (row) => row.createdAt.toISOString() },
      ],
      transaction: (fn, options) =>
        this.prisma.client.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: options?.timeout,
        }),
      fetchCount: async (tx) => (tx as PrismaService['client']).stockFlow.count({ where: effectiveWhere }),
      fetchRows: async (tx, offset, limit) => {
        const client = tx as PrismaService['client'];
        return client.stockFlow.findMany({
          where: effectiveWhere,
          orderBy: (tableQuery.orderBy as Prisma.StockFlowOrderByWithRelationInput[] | undefined) ?? [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
        });
      },
      res,
    });
    const operator = await loadAssetOperationLogOperator(this.prisma.client, exporterUserId);
    await this.prisma.client.assetOperationLog.create({
      data: {
        operatorId: operator.id,
        operatorName: operator.name,
        operatorDepartments: operator.departments as Prisma.InputJsonValue,
        system: 'ASSET',
        feature: INVENTORY_MANAGE_FUNCTION_CODE,
        actionType: 'EXPORT',
        summary: '导出了库存流水',
      },
    });
  }

  /** 组装流水导出查询条件（A-13 无外键关系；品种/库位经条目归属先查 id 集合过滤）。 */
  private async buildWhere(query: StockFlowQueryDto): Promise<Prisma.StockFlowWhereInput> {
    const structuredFields = query.filters ? collectTableFilterFields(normalizeTableFilters(query.filters)) : new Set<string>();
    const where: Prisma.StockFlowWhereInput = {};
    const itemFilter: Prisma.InventoryItemWhereInput = {};
    if (query.inventoryItemId && !structuredFields.has('inventoryItemId')) {
      where.inventoryItemId = query.inventoryItemId;
    }
    if (query.consumableId && !structuredFields.has('consumableId')) {
      itemFilter.consumableId = query.consumableId;
    }
    if (query.warehouseId && !structuredFields.has('warehouseId')) {
      itemFilter.warehouseId = query.warehouseId;
    }
    if ((query.consumableId !== undefined && !structuredFields.has('consumableId')) ||
        (query.warehouseId !== undefined && !structuredFields.has('warehouseId'))) {
      const itemIds = await this.prisma.client.inventoryItem.findMany({
        where: itemFilter,
        select: { id: true },
      });
      where.inventoryItemId = { in: itemIds.map((item) => item.id) };
    }
    if (query.flowType && !structuredFields.has('flowType')) {
      where.flowType = query.flowType as Prisma.StockFlowWhereInput['flowType'];
    }
    if (query.refType && !structuredFields.has('refType')) {
      where.refType = query.refType;
    }
    if (query.refId !== undefined && !structuredFields.has('refId')) {
      where.refId = query.refId;
    }
    return where;
  }

  /** 库存流水的受控筛选和排序字段；关联品种/库位仍由既有具名参数解析为条目 id。 */
  private tableQuery(query: StockFlowQueryDto) {
    return buildTablePrismaQuery(query, {
      id: { prismaField: 'id', type: 'number' },
      inventoryItemId: { prismaField: 'inventoryItemId', type: 'number' },
      flowType: { prismaField: 'flowType', type: 'enum' },
      direction: { prismaField: 'direction', type: 'enum' },
      consumableName: { prismaField: 'consumableName', type: 'text' },
      spec: { prismaField: 'spec', type: 'text' },
      warehouseName: { prismaField: 'warehouseName', type: 'text' },
      qty: { prismaField: 'qty', type: 'number' },
      refType: { prismaField: 'refType', type: 'text' },
      refId: { prismaField: 'refId', type: 'number' },
      operatorName: { prismaField: 'operatorName', type: 'text' },
      createdAt: { prismaField: 'createdAt', type: 'date' },
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
