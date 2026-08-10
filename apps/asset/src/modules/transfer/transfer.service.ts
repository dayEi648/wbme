import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  INVENTORY_MANAGE_FUNCTION_CODE,
  InventoryTransferCreateDto,
  InventoryTransferQueryDto,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { buildTablePrismaQuery } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  allocateFifoBatches,
  cleanupEmptyItem,
  lockOrCreateItem,
  loadWarehouseWithPath,
  lockInventoryItems,
  writeStockFlow,
  type InventoryItemLockRow,
} from '../../shared/inventory-core';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';

/**
 * 轻量库存调拨服务（asset PRD §6；A-14/A-15）。
 *
 * - 单次只处理一个来源库存条目；不建多行调拨单、不进入审批中心；
 * - 提交时服务端不能信任页面预览值：在一个 PostgreSQL 事务中按稳定 ID 顺序锁定来源
 *   条目与所需批次，重新计算可用库存；数量超限/状态变化/并发 → 整次 CONFLICT；
 * - 底层批次按 FIFO 分配；每段在目标库位创建带 source_batch_id 的调拨子批次，
 *   继承原品种/规格/供应商/品牌/单价/原始入库引用和追溯信息；
 * - 同一事务写入不可编辑的调拨主记录与批次分配明细，原子减少来源账面、增加目标
 *   账面，并生成关联同一调拨 ID 的 TRANSFER_OUT / TRANSFER_IN 成对流水；
 *   全部来源减少量之和 = 全部目标增加量；
 * - 携带幂等键：同一幂等键重试返回原调拨结果，不重复移库。
 */
