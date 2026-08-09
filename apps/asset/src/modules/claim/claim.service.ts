import { forwardRef, Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  CONSUMABLE_APPLY_FUNCTION_CODE,
  ConsumableRequestCreateDto,
  ConsumableRequestQueryDto,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { allocateFifoBatches, cleanupEmptyItem, lockInventoryItems, writeStockFlow } from '../../shared/inventory-core';
import { acquireQuotaAdvisoryLocks, computeCycleKey } from '../../shared/quota-period';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { SettingsService } from '../settings/settings.service';
import { AssetApprovalService } from '../approval/asset-approval.service';

/** 品种额度配置（提交时快照） */
export interface QuotaConfig {
  type: 'DISPOSABLE' | 'REUSABLE';
  quotaCycle: 'MONTH' | 'QUARTER' | 'YEAR' | null;
  quotaLimit: number | null;
  returnDays: number | null;
  maxHolding: number | null;
}

/** 申领行（已校验并携带快照） */
export interface ClaimLine {
  inventoryItemId: number;
  consumableId: number;
  consumableName: string;
  spec: string;
  warehouseName: string;
  warehousePath: string;
  qty: number;
  purpose: string | null;
}

/**
 * 普通消耗品申领服务（asset PRD §5/§7；A-20/A-22）。
 *
 * - 提交：库存占用 + 个人额度占用原子（同一事务）；按条目 id 升序锁定，任一不足
 *   整单失败且不产生任何占用；额度按「员工 + 品种 + 当前周期」校验并用事务级
 *   咨询锁串行化并发提交；额度配置与所属周期在提交时形成快照持久化（不只在 Redis）；
 * - 一次性用品：已批准使用量 + 待审批占用量 + 本次 ≤ 周期上限（周期键按北京时间
 *   + 申领上限重置日计算，以提交时间归属）；
 * - 借还用品：当前未结清持有量 + 待审批占用量 + 本次 ≤ 同时持有上限；
 * - 批准：把待审批占用转换为出库（FIFO）+ 额度 CONSUMED + 借还记录生成，不重复计算；
 * - 驳回/取消：占用与终态同一事务释放。
 */
@Injectable()
export class ClaimService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AssetApprovalService)) private readonly approval: AssetApprovalService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 提交普通申领（幂等；整单全有或全无）。
   *
   * @param operator 操作人
   * @param dto 申领输入
   * @returns 审批头 id + 单号
   */
  async submit(operator: AssetOperationLogOperator, dto: ConsumableRequestCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: CONSUMABLE_APPLY_FUNCTION_CODE,
      scope: 'asset.claim.submit',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        // 行去重（同一库存条目整单只能一次，A-20 唯一索引兜底）
        const itemIds = dto.items.map((item) => item.inventoryItemId);
        if (new Set(itemIds).size !== itemIds.length) {
          throw new BusinessException(inventoryErrors.ITEM_DUPLICATED);
        }
        // 按 id 升序锁定全部目标条目（整单原子）
        const locked = await lockInventoryItems(tx, itemIds);
        if (locked.length !== itemIds.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const lockedById = new Map(locked.map((row) => [row.id, row]));
        // 校验可用量并准备行快照（整单校验全部通过才写入）
        const lines: ClaimLine[] = [];
        const quotaKeys: string[] = [];
        const quotaChecks: Array<{ key: string; consumableId: number; config: QuotaConfig; cycleKey: string | null; claimed: number }> = [];
        const resetDay = await this.settings.getQuotaResetDay();
        const now = new Date();
        for (const item of dto.items) {
          const row = lockedById.get(item.inventoryItemId)!;
          if (row.bookQty - row.reservedQty < item.qty) {
            throw new BusinessException(inventoryErrors.INSUFFICIENT_STOCK);
          }
          const consumable = await tx.consumable.findUnique({
            where: { id: row.consumableId },
            select: { name: true, type: true, quotaCycle: true, quotaLimit: true, returnDays: true, maxHolding: true, status: true },
          });
          if (!consumable || consumable.status !== 'ACTIVE') {
            throw new BusinessException(inventoryErrors.CONSUMABLE_DISABLED);
          }
          lines.push({
            inventoryItemId: item.inventoryItemId,
            consumableId: row.consumableId,
            consumableName: consumable.name,
            spec: row.spec,
            warehouseName: row.warehouseName,
            warehousePath: row.warehousePath,
            qty: item.qty,
            purpose: item.purpose,
          });
          // 额度键与校验快照（咨询锁按固定顺序；一次性按周期键、借还按持有键）
          const config: QuotaConfig = {
            type: consumable.type,
            quotaCycle: consumable.quotaCycle,
            quotaLimit: consumable.quotaLimit,
            returnDays: consumable.returnDays,
            maxHolding: consumable.maxHolding,
          };
          if (config.type === 'DISPOSABLE') {
            const cycleKey = computeCycleKey(now, config.quotaCycle!, resetDay);
            quotaKeys.push(`asset.quota.${operator.id}.${row.consumableId}.${cycleKey}`);
            quotaChecks.push({ key: `asset.quota.${operator.id}.${row.consumableId}.${cycleKey}`, consumableId: row.consumableId, config, cycleKey, claimed: item.qty });
          } else {
            quotaKeys.push(`asset.quota.${operator.id}.${row.consumableId}.holding`);
            quotaChecks.push({ key: `asset.quota.${operator.id}.${row.consumableId}.holding`, consumableId: row.consumableId, config, cycleKey: null, claimed: item.qty });
          }
        }
        // 额度校验（咨询锁串行化；同一品种多行合并后校验）
        await acquireQuotaAdvisoryLocks(tx, quotaKeys);
        const merged = new Map<string, { consumableId: number; config: QuotaConfig; cycleKey: string | null; claimed: number }>();
        for (const check of quotaChecks) {
          const existing = merged.get(check.key);
          if (existing) {
            existing.claimed += check.claimed;
          } else {
            merged.set(check.key, { consumableId: check.consumableId, config: check.config, cycleKey: check.cycleKey, claimed: check.claimed });
          }
        }
        for (const check of merged.values()) {
          await this.assertQuota(tx, operator.id, check);
        }
        // 全部通过：增加库存占用 + 写审批头 + 明细 + 额度占用
        for (const line of lines) {
          await tx.inventoryItem.update({
            where: { id: line.inventoryItemId },
            data: { reservedQty: { increment: line.qty } },
          });
        }
        const head = await this.approval.createRequestHead(tx, {
          requestType: 'CONSUMABLE_REQUEST',
          applicantId: operator.id,
          applicantName: operator.name,
          applicantDepartmentSnapshot: operator.departments as Prisma.InputJsonValue,
        });
        for (const line of lines) {
          await tx.consumableRequestItem.create({
            data: {
              requestId: head.id,
              inventoryItemId: line.inventoryItemId,
              consumableName: line.consumableName,
              spec: line.spec,
              warehouseName: line.warehouseName,
              warehousePath: line.warehousePath,
              qty: line.qty,
              purpose: line.purpose,
            },
          });
        }
        for (const check of merged.values()) {
          if (check.config.type === 'DISPOSABLE') {
            await tx.quotaOccupation.create({
              data: {
                userId: operator.id,
                consumableId: check.consumableId,
                consumableName: lines.find((line) => line.consumableId === check.consumableId)?.consumableName ?? '',
                quotaType: 'DISPOSABLE_CYCLE',
                cycle: check.config.quotaCycle,
                cycleKey: check.cycleKey,
                requestId: head.id,
                qty: check.claimed,
                status: 'RESERVED',
              },
            });
          } else {
            await tx.quotaOccupation.create({
              data: {
                userId: operator.id,
                consumableId: check.consumableId,
                consumableName: lines.find((line) => line.consumableId === check.consumableId)?.consumableName ?? '',
                quotaType: 'REUSABLE_HOLDING',
                cycle: null,
                cycleKey: null,
                requestId: head.id,
                qty: check.claimed,
                status: 'RESERVED',
              },
            });
          }
        }
        return {
          result: { requestId: head.id, applicationNo: head.applicationNo },
          actionType: 'CREATE' as const,
          summary: `提交了消耗品申领 ${head.applicationNo}（${lines.length} 行）`,
        };
      },
    });
  }

  /**
   * 批准副作用：占用转出库（FIFO）+ 额度 CONSUMED + 借还记录生成（不重复占用/计算）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   * @param processorId 处理人
   */
  async applyApproved(
    tx: Prisma.TransactionClient,
    head: { id: number; applicantId: number; applicantName: string; applicantDepartmentSnapshot: Prisma.JsonValue | null },
    processorId: number,
  ): Promise<void> {
    const lines = await tx.consumableRequestItem.findMany({ where: { requestId: head.id }, orderBy: { id: 'asc' } });
    const itemIds = [...new Set(lines.map((line) => line.inventoryItemId))];
    const locked = await lockInventoryItems(tx, itemIds);
    const lockedById = new Map(locked.map((row) => [row.id, row]));
    for (const line of lines) {
      const row = lockedById.get(line.inventoryItemId);
      if (!row) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      // 占用必须完整（提交时占用，此处不重复占用）
      if (row.reservedQty < line.qty) {
        throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
      }
      const allocations = await allocateFifoBatches(tx, line.inventoryItemId, line.qty);
      await tx.inventoryItem.update({
        where: { id: line.inventoryItemId },
        data: { bookQty: { decrement: line.qty }, reservedQty: { decrement: line.qty } },
      });
      let before = row.bookQty;
      for (const allocation of allocations) {
        const after = before - allocation.qty;
        await writeStockFlow(tx, {
          flowType: 'ISSUE',
          direction: 'OUT',
          item: row,
          batchId: allocation.batchId,
          qty: allocation.qty,
          bookBefore: before,
          bookAfter: after,
          refType: 'CONSUMABLE_REQUEST',
          refId: head.id,
          operator: { id: processorId, name: '审批系统' },
        });
        before = after;
      }
      // 借还用品：出库即生成个人借还记录（due_at = 出库时间 + 归还期限快照）
      const consumable = await tx.consumable.findUnique({ where: { id: row.consumableId }, select: { type: true, returnDays: true } });
      if (consumable?.type === 'REUSABLE') {
        const borrowedAt = new Date();
        // 到期时间 = 出库时间 + 归还期限快照（与出库时间同源，避免独立取时偏差）
        const dueAt = new Date(borrowedAt.getTime() + (consumable.returnDays ?? 0) * 24 * 60 * 60 * 1000);
        await tx.borrowRecord.create({
          data: {
            recordType: 'PERSONAL',
            userId: head.applicantId,
            userName: head.applicantName,
                        requestId: head.id,
            inventoryItemId: line.inventoryItemId,
            consumableName: line.consumableName,
            spec: line.spec,
            warehouseName: line.warehouseName,
            warehousePath: line.warehousePath,
            qty: line.qty,
            borrowedAt,
            dueAt,
            // 借出时部门快照（申请人提交时快照；部门档审批闭包/注销处置数据范围数据源）
            departmentSnapshot: head.applicantDepartmentSnapshot ?? Prisma.JsonNull,
          },
        });
      }
      await cleanupEmptyItem(tx, line.inventoryItemId);
    }
    // 额度占用 RESERVED → CONSUMED（不按当前额度配置重复计算）
    await tx.quotaOccupation.updateMany({
      where: { requestId: head.id, status: 'RESERVED' },
      data: { status: 'CONSUMED' },
    });
  }

  /**
   * 驳回/取消释放：库存占用 + 额度占用（与终态同一事务）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   */
  async applyRelease(tx: Prisma.TransactionClient, head: { id: number }): Promise<void> {
    const lines = await tx.consumableRequestItem.findMany({ where: { requestId: head.id }, orderBy: { id: 'asc' } });
    for (const line of lines) {
      await tx.inventoryItem.updateMany({
        where: { id: line.inventoryItemId, reservedQty: { gte: line.qty } },
        data: { reservedQty: { decrement: line.qty } },
      });
    }
    await tx.quotaOccupation.updateMany({
      where: { requestId: head.id, status: 'RESERVED' },
      data: { status: 'RELEASED' },
    });
  }

  /**
   * 本人申领历史（随「消耗品申领」权限隐含提供）。
   *
   * @param operator 操作人
   * @param query 筛选
   * @returns items + total
   */
  async listMine(operator: AssetOperationLogOperator, query: ConsumableRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = {
      requestType: 'CONSUMABLE_REQUEST',
      applicantId: operator.id,
    };
    if (query.status) {
      where.status = query.status;
    }
    return this.paginate(where, query);
  }

  /**
   * 范围申领历史（「消耗品申领历史记录」部门/公司档）。
   *
   * @param query 筛选
   * @param applicantIds 范围内申请人 id 集合（null = 不过滤）
   * @returns items + total
   */
  async listHistory(query: ConsumableRequestQueryDto, applicantIds?: ReadonlySet<number>): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = { requestType: 'CONSUMABLE_REQUEST' };
    if (query.status) {
      where.status = query.status;
    }
    if (query.applicantName) {
      where.applicantName = { contains: query.applicantName };
    }
    if (applicantIds !== undefined) {
      if (applicantIds.size === 0) {
        return { items: [], total: 0 };
      }
      where.applicantId = { in: [...applicantIds] };
    }
    return this.paginate(where, query);
  }

  /** 分页查询 */
  private async paginate(where: Prisma.ApprovalRequestWhereInput, query: ConsumableRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.approvalRequest.count({ where }),
      this.prisma.client.approvalRequest.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /**
   * 额度校验（咨询锁已持有；提交时快照）。
   *
   * @param tx 事务客户端
   * @param userId 员工
   * @param check 额度校验项
   * @throws INSUFFICIENT_QUOTA 超限
   */
  private async assertQuota(
    tx: Prisma.TransactionClient,
    userId: number,
    check: { consumableId: number; config: QuotaConfig; cycleKey: string | null; claimed: number },
  ): Promise<void> {
    const { config, claimed } = check;
    if (config.type === 'DISPOSABLE') {
      const rows = await tx.$queryRaw<Array<{ used: bigint }>>`
        SELECT COALESCE(SUM(qty), 0) AS used
        FROM asset.quota_occupations
        WHERE user_id = ${userId}
          AND consumable_id = ${check.consumableId}
          AND cycle_key = ${check.cycleKey}
          AND status IN ('RESERVED', 'CONSUMED')
      `;
      const used = Number(rows[0]?.used ?? 0);
      if (used + claimed > (config.quotaLimit ?? 0)) {
        throw new BusinessException(inventoryErrors.INSUFFICIENT_QUOTA);
      }
    } else {
      // 借还用品：当前未结清持有量（借还记录）+ 待审批占用量 + 本次 ≤ 同时持有上限
      const rows = await tx.$queryRaw<Array<{ holding: bigint; reserved: bigint }>>`
        SELECT
          COALESCE((SELECT SUM(br.qty - br.returned_qty - br.written_off_qty)
            FROM asset.borrow_records br
            INNER JOIN asset.inventory_items ii ON ii.id = br.inventory_item_id
            WHERE br.user_id = ${userId}
              AND br.record_type = 'PERSONAL'
              AND ii.consumable_id = ${check.consumableId}), 0) AS holding,
          COALESCE((SELECT SUM(qo.qty)
            FROM asset.quota_occupations qo
            WHERE qo.user_id = ${userId}
              AND qo.consumable_id = ${check.consumableId}
              AND qo.quota_type = 'REUSABLE_HOLDING'
              AND qo.status = 'RESERVED'), 0) AS reserved
      `;
      const holding = Number(rows[0]?.holding ?? 0);
      const reserved = Number(rows[0]?.reserved ?? 0);
      if (holding + reserved + claimed > (config.maxHolding ?? 0)) {
        throw new BusinessException(inventoryErrors.INSUFFICIENT_QUOTA);
      }
    }
  }
}
