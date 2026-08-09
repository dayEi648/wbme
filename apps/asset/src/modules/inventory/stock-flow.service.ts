import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { INVENTORY_MANAGE_FUNCTION_CODE, StockFlowQueryDto } from '@wbme/contracts';
import { buildTablePrismaQuery, RedisService, runExport } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { loadAssetOperationLogOperator } from '../../shared/asset-operation-log.util';

/** 库存流水导出行（Prisma 模型行，camelCase） */
type StockFlowExportRow = Prisma.StockFlowGetPayload<object>;

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
    const where = await this.buildWhere(query);
    const tableQuery = this.tableQuery(query);
    const effectiveWhere: Prisma.StockFlowWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.StockFlowWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.stockFlow.count({ where: effectiveWhere }),
      this.prisma.client.stockFlow.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.StockFlowOrderByWithRelationInput[] | undefined) ?? [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
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
        { header: '类型', value: (row) => row.flowType },
        { header: '方向', value: (row) => row.direction },
        { header: '品种', value: (row) => row.consumableName },
        { header: '规格', value: (row) => row.spec },
        { header: '库位', value: (row) => row.warehousePath },
        { header: '数量', value: (row) => row.qty },
        { header: '变动前账面', value: (row) => row.bookBefore },
        { header: '变动后账面', value: (row) => row.bookAfter },
        { header: '业务来源', value: (row) => row.refType ?? '' },
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

  /** 组装流水查询条件（A-13 无外键关系；品种/库位经条目归属先查 id 集合过滤） */
  private async buildWhere(query: StockFlowQueryDto): Promise<Prisma.StockFlowWhereInput> {
    const where: Prisma.StockFlowWhereInput = {};
    const itemFilter: Prisma.InventoryItemWhereInput = {};
    if (query.inventoryItemId) {
      where.inventoryItemId = query.inventoryItemId;
    }
    if (query.consumableId) {
      itemFilter.consumableId = query.consumableId;
    }
    if (query.warehouseId) {
      itemFilter.warehouseId = query.warehouseId;
    }
    if (query.consumableId !== undefined || query.warehouseId !== undefined) {
      const itemIds = await this.prisma.client.inventoryItem.findMany({
        where: itemFilter,
        select: { id: true },
      });
      where.inventoryItemId = { in: itemIds.map((item) => item.id) };
    }
    if (query.flowType) {
      where.flowType = query.flowType as Prisma.StockFlowWhereInput['flowType'];
    }
    if (query.refType) {
      where.refType = query.refType;
    }
    if (query.refId) {
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
