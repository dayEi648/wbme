import { forwardRef, Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  STOCK_IN_APPLY_FUNCTION_CODE,
  StockInRequestCreateDto,
  StockInRequestQueryDto,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { attachDeactivatedFlags } from '../../shared/deactivated-flag.util';
import { loadWarehouseWithPath, lockInventoryItems, lockOrCreateItem, writeStockFlow } from '../../shared/inventory-core';
import { buildAssetApprovalRequestTableQuery } from '../../shared/table-query';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { AssetApprovalService } from '../approval/asset-approval.service';

/**
 * 入库申请服务（asset PRD §6；A-18）。
 *
 * - 清单式提交：一张申请可含多行（品种 + 供应商/品牌/规格/库位 + 数量 + 可选单价），
 *   整单进入审批（整单批准或驳回）；提交不占用库存；
 * - 批准后按行形成批次（received_at = 整单申请时间快照）、增加库存并生成入库流水；
 * - 入库仅增：MVP 不支持通过入库减少库存；驳回/取消无占用可释放（applyRelease no-op）。
 */
@Injectable()
export class StockInService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AssetApprovalService)) private readonly approval: AssetApprovalService,
  ) {}

  /**
   * 提交入库申请（幂等；整单创建，任一行非法整单不创建）。
   *
   * @param operator 操作人
   * @param dto 申请输入
   * @returns 审批头 id + 单号
   */
  async submit(operator: AssetOperationLogOperator, dto: StockInRequestCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: STOCK_IN_APPLY_FUNCTION_CODE,
      scope: 'asset.stock-in.submit',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        const prepared = await this.prepareLines(tx, dto);
        const deptSnapshot = operator.departments as Prisma.InputJsonValue;
        const head = await this.approval.createRequestHead(tx, {
          requestType: 'STOCK_IN',
          applicantId: operator.id,
          applicantName: operator.name,
          applicantDepartmentSnapshot: deptSnapshot,
        });
        const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
        for (const line of prepared) {
          await tx.stockInItem.create({
            data: {
              requestId: head.id,
              consumableId: line.consumableId,
              consumableName: line.consumableName,
              supplierId: line.supplierId,
              supplierName: line.supplierName,
              brandId: line.brandId,
              brandName: line.brandName,
              spec: line.spec,
              warehouseId: line.warehouseId,
              warehouseName: line.warehouseName,
              warehousePath: line.warehousePath,
              qty: line.qty,
              unitPrice: line.unitPrice ? new Prisma.Decimal(line.unitPrice) : null,
              receivedAt,
            },
          });
        }
        return {
          result: { requestId: head.id, applicationNo: head.applicationNo },
          actionType: 'CREATE' as const,
          summary: `提交了入库申请 ${head.applicationNo}（${prepared.length} 行）`,
        };
      },
    });
  }

  /**
   * 批准副作用（审批 process 事务内调用；失败整体回滚、申请保持 PENDING）。
   * 逐行校验品种启用 → 条目 upsert → 建批次 → 增账面 → 入库流水。
   *
   * @param tx 事务客户端
   * @param head 审批头（含申请人）
   */
  async applyApproved(tx: Prisma.TransactionClient, head: { id: number }, processorId: number): Promise<void> {
    const lines = await tx.stockInItem.findMany({ where: { requestId: head.id }, orderBy: { id: 'asc' } });
    if (lines.length === 0) {
      return;
    }
    // 整单条目按 id 升序一次性锁定（M8 复核修复：原实现逐行 lockOrCreateItem，两单行序
    // 交错时交叉加锁成环死锁 40P01）：先无锁批量定位已存在条目（IS NOT DISTINCT FROM
    // 处理可空库位），升序锁后逐行建批次；不存在条目在锁后创建（P2002 重试锁读，
    // 新行 id 恒大于旧行，不影响已锁集合的升序）
    const existing = await tx.$queryRaw<Array<{ id: number; consumable_id: number; spec: string; warehouse_id: number | null }>>(
      Prisma.sql`
        SELECT id, consumable_id, spec, warehouse_id
        FROM asset.inventory_items
        WHERE ${Prisma.join(
          lines.map(
            (line) =>
              Prisma.sql`(consumable_id = ${line.consumableId} AND spec = ${line.spec} AND warehouse_id IS NOT DISTINCT FROM ${line.warehouseId})`,
          ),
          ' OR ',
        )}
      `,
    );
    const locked =
      existing.length > 0 ? await lockInventoryItems(tx, existing.map((row) => row.id)) : [];
    const lockedById = new Map(locked.map((row) => [row.id, row]));
    for (const line of lines) {
      // 注意：批准时不再校验品种启用状态——停用前已提交的申请仍可批准（asset PRD §5）；
      // 品种状态只约束新提交（submit 已校验 ACTIVE）
      // 已存在条目取锁后行（含当前账面）；锁不到（并发清空删除）或不存在则创建
      const match = existing.find(
        (row) =>
          row.consumable_id === line.consumableId &&
          row.spec === line.spec &&
          row.warehouse_id === line.warehouseId,
      );
      const lockedRow = match ? lockedById.get(match.id) : undefined;
      const item = lockedRow
        ? { id: lockedRow.id, bookQty: lockedRow.bookQty }
        : await lockOrCreateItem(tx, {
            consumableId: line.consumableId,
            spec: line.spec,
            warehouseId: line.warehouseId,
            warehouseName: line.warehouseName,
            warehousePath: line.warehousePath,
          });
      await tx.batch.create({
        data: {
          inventoryItemId: item.id,
          consumableId: line.consumableId,
          consumableName: line.consumableName,
          spec: line.spec,
          warehouseName: line.warehouseName,
          warehousePath: line.warehousePath,
          supplierId: line.supplierId,
          supplierName: line.supplierName,
          brandId: line.brandId,
          brandName: line.brandName,
          unitPrice: line.unitPrice,
          receivedAt: line.receivedAt,
          remainingQty: line.qty,
        },
      });
      await tx.inventoryItem.update({
        where: { id: item.id },
        data: { bookQty: { increment: line.qty } },
      });
      await writeStockFlow(tx, {
        flowType: 'STOCK_IN',
        direction: 'IN',
        item: {
          id: item.id,
          consumableId: line.consumableId,
          consumableName: line.consumableName,
          spec: line.spec,
          warehouseId: line.warehouseId,
          warehouseName: line.warehouseName,
          warehousePath: line.warehousePath,
          bookQty: item.bookQty,
          reservedQty: 0,
        },
        batchId: null,
        qty: line.qty,
        bookBefore: item.bookQty,
        bookAfter: item.bookQty + line.qty,
        refType: 'STOCK_IN',
        refId: head.id,
        operator: { id: processorId, name: '审批系统' },
      });
    }
  }

  /**
   * 驳回/取消释放（入库提交不占用库存；结构性 no-op）。
   */
  async applyRelease(_tx: Prisma.TransactionClient, _head: { id: number }): Promise<void> {
    // no-op：入库申请无库存/额度占用
  }

  /**
   * 本人入库申请历史（随「入库申请」权限隐含提供）。
   *
   * @param operator 操作人
   * @param query 筛选
   * @returns items + total
   */
  async listMine(operator: AssetOperationLogOperator, query: StockInRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    return this.listByApplicant(operator.id, query);
  }

  /**
   * 范围入库申请历史（「入库申请历史记录」部门/公司档；按申请人姓名筛选）。
   *
   * @param query 筛选
   * @param applicantIds 范围内申请人 id 集合（DEPARTMENT 闭包/COMPANY；null = 不过滤）
   * @returns items + total
   */
  async listHistory(query: StockInRequestQueryDto, applicantIds?: ReadonlySet<number>): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = { requestType: 'STOCK_IN' };
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
    const result = await this.paginate(where, query);
    // 范围历史含已注销员工（M9）：补"已注销"标记（主 PRD §2.6）
    await attachDeactivatedFlags(this.prisma.client, result.items as Array<Record<string, unknown>>, 'applicantId', 'applicantDeactivated');
    return result;
  }

  /** 按申请人分页（本人历史） */
  private async listByApplicant(applicantId: number, query: StockInRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = { requestType: 'STOCK_IN', applicantId };
    if (query.status) {
      where.status = query.status;
    }
    return this.paginate(where, query);
  }

  /** 分页查询（含明细行数） */
  private async paginate(where: Prisma.ApprovalRequestWhereInput, query: StockInRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
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

  /**
   * 校验并准备入库行（品种启用、库位启用、同品种+规格+库位整单去重）。
   *
   * @param tx 事务客户端
   * @param dto 申请输入
   * @returns 已快照的入库行
   * @throws VALIDATION_FAILED 任一非法；ITEM_DUPLICATED 行重复
   */
  private async prepareLines(
    tx: Prisma.TransactionClient,
    dto: StockInRequestCreateDto,
  ): Promise<
    Array<{
      consumableId: number;
      consumableName: string;
      supplierId: number | null;
      supplierName: string | null;
      brandId: number | null;
      brandName: string | null;
      spec: string;
      warehouseId: number;
      warehouseName: string;
      warehousePath: string;
      qty: number;
      unitPrice?: string;
    }>
  > {
    const seen = new Set<string>();
    const lines: Array<{
      consumableId: number;
      consumableName: string;
      supplierId: number | null;
      supplierName: string | null;
      brandId: number | null;
      brandName: string | null;
      spec: string;
      warehouseId: number;
      warehouseName: string;
      warehousePath: string;
      qty: number;
      unitPrice?: string;
    }> = [];
    for (const item of dto.items) {
      const key = `${item.consumableId}:${item.spec}:${item.warehouseId}`;
      if (seen.has(key)) {
        throw new BusinessException(inventoryErrors.ITEM_DUPLICATED);
      }
      seen.add(key);
      const consumable = await tx.consumable.findUnique({ where: { id: item.consumableId }, select: { name: true, status: true } });
      if (!consumable || consumable.status !== 'ACTIVE') {
        throw new BusinessException(inventoryErrors.CONSUMABLE_DISABLED);
      }
      const warehouse = await loadWarehouseWithPath(tx, item.warehouseId);
      if (!warehouse) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '目标库位不存在或已停用' });
      }
      const supplier = item.supplierId !== undefined ? await this.loadDictName(tx, item.supplierId, 'SUPPLIER') : null;
      const brand = item.brandId !== undefined ? await this.loadDictName(tx, item.brandId, 'BRAND') : null;
      lines.push({
        consumableId: item.consumableId,
        consumableName: consumable.name,
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? null,
        brandId: brand?.id ?? null,
        brandName: brand?.name ?? null,
        spec: item.spec,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        warehousePath: warehouse.path,
        qty: item.qty,
        unitPrice: item.unitPrice,
      });
    }
    return lines;
  }

  /** 加载字典项（类型校验；不存在返回 null 并抛业务异常） */
  private async loadDictName(
    tx: Prisma.TransactionClient,
    dictId: number,
    dictType: string,
  ): Promise<{ id: number; name: string } | null> {
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
