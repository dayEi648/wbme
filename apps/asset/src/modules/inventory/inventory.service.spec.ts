import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import { InventoryService } from './inventory.service';
import { ensurePermissionCatalog } from '../../test-support/ensure-permission-catalog';

try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/**
 * 库存服务集成测试（T7-4 批次资料纠正）。
 *
 * 验证：
 * 1. 正常纠正（供应商/品牌/备注）成功并写入 batch_corrections；
 * 2. 存在除入库外后续流水时禁止纠正；
 * 3. 来源条目有待审批占用时禁止纠正。
 */
describeDb('InventoryService.correctBatch（T7-4）', () => {
  let prisma: PrismaService;
  let service: InventoryService;
  let operatorId = 0;

  const TEST_PHONE = '+8613900000888';
  const BASE_ID = 8_900_800;

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new InventoryService(prisma);
    await ensurePermissionCatalog(prisma);

    // 确保 asset 系统开放
    await prisma.client.$executeRaw`
      UPDATE backstage.systems SET product_status = 'OPEN' WHERE code = 'ASSET'
    `;

    // 清理并创建操作人
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${TEST_PHONE}`;
    const userRows = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('库存纠正测试员', 'MALE', ${TEST_PHONE}, 'ACTIVE', true, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    operatorId = userRows[0]!.id;
  });

  afterAll(async () => {
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${TEST_PHONE}`;
    // 并发用例可能创建归属条目与 CORRECTION 流水：按品种整体清理（0.8 复核补测残留；
    // 流水按 batch_id 清理——cleanupEmptyItem 会删除空条目，按条目 id 过滤会漏流水）
    await prisma.client.$executeRaw`
      DELETE FROM asset.batch_corrections
      WHERE batch_id IN (SELECT id FROM asset.batches WHERE consumable_id = ${BASE_ID})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM asset.stock_flows
      WHERE batch_id IN (SELECT id FROM asset.batches WHERE consumable_id = ${BASE_ID})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM asset.batches WHERE consumable_id = ${BASE_ID}
    `;
    await prisma.client.$executeRaw`
      DELETE FROM asset.inventory_items WHERE consumable_id = ${BASE_ID}
    `;
    await prisma.client.$disconnect();
  });

  async function setupBatch(overrides: { reservedQty?: number; flowType?: string } = {}) {
    const consumableId = BASE_ID;
    const warehouseId = BASE_ID + 1;
    const itemId = BASE_ID + 2;
    const batchId = BASE_ID + 3;

    // 清理旧数据：按品种整体清理——并发纠正（改规格）可能把批次移入新创建的目标条目，
    // 仅按固定 id 删除会漏掉目标条目导致 consumable 外键 RESTRICT（0.8 复核补测发现）；
    // 流水按 batch_id 清理（cleanupEmptyItem 会删除空条目，按条目 id 过滤会漏掉
    // 指向已删条目的流水，残留流水使下轮规格纠正误报 BATCH_CORRECTION_FORBIDDEN）
    await prisma.client.$executeRaw`
      DELETE FROM asset.batch_corrections
      WHERE batch_id IN (SELECT id FROM asset.batches WHERE consumable_id = ${consumableId})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM asset.stock_flows
      WHERE batch_id IN (SELECT id FROM asset.batches WHERE consumable_id = ${consumableId})
    `;
    await prisma.client.$executeRaw`DELETE FROM asset.batches WHERE consumable_id = ${consumableId}`;
    await prisma.client.$executeRaw`DELETE FROM asset.inventory_items WHERE consumable_id = ${consumableId}`;
    await prisma.client.$executeRaw`DELETE FROM asset.warehouses WHERE id = ${warehouseId}`;
    await prisma.client.$executeRaw`DELETE FROM asset.consumables WHERE id = ${consumableId}`;
    await prisma.client.$executeRaw`DELETE FROM asset.asset_dict_items WHERE id IN (99901, 99902)`;

    await prisma.client.$executeRaw`
      INSERT INTO asset.consumables (id, name, unit_name, type, quota_cycle, quota_limit, safety_stock, status, created_at, updated_at)
      VALUES (${consumableId}, '纠正测试品种', '个', 'DISPOSABLE', 'MONTH', 10, 0, 'ACTIVE', NOW(), NOW())
    `;
    await prisma.client.$executeRaw`
      INSERT INTO asset.asset_dict_items (id, dict_type, name, status, created_at, updated_at)
      VALUES
        (99901, 'SUPPLIER', '新供应商', 'ACTIVE', NOW(), NOW()),
        (99902, 'BRAND', '新品牌', 'ACTIVE', NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, dict_type = EXCLUDED.dict_type
    `;
    await prisma.client.$executeRaw`
      INSERT INTO asset.warehouses (id, name, sort, status, created_at, updated_at)
      VALUES (${warehouseId}, '纠正测试库位', 0, 'ACTIVE', NOW(), NOW())
    `;
    await prisma.client.$executeRaw`
      INSERT INTO asset.inventory_items (id, consumable_id, spec, warehouse_id, warehouse_name, warehouse_path, book_qty, reserved_qty, created_at, updated_at)
      VALUES (${itemId}, ${consumableId}, '测试规格', ${warehouseId}, '纠正测试库位', '纠正测试库位', 100, ${overrides.reservedQty ?? 0}, NOW(), NOW())
    `;
    await prisma.client.$executeRaw`
      INSERT INTO asset.batches (id, inventory_item_id, consumable_id, consumable_name, spec, warehouse_name, warehouse_path, remaining_qty, received_at, created_at, updated_at)
      VALUES (${batchId}, ${itemId}, ${consumableId}, '纠正测试品种', '测试规格', '纠正测试库位', '纠正测试库位', 100, NOW(), NOW(), NOW())
    `;

    if (overrides.flowType) {
      await prisma.client.$executeRaw`
        INSERT INTO asset.stock_flows (flow_type, direction, inventory_item_id, batch_id, consumable_name, spec, warehouse_name, warehouse_path, qty, book_before, book_after, ref_type, ref_id, operator_id, operator_name, created_at)
        VALUES (${overrides.flowType}, 'OUT', ${itemId}, ${batchId}, '纠正测试品种', '测试规格', '纠正测试库位', '纠正测试库位', 1, 100, 99, 'test', 1, ${operatorId}, '测试员', NOW())
      `;
    }

    return { batchId, itemId, warehouseId, consumableId };
  }

  it('正常纠正供应商/品牌/备注并记录前后值', async () => {
    const { batchId } = await setupBatch();
    const operator = { id: operatorId, name: '库存纠正测试员', departments: [] };

    await service.correctBatch(operator, batchId, {
      supplierId: 99901,
      brandId: 99902,
      remark: '新备注',
      reason: '测试纠正',
    });

    const batchRows = await prisma.client.$queryRaw<Array<{ supplier_name: string; brand_name: string; remark: string }>>`
      SELECT supplier_name, brand_name, remark FROM asset.batches WHERE id = ${batchId}
    `;
    expect(batchRows[0]).toMatchObject({ supplier_name: '新供应商', brand_name: '新品牌', remark: '新备注' });

    const correctionRows = await prisma.client.$queryRaw<Array<{ before: unknown; after: unknown }>>`
      SELECT before, after FROM asset.batch_corrections WHERE batch_id = ${batchId}
    `;
    expect(correctionRows.length).toBe(1);
    expect(((correctionRows[0]?.after ?? {}) as Record<string, unknown>).supplierName).toBe('新供应商');
  });

  it('存在后续非入库流水时禁止纠正并抛 BATCH_CORRECTION_FORBIDDEN', async () => {
    const { batchId } = await setupBatch({ flowType: 'ISSUE' });
    const operator = { id: operatorId, name: '库存纠正测试员', departments: [] };

    await expect(
      service.correctBatch(operator, batchId, {
        spec: '新规格',
        reason: '测试规格纠正',
      }),
    ).rejects.toMatchObject({
      entry: expect.objectContaining({ code: 'BATCH_CORRECTION_FORBIDDEN' }),
    });
  });

  it('来源条目有待审批占用时禁止纠正并抛 BATCH_CORRECTION_FORBIDDEN', async () => {
    const { batchId } = await setupBatch({ reservedQty: 10 });
    const operator = { id: operatorId, name: '库存纠正测试员', departments: [] };

    await expect(
      service.correctBatch(operator, batchId, {
        spec: '新规格',
        reason: '测试规格纠正',
      }),
    ).rejects.toMatchObject({
      entry: expect.objectContaining({ code: 'BATCH_CORRECTION_FORBIDDEN' }),
    });
  });

  it('并发纠正互不覆盖（0.8 复核回归）：改供应商与改规格交错，无死锁且不丢失更新', async () => {
    const operator = { id: operatorId, name: '库存纠正测试员', departments: [] };
    for (let round = 0; round < 5; round += 1) {
      const { batchId } = await setupBatch();
      // 两个并发纠正：一笔改供应商、一笔改规格。真实并发下可能交错执行：
      // - 双双成功：后提交者兜底字段（供应商等）必须取锁后批次行值——先提交者的
      //   供应商修改不得被过期 peek 值覆盖（0.8 丢失更新修复）；
      // - 一方被锁后一致性校验拒绝（VALIDATION_FAILED）：identity 三字段与锁前
      //   快照不符，属并发冲突的显式检测，重试即可。
      // 不允许出现死锁（40P01）或其它错误——即 M8 锁序纪律（条目升序 → 批次）的回归护栏。
      const [r1, r2] = await Promise.allSettled([
        service.correctBatch(operator, batchId, { supplierId: 99901, reason: '并发改供应商' }),
        service.correctBatch(operator, batchId, { spec: '并发新规格', reason: '并发改规格' }),
      ]);
      const rejected = [r1, r2].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      for (const r of rejected) {
        const reason = r.reason as { entry?: { code?: string }; message?: string };
        expect(reason.entry?.code).toBe('VALIDATION_FAILED');
      }
      const succeeded = [r1, r2].filter((r) => r.status === 'fulfilled');
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      // 核心断言（无丢失更新）：供应商修改必须保留（若并发方用过期值覆盖，此处为 null/旧值）
      const batchRows = await prisma.client.$queryRaw<Array<{ supplier_name: string | null; spec: string }>>`
        SELECT supplier_name, spec FROM asset.batches WHERE id = ${batchId}
      `;
      expect(batchRows[0]?.supplier_name).toBe('新供应商');
      if (succeeded.length === 2) {
        // 双双成功时规格修改也保留
        expect(batchRows[0]?.spec).toBe('并发新规格');
      }
    }
  });
});
