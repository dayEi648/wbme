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
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { cleanupEmptyItem, findOrCreateItem, loadWarehouseWithPath } from '../../shared/inventory-core';

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
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.inventoryItem.count({ where }),
      this.prisma.client.inventoryItem.findMany({
        where,
        include: { consumable: { select: { name: true, safetyStock: true } } },
        orderBy: [{ id: 'asc' }],
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
    const filtered = query.lowStockOnly ? items.filter((item) => item.lowStock) : items;
    return { total, items: filtered };
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
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.batch.count({ where }),
      this.prisma.client.batch.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((row) => ({
        ...row,
        unitPrice: row.unitPrice !== null ? Number(row.unitPrice).toFixed(2) : null,
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
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        // 锁定批次及其所属条目（批次行 FOR UPDATE）
        const batch = await tx.$queryRaw<
          Array<{
            id: number;
            inventory_item_id: number;
            consumable_id: number;
            consumable_name: string;
            spec: string;
            warehouse_id: number | null;
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
            b.warehouse_id,
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
        const sourceItem = await this.loadItemRow(tx, batchRow.inventory_item_id);
        if (!sourceItem) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }

        const before = {
          supplierId: batchRow.supplier_id,
          supplierName: batchRow.supplier_name,
          brandId: batchRow.brand_id,
          brandName: batchRow.brand_name,
          unitPrice: batchRow.unit_price?.toString() ?? null,
          remark: batchRow.remark,
          spec: batchRow.spec,
          warehouseId: batchRow.warehouse_id,
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
        const finalWarehouseId = input.warehouseId ?? batchRow.warehouse_id;
        let finalWarehouseName = batchRow.warehouse_name;
        let finalWarehousePath = batchRow.warehouse_path;
        const specChanged = finalSpec !== batchRow.spec;
        const warehouseChanged = finalWarehouseId !== batchRow.warehouse_id;
        let targetItem: { id: number; bookQty: number } | null = null;
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
          // 目标条目：同品种「规格 + 库位」唯一索引兜底（upsert 语义）
          targetItem = await findOrCreateItem(tx, {
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

  /** 加载条目行（含账面/占用；无则 null） */
  private async loadItemRow(
    tx: Prisma.TransactionClient,
    itemId: number,
  ): Promise<{ id: number; bookQty: number; reservedQty: number } | null> {
    return tx.inventoryItem.findUnique({ where: { id: itemId }, select: { id: true, bookQty: true, reservedQty: true } });
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
