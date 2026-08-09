import { Inject, Injectable } from '@nestjs/common';
import { extractDepartmentIdsFromSnapshot, toApproverScope } from '@wbme/approval';
import {
  BusinessException,
  CONSUMABLE_APPROVAL_FUNCTION_CODE,
  DirectDisposalDto,
  DisposalQueryDto,
  frameworkErrors,
  inventoryErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { assertFunctionAccess, type FunctionAccess } from '../../shared/cross-schema-auth';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { BorrowService } from '../borrow/borrow.service';

/**
 * 注销员工借还直接处置服务（asset PRD §8/§9；A-26）。
 *
 * - 非审批类型：不创建申请、不进入待审批状态、不需再次审批，确认成功即最终业务结果；
 * - 持有「消耗品审批」且数据范围覆盖（PERSONAL 按借出时部门快照闭包；AGENT_SETTLE
 *   按受领人名单全部部门快照闭包）可处理；
 * - 同一事务内重新校验：借用人/发起人仍为注销状态、借还记录归属、可处理数量
 *   （未结清 − 待审批归还占用 − 待审批核销占用），并锁定目标借还记录；
 * - 直接归还在事务中增加原批次与库存条目账面并写库存流水；直接核销只减少个人
 *   未结清持有量不回库；两者都写入不可删除的管理员直接处置记录（含关联流水引用）
 *   与操作日志，任一写入失败全部回滚；必须携带幂等键。
 */
@Injectable()
export class DisposalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly borrow: BorrowService,
    private readonly closures: DepartmentClosureService,
  ) {}

  /**
   * 待处置列表（数据范围内已注销员工尚未结清的个人借还 + 发起人已注销且可直接
   * 整单结清的代领共享清单）。
   *
   * @param userId 当前用户（审批人）
   * @param query 筛选
   * @returns items + total
   */
  async listPending(userId: number, query: DisposalQueryDto): Promise<{ items: unknown[]; total: number }> {
    const access = await assertFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPROVAL_FUNCTION_CODE);
    const scope = await this.approverScope(userId, access);
    const closure = await this.closures.closureOfUser(userId);
    const rows = await this.prisma.client.$queryRaw`
      SELECT
        br.id AS record_id, br.record_type, br.user_id, br.user_name, br.department_snapshot,
        br.request_id, br.agent_request_id, br.consumable_name, br.spec, br.warehouse_name,
        br.warehouse_path, br.qty, br.borrowed_at, br.due_at, br.returned_qty, br.written_off_qty,
        ua.status AS user_status
      FROM asset.borrow_records br
      LEFT JOIN backstage.user_accounts ua ON ua.user_id = br.user_id
      WHERE (br.qty - br.returned_qty - br.written_off_qty) > 0
        AND (
          (br.record_type = 'PERSONAL' AND ua.status = 'DEACTIVATED')
          OR (br.record_type = 'AGENT' AND EXISTS (
            SELECT 1 FROM asset.approval_requests ar
            INNER JOIN backstage.user_accounts ua2 ON ua2.user_id = ar.applicant_id
            WHERE ar.id = br.agent_request_id AND ua2.status = 'DEACTIVATED'
          ))
        )
      ORDER BY br.created_at DESC
      LIMIT 500
    `;
    // 范围过滤：PERSONAL 按借出时部门快照闭包；AGENT 按受领人名单全部部门快照闭包
    const visible: unknown[] = [];
    for (const row of rows as Array<{
      record_id: number;
      record_type: string;
      user_id: number | null;
      user_name: string | null;
      department_snapshot: Prisma.JsonValue | null;
      request_id: number;
      agent_request_id: number | null;
      user_status: string | null;
      qty: number;
      returned_qty: number;
      written_off_qty: number;
    }>) {
      if (row.record_type === 'PERSONAL') {
        const deptIds = extractDepartmentIdsFromSnapshot(row.department_snapshot).filter((id): id is number => id !== null);
        if (scope.kind === 'COMPANY' || deptIds.some((id) => closure.has(id))) {
          visible.push(row);
        }
      } else {
        // AGENT：发起人已注销且受领人名单部门快照全部在闭包内（PRD §8 覆盖原受领人名单全部部门快照）
        const recipientRows = await this.prisma.client.$queryRaw<Array<{ department_snapshot: Prisma.JsonValue }>>`
          SELECT department_snapshot FROM asset.agent_recipients WHERE request_id = ${row.request_id}
        `;
        const allDeptIds = recipientRows.flatMap((recipient) =>
          extractDepartmentIdsFromSnapshot(recipient.department_snapshot).filter((id): id is number => id !== null),
        );
        if (allDeptIds.length > 0 && allDeptIds.every((id) => closure.has(id))) {
          visible.push(row);
        }
      }
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    return { items: visible.slice(start, start + pageSize), total: visible.length };
  }

  /**
   * 直接处置（幂等；RETURN 回库 / WRITE_OFF 核销 / AGENT_SETTLE 整单结清）。
   *
   * @param operator 操作人（审批人）
   * @param userId 当前用户
   * @param dto 处置输入
   * @returns 处置记录 id
   */
  async dispose(operator: AssetOperationLogOperator, userId: number, dto: DirectDisposalDto): Promise<{ id: number }> {
    const access = await assertFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPROVAL_FUNCTION_CODE);
    const scope = await this.approverScope(userId, access);
    const closure = await this.closures.closureOfUser(userId);
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: CONSUMABLE_APPROVAL_FUNCTION_CODE,
      scope: 'asset.disposal.execute',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        if (dto.disposalType === 'AGENT_SETTLE') {
          if (dto.agentRequestId === undefined || !dto.agentItems || dto.agentItems.length === 0) {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: 'AGENT_SETTLE 需要代领清单与结清明细' });
          }
          return this.disposeAgentSettle(tx, operator, dto.agentRequestId, dto.agentItems, scope, closure);
        }
        if (!dto.items || dto.items.length === 0) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '需要处置明细' });
        }
        // 个人借还处置：按借还记录 id 升序锁定（固定顺序）
        const recordIds = [...new Set(dto.items.map((item) => item.borrowRecordId))].sort((a, b) => a - b);
        const locked = new Map<number, Awaited<ReturnType<BorrowService['lockBorrowRecord']>>>();
        for (const recordId of recordIds) {
          const record = await this.borrow.lockBorrowRecord(tx, recordId);
          if (!record) {
            throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
          }
          locked.set(recordId, record);
        }
        const refs: number[] = [];
        for (const item of dto.items) {
          const record = locked.get(item.borrowRecordId)!;
          await this.assertDisposable(tx, record, scope, closure);
          // 可处理数量 = 未结清 − 待审批归还/核销占用（与申请互斥：先提交的申请先占）
          if (dto.disposalType === 'RETURN') {
            await this.borrow.restoreRecord(tx, record, item.qty, 'DIRECT_DISPOSAL', 0, operator.id);
          } else {
            await this.borrow.writeOffRecord(tx, record, item.qty);
          }
          const flowRows = await tx.stockFlow.findMany({
            where: { refType: 'DIRECT_DISPOSAL', refId: 0 },
            orderBy: { id: 'desc' },
            take: 1,
          });
          if (flowRows[0]) {
            refs.push(flowRows[0].id);
          }
          await tx.directDisposalRecord.create({
            data: {
              disposalType: dto.disposalType,
              borrowRecordId: record.id,
              userId: record.userId,
              userName: record.userName,
              inventoryItemId: record.inventoryItemId,
              consumableName: record.consumableName,
              spec: record.spec,
              warehouseName: record.warehouseName,
              warehousePath: record.warehousePath,
              qty: item.qty,
              writeOffType: dto.disposalType === 'WRITE_OFF' ? item.writeOffType ?? null : null,
              reason: item.reason ?? null,
              processorId: operator.id,
              processorName: operator.name,
              // 关联流水引用（可空字段省略即 DB NULL）
              ...(refs.length > 0 ? { stockFlowRefs: { ids: refs } as Prisma.InputJsonValue } : {}),
            },
          });
        }
        return {
          result: { id: 0 },
          actionType: 'CREATE' as const,
          summary: `直接处置了已注销员工借还（${dto.disposalType}，${dto.items.length} 行）`,
        };
      },
    });
  }

  /**
   * 处置记录列表（RECORDS 视图；按处理时间倒序）。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @returns items + total
   */
  async listRecords(userId: number, query: DisposalQueryDto): Promise<{ items: unknown[]; total: number }> {
    await assertFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPROVAL_FUNCTION_CODE);
    const where: Prisma.DirectDisposalRecordWhereInput = {};
    if (query.disposalType) {
      where.disposalType = query.disposalType;
    }
    if (query.processorName) {
      where.processorName = { contains: query.processorName };
    }
    if (query.userName) {
      where.userName = { contains: query.userName };
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.directDisposalRecord.count({ where }),
      this.prisma.client.directDisposalRecord.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /** 解析审批人数据范围（COMPANY / DEPARTMENT 闭包） */
  private async approverScope(
    userId: number,
    access: FunctionAccess,
  ): Promise<{ kind: 'COMPANY' } | { kind: 'DEPARTMENT'; departmentIds: ReadonlySet<number> }> {
    const scope = toApproverScope(access.dataScope);
    if (scope.kind === 'COMPANY') {
      return scope;
    }
    const closure = await this.closures.closureOfUser(userId);
    return { kind: 'DEPARTMENT', departmentIds: closure };
  }

  /**
   * 处置前置断言：借用人仍为注销状态、数据范围覆盖、记录类型匹配。
   *
   * @param tx 事务客户端
   * @param record 锁定后的借还记录
   * @param scope 审批人范围
   * @param closure 部门闭包
   */
  private async assertDisposable(
    tx: Prisma.TransactionClient,
    record: Awaited<ReturnType<BorrowService['lockBorrowRecord']>>,
    scope: { kind: 'COMPANY' } | { kind: 'DEPARTMENT'; departmentIds: ReadonlySet<number> },
    closure: ReadonlySet<number>,
  ): Promise<void> {
    if (!record || record.recordType !== 'PERSONAL' || record.userId === null) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    // 借用人仍为注销状态（已恢复 → 拒绝整次处置）
    const userRows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM backstage.user_accounts WHERE user_id = ${record.userId} LIMIT 1
    `;
    if ((userRows[0]?.status ?? 'ACTIVE') !== 'DEACTIVATED') {
      throw new BusinessException(inventoryErrors.DISPOSAL_FORBIDDEN, { reason: '借用人已恢复账号' });
    }
    if (scope.kind === 'DEPARTMENT') {
      const deptRows = await tx.$queryRaw<Array<{ department_snapshot: Prisma.JsonValue | null }>>`
        SELECT department_snapshot FROM asset.borrow_records WHERE id = ${record.id}
      `;
      const deptIds = extractDepartmentIdsFromSnapshot(deptRows[0]?.department_snapshot ?? null).filter(
        (id): id is number => id !== null,
      );
      if (!deptIds.some((id) => closure.has(id))) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
    }
  }

  /**
   * 代领共享清单直接整单结清：发起人已注销、无待审批结清申请、覆盖全部未结清数量。
   *
   * @param tx 事务客户端
   * @param operator 操作人
   * @param agentRequestId 代领清单申请 id
   * @param items 结清明细
   * @param scope 审批人范围
   * @param closure 部门闭包
   */
  private async disposeAgentSettle(
    tx: Prisma.TransactionClient,
    operator: AssetOperationLogOperator,
    agentRequestId: number,
    items: Array<{ borrowRecordId: number; qty: number; method: string; writeOffType?: string; reason?: string }>,
    scope: { kind: 'COMPANY' } | { kind: 'DEPARTMENT'; departmentIds: ReadonlySet<number> },
    closure: ReadonlySet<number>,
  ): Promise<{ result: { id: number }; actionType: 'CREATE'; summary: string }> {
    const source = await tx.approvalRequest.findUnique({ where: { id: agentRequestId } });
    if (!source || source.requestType !== 'AGENT_REQUEST') {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    // 发起人已注销
    const userRows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM backstage.user_accounts WHERE user_id = ${source.applicantId} LIMIT 1
    `;
    if ((userRows[0]?.status ?? 'ACTIVE') !== 'DEACTIVATED') {
      throw new BusinessException(inventoryErrors.DISPOSAL_FORBIDDEN, { reason: '代交发起人已恢复账号' });
    }
    // 无待审批结清申请（PRD §8：注销前已提交的结清申请继续正常审批，不能与直接结清并行）
    const pendingSettle = await tx.approvalRequest.findFirst({
      where: { refRequestId: agentRequestId, requestType: 'AGENT_SETTLEMENT', status: 'PENDING' },
      select: { id: true },
    });
    if (pendingSettle) {
      throw new BusinessException(inventoryErrors.DISPOSAL_FORBIDDEN, { reason: '存在待审批的结清申请' });
    }
    // 数据范围：受领人名单全部部门快照须在闭包内
    if (scope.kind === 'DEPARTMENT') {
      const recipientRows = await tx.$queryRaw<Array<{ department_snapshot: Prisma.JsonValue }>>`
        SELECT department_snapshot FROM asset.agent_recipients WHERE request_id = ${agentRequestId}
      `;
      const allDeptIds = recipientRows.flatMap((recipient) =>
        extractDepartmentIdsFromSnapshot(recipient.department_snapshot).filter((id): id is number => id !== null),
      );
      if (allDeptIds.length === 0 || !allDeptIds.every((id) => closure.has(id))) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
    }
    // 覆盖校验：每种物品各处理方式数量之和 = 全部未结清数量
    const openRecords = await tx.$queryRaw<Array<{ id: number; open_qty: number }>>`
      SELECT id, (qty - returned_qty - written_off_qty) AS open_qty
      FROM asset.borrow_records
      WHERE record_type = 'AGENT'
        AND agent_request_id = ${agentRequestId}
        AND (qty - returned_qty - written_off_qty) > 0
      ORDER BY id ASC
    `;
    const claimedByRecord = new Map<number, number>();
    for (const item of items) {
      claimedByRecord.set(item.borrowRecordId, (claimedByRecord.get(item.borrowRecordId) ?? 0) + item.qty);
    }
    if (openRecords.length === 0 || openRecords.some((row) => claimedByRecord.get(row.id) !== Number(row.open_qty))) {
      throw new BusinessException(inventoryErrors.SETTLEMENT_COVERAGE_INCOMPLETE);
    }
    // 锁定全部记录（升序）并执行回库/核销
    const recordIds = [...new Set(items.map((item) => item.borrowRecordId))].sort((a, b) => a - b);
    const locked = new Map<number, Awaited<ReturnType<BorrowService['lockBorrowRecord']>>>();
    for (const recordId of recordIds) {
      const record = await this.borrow.lockBorrowRecord(tx, recordId);
      if (!record) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      locked.set(recordId, record);
    }
    const refs: number[] = [];
    for (const item of items) {
      const record = locked.get(item.borrowRecordId)!;
      if (item.method === 'RETURN') {
        await this.borrow.restoreRecord(tx, record, item.qty, 'DIRECT_DISPOSAL', 0, operator.id);
      } else {
        await this.borrow.writeOffRecord(tx, record, item.qty);
      }
      const flowRows = await tx.stockFlow.findMany({ where: { refType: 'DIRECT_DISPOSAL', refId: 0 }, orderBy: { id: 'desc' }, take: 1 });
      if (flowRows[0]) {
        refs.push(flowRows[0].id);
      }
      await tx.directDisposalRecord.create({
        data: {
          disposalType: 'AGENT_SETTLE',
          borrowRecordId: record.id,
          agentRequestId,
          userId: null,
          userName: null,
          inventoryItemId: record.inventoryItemId,
          consumableName: record.consumableName,
          spec: record.spec,
          warehouseName: record.warehouseName,
          warehousePath: record.warehousePath,
          qty: item.qty,
          writeOffType: item.method === 'WRITE_OFF' ? (item.writeOffType as 'LOST' | 'DAMAGED') ?? null : null,
          reason: item.reason ?? null,
          processorId: operator.id,
          processorName: operator.name,
          // 关联流水引用（可空字段省略即 DB NULL）
          ...(refs.length > 0 ? { stockFlowRefs: { ids: refs } as Prisma.InputJsonValue } : {}),
        },
      });
    }
    return {
      result: { id: 0 },
      actionType: 'CREATE' as const,
      summary: `直接整单结清了已注销代交人的代领清单（${items.length} 行）`,
    };
  }
}
