import { forwardRef, Inject, Injectable } from '@nestjs/common';
import {
  BorrowHistoryQueryDto,
  BorrowReturnCreateDto,
  BorrowWriteOffCreateDto,
  BusinessException,
  MY_BORROW_FUNCTION_CODE,
  MyBorrowQueryDto,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { attachDeactivatedFlags } from '../../shared/deactivated-flag.util';
import { writeStockFlow, type InventoryItemLockRow } from '../../shared/inventory-core';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { AssetApprovalService } from '../approval/asset-approval.service';

/** 锁定后的借还记录行（含处置记录所需快照字段） */
export interface BorrowRecordLockRow {
  id: number;
  userId: number | null;
  userName: string | null;
  recordType: string;
  requestId: number;
  inventoryItemId: number;
  consumableName: string;
  spec: string;
  warehouseName: string;
  warehousePath: string;
  qty: number;
  returnedQty: number;
  writtenOffQty: number;
  /** 借出时部门快照（H2：借还记录创建时写入；处置记录保留快照数据源） */
  departmentSnapshot: Prisma.JsonValue | null;
}

/**
 * 借还、归还与核销服务（asset PRD §8；A-23/A-24）。
 *
 * - 归还/核销申请：可申请处理数量 = 未结清 − 待审批归还占用 − 待审批核销占用
 *   （派生值，无独立占用表；锁定借还记录后按公式计算）；批准把占用转换为已归还/
 *   已核销，驳回或取消时占用随 PENDING 终态自然消失（无数据回写）；
 * - 归还批准回库到原借出批次：批次分配在借出时持久化，按最后借出先归还恢复批次余量；
 * - 核销批准不回库；逾期只提示不阻止；到期后仍允许归还。
 */
@Injectable()
export class BorrowService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AssetApprovalService)) private readonly approval: AssetApprovalService,
  ) {}

  /**
   * 我的借还列表（本人档：本人借出；含本人作为受领人的代领共享清单只读视图）。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @returns items（个人借还）+ agentShared（受领的代领清单）+ total
   */
  async listMine(userId: number, query: MyBorrowQueryDto): Promise<{ items: unknown[]; agentShared: unknown[]; total: number }> {
    const whereSql = buildBorrowWhereSql({ userId, settlementStatus: query.settlementStatus, overdueOnly: query.overdueOnly, recordType: 'PERSONAL' });
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [totalRow, rows] = await Promise.all([
      this.prisma.client.$queryRawUnsafe<Array<{ total: bigint }>>(`SELECT COUNT(*)::bigint AS total FROM asset.borrow_records ${whereSql}`),
      this.prisma.client.$queryRawUnsafe<unknown[]>(
        `SELECT id, record_type, user_id, user_name, request_id, inventory_item_id, consumable_name, spec,
                warehouse_name, warehouse_path, qty, borrowed_at, due_at, returned_qty, written_off_qty, created_at
         FROM asset.borrow_records ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      ),
    ]);
    // 本人作为受领人的代领共享清单（只读且不计个人持有）
    const agentShared = await this.prisma.client.$queryRaw<unknown[]>`
      SELECT br.id, br.record_type, br.request_id, br.inventory_item_id, br.consumable_name, br.spec,
             br.warehouse_name, br.warehouse_path, br.qty, br.borrowed_at, br.due_at,
             br.returned_qty, br.written_off_qty, ar.applicant_name AS proxy_name
      FROM asset.borrow_records br
      INNER JOIN asset.approval_requests ar ON ar.id = br.agent_request_id
      WHERE br.record_type = 'AGENT'
        AND br.agent_request_id IN (
          SELECT request_id FROM asset.agent_recipients WHERE user_id = ${userId}
        )
      ORDER BY br.created_at DESC
    `;
    return { items: rows, agentShared, total: Number(totalRow[0]?.total ?? 0) };
  }

  /**
   * 提交归还申请（幂等；可申请数量公式校验；同一借还记录整单一次）。
   *
   * @param operator 操作人
   * @param dto 归还输入
   * @returns 审批头 id + 单号
   */
  async submitReturn(operator: AssetOperationLogOperator, dto: BorrowReturnCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    return this.submitBorrowAction(operator, 'RETURN', dto.items, dto.idempotencyKey);
  }

  /**
   * 提交核销申请（幂等；遗失/损坏核销不回库）。
   *
   * @param operator 操作人
   * @param dto 核销输入
   * @returns 审批头 id + 单号
   */
  async submitWriteOff(operator: AssetOperationLogOperator, dto: BorrowWriteOffCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    return this.submitBorrowAction(operator, 'WRITE_OFF', dto.items, dto.idempotencyKey);
  }

  /**
   * 归还批准副作用：锁定记录 → returned_qty += qty → 回库到原批次（ISSUE 流水段恢复）。
   *
   * @param tx 事务客户端
   * @param head 审批头（含处理人；流水操作人 = 真实审批处理人，L8）
   */
  async applyReturnApproved(
    tx: Prisma.TransactionClient,
    head: { id: number; applicantId: number; processorId: number | null; processorName: string | null },
  ): Promise<void> {
    const items = await tx.borrowActionItem.findMany({ where: { requestId: head.id }, orderBy: { id: 'asc' } });
    for (const item of items) {
      const record = await this.lockBorrowRecord(tx, item.borrowRecordId);
      if (!record) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      // 占用必须完整（提交时占用；此处不重复占用）
      if ((await this.availableActionQty(tx, record)) < item.qty) {
        throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
      }
      await this.restoreRecord(
        tx,
        record,
        item.qty,
        'RETURN',
        head.id,
        head.processorId ?? head.applicantId,
        head.processorName ?? '审批系统',
      );
    }
  }

  /**
   * 归还数量回库（供归还申请批准与代领结清/直接处置复用）：
   * 锁定记录 → returned_qty += qty → 按借出时持久化的批次分配逐段恢复批次与账面。
   *
   * @param tx 事务客户端
   * @param record 锁定后的借还记录
   * @param qty 归还数量（≤ 可申请数量）
   * @param refType 流水业务来源（RETURN / AGENT_SETTLEMENT / DIRECT_DISPOSAL）
   * @param refId 业务来源标识
   * @param operatorId 操作人 id
   * @param operatorName 操作人姓名（L8：真实处理人，不再硬编码"审批系统"）
   * @returns 本次写入的 RETURN 库存流水 ID，用于处置记录追溯
   * @throws STOCK_CONFLICT 数量超限/批次分配不足或批次归属异常
   */
  async restoreRecord(
    tx: Prisma.TransactionClient,
    record: BorrowRecordLockRow,
    qty: number,
    refType: string,
    refId: number,
    operatorId: number,
    operatorName: string,
  ): Promise<number[]> {
    if ((await this.availableActionQty(tx, record)) < qty) {
      throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
    }

    // 无锁定位分配行（仅预检归属；最终校验以锁后重读为准）。
    const peekAllocations = await tx.$queryRaw<
      Array<{
        id: number;
        batchId: number;
        issuedQty: number;
        returnedQty: number;
        inventoryItemId: number;
      }>
    >`
      SELECT
        ba.id,
        ba.batch_id AS "batchId",
        ba.issued_qty AS "issuedQty",
        ba.returned_qty AS "returnedQty",
        b.inventory_item_id AS "inventoryItemId"
      FROM asset.borrow_batch_allocations ba
      INNER JOIN asset.batches b ON b.id = ba.batch_id
      WHERE ba.borrow_record_id = ${record.id}
      ORDER BY ba.id DESC
    `;
    if (peekAllocations.length === 0 || peekAllocations.some((allocation) => allocation.inventoryItemId !== record.inventoryItemId)) {
      throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
    }

    // 锁序与全系统一致（M8 复核修复）：先锁库存条目，再锁批次行——
    // 原实现先锁批次（FOR UPDATE OF ba, b）再锁条目，与调拨/纠正
    // （无锁定位后按 id 升序一次性锁条目，再锁批次）反向，并发归还 × 调拨
    // 可成环 40P01。
    const itemRow = await this.lockInventoryItem(tx, record.inventoryItemId);
    if (!itemRow) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }

    // 锁后重读分配行与批次行（锁定份额防并发归还重复使用批次份额；最终校验以此为准）。
    const allocations = await tx.$queryRaw<
      Array<{
        id: number;
        batchId: number;
        issuedQty: number;
        returnedQty: number;
        inventoryItemId: number;
      }>
    >`
      SELECT
        ba.id,
        ba.batch_id AS "batchId",
        ba.issued_qty AS "issuedQty",
        ba.returned_qty AS "returnedQty",
        b.inventory_item_id AS "inventoryItemId"
      FROM asset.borrow_batch_allocations ba
      INNER JOIN asset.batches b ON b.id = ba.batch_id
      WHERE ba.borrow_record_id = ${record.id}
      ORDER BY ba.id DESC
      FOR UPDATE OF ba, b
    `;

    const allocatedQty = allocations.reduce((sum, allocation) => sum + allocation.issuedQty - allocation.returnedQty, 0);
    if (allocatedQty < qty || allocations.some((allocation) => allocation.inventoryItemId !== record.inventoryItemId)) {
      throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
    }

    let remaining = qty;
    let bookQty = itemRow.bookQty;
    const returnFlowIds: number[] = [];
    for (const allocation of allocations) {
      if (remaining <= 0) {
        break;
      }
      const availableQty = allocation.issuedQty - allocation.returnedQty;
      if (availableQty <= 0) {
        continue;
      }
      const take = Math.min(availableQty, remaining);
      await tx.borrowBatchAllocation.update({ where: { id: allocation.id }, data: { returnedQty: { increment: take } } });
      await tx.batch.update({ where: { id: allocation.batchId }, data: { remainingQty: { increment: take } } });
      await tx.inventoryItem.update({ where: { id: itemRow.id }, data: { bookQty: { increment: take } } });
      const flowId = await writeStockFlow(tx, {
        flowType: 'RETURN',
        direction: 'IN',
        item: itemRow,
        batchId: allocation.batchId,
        qty: take,
        bookBefore: bookQty,
        bookAfter: bookQty + take,
        refType,
        refId,
        operator: { id: operatorId, name: operatorName },
      });
      returnFlowIds.push(flowId);
      bookQty += take;
      remaining -= take;
    }
    if (remaining > 0) {
      throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
    }
    await tx.borrowRecord.update({
      where: { id: record.id },
      data: { returnedQty: { increment: qty } },
    });
    return returnFlowIds;
  }

  /**
   * 核销数量（供核销申请批准与代领结清/直接处置复用）：
   * 锁定记录 → written_off_qty += qty（不回库）。
   *
   * @param tx 事务客户端
   * @param record 锁定后的借还记录
   * @param qty 核销数量（≤ 可申请数量）
   */
  async writeOffRecord(tx: Prisma.TransactionClient, record: BorrowRecordLockRow, qty: number): Promise<void> {
    if ((await this.availableActionQty(tx, record)) < qty) {
      throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
    }
    await tx.borrowRecord.update({
      where: { id: record.id },
      data: { writtenOffQty: { increment: qty } },
    });
  }

  /**
   * 核销批准副作用：锁定记录 → written_off_qty += qty（不回库）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   */
  async applyWriteOffApproved(tx: Prisma.TransactionClient, head: { id: number }): Promise<void> {
    const items = await tx.borrowActionItem.findMany({ where: { requestId: head.id }, orderBy: { id: 'asc' } });
    for (const item of items) {
      const record = await this.lockBorrowRecord(tx, item.borrowRecordId);
      if (!record) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      await this.writeOffRecord(tx, record, item.qty);
    }
  }

  /**
   * 驳回/取消释放（归还/核销占用为派生值：PENDING 头消失即释放，无数据回写）。
   */
  async applyRelease(_tx: Prisma.TransactionClient, _head: { id: number }): Promise<void> {
    // no-op：可申请处理数量为派生计算，无独立占用表
  }

  /**
   * 借还历史（「借还历史记录」部门/公司档：按记录类型/借用人/代交人/受领人/部门/结清状态/逾期查询）。
   *
   * @param query 筛选
   * @param departmentIds 部门闭包（null = 不按部门过滤；DEPARTMENT 档由调用方解析）
   * @returns items + total
   */
  async listHistory(query: BorrowHistoryQueryDto, departmentIds?: ReadonlySet<number>): Promise<{ items: unknown[]; total: number }> {
    const whereSql = buildBorrowWhereSql({
      recordType: query.recordType,
      userId: query.userId,
      recipientId: query.recipientId,
      departmentId: query.departmentId,
      departmentIds,
      settlementStatus: query.settlementStatus,
      overdueOnly: query.overdueOnly,
      keyword: query.keyword,
    });
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [totalRow, rows] = await Promise.all([
      this.prisma.client.$queryRawUnsafe<Array<{ total: bigint }>>(`SELECT COUNT(*)::bigint AS total FROM asset.borrow_records ${whereSql}`),
      this.prisma.client.$queryRawUnsafe<unknown[]>(
        `SELECT id, record_type, user_id, user_name, request_id, agent_request_id, inventory_item_id,
                consumable_name, spec, warehouse_name, warehouse_path, qty, borrowed_at, due_at,
                returned_qty, written_off_qty, created_at
         FROM asset.borrow_records ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      ),
    ]);
    const items = rows as Array<Record<string, unknown>>;
    // 借还历史含已注销员工（M9）：补"已注销"标记（主 PRD §2.6）
    await attachDeactivatedFlags(this.prisma.client, items, 'userId', 'userDeactivated');
    return { items, total: Number(totalRow[0]?.total ?? 0) };
  }

  /**
   * 借还、归还与核销申请的通用提交（RETURN / WRITE_OFF）。
   *
   * @param operator 操作人
   * @param requestType 申请类型
   * @param items 明细行（borrowRecordId + qty + 类型/原因）
   */
  private async submitBorrowAction(
    operator: AssetOperationLogOperator,
    requestType: 'RETURN' | 'WRITE_OFF',
    items: Array<{ borrowRecordId: number; qty: number; writeOffType?: string; reason?: string }>,
    idempotencyKey?: string,
  ): Promise<{ requestId: number; applicationNo: string }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: MY_BORROW_FUNCTION_CODE,
      scope: `asset.borrow.${requestType.toLowerCase()}.submit`,
      idempotencyKey,
      fingerprint: fingerprintPayload({ requestType, items }),
      run: async (tx) => {
        // 同一借还记录整单只能一次（A-24 唯一索引兜底）
        const recordIds = items.map((item) => item.borrowRecordId);
        if (new Set(recordIds).size !== recordIds.length) {
          throw new BusinessException(inventoryErrors.ITEM_DUPLICATED);
        }
        const prepared: Array<{
          borrowRecordId: number;
          qty: number;
          writeOffType: 'LOST' | 'DAMAGED' | null;
          reason: string | null;
        }> = [];
        for (const item of items) {
          const record = await this.lockBorrowRecord(tx, item.borrowRecordId);
          if (!record || record.userId !== operator.id || record.recordType !== 'PERSONAL') {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
          // 可申请处理数量 = 未结清 − 待审批归还占用 − 待审批核销占用
          if ((await this.availableActionQty(tx, record)) < item.qty) {
            throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
          }
          prepared.push({
            borrowRecordId: item.borrowRecordId,
            qty: item.qty,
            writeOffType: requestType === 'WRITE_OFF' ? (item.writeOffType as 'LOST' | 'DAMAGED') : null,
            reason: item.reason ?? null,
          });
        }
        const head = await this.approval.createRequestHead(tx, {
          requestType,
          applicantId: operator.id,
          applicantName: operator.name,
          applicantDepartmentSnapshot: operator.departments as Prisma.InputJsonValue,
        });
        for (const line of prepared) {
          await tx.borrowActionItem.create({
            data: {
              requestId: head.id,
              borrowRecordId: line.borrowRecordId,
              qty: line.qty,
              writeOffType: line.writeOffType,
              reason: line.reason,
            },
          });
        }
        return {
          result: { requestId: head.id, applicationNo: head.applicationNo },
          actionType: 'CREATE' as const,
          summary: `提交了${requestType === 'RETURN' ? '归还' : '核销'}申请 ${head.applicationNo}（${prepared.length} 行）`,
        };
      },
    });
  }

  /** 锁定借还记录（FOR UPDATE；归还/核销/结清/处置复用） */
  async lockBorrowRecord(tx: Prisma.TransactionClient, recordId: number): Promise<BorrowRecordLockRow | null> {
    const rows = await tx.$queryRaw<BorrowRecordLockRow[]>`
      SELECT
        id,
        user_id AS "userId",
        user_name AS "userName",
        record_type AS "recordType",
        request_id AS "requestId",
        inventory_item_id AS "inventoryItemId",
        consumable_name AS "consumableName",
        spec,
        warehouse_name AS "warehouseName",
        warehouse_path AS "warehousePath",
        qty,
        returned_qty AS "returnedQty",
        written_off_qty AS "writtenOffQty",
        department_snapshot AS "departmentSnapshot"
      FROM asset.borrow_records
      WHERE id = ${recordId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /** 锁定库存条目（FOR UPDATE；用于归还回库） */
  private async lockInventoryItem(tx: Prisma.TransactionClient, itemId: number): Promise<InventoryItemLockRow | null> {
    const rows = await tx.$queryRaw<InventoryItemLockRow[]>`
      SELECT ii.id, ii.consumable_id AS "consumableId", c.name AS "consumableName", ii.spec,
             ii.warehouse_id AS "warehouseId", ii.warehouse_name AS "warehouseName",
             ii.warehouse_path AS "warehousePath", ii.book_qty AS "bookQty", ii.reserved_qty AS "reservedQty"
      FROM asset.inventory_items ii
      INNER JOIN asset.consumables c ON c.id = ii.consumable_id
      WHERE ii.id = ${itemId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /**
   * 可申请处理数量（派生计算）：未结清 − 该记录在 PENDING RETURN/WRITE_OFF 申请的占用。
   *
   * @param tx 事务客户端
   * @param record 锁定后的借还记录
   * @returns 可申请数量
   */
  private async availableActionQty(tx: Prisma.TransactionClient, record: BorrowRecordLockRow): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ occupied: bigint }>>`
      SELECT COALESCE(SUM(bai.qty), 0) AS occupied
      FROM asset.borrow_action_items bai
      INNER JOIN asset.approval_requests r ON r.id = bai.request_id
      WHERE bai.borrow_record_id = ${record.id}
        AND r.request_type IN ('RETURN', 'WRITE_OFF')
        AND r.status = 'PENDING'
    `;
    const occupied = Number(rows[0]?.occupied ?? 0);
    return record.qty - record.returnedQty - record.writtenOffQty - occupied;
  }
}

