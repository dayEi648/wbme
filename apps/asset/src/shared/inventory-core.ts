import { BusinessException, inventoryErrors } from '@wbme/contracts';
import { Prisma } from '../generated/prisma/client';
import type { StockFlowType } from '../generated/prisma/enums';

/**
 * 库存一致性共享工具（asset PRD §5/§6）。
 *
 * 全部库存变动（入库/变更/申领/调拨/归还/处置）遵守同一套规则：
 * - 条目行锁按 id 升序统一加锁，避免并发事务交叉加锁死锁；
 * - 出库按批次 FIFO（received_at 升序、同时间按 id）逐段扣减；
 * - 流水只追加，与业务写入同事务；
 * - 账面与占用清零的空条目由应用层清理（表设计 A-10）。
 */

/** 库存条目锁定行（含流水快照所需字段；consumable_name 经 JOIN 品种表取当前值） */
export interface InventoryItemLockRow {
  id: number;
  consumableId: number;
  consumableName: string;
  spec: string;
  warehouseId: number | null;
  warehouseName: string;
  warehousePath: string;
  bookQty: number;
  reservedQty: number;
}

/** FIFO 分配段 */
export interface BatchAllocation {
  batchId: number;
  qty: number;
}

/** 流水写入参数（快照字段由条目行提供） */
export interface StockFlowInput {
  flowType: StockFlowType;
  direction: 'IN' | 'OUT';
  item: InventoryItemLockRow;
  batchId: number | null;
  qty: number;
  bookBefore: number;
  bookAfter: number;
  /** 业务来源类型（申请/调拨/处置等） */
  refType: string;
  refId: number;
  operator: { id: number; name: string };
}

/**
 * 按 id 升序锁定库存条目（FOR UPDATE）。
 * 调用方必须先把整单/整批涉及的全部条目 id 收集齐再一次性加锁。
 *
 * @param tx 事务客户端
 * @param ids 条目 id 集合
 * @returns 锁定行（升序）
 */
export async function lockInventoryItems(tx: Prisma.TransactionClient, ids: readonly number[]): Promise<InventoryItemLockRow[]> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) {
    return [];
  }
  return tx.$queryRaw<InventoryItemLockRow[]>`
    SELECT
      ii.id,
      ii.consumable_id AS "consumableId",
      c.name AS "consumableName",
      ii.spec,
      ii.warehouse_id AS "warehouseId",
      ii.warehouse_name AS "warehouseName",
      ii.warehouse_path AS "warehousePath",
      ii.book_qty AS "bookQty",
      ii.reserved_qty AS "reservedQty"
    FROM asset.inventory_items ii
    INNER JOIN asset.consumables c ON c.id = ii.consumable_id
    WHERE ii.id = ANY(${unique as number[]})
    ORDER BY ii.id ASC
    FOR UPDATE
  `;
}

/**
 * FIFO 分配批次并扣减 remaining_qty（批次行 FOR UPDATE；调用方须已锁定所属条目）。
 * 累计不足时整段不回写并抛 INSUFFICIENT_STOCK。
 *
 * @param tx 事务客户端
 * @param itemId 条目 id
 * @param qty 需要出库数量
 * @returns 分配段列表（batchId + qty；各段已扣减 remaining_qty）
 * @throws INSUFFICIENT_STOCK 批次剩余总量不足
 */
export async function allocateFifoBatches(tx: Prisma.TransactionClient, itemId: number, qty: number): Promise<BatchAllocation[]> {
  const rows = await tx.$queryRaw<Array<{ id: number; remaining_qty: number }>>`
    SELECT id, remaining_qty
    FROM asset.batches
    WHERE inventory_item_id = ${itemId}
      AND remaining_qty > 0
    ORDER BY received_at ASC, id ASC
    FOR UPDATE
  `;
  const allocations: BatchAllocation[] = [];
  let remaining = qty;
  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }
    const take = Math.min(row.remaining_qty, remaining);
    await tx.$executeRaw`
      UPDATE asset.batches
      SET remaining_qty = remaining_qty - ${take}
      WHERE id = ${row.id}
    `;
    allocations.push({ batchId: row.id, qty: take });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new BusinessException(inventoryErrors.INSUFFICIENT_STOCK);
  }
  return allocations;
}

