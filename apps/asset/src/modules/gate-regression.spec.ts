import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { RedisService } from '@wbme/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma.service';
import { DepartmentClosureService } from '../shared/department-closure.service';
import { loadAssetOperationLogOperator } from '../shared/asset-operation-log.util';
import { ensurePermissionCatalog } from '../test-support/ensure-permission-catalog';
import { AssetApprovalService } from './approval/asset-approval.service';
import { AssetApprovalSideEffect } from './approval/asset-approval-side-effect';
import { AssetService } from './asset/asset.service';
import { AgentSettlementService } from './borrow/agent-settlement.service';
import { BorrowService } from './borrow/borrow.service';
import { AgentClaimService } from './claim/agent-claim.service';
import { ClaimService } from './claim/claim.service';
import { CategoryService } from './catalog/category.service';
import { DictService } from './catalog/dict.service';
import { WarehouseService } from './warehouse/warehouse.service';
import { DisposalService } from './disposal/disposal.service';
import { DisposalQueryDto } from '@wbme/contracts';
import { ConsumableController } from './consumable/consumable.controller';
import { ConsumableService } from './consumable/consumable.service';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { StockFlowService } from './inventory/stock-flow.service';
import { QrService } from './qr/qr.service';
import { RepairService } from './repair/repair.service';
import { StockChangeService } from './request/stock-change.service';
import { StockInService } from './request/stock-in.service';
import { SettingsService } from './settings/settings.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/**
 * 阶段7关口回归测试（H1/H2/M1/M3/M4/M6/M7/M8/B/②/AGENT 归类修复）：
 * 全部使用真实本地 PostgreSQL + Nest 测试容器装配（forwardRef 依赖循环由容器解析）。
 */