/** 借还记录查询条件（SQL 片段；只接受白名单参数；外层 FROM 必须为不带别名的 asset.borrow_records——EXISTS 子查询经 borrow_records.xxx 显式关联外层，未限定的列名会错误绑定到子查询表） */
export function buildBorrowWhereSql(options: {
  userId?: number;
  recipientId?: number;
  recordType?: 'PERSONAL' | 'AGENT';
  departmentId?: number;
  departmentIds?: ReadonlySet<number>;
  settlementStatus?: 'OPEN' | 'SETTLED';
  overdueOnly?: boolean;
  keyword?: string;
}): string {
  const clauses: string[] = [];
  if (options.recordType) {
    clauses.push(`record_type = '${options.recordType}'`);
  }
  if (options.userId !== undefined) {
    // userId 语义（borrow.dto.ts）：PERSONAL = 借用人（user_id）；
    // AGENT 记录 user_id 恒为 null，发起人存审批头 proxy_id（代交人）/applicant_id
    clauses.push(`(user_id = ${options.userId} OR (record_type = 'AGENT' AND EXISTS (
      SELECT 1 FROM asset.approval_requests ar
      WHERE ar.id = borrow_records.request_id AND (ar.proxy_id = ${options.userId} OR ar.applicant_id = ${options.userId})
    )))`);
  }
  if (options.recipientId !== undefined) {
    // 受领人筛选仅对 AGENT 记录生效（个人记录无受领人）：匹配代领申请的受领人名单
    clauses.push(`record_type = 'AGENT' AND EXISTS (
      SELECT 1 FROM asset.agent_recipients arp
      WHERE arp.request_id = borrow_records.request_id AND arp.user_id = ${options.recipientId}
    )`);
  }
  if (options.departmentId !== undefined) {
    // 借出时部门快照包含该部门（兼容数组与单对象形状，L6：单对象快照不再被 @> 数组匹配静默漏过）
    clauses.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(department_snapshot) = 'array' THEN department_snapshot
             ELSE jsonb_build_array(department_snapshot) END
      ) el WHERE el->>'id' = '${options.departmentId}'
    )`);
  }
  if (options.departmentIds !== undefined) {
    if (options.departmentIds.size === 0) {
      return 'WHERE 1 = 0';
    }
    const ids = [...options.departmentIds].join(',');
    // 快照兼容数组与单对象形状（L6）：jsonb_array_elements 直接作用于单对象快照会抛错，
    // 统一先 CASE 展开为数组；PERSONAL 按借出时部门快照匹配闭包；
    // AGENT 按发起人（审批头）或受领人名单快照匹配闭包
    clauses.push(`(
      (record_type = 'PERSONAL' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(department_snapshot) = 'array' THEN department_snapshot
               ELSE jsonb_build_array(department_snapshot) END
        ) el WHERE el->>'id' IN (${ids})
      ))
      OR (record_type = 'AGENT' AND (
        EXISTS (
          SELECT 1 FROM asset.approval_requests ar
          WHERE ar.id = borrow_records.request_id AND ar.applicant_department_snapshot IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(ar.applicant_department_snapshot) = 'array' THEN ar.applicant_department_snapshot
                     ELSE jsonb_build_array(ar.applicant_department_snapshot) END
              ) el WHERE el->>'id' IN (${ids})
            )
        )
        OR EXISTS (
          SELECT 1 FROM asset.agent_recipients arp
          WHERE arp.request_id = borrow_records.request_id
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(arp.department_snapshot) = 'array' THEN arp.department_snapshot
                     ELSE jsonb_build_array(arp.department_snapshot) END
              ) el WHERE el->>'id' IN (${ids})
            )
        )
      ))
    )`);
  }
  if (options.settlementStatus === 'OPEN') {
    clauses.push('(qty - returned_qty - written_off_qty) > 0');
  } else if (options.settlementStatus === 'SETTLED') {
    clauses.push('(qty - returned_qty - written_off_qty) = 0');
  }
  if (options.overdueOnly) {
    clauses.push("due_at < now() AND (qty - returned_qty - written_off_qty) > 0");
  }
  if (options.keyword) {
    // $queryRawUnsafe 字符串拼接：关键字内单引号必须转义（'' 为 SQL 字面量转义）
    const escaped = options.keyword.replace(/'/g, "''");
    clauses.push(`(consumable_name ILIKE '%${escaped}%' OR user_name ILIKE '%${escaped}%')`);
  }
  return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
}