/**
 * 写入库存流水（只追加；与业务写入同事务）。
 *
 * @param tx 事务客户端
 * @param flow 流水内容（book_before/after 由调用方按变动前/后实际值传入）
 */
export async function writeStockFlow(tx: Prisma.TransactionClient, flow: StockFlowInput): Promise<number> {
  const created = await tx.stockFlow.create({
    data: {
      flowType: flow.flowType,
      direction: flow.direction,
      inventoryItemId: flow.item.id,
      batchId: flow.batchId,
      consumableName: flow.item.consumableName,
      spec: flow.item.spec,
      warehouseName: flow.item.warehouseName,
      warehousePath: flow.item.warehousePath,
      qty: flow.qty,
      bookBefore: flow.bookBefore,
      bookAfter: flow.bookAfter,
      refType: flow.refType,
      refId: flow.refId,
      operatorId: flow.operator.id,
      operatorName: flow.operator.name,
    },
  });
  return created.id;
}

/**
 * 清理空条目：账面与占用均为 0 时物理删除（表设计 A-10 应用层清理；历史流水保留）。
 *
 * 排除仍存在未结清借还记录（qty > returned + written_off）的条目：借还品出库后
 * 条目归零但借还尚未结清，归还/结清/处置仍须按原条目回库（PRD §5 归还例外，
 * §8 借出时部门快照关联），删除会导致归还路径 RESOURCE_NOT_FOUND。
 *
 * @param tx 事务客户端
 * @param itemId 条目 id
 */
export async function cleanupEmptyItem(tx: Prisma.TransactionClient, itemId: number): Promise<void> {
  // 借还记录对库存条目无外键（跨模块裸字段约定），用 NOT EXISTS 子查询排除未结清引用
  await tx.$executeRaw`
    DELETE FROM asset.inventory_items
    WHERE id = ${itemId}
      AND book_qty = 0
      AND reserved_qty = 0
      AND NOT EXISTS (
        SELECT 1 FROM asset.borrow_records br
        WHERE br.inventory_item_id = asset.inventory_items.id
          AND br.qty > br.returned_qty + br.written_off_qty
      )
  `;
}

/** 加载启用库位（含父链路径快照；停用/不存在返回 null） */
export interface WarehousePathRow {
  id: number;
  name: string;
  path: string;
}

/**
 * 加载启用库位及其路径快照（沿父链上溯拼装；首节点须启用，上级可为停用——停用不
 * 影响既有展示；深度上限 64 防环）。
 *
 * @param tx 事务客户端
 * @param warehouseId 库位 id
 * @returns 库位 + 路径；不存在或首节点停用返回 null
 */
export async function loadWarehouseWithPath(
  tx: Prisma.TransactionClient,
  warehouseId: number | null | undefined,
): Promise<WarehousePathRow | null> {
  if (warehouseId === null || warehouseId === undefined) {
    return null;
  }
  const names: string[] = [];
  let current: number | null = warehouseId;
  for (let depth = 0; current !== null && depth < 64; depth++) {
    // 显式类型标注打破 Prisma 泛型推断与循环变量的循环（TS7022）
    const targetId: number = current;
    const row: { id: number; parentId: number | null; name: string; status: string } | null =
      await tx.warehouse.findUnique({
        where: { id: targetId },
        select: { id: true, parentId: true, name: true, status: true },
      });
    if (!row) {
      return null;
    }
    if (depth === 0 && row.status !== 'ACTIVE') {
      return null;
    }
    names.unshift(row.name);
    current = row.parentId;
  }
  return { id: warehouseId, name: names[names.length - 1] ?? '', path: names.join('/') };
}