@Injectable()
export class TransferService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 创建调拨（幂等；事务内重算可用量；超限/并发 CONFLICT）。
   *
   * @param operator 操作人
   * @param dto 调拨输入
   * @returns 调拨结果（主记录 id + 来源/目标条目 + 数量）
   */
  async create(operator: AssetOperationLogOperator, dto: InventoryTransferCreateDto): Promise<{
    transferId: number;
    fromInventoryItemId: number;
    toInventoryItemId: number;
    qty: number;
  }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: INVENTORY_MANAGE_FUNCTION_CODE,
      scope: 'asset.transfer.create',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        // ① 无锁定位来源条目（锁前仅取归属与库位用于目标条目定位；行锁后重新校验）
        const sourcePeek = await tx.inventoryItem.findUnique({
          where: { id: dto.fromInventoryItemId },
          select: { id: true, consumableId: true, spec: true, warehouseId: true },
        });
        if (!sourcePeek) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // ② 目标库位：必须启用且不同于来源库位（来源库位停用仍可调出）
        const targetWarehouse = await loadWarehouseWithPath(tx, dto.toWarehouseId);
        if (!targetWarehouse || targetWarehouse.id === sourcePeek.warehouseId) {
          throw new BusinessException(inventoryErrors.LOCATION_INVALID_TARGET);
        }
        // ③ 无锁定位目标条目（同品种 + 同规格 + 目标库位；目标库位 ≠ 来源库位故不会命中来源行）；
        // 与来源条目按 id 升序一次性锁定——遵守系统锁序纪律「条目升序 → 批次」（M8 复核修复：
        // 原实现先单锁来源、再补锁目标，反向调拨 A→B 与 B→A 并发时各持来源互要对方成环死锁 40P01）
        const targetCandidate = await tx.inventoryItem.findFirst({
          where: { consumableId: sourcePeek.consumableId, spec: sourcePeek.spec, warehouseId: targetWarehouse.id },
          select: { id: true },
        });
        const lockIds = targetCandidate
          ? [...new Set([sourcePeek.id, targetCandidate.id])].sort((a, b) => a - b)
          : [sourcePeek.id];
        const lockedItems = await lockInventoryItems(tx, lockIds);
        const sourceItem = lockedItems.find((row) => row.id === sourcePeek.id);
        if (!sourceItem) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 锁后一致性校验：来源条目归属在锁前与锁后不一致 → 并发移动，整批拒绝重试
        if (
          sourceItem.consumableId !== sourcePeek.consumableId ||
          sourceItem.spec !== sourcePeek.spec ||
          sourceItem.warehouseId !== sourcePeek.warehouseId
        ) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '来源条目已被并发修改，请重试' });
        }
        let targetItem: { id: number; bookQty: number } | null = null;
        if (targetCandidate) {
          targetItem = lockedItems.find((row) => row.id === targetCandidate.id) ?? null;
          if (!targetItem) {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
        }
        // ④ 事务内重算可用库存：超过当前可用 / 状态变化 → CONFLICT（以锁后行值为准）
        const available = sourceItem.bookQty - sourceItem.reservedQty;
        if (sourceItem.bookQty <= 0 || dto.qty > available) {
          throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
        }
        // ⑤ FIFO 分配来源批次（条目锁之后，M8 锁序）
        const allocations = await allocateFifoBatches(tx, sourceItem.id, dto.qty);
        // ⑥ 目标条目不存在：批次锁之后创建（P2002 重试锁读；新行 id 恒大于旧行，不影响已锁升序）
        targetItem ??= await lockOrCreateItem(tx, {
          consumableId: sourceItem.consumableId,
          spec: sourceItem.spec,
          warehouseId: targetWarehouse.id,
          warehouseName: targetWarehouse.name,
          warehousePath: targetWarehouse.path,
        });
        // ⑦ 写调拨主记录 + 批次分配明细（同事务；调拨完成后不可编辑/删除）
        const transfer = await tx.inventoryTransfer.create({
          data: {
            fromInventoryItemId: sourceItem.id,
            toInventoryItemId: targetItem.id,
            fromWarehouseName: sourceItem.warehouseName,
            fromWarehousePath: sourceItem.warehousePath,
            toWarehouseName: targetWarehouse.name,
            toWarehousePath: targetWarehouse.path,
            qty: dto.qty,
            remark: dto.remark ?? null,
            operatorId: operator.id,
            operatorName: operator.name,
          },
        });
        // ⑧ 来源减少、目标增加（账面）；每段建子批次 + 明细 + 成对流水
        let outBefore = sourceItem.bookQty;
        let inBefore = targetItem.bookQty;
        for (const allocation of allocations) {
          const sourceBatch = await tx.batch.findUnique({
            where: { id: allocation.batchId },
            select: {
              id: true,
              consumableId: true,
              consumableName: true,
              spec: true,
              supplierId: true,
              supplierName: true,
              brandId: true,
              brandName: true,
              unitPrice: true,
              receivedAt: true,
            },
          });
          if (!sourceBatch) {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
          // 目标库位创建调拨子批次（source_batch_id 追溯；继承采购来源）
          const subBatch = await tx.batch.create({
            data: {
              inventoryItemId: targetItem.id,
              sourceBatchId: sourceBatch.id,
              consumableId: sourceBatch.consumableId,
              consumableName: sourceBatch.consumableName,
              spec: sourceBatch.spec,
              warehouseName: targetWarehouse.name,
              warehousePath: targetWarehouse.path,
              supplierId: sourceBatch.supplierId,
              supplierName: sourceBatch.supplierName,
              brandId: sourceBatch.brandId,
              brandName: sourceBatch.brandName,
              unitPrice: sourceBatch.unitPrice,
              receivedAt: sourceBatch.receivedAt,
              remainingQty: allocation.qty,
            },
          });
          await tx.transferBatchItem.create({
            data: {
              transferId: transfer.id,
              sourceBatchId: allocation.batchId,
              targetBatchId: subBatch.id,
              qty: allocation.qty,
            },
          });
          const outAfter = outBefore - allocation.qty;
          const inAfter = inBefore + allocation.qty;
          await tx.inventoryItem.update({
            where: { id: sourceItem.id },
            data: { bookQty: { decrement: allocation.qty } },
          });
          await tx.inventoryItem.update({
            where: { id: targetItem.id },
            data: { bookQty: { increment: allocation.qty } },
          });
          await writeStockFlow(tx, {
            flowType: 'TRANSFER_OUT',
            direction: 'OUT',
            item: sourceItem,
            batchId: allocation.batchId,
            qty: allocation.qty,
            bookBefore: outBefore,
            bookAfter: outAfter,
            refType: 'TRANSFER',
            refId: transfer.id,
            operator: { id: operator.id, name: operator.name },
          });
          const targetItemRow: InventoryItemLockRow = {
            id: targetItem.id,
            consumableId: sourceItem.consumableId,
            consumableName: sourceItem.consumableName,
            spec: sourceItem.spec,
            warehouseId: targetWarehouse.id,
            warehouseName: targetWarehouse.name,
            warehousePath: targetWarehouse.path,
            bookQty: targetItem.bookQty,
            reservedQty: 0,
          };
          await writeStockFlow(tx, {
            flowType: 'TRANSFER_IN',
            direction: 'IN',
            item: targetItemRow,
            batchId: subBatch.id,
            qty: allocation.qty,
            bookBefore: inBefore,
            bookAfter: inAfter,
            refType: 'TRANSFER',
            refId: transfer.id,
            operator: { id: operator.id, name: operator.name },
          });
          outBefore = outAfter;
          inBefore = inAfter;
        }
        // 来源条目空则清理（目标条目保留；存在未结清借还时保留，归还仍按原条目回库）
        await cleanupEmptyItem(tx, sourceItem.id);
        return {
          result: {
            transferId: transfer.id,
            fromInventoryItemId: sourceItem.id,
            toInventoryItemId: targetItem.id,
            qty: dto.qty,
          },
          actionType: 'CREATE' as const,
          summary: `调拨 ${dto.qty} 件：${sourceItem.warehouseName} → ${targetWarehouse.name}（${sourceItem.consumableName}/${sourceItem.spec}）`,
        };
      },
    });
  }

  /**
   * 调拨记录列表（按品种/规格/来源库位/目标库位/操作者/时间筛选，默认时间倒序）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async list(query: InventoryTransferQueryDto): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.InventoryTransferWhereInput = {};
    // A-14 无外键关系：来源/目标条目筛选先查条目 id 集合
    const fromFilter: Prisma.InventoryItemWhereInput = {};
    if (query.consumableId) {
      fromFilter.consumableId = query.consumableId;
    }
    if (query.spec) {
      fromFilter.spec = query.spec;
    }
    if (query.fromWarehouseId) {
      fromFilter.warehouseId = query.fromWarehouseId;
    }
    if (query.consumableId !== undefined || query.spec !== undefined || query.fromWarehouseId !== undefined) {
      const ids = await this.prisma.client.inventoryItem.findMany({ where: fromFilter, select: { id: true } });
      where.fromInventoryItemId = { in: ids.map((item) => item.id) };
    }
    if (query.toWarehouseId) {
      const ids = await this.prisma.client.inventoryItem.findMany({
        where: { warehouseId: query.toWarehouseId },
        select: { id: true },
      });
      where.toInventoryItemId = { in: ids.map((item) => item.id) };
    }
    if (query.operatorId) {
      where.operatorId = query.operatorId;
    }
    const tableQuery = buildTablePrismaQuery(query, {
      id: { prismaField: 'id', type: 'number' },
      fromInventoryItemId: { prismaField: 'fromInventoryItemId', type: 'number' },
      toInventoryItemId: { prismaField: 'toInventoryItemId', type: 'number' },
      fromWarehouseName: { prismaField: 'fromWarehouseName', type: 'text' },
      toWarehouseName: { prismaField: 'toWarehouseName', type: 'text' },
      qty: { prismaField: 'qty', type: 'number' },
      operatorId: { prismaField: 'operatorId', type: 'number' },
      operatorName: { prismaField: 'operatorName', type: 'text' },
      createdAt: { prismaField: 'createdAt', type: 'date' },
    });
    const effectiveWhere: Prisma.InventoryTransferWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.InventoryTransferWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.inventoryTransfer.count({ where: effectiveWhere }),
      this.prisma.client.inventoryTransfer.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.InventoryTransferOrderByWithRelationInput[] | undefined) ?? [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /**
   * 调拨详情（批次分配明细 + 成对流水）。
   *
   * @param id 调拨主记录 id
   * @returns 详情
   */
  async detail(id: number): Promise<unknown> {
    const transfer = await this.prisma.client.inventoryTransfer.findUnique({
      where: { id },
      include: {
        batchItems: { orderBy: { id: 'asc' } },
      },
    });
    if (!transfer) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const flows = await this.prisma.client.stockFlow.findMany({
      where: { refType: 'TRANSFER', refId: id },
      orderBy: { id: 'asc' },
    });
    return { transfer, batchItems: transfer.batchItems, flows };
  }
}
