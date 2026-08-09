import { forwardRef, Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  STOCK_CHANGE_APPLY_FUNCTION_CODE,
  StockChangeRequestCreateDto,
  StockChangeRequestQueryDto,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { allocateFifoBatches, cleanupEmptyItem, lockInventoryItems, writeStockFlow } from '../../shared/inventory-core';
import { buildAssetApprovalRequestTableQuery } from '../../shared/table-query';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { AssetApprovalService } from '../approval/asset-approval.service';

/**
 * 库存变更申请服务（asset PRD §6；A-19）。
 *
 * - 仅处理非正常领用造成的意外库存扣减，MVP 不支持通过该功能增加库存；
 * - 清单式提交：同一库存条目整单只能出现一次；提交时按条目固定顺序锁定并在同一
 *   事务内校验可用库存、增加占用（reserved_qty），任一行非法整单不创建；
 * - 批准后按行按批次 FIFO 扣减并生成流水（不重复占用）；驳回/取消释放占用
 *   （与申请转终态同一事务）。
 */
@Injectable()
export class StockChangeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AssetApprovalService)) private readonly approval: AssetApprovalService,
  ) {}

  /**
   * 提交库存变更申请（幂等；整单全有或全无：任一行库存不足/重复/非法则整单不创建）。
   *
   * @param operator 操作人
   * @param dto 申请输入
   * @returns 审批头 id + 单号
   */
  async submit(operator: AssetOperationLogOperator, dto: StockChangeRequestCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: STOCK_CHANGE_APPLY_FUNCTION_CODE,
      scope: 'asset.stock-change.submit',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        // 行校验：同一库存条目整单只能一次（A-19 唯一索引兜底）
        const itemIds = dto.items.map((item) => item.inventoryItemId);
        if (new Set(itemIds).size !== itemIds.length) {
          throw new BusinessException(inventoryErrors.ITEM_DUPLICATED);
        }
        // 按 id 升序锁定全部目标条目，重算可用量并增加占用（整单原子）
        const locked = await lockInventoryItems(tx, itemIds);
        const lockedById = new Map(locked.map((row) => [row.id, row]));
        if (locked.length !== new Set(itemIds).size) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const lines: Array<{
          inventoryItemId: number;
          consumableName: string;
          spec: string;
          warehouseName: string;
          warehousePath: string;
          changeTypeId: number | null;
          changeTypeName: string | null;
          reason: string;
          qty: number;
        }> = [];
        const reservations: Array<{ id: number; qty: number }> = [];
        for (const item of dto.items) {
          const row = lockedById.get(item.inventoryItemId)!;
          if (row.bookQty - row.reservedQty < item.qty) {
            throw new BusinessException(inventoryErrors.INSUFFICIENT_STOCK);
          }
          // 变更类型必填（asset PRD §6；loadDictName 校验字典项存在）
          const changeType = await this.loadDictName(tx, item.changeTypeId, 'CHANGE_TYPE');
          lines.push({
            inventoryItemId: item.inventoryItemId,
            consumableName: row.consumableName,
            spec: row.spec,
            warehouseName: row.warehouseName,
            warehousePath: row.warehousePath,
            changeTypeId: changeType.id,
            changeTypeName: changeType.name,
            reason: item.reason,
            qty: item.qty,
          });
          reservations.push({ id: item.inventoryItemId, qty: item.qty });
        }
        // 增加占用（行已锁定，同一事务内）
        for (const reservation of reservations) {
          await tx.inventoryItem.update({
            where: { id: reservation.id },
            data: { reservedQty: { increment: reservation.qty } },
          });
        }
        const head = await this.approval.createRequestHead(tx, {
          requestType: 'STOCK_CHANGE',
          applicantId: operator.id,
          applicantName: operator.name,
          applicantDepartmentSnapshot: operator.departments as Prisma.InputJsonValue,
        });
        for (const line of lines) {
          await tx.stockChangeItem.create({
            data: {
              requestId: head.id,
              inventoryItemId: line.inventoryItemId,
              consumableName: line.consumableName,
              spec: line.spec,
              warehouseName: line.warehouseName,
              warehousePath: line.warehousePath,
              changeTypeId: line.changeTypeId,
              changeTypeName: line.changeTypeName,
              reason: line.reason,
              qty: line.qty,
              changedAt: dto.changedAt ? new Date(dto.changedAt) : new Date(),
            },
          });
        }
        return {
          result: { requestId: head.id, applicationNo: head.applicationNo },
          actionType: 'CREATE' as const,
          summary: `提交了库存变更申请 ${head.applicationNo}（${lines.length} 行）`,
        };
      },
    });
  }

  /**
   * 批准副作用：按行 FIFO 扣减批次与账面、释放占用、写 DEDUCTION 流水（不重复占用）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   */
  async applyApproved(tx: Prisma.TransactionClient, head: { id: number; applicantId: number }): Promise<void> {
    const lines = await tx.stockChangeItem.findMany({ where: { requestId: head.id }, orderBy: { id: 'asc' } });
    const itemIds = [...new Set(lines.map((line) => line.inventoryItemId))];
    const locked = await lockInventoryItems(tx, itemIds);
    const lockedById = new Map(locked.map((row) => [row.id, row]));
    for (const line of lines) {
      const row = lockedById.get(line.inventoryItemId);
      if (!row) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      // 占用必须完整（提交时占用，此处不得重复占用）
      if (row.reservedQty < line.qty) {
        throw new BusinessException(inventoryErrors.STOCK_CONFLICT);
      }
      const allocations = await allocateFifoBatches(tx, line.inventoryItemId, line.qty);
      await tx.inventoryItem.update({
        where: { id: line.inventoryItemId },
        data: { bookQty: { decrement: line.qty }, reservedQty: { decrement: line.qty } },
      });
      // 每段流水记录各自变动前后账面（按段累计）
      let before = row.bookQty;
      for (const allocation of allocations) {
        const after = before - allocation.qty;
        await writeStockFlow(tx, {
          flowType: 'DEDUCTION',
          direction: 'OUT',
          item: row,
          batchId: allocation.batchId,
          qty: allocation.qty,
          bookBefore: before,
          bookAfter: after,
          refType: 'STOCK_CHANGE',
          refId: head.id,
          operator: { id: head.applicantId, name: '审批系统' },
        });
        before = after;
      }
      // 空条目清理（条件删除：账面与占用均为 0 才删）
      await cleanupEmptyItem(tx, line.inventoryItemId);
    }
  }

  /**
   * 驳回/取消释放：按行减少条目占用（与终态同事务）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   */
  async applyRelease(tx: Prisma.TransactionClient, head: { id: number }): Promise<void> {
    const lines = await tx.stockChangeItem.findMany({ where: { requestId: head.id }, orderBy: { id: 'asc' } });
    for (const line of lines) {
      await tx.inventoryItem.updateMany({
        where: { id: line.inventoryItemId, reservedQty: { gte: line.qty } },
        data: { reservedQty: { decrement: line.qty } },
      });
    }
  }

  /**
   * 本人库存变更申请历史（随「库存变更申请」权限隐含提供）。
   *
   * @param operator 操作人
   * @param query 筛选
   * @returns items + total
   */
  async listMine(operator: AssetOperationLogOperator, query: StockChangeRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    return this.listByApplicant(operator.id, query);
  }

  /**
   * 范围库存变更申请历史（「库存变更申请历史记录」部门/公司档）。
   *
   * @param query 筛选
   * @param applicantIds 范围内申请人 id 集合（null = 不过滤）
   * @returns items + total
   */
  async listHistory(query: StockChangeRequestQueryDto, applicantIds?: ReadonlySet<number>): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = { requestType: 'STOCK_CHANGE' };
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

  /** 按申请人分页（本人历史） */
  private async listByApplicant(applicantId: number, query: StockChangeRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = { requestType: 'STOCK_CHANGE', applicantId };
    if (query.status) {
      where.status = query.status;
    }
    return this.paginate(where, query);
  }

  /** 分页查询 */
  private async paginate(where: Prisma.ApprovalRequestWhereInput, query: StockChangeRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    const tableQuery = buildAssetApprovalRequestTableQuery(query);
    const effectiveWhere: Prisma.ApprovalRequestWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.ApprovalRequestWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.approvalRequest.count({ where: effectiveWhere }),
      this.prisma.client.approvalRequest.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.ApprovalRequestOrderByWithRelationInput[] | undefined) ?? [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /** 加载字典项（类型校验） */
  private async loadDictName(
    tx: Prisma.TransactionClient,
    dictId: number,
    dictType: string,
  ): Promise<{ id: number; name: string }> {
    const row = await tx.assetDictItem.findFirst({
      where: { id: dictId, dictType: dictType as Prisma.AssetDictItemWhereInput['dictType'] },
      select: { id: true, name: true },
    });
    if (!row) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: `字典项不存在（${dictType}）` });
    }
    return row;
  }
}