/**
 * 按「品种 + 规格 + 库位」查找或创建库存条目（A-10 唯一索引兜底并发创建归并）。
 *
 * @param tx 事务客户端
 * @param input 条目归属与库位快照
 * @returns 条目行（含当前账面）
 */
export async function findOrCreateItem(
  tx: Prisma.TransactionClient,
  input: {
    consumableId: number;
    spec: string;
    warehouseId: number | null;
    warehouseName: string;
    warehousePath: string;
  },
): Promise<{ id: number; bookQty: number }> {
  const existing = await tx.inventoryItem.findFirst({
    where: { consumableId: input.consumableId, spec: input.spec, warehouseId: input.warehouseId },
    select: { id: true, bookQty: true },
  });
  if (existing) {
    return existing;
  }
  try {
    const created = await tx.inventoryItem.create({
      data: {
        consumableId: input.consumableId,
        spec: input.spec,
        warehouseId: input.warehouseId,
        warehouseName: input.warehouseName,
        warehousePath: input.warehousePath,
      },
    });
    return { id: created.id, bookQty: 0 };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // 并发创建撞唯一索引：重读归并
      const row = await tx.inventoryItem.findFirst({
        where: { consumableId: input.consumableId, spec: input.spec, warehouseId: input.warehouseId },
        select: { id: true, bookQty: true },
      });
      if (row) {
        return row;
      }
    }
    throw error;
  }
}

/**
 * 锁读或创建库存条目（M8，主 PRD §11 / asset PRD §6：每条流水保存各自变动前后数量）。
 *
 * 与 findOrCreateItem 的差异：命中行一律 `SELECT ... FOR UPDATE` 行锁后再返回，
 * 保证同条目并发的流水 book_before/after 基于同一串行化后的账面值；不存在时创建
 * 后（P2002 归并）再锁读返回。调用点：调拨目标、入库批准、批次纠错（写路径）。
 *
 * @param tx 事务客户端
 * @param input 条目归属与库位快照
 * @returns 条目行（含锁内读取的当前账面）
 */
export async function lockOrCreateItem(
  tx: Prisma.TransactionClient,
  input: {
    consumableId: number;
    spec: string;
    warehouseId: number | null;
    warehouseName: string;
    warehousePath: string;
  },
): Promise<{ id: number; bookQty: number }> {
  const existing = await tx.$queryRaw<Array<{ id: number; book_qty: number }>>`
    SELECT id, book_qty
    FROM asset.inventory_items
    WHERE consumable_id = ${input.consumableId}
      AND spec = ${input.spec}
      AND warehouse_id IS NOT DISTINCT FROM ${input.warehouseId}
    FOR UPDATE
  `;
  if (existing[0]) {
    return { id: existing[0].id, bookQty: Number(existing[0].book_qty) };
  }
  try {
    const created = await tx.inventoryItem.create({
      data: {
        consumableId: input.consumableId,
        spec: input.spec,
        warehouseId: input.warehouseId,
        warehouseName: input.warehouseName,
        warehousePath: input.warehousePath,
      },
    });
    // 创建后锁读（行已归本事务所有，FOR UPDATE 立即返回）
    return { id: created.id, bookQty: 0 };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // 并发创建撞唯一索引：锁读已提交行（等待持有锁事务提交后读取最新账面）
      const row = await tx.$queryRaw<Array<{ id: number; book_qty: number }>>`
        SELECT id, book_qty
        FROM asset.inventory_items
        WHERE consumable_id = ${input.consumableId}
          AND spec = ${input.spec}
          AND warehouse_id IS NOT DISTINCT FROM ${input.warehouseId}
        FOR UPDATE
      `;
      if (row[0]) {
        return { id: row[0].id, bookQty: Number(row[0].book_qty) };
      }
    }
    throw error;
  }
}
