import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma.service';
import { cleanupEmptyItem } from './inventory-core';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/**
 * 空条目清理（H1 修复回归）：
 * 借还品出库后条目账面/占用归零时，仍存在未结清借还记录的条目必须保留
 * （归还/结清/直接处置仍按原条目回库）；无未结清借还时按 A-10 应用层清理。
 */
describeDb('cleanupEmptyItem（H1 修复：未结清借还条目保留）', () => {
  let prisma: PrismaService;

  const BASE = 8_901_100;
  const consumableId = BASE + 1;
  const warehouseId = BASE + 2;
  const keptItemId = BASE + 3; // 有未结清借还 → 应保留
  const settledItemId = BASE + 4; // 借还已结清 → 可删
  const bareItemId = BASE + 5; // 无借还 → 可删
  const batchId = BASE + 6;
  const borrowKeptId = BASE + 7;
  const borrowSettledId = BASE + 8;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.client.$executeRaw`
      INSERT INTO asset.consumables (id, name, unit_name, type, return_days, max_holding, safety_stock, status, created_at, updated_at)
      VALUES (${consumableId}, 'H1回归借还品', '个', 'REUSABLE', 30, 10, 0, 'ACTIVE', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await prisma.client.$executeRaw`
      INSERT INTO asset.warehouses (id, name, status, created_at, updated_at)
      VALUES (${warehouseId}, 'H1回归库位', 'ACTIVE', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    // 同一品种多条条目：规格区分（A-10 唯一索引 (consumable_id, COALESCE(warehouse_id,0), spec)）
    for (const [itemId, spec] of [[keptItemId, '标准A'], [settledItemId, '标准B'], [bareItemId, '标准C']] as Array<[number, string]>) {
      await prisma.client.$executeRaw`
        INSERT INTO asset.inventory_items (id, consumable_id, spec, warehouse_id, warehouse_name, warehouse_path, book_qty, reserved_qty, created_at, updated_at)
        VALUES (${itemId}, ${consumableId}, ${spec}, ${warehouseId}, 'H1回归库位', 'H1回归库位', 0, 0, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
    }
    await prisma.client.$executeRaw`
      INSERT INTO asset.batches (id, inventory_item_id, consumable_id, consumable_name, spec, warehouse_name, warehouse_path, remaining_qty, received_at, created_at, updated_at)
      VALUES (${batchId}, ${keptItemId}, ${consumableId}, 'H1回归借还品', '标准', 'H1回归库位', 'H1回归库位', 0, NOW(), NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await prisma.client.$executeRaw`
      INSERT INTO asset.borrow_records (id, record_type, request_id, inventory_item_id, consumable_name, spec, warehouse_name, warehouse_path, qty, returned_qty, written_off_qty, borrowed_at, due_at, created_at)
      VALUES
        (${borrowKeptId}, 'PERSONAL', 0, ${keptItemId}, 'H1回归借还品', '标准A', 'H1回归库位', 'H1回归库位', 10, 0, 0, NOW(), NOW() + INTERVAL '30 days', NOW()),
        (${borrowSettledId}, 'PERSONAL', 0, ${settledItemId}, 'H1回归借还品', '标准B', 'H1回归库位', 'H1回归库位', 5, 5, 0, NOW(), NOW() + INTERVAL '30 days', NOW())
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    await prisma.client.$executeRaw`DELETE FROM asset.borrow_records WHERE id IN (${borrowKeptId}, ${borrowSettledId})`;
    await prisma.client.$executeRaw`DELETE FROM asset.batches WHERE id = ${batchId}`;
    await prisma.client.$executeRaw`DELETE FROM asset.inventory_items WHERE id IN (${keptItemId}, ${settledItemId}, ${bareItemId})`;
    await prisma.client.$executeRaw`DELETE FROM asset.warehouses WHERE id = ${warehouseId}`;
    await prisma.client.$executeRaw`DELETE FROM asset.consumables WHERE id = ${consumableId}`;
    await prisma.client.$disconnect();
  });

  it('存在未结清借还（qty > returned + written_off）→ 条目保留', async () => {
    await cleanupEmptyItem(prisma.client, keptItemId);
    const row = await prisma.client.inventoryItem.findUnique({ where: { id: keptItemId } });
    expect(row).not.toBeNull();
  });

  it('借还已结清（returned = qty）→ 条目可清理', async () => {
    await cleanupEmptyItem(prisma.client, settledItemId);
    const row = await prisma.client.inventoryItem.findUnique({ where: { id: settledItemId } });
    expect(row).toBeNull();
  });

  it('无任何借还记录 → 条目可清理（A-10 应用层清理语义不变）', async () => {
    await cleanupEmptyItem(prisma.client, bareItemId);
    const row = await prisma.client.inventoryItem.findUnique({ where: { id: bareItemId } });
    expect(row).toBeNull();
  });
});