describeDb('asset 关口回归（T7 修复验收）', () => {
  const BASE = 8_902_000;
  const [deptA, deptB] = [BASE + 1, BASE + 2];
  const [adminId, deptApproverId, inventoryManagerId, assetMaintainerId, applicantId] = [BASE + 10, BASE + 11, BASE + 12, BASE + 13, BASE + 14];
  // 顶级分类复用系统内置（ensureDefaults 产物，幂等）；子分类使用测试段 id
  let topFixedId = BASE + 20;
  let topConsumableId = BASE + 22;
  const [subFixedId, subConsumableId] = [BASE + 21, BASE + 23];
  const [reusableId, disposableId] = [BASE + 30, BASE + 31];
  const [warehouseId, reusableItemId, disposableItemId] = [BASE + 40, BASE + 41, BASE + 42];
  const [reusableBatchFirstId, reusableBatchSecondId] = [BASE + 43, BASE + 44];
  const [assetInUseId, assetIdleId, assetDeptBId] = [BASE + 50, BASE + 51, BASE + 52];
  const [repairDeptAId, repairDeptBId] = [BASE + 60, BASE + 61];
  const [qrItemId, qrAssetId] = [BASE + 70, BASE + 71];
  const [agentReqId, borrowAgentAId, borrowAgentBId] = [BASE + 80, BASE + 81, BASE + 82];
  const [consumableIdForStockIn, stockInItemId] = [BASE + 83, BASE + 84];

  let prisma: PrismaService;
  let approval: AssetApprovalService;
  let borrow: BorrowService;
  let disposal: DisposalService;
  let claim: ClaimService;
  let agentSettlement: AgentSettlementService;
  let stockIn: StockInService;
  let qr: QrService;
  let dict: DictService;
  let categoryService: CategoryService;
  let warehouseService: WarehouseService;
  let assetService: AssetService;
  let inventoryController: InventoryController;
  let consumableController: ConsumableController;
  let repair: RepairService;
  let previousAssetStatus: string | null = null;

  beforeAll(async () => {
    prisma = new PrismaService();
    await ensurePermissionCatalog(prisma);

    const statusRows = await prisma.client.$queryRaw<Array<{ product_status: string }>>`
      SELECT product_status::text AS product_status FROM backstage.systems WHERE code = 'ASSET' LIMIT 1
    `;
    previousAssetStatus = statusRows[0]?.product_status ?? null;
    await prisma.client.$executeRaw`
      UPDATE backstage.systems SET product_status = 'OPEN' WHERE code = 'ASSET'
    `;

    // 用户
    const users: Array<[number, string, string]> = [
      [adminId, '关口测试超管', '+8613900000901'],
      [deptApproverId, '关口测试部门审批人', '+8613900000902'],
      [inventoryManagerId, '关口测试库存管理员', '+8613900000903'],
      [assetMaintainerId, '关口测试资产维护人', '+8613900000904'],
      [applicantId, '关口测试申请人', '+8613900000905'],
    ];
    for (const [id, name, phone] of users) {
      await prisma.client.$executeRaw`
        INSERT INTO base.users (id, name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
        VALUES (${id}, ${name}, 'MALE', ${phone}, 'ACTIVE', ${id === adminId}, 'test-hash', NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
    }
    // 部门（闭包数据；department_closure 视图实时计算含自身）
    for (const [id, name] of [[deptA, '关口测试A部门'], [deptB, '关口测试B部门']] as Array<[number, string]>) {
      await prisma.client.$executeRaw`
        INSERT INTO hr.departments (id, name, status, created_at, updated_at)
        VALUES (${id}, ${name}, 'ACTIVE', NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
    }
    for (const [userId, deptId] of [[deptApproverId, deptA], [assetMaintainerId, deptA], [applicantId, deptA]] as Array<[number, number]>) {
      await prisma.client.$executeRaw`
        INSERT INTO hr.user_departments (user_id, department_id, created_by)
        VALUES (${userId}, ${deptId}, ${userId})
        ON CONFLICT (user_id, department_id) DO NOTHING
      `;
    }
    // 功能授权
    const grants: Array<[number, string, string]> = [
      [deptApproverId, 'consumable_approval', 'DEPARTMENT'],
      [inventoryManagerId, 'inventory_manage', 'COMPANY'],
      [assetMaintainerId, 'fixed_asset_maintain', 'DEPARTMENT'],
      [applicantId, 'consumable_apply', 'COMPANY'],
    ];
    for (const [userId, code, scope] of grants) {
      await prisma.client.$executeRaw`
        INSERT INTO backstage.employee_grants (user_id, function_code, data_scope, granted_by)
        VALUES (${userId}, ${code}, ${scope}::backstage."DataScope", ${adminId})
        ON CONFLICT DO NOTHING
      `;
    }
    // 分类：顶级分类复用系统内置（同名唯一索引冲突时保留既有行），一级子类使用测试段 id。
    // 幂等重跑：先清测试段残留（子分类引用测试段顶级分类时一并删除）
    await prisma.client.$executeRaw`DELETE FROM asset.asset_categories WHERE id IN (${BASE + 20}, ${BASE + 21}, ${BASE + 22}, ${BASE + 23})`;
    await prisma.client.$executeRaw`
      INSERT INTO asset.asset_categories (parent_id, name, sort, created_at, updated_at)
      VALUES (NULL, '固定资产', 0, NOW(), NOW()), (NULL, '消耗品', 1, NOW(), NOW())
      ON CONFLICT (COALESCE(parent_id, 0), name) DO NOTHING
    `;
    const topRows = await prisma.client.$queryRaw<Array<{ id: number; name: string }>>`
      SELECT id, name FROM asset.asset_categories
      WHERE parent_id IS NULL AND name IN ('固定资产', '消耗品')
    `;
    topFixedId = topRows.find((row) => row.name === '固定资产')!.id;
    topConsumableId = topRows.find((row) => row.name === '消耗品')!.id;
    await prisma.client.$executeRaw`
      INSERT INTO asset.asset_categories (id, parent_id, name, sort, created_at, updated_at)
      VALUES
        (${subFixedId}, ${topFixedId}, '测试设备', 0, NOW(), NOW()),
        (${subConsumableId}, ${topConsumableId}, '办公用品', 0, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    // 品种：REUSABLE（借还品）、DISPOSABLE（申领）与 M7 入库品（先建，条目 FK 引用）
    await prisma.client.$executeRaw`
      INSERT INTO asset.consumables (id, name, category_id, category_name, unit_name, type, quota_cycle, quota_limit, return_days, max_holding, safety_stock, status, created_at, updated_at)
      VALUES
        (${reusableId}, '关口测试借还品', ${subConsumableId}, '办公用品', '个', 'REUSABLE', NULL, NULL, 30, 10, 0, 'ACTIVE', NOW(), NOW()),
        (${disposableId}, '关口测试一次性品', ${subConsumableId}, '办公用品', '个', 'DISPOSABLE', 'MONTH', 10, NULL, NULL, 0, 'ACTIVE', NOW(), NOW()),
        (${consumableIdForStockIn}, '关口测试入库品', ${subConsumableId}, '办公用品', '个', 'DISPOSABLE', 'MONTH', 100, NULL, NULL, 0, 'ACTIVE', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    // 幂等重跑恢复：M7 用例可能把入库品改为停用，beforeAll 显式恢复启用
    await prisma.client.$executeRaw`
      UPDATE asset.consumables SET status = 'ACTIVE' WHERE id IN (${reusableId}, ${disposableId}, ${consumableIdForStockIn})
    `;
    // 库位与库存条目（账面 50）
    await prisma.client.$executeRaw`
      INSERT INTO asset.warehouses (id, name, status, created_at, updated_at)
      VALUES (${warehouseId}, '关口测试库位', 'ACTIVE', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    for (const itemId of [reusableItemId, disposableItemId, stockInItemId]) {
      await prisma.client.$executeRaw`
        INSERT INTO asset.inventory_items (id, consumable_id, spec, warehouse_id, warehouse_name, warehouse_path, book_qty, reserved_qty, created_at, updated_at)
        VALUES (${itemId}, ${itemId === stockInItemId ? consumableIdForStockIn : itemId === reusableItemId ? reusableId : disposableId}, '标准', ${warehouseId}, '关口测试库位', '关口测试库位', 50, 0, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
    }
    // 批次（H2 申领出库用；分两批以验证归还回到实际借出批次）
    await prisma.client.$executeRaw`
      INSERT INTO asset.batches (id, inventory_item_id, consumable_id, consumable_name, spec, warehouse_name, warehouse_path, remaining_qty, received_at, created_at, updated_at)
      VALUES
        (${reusableBatchFirstId}, ${reusableItemId}, ${reusableId}, '关口测试借还品', '标准', '关口测试库位', '关口测试库位', 1, NOW() - INTERVAL '2 days', NOW(), NOW()),
        (${reusableBatchSecondId}, ${reusableItemId}, ${reusableId}, '关口测试借还品', '标准', '关口测试库位', '关口测试库位', 49, NOW() - INTERVAL '1 day', NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET remaining_qty = EXCLUDED.remaining_qty, updated_at = NOW()
    `;
    // 资产（IN_USE / IDLE / deptB）
    await prisma.client.$executeRaw`
      INSERT INTO asset.assets (id, name, category_id, category_name, amount, usage_status, ownership, department_id, department_name, created_at, updated_at)
      VALUES
        (${assetInUseId}, '关口测试在用资产', ${subFixedId}, '测试设备', 100.00, 'IN_USE', 'COMPANY', ${deptA}, '关口测试A部门', NOW(), NOW()),
        (${assetIdleId}, '关口测试闲置资产', ${subFixedId}, '测试设备', 100.00, 'IDLE', 'COMPANY', ${deptA}, '关口测试A部门', NOW(), NOW()),
        (${assetDeptBId}, '关口测试B部门资产', ${subFixedId}, '测试设备', 100.00, 'IDLE', 'COMPANY', ${deptB}, '关口测试B部门', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    // 幂等重跑恢复：B 用例会软删除闲置资产，beforeAll 恢复（deleted_at 置空）
    await prisma.client.$executeRaw`
      UPDATE asset.assets SET deleted_at = NULL, deleted_by = NULL WHERE id IN (${assetInUseId}, ${assetIdleId}, ${assetDeptBId})
    `;
    // 维修单（deptA / deptB 各一张，均为 PENDING）
    await prisma.client.$executeRaw`
      INSERT INTO asset.repair_orders (id, asset_id, status, version, fault_description, reported_at, pre_status, created_at, updated_at)
      VALUES
        (${repairDeptAId}, ${assetInUseId}, 'PENDING', 1, 'A部门故障', NOW(), 'IN_USE', NOW(), NOW()),
        (${repairDeptBId}, ${assetDeptBId}, 'PENDING', 1, 'B部门故障', NOW(), 'IDLE', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    // 二维码（INVENTORY_ITEM / ASSET 各一）
    await prisma.client.$executeRaw`
      INSERT INTO asset.qr_codes (id, public_id, target_type, target_id, status, created_by, created_at, updated_at)
      VALUES
        (${qrItemId}, 'gate-qr-item-test-public-id', 'INVENTORY_ITEM', ${reusableItemId}, 'ACTIVE', ${adminId}, NOW(), NOW()),
        (${qrAssetId}, 'gate-qr-asset-test-public-id', 'ASSET', ${assetIdleId}, 'ACTIVE', ${adminId}, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    // 代领清单头 + 两条 AGENT 借还记录（一条本清单、一条外部清单，M1 用）
    await prisma.client.$executeRaw`
      INSERT INTO asset.approval_requests (id, application_no, request_type, applicant_id, applicant_name, applicant_department_snapshot, status, version, submitted_at, created_at, updated_at)
      VALUES (${agentReqId}, 'AS-GATE-0001', 'AGENT_REQUEST', ${applicantId}, '关口测试申请人', '[{"id": 1, "name": "占位"}]', 'APPROVED', 1, NOW(), NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await prisma.client.$executeRaw`
      INSERT INTO asset.borrow_records (id, record_type, agent_request_id, request_id, inventory_item_id, consumable_name, spec, warehouse_name, warehouse_path, qty, returned_qty, written_off_qty, borrowed_at, due_at, created_at)
      VALUES
        (${borrowAgentAId}, 'AGENT', ${agentReqId}, ${agentReqId}, ${reusableItemId}, '关口测试借还品', '标准', '关口测试库位', '关口测试库位', 5, 0, 0, NOW(), NOW() + INTERVAL '30 days', NOW()),
        (${borrowAgentBId}, 'AGENT', ${agentReqId + 999}, ${agentReqId + 999}, ${reusableItemId}, '关口测试借还品', '标准', '关口测试库位', '关口测试库位', 5, 0, 0, NOW(), NOW() + INTERVAL '30 days', NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    // Nest 测试容器装配（forwardRef 循环由容器解析）
    const moduleRef = await Test.createTestingModule({
      providers: [
        PrismaService,
        DepartmentClosureService,
        SettingsService,
        { provide: RedisService, useValue: { redis: null } },
        StockInService,
        StockChangeService,
        ClaimService,
        AgentClaimService,
        BorrowService,
        DisposalService,
        AgentSettlementService,
        AssetApprovalSideEffect,
        AssetApprovalService,
        QrService,
        DictService,
        CategoryService,
        WarehouseService,
        AssetService,
        RepairService,
        InventoryService,
        StockFlowService,
        ConsumableService,
      ],
      controllers: [InventoryController, ConsumableController],
    }).compile();
    approval = moduleRef.get(AssetApprovalService);
    borrow = moduleRef.get(BorrowService);
    disposal = moduleRef.get(DisposalService);
    claim = moduleRef.get(ClaimService);
    agentSettlement = moduleRef.get(AgentSettlementService);
    stockIn = moduleRef.get(StockInService);
    qr = moduleRef.get(QrService);
    dict = moduleRef.get(DictService);
    categoryService = moduleRef.get(CategoryService);
    warehouseService = moduleRef.get(WarehouseService);
    assetService = moduleRef.get(AssetService);
    inventoryController = moduleRef.get(InventoryController);
    consumableController = moduleRef.get(ConsumableController);
    repair = moduleRef.get(RepairService);
  });

  afterAll(async () => {
    const testUserIds = [adminId, deptApproverId, inventoryManagerId, assetMaintainerId, applicantId] as number[];
    // FK 依赖顺序：结清明细 → 审批动作 → 借还记录 → 申请头（Prisma 数组参数用 = ANY）
    await prisma.client.$executeRaw`
      DELETE FROM asset.agent_settlement_items asi
      USING asset.approval_requests ar
      WHERE asi.request_id = ar.id AND ar.applicant_id = ANY(${testUserIds})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM asset.approval_actions aa
      USING asset.approval_requests ar
      WHERE aa.request_id = ar.id AND ar.applicant_id = ANY(${testUserIds})
    `;
    await prisma.client.$executeRaw`
      DELETE FROM asset.stock_flows
      WHERE inventory_item_id IN (${reusableItemId}, ${disposableItemId}, ${stockInItemId})
    `;
    await prisma.client.$executeRaw`DELETE FROM asset.borrow_records WHERE id IN (${borrowAgentAId}, ${borrowAgentBId})`;
    await prisma.client.$executeRaw`
      DELETE FROM asset.approval_requests
      WHERE applicant_id = ANY(${testUserIds})
        OR id = ${agentReqId}
    `;
    await prisma.client.$executeRaw`DELETE FROM asset.qr_codes WHERE id IN (${qrItemId}, ${qrAssetId})`;
    await prisma.client.$executeRaw`DELETE FROM asset.repair_orders WHERE id IN (${repairDeptAId}, ${repairDeptBId})`;
    await prisma.client.$executeRaw`DELETE FROM asset.assets WHERE id IN (${assetInUseId}, ${assetIdleId}, ${assetDeptBId})`;
    await prisma.client.$executeRaw`DELETE FROM asset.batches WHERE inventory_item_id IN (${reusableItemId}, ${disposableItemId}, ${stockInItemId})`;
    await prisma.client.$executeRaw`DELETE FROM asset.inventory_items WHERE id IN (${reusableItemId}, ${disposableItemId}, ${stockInItemId})`;
    await prisma.client.$executeRaw`DELETE FROM asset.warehouses WHERE id = ${warehouseId}`;
    await prisma.client.$executeRaw`DELETE FROM asset.consumables WHERE id IN (${reusableId}, ${disposableId}, ${consumableIdForStockIn})`;
    // 顶级分类为系统内置（ensureDefaults 幂等管理），只清理测试子分类
    await prisma.client.$executeRaw`DELETE FROM asset.asset_categories WHERE id IN (${subFixedId}, ${subConsumableId})`;
    await prisma.client.$executeRaw`DELETE FROM backstage.employee_grants WHERE user_id IN (${deptApproverId}, ${inventoryManagerId}, ${assetMaintainerId}, ${applicantId})`;
    await prisma.client.$executeRaw`DELETE FROM hr.user_departments WHERE user_id IN (${deptApproverId}, ${assetMaintainerId}, ${applicantId})`;
    await prisma.client.$executeRaw`DELETE FROM hr.departments WHERE id IN (${deptA}, ${deptB})`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE id IN (${adminId}, ${deptApproverId}, ${inventoryManagerId}, ${assetMaintainerId}, ${applicantId})`;
    if (previousAssetStatus !== null) {
      await prisma.client.$executeRaw`
        UPDATE backstage.systems SET product_status = CAST(${previousAssetStatus} AS backstage."ProductStatus") WHERE code = 'ASSET'
      `;
    }
    await prisma.client.$disconnect();
  });

  it('② 字典种子：ensureDefaults 初始化 CHANGE_TYPE「其他意外扣减」', async () => {
    await dict.ensureDefaults();
    const row = await prisma.client.assetDictItem.findFirst({
      where: { dictType: 'CHANGE_TYPE', name: '其他意外扣减' },
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe('ACTIVE');
  });

  it('配置类删除预览（批次3-1）：被引用时返回逐目标引用数，确认后物理删除且名称快照保留', async () => {
    const operator = await loadAssetOperationLogOperator(prisma.client, inventoryManagerId);
    const tempCategoryId = BASE + 800;
    const tempItemId = BASE + 803;
    let createdCategoryId = -1;
    let createdWarehouseId = -1;
    let createdDictId = -1;
    try {
      // 分类：被品种引用时预览返回逐目标数字；确认删除物理成功；品种名称快照保留
      const category = await categoryService.create(operator, { parentId: topConsumableId, name: '批次3临时分类' });
      createdCategoryId = category.id;
      await prisma.client.$executeRaw`
        INSERT INTO asset.consumables (id, name, category_id, category_name, unit_name, type, quota_cycle, quota_limit, safety_stock, status, created_at, updated_at)
        VALUES (${tempCategoryId}, '批次3临时品种', ${category.id}, '批次3临时分类', '个', 'DISPOSABLE', 'MONTH', 10, 0, 'ACTIVE', NOW(), NOW())
      `;
      const categoryPreview = await categoryService.deletePreview([category.id]);
      expect(categoryPreview.items).toEqual([{ id: category.id, assetCount: 0, consumableCount: 1 }]);
      await categoryService.batchDelete(operator, [category.id]);
      const categorySnapshot = await prisma.client.consumable.findUnique({
        where: { id: tempCategoryId },
        select: { categoryId: true, categoryName: true },
      });
      expect(categorySnapshot).toEqual({ categoryId: category.id, categoryName: '批次3临时分类' });

      // 库位：被库存条目引用时预览三组数字；确认删除物理成功
      const warehouse = await warehouseService.create(operator, { name: '批次3临时库位' });
      createdWarehouseId = warehouse.id;
      await prisma.client.$executeRaw`
        INSERT INTO asset.inventory_items (id, consumable_id, spec, warehouse_id, warehouse_name, warehouse_path, book_qty, reserved_qty, created_at, updated_at)
        VALUES (${tempItemId}, ${tempCategoryId}, '标准', ${warehouse.id}, '批次3临时库位', '批次3临时库位', 5, 0, NOW(), NOW())
      `;
      const warehousePreview = await warehouseService.deletePreview([warehouse.id]);
      expect(warehousePreview.items).toEqual([
        { id: warehouse.id, inventoryItemCount: 1, borrowCount: 0, pendingCount: 0 },
      ]);
      await warehouseService.batchDelete(operator, [warehouse.id]);

      // 字典：无业务引用时预览 0；确认删除物理成功
      const dictItem = await dict.create(operator, { dictType: 'CHANGE_TYPE', name: '批次3临时变更类型' });
      createdDictId = dictItem.id;
      const dictPreview = await dict.deletePreview([dictItem.id]);
      expect(dictPreview.items).toEqual([{ id: dictItem.id, referencedCount: 0 }]);
      await dict.batchDelete(operator, [dictItem.id]);

      // 删除后目标不存在：预览返回 RESOURCE_NOT_FOUND（幂等删除不静默吞掉错误目标）
      await expect(categoryService.deletePreview([category.id])).rejects.toMatchObject({
        entry: { code: 'RESOURCE_NOT_FOUND' },
      });
    } finally {
      await prisma.client.$executeRaw`DELETE FROM asset.inventory_items WHERE id = ${tempItemId}`;
      await prisma.client.$executeRaw`DELETE FROM asset.consumables WHERE id = ${tempCategoryId}`;
      if (createdCategoryId >= 0) {
        await prisma.client.$executeRaw`DELETE FROM asset.asset_categories WHERE id = ${createdCategoryId}`;
      }
      if (createdWarehouseId >= 0) {
        await prisma.client.$executeRaw`DELETE FROM asset.warehouses WHERE id = ${createdWarehouseId}`;
      }
      if (createdDictId >= 0) {
        await prisma.client.$executeRaw`DELETE FROM asset.asset_dict_items WHERE id = ${createdDictId}`;
      }
    }
  });

  it('H2 借出批次追溯：申领批准后记录部门快照，并按原批次 LIFO 归还', async () => {
    const operator = await loadAssetOperationLogOperator(prisma.client, applicantId);
    const { requestId } = await claim.submit(operator, {
      items: [{ inventoryItemId: reusableItemId, qty: 3, purpose: '关口回归测试' }],
    });
    await approval.process(requestId, 'APPROVE', adminId);
    const rows = await prisma.client.$queryRaw<Array<{ id: number; department_snapshot: unknown }>>`
      SELECT id, department_snapshot FROM asset.borrow_records
      WHERE request_id = ${requestId} AND record_type = 'PERSONAL' LIMIT 1
    `;
    const recordId = rows[0]?.id;
    const snapshot = rows[0]?.department_snapshot as Array<{ id: number; name: string }> | null;
    expect(recordId).toBeDefined();
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot?.some((d) => d.id === deptA)).toBe(true);
    // 出库后条目保留（H1 修复：有未结清借还的条目不被清理）
    const item = await prisma.client.inventoryItem.findUnique({ where: { id: reusableItemId } });
    expect(item).not.toBeNull();
    const allocations = await prisma.client.borrowBatchAllocation.findMany({
      where: { borrowRecordId: recordId },
      orderBy: { id: 'asc' },
    });
    expect(allocations.map((allocation) => [allocation.batchId, allocation.issuedQty])).toEqual([
      [reusableBatchFirstId, 1],
      [reusableBatchSecondId, 2],
    ]);
    const returnFlowIds = await prisma.client.$transaction(async (tx) => {
      const record = await borrow.lockBorrowRecord(tx, recordId!);
      expect(record).not.toBeNull();
      return borrow.restoreRecord(tx, record!, 2, 'TEST_RETURN', requestId, adminId, '管理员');
    });
    const returnFlows = await prisma.client.stockFlow.findMany({ where: { id: { in: returnFlowIds } } });
    expect(returnFlows.map((flow) => flow.batchId)).toEqual([reusableBatchSecondId]);
    const restoredAllocations = await prisma.client.borrowBatchAllocation.findMany({
      where: { borrowRecordId: recordId },
      orderBy: { id: 'asc' },
    });
    expect(restoredAllocations.map((allocation) => allocation.returnedQty)).toEqual([0, 2]);
    // 清理借还记录（避免影响其他用例）
    await prisma.client.$executeRaw`DELETE FROM asset.borrow_records WHERE request_id = ${requestId}`;
  });

  it('L6 待处置范围：NULL 部门快照不可见；单对象/数组闭包内快照可见；闭包外部门不可见', async () => {
    // 部门闭包数据：deptApproverId ∈ deptA → closure = [deptA]
    // 待处置列表只展示已注销员工的未结清借还（whereSql: ua.status='DEACTIVATED'），
    // 故构造一名已注销员工并关联 4 条 PERSONAL 记录，快照形状四态：
    // NULL（修复前会经 jsonb_build_array(NULL) → [null] → array_length=1 错误放行，
    // L6 回归修复后应不可见）、单对象、数组[deptA]（闭包内）、数组[deptB]（闭包外）
    const [nullSnapshotId, singleSnapshotId, arrayInId, arrayOutId] = [BASE + 90, BASE + 91, BASE + 92, BASE + 93];
    const deactivatedUserId = BASE + 94;
    await prisma.client.$executeRaw`
      INSERT INTO base.users (id, name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES (${deactivatedUserId}, '关口测试已注销员工', 'MALE', '+8613900000906', 'DEACTIVATED', false, 'test-hash', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await prisma.client.$executeRaw`
      INSERT INTO asset.borrow_records
        (id, record_type, user_id, user_name, agent_request_id, request_id, inventory_item_id, consumable_name, spec,
         warehouse_name, warehouse_path, qty, returned_qty, written_off_qty, borrowed_at, due_at, created_at, department_snapshot)
      VALUES
        (${nullSnapshotId}, 'PERSONAL', ${deactivatedUserId}, '关口测试已注销员工', NULL, ${agentReqId}, ${reusableItemId}, 'L6空快照', '标准', '关口测试库位', '关口测试库位', 1, 0, 0, NOW(), NOW() + INTERVAL '30 days', NOW(), NULL),
        (${singleSnapshotId}, 'PERSONAL', ${deactivatedUserId}, '关口测试已注销员工', NULL, ${agentReqId}, ${reusableItemId}, 'L6单对象快照', '标准', '关口测试库位', '关口测试库位', 1, 0, 0, NOW(), NOW() + INTERVAL '30 days', NOW(), ${JSON.stringify({ id: deptA, name: '关口测试A部门' })}::jsonb),
        (${arrayInId}, 'PERSONAL', ${deactivatedUserId}, '关口测试已注销员工', NULL, ${agentReqId}, ${reusableItemId}, 'L6数组闭包内', '标准', '关口测试库位', '关口测试库位', 1, 0, 0, NOW(), NOW() + INTERVAL '30 days', NOW(), ${JSON.stringify([{ id: deptA, name: '关口测试A部门' }])}::jsonb),
        (${arrayOutId}, 'PERSONAL', ${deactivatedUserId}, '关口测试已注销员工', NULL, ${agentReqId}, ${reusableItemId}, 'L6数组闭包外', '标准', '关口测试库位', '关口测试库位', 1, 0, 0, NOW(), NOW() + INTERVAL '30 days', NOW(), ${JSON.stringify([{ id: deptB, name: '关口测试B部门' }])}::jsonb)
    `;
    try {
      const { items } = await disposal.listPending(deptApproverId, new DisposalQueryDto());
      const recordIds = (items as Array<{ record_id: number }>).map((row) => row.record_id);
      expect(recordIds).toContain(singleSnapshotId);
      expect(recordIds).toContain(arrayInId);
      expect(recordIds).not.toContain(nullSnapshotId);
      expect(recordIds).not.toContain(arrayOutId);
    } finally {
      // 清理（含失败路径，避免影响其他用例）
      await prisma.client.$executeRaw`
        DELETE FROM asset.borrow_records WHERE id IN (${nullSnapshotId}, ${singleSnapshotId}, ${arrayInId}, ${arrayOutId})
      `;
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${deactivatedUserId}`;
    }
  });

  it('新增关口：仅固定资产维护的部门档列表不会越权显示其他部门资产', async () => {
    const list = await assetService.list(assetMaintainerId, { page: 1, pageSize: 50 });
    const ids = list.items.map((item) => item.id);
    expect(ids).toContain(assetInUseId);
    expect(ids).not.toContain(assetDeptBId);
  });

  it('新增关口：申领权限可读取携带 inventoryItemId 的可用库存目录，不能读取完整库存台账', async () => {
    const catalog = await inventoryController.listItems(applicantId, { availableOnly: true, page: 1, pageSize: 50 }) as {
      data: Array<{ id: number; availableQty: number }>;
    };
    expect(catalog.data).toContainEqual(expect.objectContaining({ id: reusableItemId, availableQty: expect.any(Number) }));
    await expect(inventoryController.listItems(applicantId, { page: 1, pageSize: 50 })).rejects.toMatchObject({
      entry: { code: 'RESOURCE_NOT_FOUND' },
    });
    const summary = await consumableController.list(applicantId, { hasAvailableStock: true, page: 1, pageSize: 50 }) as {
      data: Array<{ id: number }>;
    };
    expect(summary.data).toContainEqual(expect.objectContaining({ id: reusableId }));
  });

  it('M1 代领结清夹带非本清单借还记录 → RESOURCE_NOT_FOUND', async () => {
    const operator = await loadAssetOperationLogOperator(prisma.client, applicantId);
    // borrowAgentBId 属于其他清单（agent_request_id 非 agentReqId）：整单拒绝且不泄露存在性
    await expect(
      agentSettlement.submit(operator, {
        refRequestId: agentReqId,
        items: [{ borrowRecordId: borrowAgentBId, method: 'RETURN', qty: 5 }],
      }),
    ).rejects.toMatchObject({ entry: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('M1 代领结清正常整单覆盖 → 提交成功', async () => {
    const operator = await loadAssetOperationLogOperator(prisma.client, applicantId);
    const result = await agentSettlement.submit(operator, {
      refRequestId: agentReqId,
      items: [{ borrowRecordId: borrowAgentAId, method: 'RETURN', qty: 5 }],
    });
    expect(result.requestId).toBeGreaterThan(0);
  });

  it('M7 停用品种的入库申请仍可批准（asset PRD §5）', async () => {
    const operator = await loadAssetOperationLogOperator(prisma.client, applicantId);
    const { requestId } = await stockIn.submit(operator, {
      items: [
        {
          consumableId: consumableIdForStockIn,
          spec: '标准',
          warehouseId,
          qty: 8,
        },
      ],
    });
    // 提交后停用品种
    await prisma.client.$executeRaw`
      UPDATE asset.consumables SET status = 'DISABLED' WHERE id = ${consumableIdForStockIn}
    `;
    // 修复后：批准不应再被 CONSUMABLE_DISABLED 拦截
    await expect(approval.process(requestId, 'APPROVE', adminId)).resolves.toBeUndefined();
    const batch = await prisma.client.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*) AS total FROM asset.batches WHERE consumable_id = ${consumableIdForStockIn}
    `;
    expect(Number(batch[0]?.total ?? 0)).toBeGreaterThan(0);
  });

  it('AGENT_REQUEST 归入「消耗品申领」筛选', async () => {
    const list = await approval.list(adminId, { page: 1, pageSize: 100, requestType: 'CONSUMABLE_REQUEST' });
    expect(list.items.some((item) => item.requestType === 'AGENT_REQUEST')).toBe(true);
  });

  it('M3 二维码 action 按目标类型隔离权限', async () => {
    const assetOnlyOperator = await loadAssetOperationLogOperator(prisma.client, assetMaintainerId);
    // 仅持固定资产维护：操作库存条目二维码 → 404
    await expect(qr.action(assetOnlyOperator, qrItemId, 'DISABLE')).rejects.toMatchObject({
      entry: { code: 'RESOURCE_NOT_FOUND' },
    });
    const inventoryOperator = await loadAssetOperationLogOperator(prisma.client, inventoryManagerId);
    await expect(qr.action(inventoryOperator, qrItemId, 'DISABLE')).resolves.toMatchObject({ ok: true });
    // 恢复状态便于其他用例
    await prisma.client.$executeRaw`UPDATE asset.qr_codes SET status = 'ACTIVE' WHERE id = ${qrItemId}`;
  });

  it('M4 二维码解析：无申领权限解析库存条目 → QR_INVALID', async () => {
    // deptApprover 仅有 consumable_approval（无 consumable_apply）
    await expect(qr.parse(deptApproverId, 'gate-qr-item-test-public-id')).rejects.toMatchObject({
      entry: { code: 'QR_INVALID' },
    });
    // 持申领权限可解析（applicant 有 consumable_apply）
    const parsed = await qr.parse(applicantId, 'gate-qr-item-test-public-id');
    expect(parsed.targetType).toBe('INVENTORY_ITEM');
  });

  it('L9 二维码解析：无任何资产功能解析申领目录 → QR_INVALID（与无效码同码不泄露）', async () => {
    const catalogQrId = BASE + 72;
    const catalogPublicId = 'gate-qr-catalog-test-public-id';
    await prisma.client.$executeRaw`
      INSERT INTO asset.qr_codes (id, public_id, target_type, target_id, status, created_by, created_at, updated_at)
      VALUES (${catalogQrId}, ${catalogPublicId}, 'SCAN_CATALOG', NULL, 'ACTIVE', ${adminId}, NOW(), NOW())
    `;
    try {
      // deptApprover 仅有 consumable_approval（不在任一资产功能内）→ QR_INVALID
      await expect(qr.parse(deptApproverId, catalogPublicId)).rejects.toMatchObject({
        entry: { code: 'QR_INVALID' },
      });
      // 持任一资产功能（applicant 有 consumable_apply）→ 正常解析
      const parsed = await qr.parse(applicantId, catalogPublicId);
      expect(parsed.targetType).toBe('SCAN_CATALOG');
    } finally {
      await prisma.client.$executeRaw`DELETE FROM asset.qr_codes WHERE id = ${catalogQrId}`;
    }
  });

  it('M6 固定资产归入消耗品分类 → VALIDATION_FAILED', async () => {
    const operator = await loadAssetOperationLogOperator(prisma.client, assetMaintainerId);
    await expect(
      assetService.create(operator, assetMaintainerId, {
        name: '关口测试错误分类资产',
        categoryId: subConsumableId,
        amount: '100.00',
        ownership: 'COMPANY',
        departmentId: deptA,
      }),
    ).rejects.toMatchObject({ entry: { code: 'VALIDATION_FAILED' } });
  });

  it('B 软删除：IN_USE 资产整批拒绝（ASSET_REFERENCED）', async () => {
    const operator = await loadAssetOperationLogOperator(prisma.client, assetMaintainerId);
    await expect(
      assetService.batchDelete(operator, assetMaintainerId, { ids: [assetInUseId] }),
    ).rejects.toMatchObject({ entry: { code: 'ASSET_REFERENCED' } });
    // 闲置资产可删（软删除）
    const result = await assetService.batchDelete(operator, assetMaintainerId, { ids: [assetIdleId] });
    expect(result.deleted).toBe(1);
  });

  it('M8 维修单列表 DEPARTMENT 闭包裁剪', async () => {
    const list = await repair.list(assetMaintainerId, { page: 1, pageSize: 50 });
    const ids = list.items.map((row) => (row as { id: number }).id);
    expect(ids).toContain(repairDeptAId);
    expect(ids).not.toContain(repairDeptBId);
  });
});
