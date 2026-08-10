import { Inject, Injectable } from '@nestjs/common';
import {
  ASSET_CONFIG_FUNCTION_CODE,
  BatchCorrectionDto,
  BatchQueryDto,
  BusinessException,
  InventoryItemQueryDto,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { buildTablePrismaQuery } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { cleanupEmptyItem, loadWarehouseWithPath, lockInventoryItems, lockOrCreateItem } from '../../shared/inventory-core';

/**
 * 批次是否仍存在（correctBatch 并发路径辅助）：来源条目缺失时，若批次仍在则说明
 * 并发纠正已移动批次归属并清理了来源条目——属并发冲突应提示重试而非「资源不存在」。
 *
 * @param tx 事务客户端
 * @param batchId 批次 id
 * @throws VALIDATION_FAILED 批次仍在（归属被并发移动）
 */
async function assertBatchStillExists(tx: Prisma.TransactionClient, batchId: number): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM asset.batches WHERE id = ${batchId}
  `;
  if (rows[0]) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '批次资料已被并发修改，请重试' });
  }
}

/** 库存条目列表项 */
export interface InventoryItemListItem {
  id: number;
  consumableId: number;
  consumableName: string;
  spec: string;
  warehouseId: number | null;
  warehouseName: string;
  warehousePath: string;
  bookQty: number;
  reservedQty: number;
  /** 可用 = 账面 − 占用（计算值，不冗余存储） */
  availableQty: number;
  /** 低库存标记（可用 < 品种安全库存） */
  lowStock: boolean;
}

/**
 * 库存条目与批次服务（asset PRD §5；A-10/A-11/A-12）。
 *
 * - 库存条目：同一品种「规格 + 库位」合并为一个条目（唯一索引），是申领和库存扣减
 *   的直接对象；账面/占用/可用一致性由各业务事务保证；
 * - 批次：FIFO 出库对象；调拨子批次带 source_batch_id 追溯；
 * - 批次纠正：供应商/品牌/单价/备注直接纠正并记录前后值；规格/库位会改变条目归属，
 *   仅当该批次除原始入库外从未发生后续流水、且来源条目当前无待审批占用时才允许。
 */
@Injectable()
export class InventoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 库存条目列表（分页；品种/库位/规格筛选；低库存过滤）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async listItems(query: InventoryItemQueryDto): Promise<{ items: InventoryItemListItem[]; total: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    if (query.lowStockOnly || query.availableOnly) {
      return this.listItemsWithComputedFilters(query, page, pageSize);
    }
    const where: Prisma.InventoryItemWhereInput = {};
    if (query.consumableId) {
      where.consumableId = query.consumableId;
    }
    if (query.warehouseId) {
      where.warehouseId = query.warehouseId;
    }
    if (query.spec) {
      where.spec = query.spec;
    }
    const tableQuery = buildTablePrismaQuery(query, {
      id: { prismaField: 'id', type: 'number' },
      consumableId: { prismaField: 'consumableId', type: 'number' },
      warehouseId: { prismaField: 'warehouseId', type: 'number' },
      spec: { prismaField: 'spec', type: 'text' },
      warehouseName: { prismaField: 'warehouseName', type: 'text' },
      bookQty: { prismaField: 'bookQty', type: 'number' },
      reservedQty: { prismaField: 'reservedQty', type: 'number' },
      createdAt: { prismaField: 'createdAt', type: 'date' },
      updatedAt: { prismaField: 'updatedAt', type: 'date' },
    });
    const effectiveWhere: Prisma.InventoryItemWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.InventoryItemWhereInput] }
      : where;
    const [total, rows] = await Promise.all([
      this.prisma.client.inventoryItem.count({ where: effectiveWhere }),
      this.prisma.client.inventoryItem.findMany({
        where: effectiveWhere,
        include: { consumable: { select: { name: true, safetyStock: true } } },
        orderBy: (tableQuery.orderBy as Prisma.InventoryItemOrderByWithRelationInput[] | undefined) ?? [{ id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const items: InventoryItemListItem[] = rows.map((row) => {
      const availableQty = row.bookQty - row.reservedQty;
      return {
        id: row.id,
        consumableId: row.consumableId,
        consumableName: row.consumable.name,
        spec: row.spec,
        warehouseId: row.warehouseId,
        warehouseName: row.warehouseName,
        warehousePath: row.warehousePath,
        bookQty: row.bookQty,
        reservedQty: row.reservedQty,
        availableQty,
        lowStock: availableQty < row.consumable.safetyStock,
      };
    });
    return { total, items };
  }

  /**
   * 按可用库存/低库存计算字段查询条目。计算条件在 SQL 中完成，确保 total 与分页结果一致。
   *
   * @param query 查询条件
   * @param page 页码
   * @param pageSize 每页数量
   * @returns 满足计算条件的条目和总数
   */
  private async listItemsWithComputedFilters(
    query: InventoryItemQueryDto,
    page: number,
    pageSize: number,
  ): Promise<{ items: InventoryItemListItem[]; total: number }> {
    const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (query.consumableId) {
      conditions.push(Prisma.sql`ii.consumable_id = ${query.consumableId}`);
    }
    if (query.warehouseId) {
      conditions.push(Prisma.sql`ii.warehouse_id = ${query.warehouseId}`);
    }
    if (query.spec) {
      conditions.push(Prisma.sql`ii.spec = ${query.spec}`);
    }
    if (query.lowStockOnly) {
      conditions.push(Prisma.sql`ii.book_qty - ii.reserved_qty < c.safety_stock`);
    }
    if (query.availableOnly) {
      conditions.push(Prisma.sql`c.status = 'ACTIVE'`);
      conditions.push(Prisma.sql`ii.book_qty > ii.reserved_qty`);
    }
    const whereSql = Prisma.join(conditions, ' AND ');
    const offset = (page - 1) * pageSize;
    const [countRows, rows] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*)::bigint AS total
        FROM asset.inventory_items ii
        INNER JOIN asset.consumables c ON c.id = ii.consumable_id
        WHERE ${whereSql}
      `,
      this.prisma.client.$queryRaw<
        Array<InventoryItemListItem & { safetyStock: number }>
      >`
        SELECT
          ii.id,
          ii.consumable_id AS "consumableId",
          c.name AS "consumableName",
          ii.spec,
          ii.warehouse_id AS "warehouseId",
          ii.warehouse_name AS "warehouseName",
          ii.warehouse_path AS "warehousePath",
          ii.book_qty AS "bookQty",
          ii.reserved_qty AS "reservedQty",
          ii.book_qty - ii.reserved_qty AS "availableQty",
          c.safety_stock AS "safetyStock"
        FROM asset.inventory_items ii
        INNER JOIN asset.consumables c ON c.id = ii.consumable_id
        WHERE ${whereSql}
        ORDER BY ii.id ASC
        LIMIT ${pageSize} OFFSET ${offset}
      `,
    ]);
    return {
      total: Number(countRows[0]?.total ?? 0),
      items: rows.map(({ safetyStock, ...item }) => ({ ...item, lowStock: item.availableQty < safetyStock })),
    };
  }

  /**
   * 批次列表（分页；条目/品种/库位筛选；含剩余数量与追溯来源）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async listBatches(query: BatchQueryDto): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.BatchWhereInput = {};
    if (query.inventoryItemId) {
      where.inventoryItemId = query.inventoryItemId;
    }
    if (query.consumableId) {
      where.consumableId = query.consumableId;
    }
    if (query.warehouseId) {
      // A-11 批次只保存库位名称/路径快照；按库位筛选经条目归属先查 id 集合
      const ids = await this.prisma.client.inventoryItem.findMany({
        where: { warehouseId: query.warehouseId },
        select: { id: true },
      });
      where.inventoryItemId = { in: ids.map((item) => item.id) };
    }
    const tableQuery = buildTablePrismaQuery(query, {
      id: { prismaField: 'id', type: 'number' },
      inventoryItemId: { prismaField: 'inventoryItemId', type: 'number' },
      consumableId: { prismaField: 'consumableId', type: 'number' },
      consumableName: { prismaField: 'consumableName', type: 'text' },
      spec: { prismaField: 'spec', type: 'text' },
      warehouseName: { prismaField: 'warehouseName', type: 'text' },
      remainingQty: { prismaField: 'remainingQty', type: 'number' },
      receivedAt: { prismaField: 'receivedAt', type: 'date' },
      createdAt: { prismaField: 'createdAt', type: 'date' },
    });
    const effectiveWhere: Prisma.BatchWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.BatchWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.batch.count({ where: effectiveWhere }),
      this.prisma.client.batch.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.BatchOrderByWithRelationInput[] | undefined) ?? [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((row) => ({
        ...row,
        unitPrice: row.unitPrice !== null ? row.unitPrice.toFixed(2) : null,
      })),
    };
  }

  /**
   * 批次纠正（A-12：供应商/品牌/单价/备注直接纠正；规格/库位仅无后续流水且
   * 来源条目无待审批占用时可纠正，同一事务归并账面数量并记录纠正流水/审计）。
   *
   * @param operator 操作人
   * @param batchId 批次 id
   * @param input 纠正输入（reason 必填）
   * @throws RESOURCE_NOT_FOUND 批次不存在；BATCH_CORRECTION_FORBIDDEN 规格纠正条件不满足
   */
  async correctBatch(operator: AssetOperationLogOperator, batchId: number, input: BatchCorrectionDto): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.batch.correct',
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        // 锁序（M8 复核修复）：先无锁读批次定位条目，再按「条目 id 升序 → 批次行」加锁——
        // 与全系统其它写路径（申领/调拨/入库：lockInventoryItems 升序 → allocateFifoBatches）
        // 一致，避免批次锁在前与条目锁交叉成环死锁（40P01）。
        // 注意：asset.batches 表不存 warehouse_id（仅快照 warehouse_name/path），
        // 库位 ID 来自 inventory_items.warehouse_id。
        const batchPeek = await tx.$queryRaw<
          Array<{
            id: number;
            inventory_item_id: number;
            consumable_id: number;
            consumable_name: string;
            spec: string;
            warehouse_name: string;
            warehouse_path: string;
            supplier_id: number | null;
            supplier_name: string | null;
            brand_id: number | null;
            brand_name: string | null;
            unit_price: Prisma.Decimal | null;
            remark: string | null;
            remaining_qty: number;
          }>
        >`
          SELECT
            b.id,
            b.inventory_item_id,
            b.consumable_id,
            b.consumable_name,
            b.spec,
            b.warehouse_name,
            b.warehouse_path,
            b.supplier_id,
            b.supplier_name,
            b.brand_id,
            b.brand_name,
            b.unit_price,
            b.remark,
            b.remaining_qty
          FROM asset.batches b
          WHERE b.id = ${batchId}
        `;
        const batchPeekRow = batchPeek[0];
        if (!batchPeekRow) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 无锁读来源条目（锁前仅取库位用于目标条目定位；行锁后重新校验）
        const sourcePeek = await tx.inventoryItem.findUnique({
          where: { id: batchPeekRow.inventory_item_id },
          select: { id: true, warehouseId: true },
        });
        if (!sourcePeek) {
          await assertBatchStillExists(tx, batchId);
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 规格/库位纠正会改变批次所属条目：锁前按当前值猜测目标键用于无锁定位；
        // 目标条目与来源条目按 id 升序一次性锁定——遵守系统锁序纪律「条目升序 → 批次」
        // （M8 复核修复：原实现先单锁来源、再补锁目标，反向纠正并发时各持来源互要
        // 对方成环死锁 40P01；目标不存在时仅锁来源，批次锁后创建）
        const finalSpecGuess = input.spec ?? batchPeekRow.spec;
        const finalWarehouseIdGuess = input.warehouseId ?? sourcePeek.warehouseId;
        const targetCandidate =
          finalSpecGuess !== batchPeekRow.spec || finalWarehouseIdGuess !== sourcePeek.warehouseId
            ? await tx.inventoryItem.findFirst({
                where: { consumableId: batchPeekRow.consumable_id, spec: finalSpecGuess, warehouseId: finalWarehouseIdGuess },
                select: { id: true },
              })
            : null;
        const lockIds = [...new Set([batchPeekRow.inventory_item_id, ...(targetCandidate ? [targetCandidate.id] : [])])].sort((a, b) => a - b);
        const lockedItems = await lockInventoryItems(tx, lockIds);
        const sourceItem = lockedItems.find((row) => row.id === batchPeekRow.inventory_item_id);
        if (!sourceItem) {
          // 锁等待期间并发纠正可能已移动批次归属并清理来源条目：条目消失时区分
          // 「批次仍在但归属已移动」（并发冲突，重试）与「批次本身消失」
          await assertBatchStillExists(tx, batchId);
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        let targetItem: { id: number; bookQty: number } | null = null;
        if (targetCandidate) {
          targetItem = lockedItems.find((row) => row.id === targetCandidate.id) ?? null;
          if (!targetItem) {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
        }
        // 锁定批次行（条目锁之后，M8 锁序）；锁读校验归属/规格/库位未被并发修改
        const batch = await tx.$queryRaw<
          Array<{
            id: number;
            inventory_item_id: number;
            consumable_id: number;
            consumable_name: string;
            spec: string;
            warehouse_name: string;
            warehouse_path: string;
            supplier_id: number | null;
            supplier_name: string | null;
            brand_id: number | null;
            brand_name: string | null;
            unit_price: Prisma.Decimal | null;
            remark: string | null;
            remaining_qty: number;
          }>
        >`
          SELECT
            b.id,
            b.inventory_item_id,
            b.consumable_id,
            b.consumable_name,
            b.spec,
            b.warehouse_name,
            b.warehouse_path,
            b.supplier_id,
            b.supplier_name,
            b.brand_id,
            b.brand_name,
            b.unit_price,
            b.remark,
            b.remaining_qty
          FROM asset.batches b
          WHERE b.id = ${batchId}
          FOR UPDATE
        `;
        const batchRow = batch[0];
        if (!batchRow) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (
          batchRow.inventory_item_id !== batchPeekRow.inventory_item_id ||
          batchRow.spec !== batchPeekRow.spec ||
          batchRow.warehouse_name !== batchPeekRow.warehouse_name
        ) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '批次资料已被并发修改，请重试' });
        }
        // 锁后重算纠正值（复核修复）：兜底字段一律以锁后读的批次行/条目行为准——原实现
        // 取锁前 peek，并发「改规格」与「改供应商」交错时后提交者用过期值覆盖先提交者
        // 的修改（丢失更新），且审计 before 失真
        const before = {
          supplierId: batchRow.supplier_id,
          supplierName: batchRow.supplier_name,
          brandId: batchRow.brand_id,
          brandName: batchRow.brand_name,
          unitPrice: batchRow.unit_price?.toString() ?? null,
          remark: batchRow.remark,
          spec: batchRow.spec,
          warehouseId: sourceItem.warehouseId,
          warehouseName: batchRow.warehouse_name,
        };
        // 供应商/品牌/单价/备注：直接纠正（字段可空则清除）
        const supplier = input.supplierId !== undefined ? await this.loadDictName(tx, input.supplierId, 'SUPPLIER') : null;
        const brand = input.brandId !== undefined ? await this.loadDictName(tx, input.brandId, 'BRAND') : null;
        const finalSupplierId = input.supplierId !== undefined ? (input.supplierId || null) : batchRow.supplier_id;
        const finalSupplierName = input.supplierId !== undefined ? (supplier?.name ?? null) : batchRow.supplier_name;
        const finalBrandId = input.brandId !== undefined ? (input.brandId || null) : batchRow.brand_id;
        const finalBrandName = input.brandId !== undefined ? (brand?.name ?? null) : batchRow.brand_name;
        const finalUnitPrice = input.unitPrice !== undefined ? (input.unitPrice ? new Prisma.Decimal(input.unitPrice) : null) : batchRow.unit_price;
        const finalRemark = input.remark !== undefined ? input.remark : batchRow.remark;
        // 规格/库位纠正：会改变批次所属条目，仅当无后续流水且来源条目无待审批占用时允许
        const finalSpec = input.spec ?? batchRow.spec;
        const finalWarehouseId = input.warehouseId ?? sourceItem.warehouseId;
        let finalWarehouseName = batchRow.warehouse_name;
        let finalWarehousePath = batchRow.warehouse_path;
        const specChanged = finalSpec !== batchRow.spec;
        const warehouseChanged = finalWarehouseId !== sourceItem.warehouseId;
        if (specChanged || warehouseChanged) {
          const flowCount = await tx.$queryRaw<Array<{ total: bigint }>>`
            SELECT COUNT(*) AS total
            FROM asset.stock_flows
            WHERE batch_id = ${batchId}
              AND flow_type <> 'STOCK_IN'
          `;
          if (Number(flowCount[0]?.total ?? 0) > 0 || sourceItem.reservedQty > 0) {
            throw new BusinessException(inventoryErrors.BATCH_CORRECTION_FORBIDDEN);
          }
          const targetWarehouse = await loadWarehouseWithPath(tx, finalWarehouseId);
          if (!targetWarehouse) {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '目标库位不存在或已停用' });
          }
          finalWarehouseName = targetWarehouse.name;
          finalWarehousePath = targetWarehouse.path;
          // 目标条目不存在：批次锁之后 create（P2002 重试锁读；新行 id 恒大于旧行，补锁不破坏升序）
          targetItem ??= await lockOrCreateItem(tx, {
            consumableId: batchRow.consumable_id,
            spec: finalSpec,
            warehouseId: targetWarehouse.id,
            warehouseName: targetWarehouse.name,
            warehousePath: targetWarehouse.path,
          });
          // 归并账面：来源条目减少、目标条目增加（数量 = 批次剩余）；CORRECTION 成对流水
          const moved = batchRow.remaining_qty;
          if (targetItem.id !== sourceItem.id && moved > 0) {
            await tx.inventoryItem.update({ where: { id: sourceItem.id }, data: { bookQty: { decrement: moved } } });
            await tx.inventoryItem.update({ where: { id: targetItem.id }, data: { bookQty: { increment: moved } } });
            await tx.stockFlow.create({
              data: {
                flowType: 'CORRECTION',
                direction: 'OUT',
                inventoryItemId: sourceItem.id,
                batchId,
                consumableName: batchRow.consumable_name,
                spec: batchRow.spec,
                warehouseName: batchRow.warehouse_name,
                warehousePath: batchRow.warehouse_path,
                qty: moved,
                bookBefore: sourceItem.bookQty,
                bookAfter: sourceItem.bookQty - moved,
                refType: 'batch-correction',
                refId: batchId,
                operatorId: operator.id,
                operatorName: operator.name,
              },
            });
            await tx.stockFlow.create({
              data: {
                flowType: 'CORRECTION',
                direction: 'IN',
                inventoryItemId: targetItem.id,
                batchId,
                consumableName: batchRow.consumable_name,
                spec: finalSpec,
                warehouseName: targetWarehouse.name,
                warehousePath: targetWarehouse.path,
                qty: moved,
                bookBefore: targetItem.bookQty,
                bookAfter: targetItem.bookQty + moved,
                refType: 'batch-correction',
                refId: batchId,
                operatorId: operator.id,
                operatorName: operator.name,
              },
            });
            // 批次归属移动到目标条目（A-11 只保存库位名称/路径快照，无 warehouse_id）
            await tx.batch.update({
              where: { id: batchId },
              data: {
                inventoryItemId: targetItem.id,
                spec: finalSpec,
                warehouseName: targetWarehouse.name,
                warehousePath: targetWarehouse.path,
              },
            });
            await cleanupEmptyItem(tx, sourceItem.id);
          }
        }

        // 统一更新批次资料（供应商等字段 + 归属快照；A-11 无 warehouse_id 字段）
        await tx.batch.update({
          where: { id: batchId },
          data: {
            supplierId: finalSupplierId,
            supplierName: finalSupplierName,
            brandId: finalBrandId,
            brandName: finalBrandName,
            unitPrice: finalUnitPrice,
            remark: finalRemark,
            spec: finalSpec,
            warehouseName: finalWarehouseName,
            warehousePath: finalWarehousePath,
            updatedBy: operator.id,
          },
        });

        await tx.batchCorrection.create({
          data: {
            batchId,
            before: before as Prisma.InputJsonValue,
            after: {
              supplierId: finalSupplierId,
              supplierName: finalSupplierName,
              brandId: finalBrandId,
              brandName: finalBrandName,
              unitPrice: finalUnitPrice?.toString() ?? null,
              remark: finalRemark,
              spec: finalSpec,
              warehouseId: finalWarehouseId,
              warehouseName: finalWarehouseName,
            } as Prisma.InputJsonValue,
            reason: input.reason,
            operatorId: operator.id,
            operatorName: operator.name,
          },
        });
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `纠正了批次 ${batchId} 资料：${input.reason}`,
        };
      },
    });
  }

  /** 加载字典项名称（未填返回 null） */
  private async loadDictName(
    tx: Prisma.TransactionClient,
    dictId: number | null | undefined,
    dictType: string,
  ): Promise<{ id: number; name: string } | null> {
    if (dictId === null || dictId === undefined) {
      return null;
    }
    return tx.assetDictItem.findFirst({
      where: { id: dictId, dictType: dictType as Prisma.AssetDictItemWhereInput['dictType'] },
      select: { id: true, name: true },
    });
  }
}
