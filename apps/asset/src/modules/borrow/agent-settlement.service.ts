import { forwardRef, Inject, Injectable } from '@nestjs/common';
import {
  AgentSettlementCreateDto,
  AgentSettlementQueryDto,
  BusinessException,
  PROXY_APPLY_FUNCTION_CODE,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { buildAssetApprovalRequestTableQuery } from '../../shared/table-query';
import { AssetApprovalService } from '../approval/asset-approval.service';
import { BorrowService, type BorrowRecordLockRow } from './borrow.service';

/**
 * 代领一次性结清服务（asset PRD §7/§8；A-25）。
 *
 * - 入口在发起人的代交申领清单中，必须覆盖全部未结清数量：每种物品各处理方式
 *   数量之和必须等于该物品全部未结清数量，不能只提交其中一部分；
 * - 同一代领清单最多一条待审批结清申请（部分唯一索引；PENDING_LIMIT_REACHED）；
 * - 待审批期间整张清单锁定，不得再发起另一结清申请；驳回或取消后可重新提交；
 * - 批准时在同一事务一次完成全部回库、核销、库存流水和清单结清，任一部分失败
 *   则全部不生效；驳回时全部维持未结清（派生占用随终态消失）。
 */
@Injectable()
export class AgentSettlementService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AssetApprovalService)) private readonly approval: AssetApprovalService,
    private readonly borrow: BorrowService,
  ) {}

  /**
   * 提交代领结清（幂等；整单覆盖校验；同一清单最多一条待审批结清）。
   *
   * @param operator 操作人（代交申领发起人）
   * @param dto 结清输入
   * @returns 审批头 id + 单号
   */
  async submit(operator: AssetOperationLogOperator, dto: AgentSettlementCreateDto): Promise<{ requestId: number; applicationNo: string }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: PROXY_APPLY_FUNCTION_CODE,
      scope: 'asset.agent-settlement.submit',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        // 目标代领清单必须是本人发起的 AGENT_REQUEST
        const source = await tx.approvalRequest.findUnique({ where: { id: dto.refRequestId } });
        if (!source || source.requestType !== 'AGENT_REQUEST' || source.applicantId !== operator.id) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 整单覆盖校验：每种物品各处理方式数量之和 = 全部未结清数量
        const openRecords = await tx.$queryRaw<Array<{ id: number; open_qty: number }>>`
          SELECT id, (qty - returned_qty - written_off_qty) AS open_qty
          FROM asset.borrow_records
          WHERE record_type = 'AGENT'
            AND agent_request_id = ${dto.refRequestId}
            AND (qty - returned_qty - written_off_qty) > 0
          ORDER BY id ASC
        `;
        const openIds = new Set(openRecords.map((row) => row.id));
        if (openRecords.length === 0 || dto.items.some((item) => !openIds.has(item.borrowRecordId))) {
          // 夹带非本清单的借还记录：整单拒绝且不泄露外部记录存在性（M1 修复）
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const claimedByRecord = new Map<number, number>();
        for (const item of dto.items) {
          claimedByRecord.set(item.borrowRecordId, (claimedByRecord.get(item.borrowRecordId) ?? 0) + item.qty);
        }
        if (openRecords.some((row) => claimedByRecord.get(row.id) !== Number(row.open_qty))) {
          throw new BusinessException(inventoryErrors.SETTLEMENT_COVERAGE_INCOMPLETE);
        }
        const head = await this.approval.createRequestHead(tx, {
          requestType: 'AGENT_SETTLEMENT',
          applicantId: operator.id,
          applicantName: operator.name,
          applicantDepartmentSnapshot: operator.departments as Prisma.InputJsonValue,
          refRequestId: dto.refRequestId,
        });
        for (const item of dto.items) {
          await tx.agentSettlementItem.create({
            data: {
              requestId: head.id,
              borrowRecordId: item.borrowRecordId,
              qty: item.qty,
              method: item.method,
              writeOffType: item.method === 'WRITE_OFF' ? item.writeOffType ?? null : null,
              reason: item.reason ?? null,
            },
          });
        }
        return {
          result: { requestId: head.id, applicationNo: head.applicationNo },
          actionType: 'CREATE' as const,
          summary: `提交了代领结清申请 ${head.applicationNo}（${dto.items.length} 行）`,
        };
      },
    });
  }

  /**
   * 批准副作用：单事务一次完成全部回库、核销、流水与清单结清（任一部分失败全部不生效）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   * @param processorId 处理人
   */
  async applyApproved(tx: Prisma.TransactionClient, head: { id: number; applicantId: number }, processorId: number): Promise<void> {
    const items = await tx.agentSettlementItem.findMany({ where: { requestId: head.id }, orderBy: { id: 'asc' } });
    // 按借还记录 id 升序锁定全部记录（固定顺序）
    const recordIds = [...new Set(items.map((item) => item.borrowRecordId))].sort((a, b) => a - b);
    const locked = new Map<number, BorrowRecordLockRow>();
    for (const recordId of recordIds) {
      const record = await this.borrow.lockBorrowRecord(tx, recordId);
      if (!record) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      locked.set(recordId, record);
    }
    for (const item of items) {
      const record = locked.get(item.borrowRecordId)!;
      if (item.method === 'RETURN') {
        await this.borrow.restoreRecord(tx, record, item.qty, 'AGENT_SETTLEMENT', head.id, processorId);
      } else {
        await this.borrow.writeOffRecord(tx, record, item.qty);
      }
    }
  }

  /**
   * 驳回/取消释放（结清占用为派生值：PENDING 头消失即释放，无数据回写）。
   */
  async applyRelease(_tx: Prisma.TransactionClient, _head: { id: number }): Promise<void> {
    // no-op
  }

  /**
   * 本人代领结清申请历史。
   *
   * @param operator 操作人
   * @param query 筛选
   * @returns items + total
   */
  async listMine(operator: AssetOperationLogOperator, query: AgentSettlementQueryDto): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = { requestType: 'AGENT_SETTLEMENT', applicantId: operator.id };
    if (query.status) {
      where.status = query.status;
    }
    return this.paginate(where, query);
  }

  /** 分页查询 */
  private async paginate(where: Prisma.ApprovalRequestWhereInput, query: AgentSettlementQueryDto): Promise<{ items: unknown[]; total: number }> {
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
}
