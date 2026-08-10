import { forwardRef, Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  ConsumableRequestQueryDto,
  PROXY_APPLY_FUNCTION_CODE,
  AgentRequestCreateDto,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { attachDeactivatedFlags } from '../../shared/deactivated-flag.util';
import { allocateFifoBatches, cleanupEmptyItem, lockInventoryItems, writeStockFlow } from '../../shared/inventory-core';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { getFunctionAccess } from '../../shared/cross-schema-auth';
import { buildAssetApprovalRequestTableQuery } from '../../shared/table-query';
import { AssetApprovalService } from '../approval/asset-approval.service';

/**
 * 代交申领服务（asset PRD §7；A-20/A-21）。
 *
 * - 「受领人名单 + 一张共享物品清单」结构：每种物品只填清单总数量，不按受领人分摊；
 * - 受领人不能选择自己、不能重复选择同一人、须为数据范围内在职员工；
 * - 库存占用和出库只按共享清单总数量计算一次，不按受领人数重复乘算；
 * - 不占任何个人额度（发起人及受领人均不计入申领数量或持有数量）；
 * - 批准后借还类物品生成清单级（AGENT）借还记录，不设置个人借用人。
 */
@Injectable()
export class AgentClaimService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AssetApprovalService)) private readonly approval: AssetApprovalService,
    private readonly closures: DepartmentClosureService,
  ) {}

  /**
   * 提交代交申领（幂等；整单全有或全无；不占额度）。
   *
   * @param operator 操作人
   * @param dto 代交输入
   * @returns 审批头 id + 单号
   */
  async submit(operator: AssetOperationLogOperator, dto: AgentRequestCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: PROXY_APPLY_FUNCTION_CODE,
      scope: 'asset.agent-claim.submit',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        // 受领人校验：不能选择自己、不能重复、须为范围内在职员工
        const recipients = await this.prepareRecipients(tx, operator, dto.recipientIds);
        // 行去重（同一库存条目整单只能一次）
        const itemIds = dto.items.map((item) => item.inventoryItemId);
        if (new Set(itemIds).size !== itemIds.length) {
          throw new BusinessException(inventoryErrors.ITEM_DUPLICATED);
        }
        // 按 id 升序锁定目标条目并校验可用量（整单原子；不占额度）
        const locked = await lockInventoryItems(tx, itemIds);
        if (locked.length !== itemIds.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const lockedById = new Map(locked.map((row) => [row.id, row]));
        const lines: Array<{
          inventoryItemId: number;
          consumableId: number;
          consumableName: string;
          spec: string;
          warehouseName: string;
          warehousePath: string;
          qty: number;
          purpose: string | null;
        }> = [];
        for (const item of dto.items) {
          const row = lockedById.get(item.inventoryItemId)!;
          if (row.bookQty - row.reservedQty < item.qty) {
            throw new BusinessException(inventoryErrors.INSUFFICIENT_STOCK);
          }
          const consumable = await tx.consumable.findUnique({
            where: { id: row.consumableId },
            select: { name: true, status: true },
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
            purpose: item.purpose ?? null,
          });
        }
        // 增加库存占用（共享清单总数量一次计算）
        for (const line of lines) {
          await tx.inventoryItem.update({
            where: { id: line.inventoryItemId },
            data: { reservedQty: { increment: line.qty } },
          });
        }
        const head = await this.approval.createRequestHead(tx, {
          requestType: 'AGENT_REQUEST',
          applicantId: operator.id,
          applicantName: operator.name,
          applicantDepartmentSnapshot: operator.departments as Prisma.InputJsonValue,
          proxyId: operator.id,
          proxyName: operator.name,
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
        for (const recipient of recipients) {
          await tx.agentRecipient.create({
            data: {
              requestId: head.id,
              userId: recipient.userId,
              userName: recipient.userName,
              departmentSnapshot: recipient.departmentSnapshot as Prisma.InputJsonValue,
            },
          });
        }
        return {
          result: { requestId: head.id, applicationNo: head.applicationNo },
          actionType: 'CREATE' as const,
          summary: `提交了代交申领 ${head.applicationNo}（${lines.length} 行，受领人 ${recipients.length} 人）`,
        };
      },
    });
  }

  /**
   * 批准副作用：占用转出库（FIFO）；借还类生成清单级 AGENT 借还记录（不占个人额度）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   * @param processorId 处理人
   */
  async applyApproved(
    tx: Prisma.TransactionClient,
    head: { id: number; applicantDepartmentSnapshot: Prisma.JsonValue | null; processorId: number | null; processorName: string | null },
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
          refType: 'AGENT_REQUEST',
          refId: head.id,
          operator: { id: processorId, name: head.processorName ?? '审批系统' },
        });
        before = after;
      }
      // 借还用品：清单级代领借还记录（不设置个人借用人；一次性整单结清）
      const consumable = await tx.consumable.findUnique({ where: { id: row.consumableId }, select: { type: true, returnDays: true } });
      if (consumable?.type === 'REUSABLE') {
        const borrowedAt = new Date();
        // 到期时间 = 出库时间 + 归还期限快照（与出库时间同源，避免独立取时偏差）
        const dueAt = new Date(borrowedAt.getTime() + (consumable.returnDays ?? 0) * 24 * 60 * 60 * 1000);
        const borrowRecord = await tx.borrowRecord.create({
          data: {
            recordType: 'AGENT',
            userId: null,
            userName: null,
                        agentRequestId: head.id,
            requestId: head.id,
            inventoryItemId: line.inventoryItemId,
            consumableName: line.consumableName,
            spec: line.spec,
            warehouseName: line.warehouseName,
            warehousePath: line.warehousePath,
            qty: line.qty,
            borrowedAt,
            dueAt,
            // 借出时部门快照：受领人名单部门快照合并（部门档审批/注销处置数据范围数据源）
            departmentSnapshot: await this.mergeRecipientSnapshots(tx, head.id),
          },
        });
        await tx.borrowBatchAllocation.createMany({
          data: allocations.map((allocation) => ({
            borrowRecordId: borrowRecord.id,
            batchId: allocation.batchId,
            issuedQty: allocation.qty,
          })),
        });
      }
      await cleanupEmptyItem(tx, line.inventoryItemId);
    }
  }

  /**
   * 驳回/取消释放：减少条目占用（不占额度）。
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
  }

  /**
   * 合并受领人名单部门快照（借还记录「借出时部门快照」= 全部受领人部门并集；
   * 受领人无部门时返回 null）。
   *
   * @param tx 事务客户端
   * @param requestId 代领申请 id
   * @returns 部门快照数组（[{ id, name }] 去重）或 null
   */
  private async mergeRecipientSnapshots(tx: Prisma.TransactionClient, requestId: number): Promise<Prisma.InputJsonValue> {
    // 快照形状兼容数组与单对象（L6）：单对象快照先 CASE 展开为数组，避免 jsonb_array_elements 抛错
    const rows = await tx.$queryRaw<Array<{ snapshot: Prisma.JsonValue | null }>>`
      SELECT jsonb_agg(DISTINCT dept) AS snapshot
      FROM asset.agent_recipients ar
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(ar.department_snapshot) = 'array' THEN ar.department_snapshot
             ELSE jsonb_build_array(ar.department_snapshot) END
      ) AS dept
      WHERE ar.request_id = ${requestId}
    `;
    // 受领人均无部门时 jsonb_agg 为 NULL → 写 JSON null
    return (rows[0]?.snapshot ?? Prisma.JsonNull) as Prisma.InputJsonValue;
  }

  /**
   * 本人代交申领历史（随「代交申领」权限隐含提供；受领人名单一并返回）。
   *
   * @param operator 操作人
   * @param query 筛选
   * @returns items + total
   */
  async listMine(operator: AssetOperationLogOperator, query: ConsumableRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = { requestType: 'AGENT_REQUEST', applicantId: operator.id };
    if (query.status) {
      where.status = query.status;
    }
    return this.paginate(where, query);
  }

  /**
   * 范围代交申领历史（「消耗品申领历史记录」部门/公司档按类型过滤）。
   *
   * @param query 筛选
   * @param applicantIds 范围内申请人 id 集合（null = 不过滤）
   * @returns items + total
   */
  async listHistory(query: ConsumableRequestQueryDto, applicantIds?: ReadonlySet<number>): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = { requestType: 'AGENT_REQUEST' };
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

  /** 分页查询（含受领人名单） */
  private async paginate(where: Prisma.ApprovalRequestWhereInput, query: ConsumableRequestQueryDto): Promise<{ items: unknown[]; total: number }> {
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
        include: { agentRecipients: { orderBy: { id: 'asc' } } },
        orderBy: (tableQuery.orderBy as Prisma.ApprovalRequestOrderByWithRelationInput[] | undefined) ?? [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /**
   * 受领人校验与快照：不能选择自己、不能重复、须为数据范围内在职员工。
   *
   * @param tx 事务客户端
   * @param operator 发起人
   * @param recipientIds 受领人 id 列表
   * @returns 受领人快照
   * @throws RECIPIENT_INVALID 任一受领人不合法
   */
  private async prepareRecipients(
    tx: Prisma.TransactionClient,
    operator: AssetOperationLogOperator,
    recipientIds: readonly number[],
  ): Promise<Array<{ userId: number; userName: string; departmentSnapshot: Array<{ id: number; name: string }> }>> {
    if (new Set(recipientIds).size !== recipientIds.length) {
      throw new BusinessException(inventoryErrors.RECIPIENT_INVALID, { reason: '受领人不能重复' });
    }
    if (recipientIds.includes(operator.id)) {
      throw new BusinessException(inventoryErrors.RECIPIENT_INVALID, { reason: '不能为自己代领' });
    }
    // 数据范围：DEPARTMENT 闭包内 / COMPANY（或超管 dataScope=null）全部在职
    const access = await getFunctionAccess(this.prisma.client, operator.id, PROXY_APPLY_FUNCTION_CODE);
    let allowedIds = new Set<number>();
    if (access.dataScope === 'DEPARTMENT') {
      const closure = await this.closures.closureOfUser(operator.id);
      // 在职过滤（与 COMPANY 档一致——PRD §7「在职受领人」；
      // 注销不删除 user_departments，须显式 JOIN 账号状态）
      const rows = await this.prisma.client.$queryRaw<Array<{ user_id: number }>>`
        SELECT DISTINCT uo.user_id
        FROM hr.user_org uo
        INNER JOIN backstage.user_accounts ua ON ua.user_id = uo.user_id
          AND ua.status = 'ACTIVE' AND ua.deleted_at IS NULL
        WHERE uo.department_id = ANY(${[...closure] as number[]})
      `;
      allowedIds = new Set(rows.map((row) => row.user_id));
    } else if (access.dataScope === null || access.dataScope === 'COMPANY') {
      const rows = await this.prisma.client.$queryRaw<Array<{ user_id: number }>>`
        SELECT user_id FROM backstage.user_accounts WHERE status = 'ACTIVE' AND deleted_at IS NULL
      `;
      allowedIds = new Set(rows.map((row) => row.user_id));
    }
    const recipients: Array<{ userId: number; userName: string; departmentSnapshot: Array<{ id: number; name: string }> }> = [];
    for (const recipientId of recipientIds) {
      if (!allowedIds.has(recipientId)) {
        throw new BusinessException(inventoryErrors.RECIPIENT_INVALID, { reason: '受领人不在可代领范围内' });
      }
      const rows = await tx.$queryRaw<Array<{ name: string; department_id: number | null; department_name: string | null }>>`
        SELECT ua.name, uo.department_id, uo.department_name
        FROM backstage.user_accounts ua
        LEFT JOIN hr.user_org uo ON uo.user_id = ua.user_id
        WHERE ua.user_id = ${recipientId}
      `;
      const name = rows[0]?.name ?? '';
      const departments = rows
        .filter((row) => row.department_id !== null)
        .map((row) => ({ id: row.department_id as number, name: row.department_name as string }));
      recipients.push({ userId: recipientId, userName: name, departmentSnapshot: departments });
    }
    return recipients;
  }
}
