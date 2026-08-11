import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import type { Response } from 'express';
import {
  APPLICATION_NO_PREFIX_ASSET,
  assertOpinionIfRequired,
  assertPending,
  assertScopeCoversAll,
  assertTransitionAllowed,
  extractDepartmentIdsFromSnapshot,
  generateApplicationNo,
  isCompanyOnlyRequestType,
  resolveProcessTransition,
  throwIfTransitionLost,
  toApproverScope,
  withPendingLimitMapping,
} from '@wbme/approval';
import {
  BusinessException,
  CONSUMABLE_APPROVAL_FUNCTION_CODE,
  ApprovalListQueryDto,
  approvalErrors,
  frameworkErrors,
  type DataScope,
} from '@wbme/contracts';
import { RedisService, runExport } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { getFunctionAccess, loadSessionUser, loadUserName } from '../../shared/cross-schema-auth';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  loadAssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';
import { buildAssetApprovalRequestTableQuery } from '../../shared/table-query';
import { AssetApprovalSideEffect } from './asset-approval-side-effect';

/** asset 审批申请类型（6+1） */
export type AssetRequestType =
  | 'STOCK_IN'
  | 'STOCK_CHANGE'
  | 'CONSUMABLE_REQUEST'
  | 'AGENT_REQUEST'
  | 'RETURN'
  | 'WRITE_OFF'
  | 'AGENT_SETTLEMENT';

const ALL_ASSET_TYPES: readonly AssetRequestType[] = [
  'STOCK_IN',
  'STOCK_CHANGE',
  'CONSUMABLE_REQUEST',
  'AGENT_REQUEST',
  'RETURN',
  'WRITE_OFF',
  'AGENT_SETTLEMENT',
];

/** 列表项 */
export interface AssetApprovalListItem {
  id: number;
  applicationNo: string;
  requestType: string;
  applicantId: number;
  applicantName: string;
  status: string;
  version: number;
  submittedAt: Date | null;
  processorId: number | null;
  processorName: string | null;
  processedAt: Date | null;
  opinion: string | null;
  refRequestId: number | null;
}

/** 测试/内部提交入参 */
export interface SubmitTestHeaderInput {
  requestType: AssetRequestType;
  applicantId: number;
  applicantName: string;
  applicantDepartmentSnapshot?: { id?: number; departmentId?: number; name?: string };
  /** AGENT_SETTLEMENT 条件唯一索引键 */
  refRequestId?: number;
  proxyId?: number;
  proxyName?: string;
}

/** 业务模块提交审批头入参（事务内调用；各业务服务复用） */
export interface CreateRequestHeadInput {
  requestType: AssetRequestType;
  applicantId: number;
  applicantName: string;
  applicantDepartmentSnapshot: Prisma.InputJsonValue;
  /** AGENT_SETTLEMENT 条件唯一索引键 */
  refRequestId?: number;
  proxyId?: number;
  proxyName?: string;
  /** 申请人整单备注（入库/库存变更提交时填写；审批详情展示） */
  remark?: string;
}

/**
 * asset 审批头服务（主 PRD §3.2；接入部门闭包与业务副作用）。
 *
 * - 六类 + 代领结清审批头创建、处理、取消、列表、导出与待办统计；
 * - 批准/驳回/取消业务副作用经 AssetApprovalSideEffect 编排器执行
 *   （库存入账/扣减、额度转换/释放、借还回库/核销、代领结清，与终态同一事务）；
 * - 数据范围：COMPANY 可见全部类型；DEPARTMENT 排除 STOCK_IN/STOCK_CHANGE
 *   （`isCompanyOnlyRequestType`）并按部门闭包裁剪（hr.department_closure 视图）。
 */
@Injectable()
export class AssetApprovalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly closures: DepartmentClosureService,
    // 批准/驳回/取消副作用编排器（forwardRef 打破与业务模块的构造循环；测试手工构造时省略 = null）
    @Optional() @Inject(forwardRef(() => AssetApprovalSideEffect)) private readonly sideEffect: AssetApprovalSideEffect | null = null,
    private readonly redis: RedisService = { redis: null } as unknown as RedisService,
  ) {}

  /**
   * 业务模块提交审批头（事务内调用；创建 PENDING 审批头 + SUBMIT 动作，各业务服务复用）。
   *
   * @param tx 事务客户端（与业务明细同事务）
   * @param input 申请类型与申请人
   * @returns 审批头 id + 单号
   * @throws PENDING_LIMIT_REACHED 代领结清单待审批冲突（withPendingLimitMapping）
   */
  async createRequestHead(tx: Prisma.TransactionClient, input: CreateRequestHeadInput): Promise<{ id: number; applicationNo: string }> {
    if (input.requestType === 'AGENT_SETTLEMENT' && input.refRequestId === undefined) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        reason: 'AGENT_SETTLEMENT_REQUIRES_REF_REQUEST_ID',
      });
    }
    const prefix = APPLICATION_NO_PREFIX_ASSET[input.requestType] ?? 'AS';
    const applicationNo = generateApplicationNo(prefix);
    return withPendingLimitMapping(async () => {
      const head = await tx.approvalRequest.create({
        data: {
          applicationNo,
          requestType: input.requestType,
          applicantId: input.applicantId,
          applicantName: input.applicantName,
          applicantDepartmentSnapshot: input.applicantDepartmentSnapshot,
          proxyId: input.proxyId ?? null,
          proxyName: input.proxyName ?? null,
          refRequestId: input.refRequestId ?? null,
          remark: input.remark ?? null,
          status: 'PENDING',
          submittedAt: new Date(),
          createdBy: input.applicantId,
        },
      });
      await tx.approvalActionRecord.create({
        data: {
          requestId: head.id,
          action: 'SUBMIT',
          actorId: input.applicantId,
          actorName: input.applicantName,
        },
      });
      return { id: head.id, applicationNo };
    });
  }

  /**
   * 测试/内部：创建 PENDING 审批头 + SUBMIT 动作（明细行非 FK 强制时可省略）。
   *
   * @param input 申请类型与申请人
   * @returns 审批头 id
   * @throws PENDING_LIMIT_REACHED 代领结清单待审批冲突
   */
  async submitTestHeader(input: SubmitTestHeaderInput): Promise<{ requestId: number }> {
    const deptSnapshot = (input.applicantDepartmentSnapshot ?? {
      id: 1,
      name: '占位部门',
    }) as Prisma.InputJsonValue;
    const request = await this.prisma.client.$transaction(async (tx) =>
      this.createRequestHead(tx, {
        requestType: input.requestType,
        applicantId: input.applicantId,
        applicantName: input.applicantName,
        applicantDepartmentSnapshot: deptSnapshot,
        refRequestId: input.refRequestId,
        proxyId: input.proxyId,
        proxyName: input.proxyName,
      }),
    );
    return { requestId: request.id };
  }

  /**
   * 审批处理（内核状态迁移 + 批准业务副作用 / 驳回占用释放 + DEPARTMENT 闭包范围断言）。
   *
   * @param id 审批头 id
   * @param action APPROVE | REJECT
   * @param processorId 处理人
   * @param opinion 意见（驳回必填）
   */
  async process(
    id: number,
    action: 'APPROVE' | 'REJECT',
    processorId: number,
    opinion?: string,
    idempotencyKey?: string,
  ): Promise<void> {
    const operator = await loadAssetOperationLogOperator(this.prisma.client, processorId);
    await executeIdempotentOperation<void>(this.prisma.client, {
      operator,
      feature: CONSUMABLE_APPROVAL_FUNCTION_CODE,
      scope: `asset.approval.process/${id}`,
      idempotencyKey,
      fingerprint: fingerprintPayload({ action, opinion: opinion ?? null }),
      run: async (tx) => {
        const transition = resolveProcessTransition(action);
        assertOpinionIfRequired(transition.requiresOpinion, opinion);
        await this.processInner(tx, id, action, transition, processorId, opinion);
        return {
          result: undefined as unknown as void,
          actionType: 'UPDATE' as const,
          summary: `处理了资产审批（${action}）`,
        };
      },
    });
  }

  /** process 业务主体（幂等 run 内执行；依赖数据库状态的校验全部在此） */
  private async processInner(
    tx: Prisma.TransactionClient,
    id: number,
    action: 'APPROVE' | 'REJECT',
    transition: ReturnType<typeof resolveProcessTransition>,
    processorId: number,
    opinion?: string,
  ): Promise<void> {
    const head = await tx.approvalRequest.findUnique({ where: { id } });
      if (!head) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      await this.assertCanAccessRequest(processorId, head.requestType);
      if (head.status !== 'PENDING') {
        throw new BusinessException(approvalErrors.STATUS_CONFLICT);
      }
      assertTransitionAllowed(head.status, transition.status);

      // T7：DEPARTMENT 档须覆盖申请对象全部部门快照（申请人/受领人/借出时快照）
      await this.assertScopeCovers(tx, head, processorId);

      const processorName = await loadUserName(tx, processorId);
      const now = new Date();
      const updated = await tx.approvalRequest.updateMany({
        where: { id, status: 'PENDING', version: head.version },
        data: {
          status: transition.status,
          version: { increment: 1 },
          processorId,
          processorName,
          processedAt: now,
          opinion: opinion ?? null,
        },
      });
      throwIfTransitionLost(updated.count);

      // T7：批准副作用（业务校验失败 → 事务回滚 → 申请保持待审批）；
      // 驳回释放占用（与终态同一事务）
      const sideHead = {
        id: head.id,
        requestType: head.requestType,
        applicantId: head.applicantId,
        applicantName: head.applicantName,
        applicantDepartmentSnapshot: head.applicantDepartmentSnapshot,
        processorId,
        processorName,
      };
      if (action === 'APPROVE') {
        if (this.sideEffect) {
          await this.sideEffect.applyApprove(tx, sideHead, processorId);
        }
      } else if (this.sideEffect) {
        await this.sideEffect.applyRelease(tx, sideHead);
      }

      await tx.approvalActionRecord.create({
        data: {
          requestId: id,
          action: transition.action,
          actorId: processorId,
          actorName: processorName,
          opinion: opinion ?? null,
        },
      });
  }

  /**
   * 申请人/代交人取消待审批（cancelSource=USER）。
   *
   * @param id 审批头 id
   * @param actorId 操作人
   */
  async cancel(id: number, actorId: number, idempotencyKey?: string): Promise<void> {
    const operator = await loadAssetOperationLogOperator(this.prisma.client, actorId);
    await executeIdempotentOperation<void>(this.prisma.client, {
      operator,
      feature: CONSUMABLE_APPROVAL_FUNCTION_CODE,
      scope: `asset.approval.cancel/${id}`,
      idempotencyKey,
      fingerprint: fingerprintPayload({ cancel: true }),
      run: async (tx) => {
        const transition = resolveProcessTransition('CANCEL', 'USER');
        await this.cancelInner(tx, id, actorId, transition);
        return {
          result: undefined as unknown as void,
          actionType: 'UPDATE' as const,
          summary: '取消了资产审批',
        };
      },
    });
  }

  /** cancel 业务主体（幂等 run 内执行；依赖数据库状态的校验全部在此） */
  private async cancelInner(
    tx: Prisma.TransactionClient,
    id: number,
    actorId: number,
    transition: ReturnType<typeof resolveProcessTransition>,
  ): Promise<void> {
    const head = await tx.approvalRequest.findUnique({ where: { id } });
      if (!head) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      if (head.applicantId !== actorId && head.proxyId !== actorId) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      assertPending(head.status);
      assertTransitionAllowed(head.status, transition.status);

      const actorName = await loadUserName(tx, actorId);
      const now = new Date();
      const updated = await tx.approvalRequest.updateMany({
        where: { id, status: 'PENDING', version: head.version },
        data: {
          status: 'CANCELLED',
          version: { increment: 1 },
          cancelledBy: actorId,
          cancelledAt: now,
          cancelSource: 'USER',
        },
      });
      throwIfTransitionLost(updated.count);

      // T7：取消释放业务占用（库存/额度/借还派生占用；与终态同一事务）
      // 用户取消无审批处理人：processorId/processorName 传 null（release 不依赖处理人）
      if (this.sideEffect) {
        await this.sideEffect.applyRelease(tx, {
          id: head.id,
          requestType: head.requestType,
          applicantId: head.applicantId,
          applicantName: head.applicantName,
          applicantDepartmentSnapshot: head.applicantDepartmentSnapshot,
          processorId: null,
          processorName: null,
        });
      }

      await tx.approvalActionRecord.create({
        data: {
          requestId: id,
          action: 'CANCEL',
          actorId,
          actorName,
          cancelSource: 'USER',
        },
      });
  }

  /**
   * 分页列表（公司范围全部类型；部门范围排除入库/库存变更）。
   *
   * @param userId 当前用户
   * @param query 筛选与分页
   * @returns items + total
   */
  async list(
    userId: number,
    query: ApprovalListQueryDto,
  ): Promise<{ items: AssetApprovalListItem[]; total: number }> {
    const visibleTypes = await this.resolveVisibleTypes(userId);
    if (visibleTypes.length === 0) {
      return { items: [], total: 0 };
    }
    const where = await this.buildWhere(query, visibleTypes, userId);
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
    return {
      total,
      items: rows.map((row) => this.toListItem(row)),
    };
  }

  /**
   * 详情 + 申请对象明细；范围外/不存在 → 404。
   *
   * @param userId 当前用户
   * @param id 审批头 id
   * @returns 详情（detail 为按申请类型的申请对象列表，含名称快照；主 PRD §3.2）
   */
  async getDetail(userId: number, id: number): Promise<{
    request: AssetApprovalListItem & {
      proxyId: number | null;
      proxyName: string | null;
      cancelSource: string | null;
      cancelledAt: Date | null;
      remark: string | null;
    };
    detail: unknown;
    actions: Array<{
      id: number;
      action: string;
      actorId: number;
      actorName: string;
      opinion: string | null;
      cancelSource: string | null;
      createdAt: Date;
    }>;
  }> {
    const head = await this.prisma.client.approvalRequest.findUnique({
      where: { id },
      include: {
        actions: { orderBy: { createdAt: 'asc' } },
        stockInItems: { orderBy: { id: 'asc' } },
        stockChangeItems: { orderBy: { id: 'asc' } },
        consumableRequestItems: { orderBy: { id: 'asc' } },
        agentRecipients: { orderBy: { id: 'asc' } },
        borrowActionItems: { orderBy: { id: 'asc' }, include: { borrowRecord: true } },
        agentSettlementItems: { orderBy: { id: 'asc' }, include: { borrowRecord: true } },
      },
    });
    if (!head) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    await this.assertCanAccessRequest(userId, head.requestType);
    // T7：详情与处理执行相同的闭包范围校验（主 PRD §3.2）
    await this.assertScopeCovers(this.prisma.client as unknown as Prisma.TransactionClient, head, userId);
    return {
      request: {
        ...this.toListItem(head),
        proxyId: head.proxyId,
        proxyName: head.proxyName,
        cancelSource: head.cancelSource,
        cancelledAt: head.cancelledAt,
        remark: head.remark,
      },
      detail: resolveAssetDetail(head),
      actions: head.actions.map((action) => ({
        id: action.id,
        action: action.action,
        actorId: action.actorId,
        actorName: action.actorName,
        opinion: action.opinion,
        cancelSource: action.cancelSource,
        createdAt: action.createdAt,
      })),
    };
  }

  /**
   * 可见待审批数量（按类型 breakdown）。
   *
   * @param userId 用户 id
   * @param isSuperAdmin 是否超管（可省略）
   * @returns total + byType
   */
  async pendingCount(
    userId: number,
    isSuperAdmin?: boolean,
  ): Promise<{ total: number; byType: Record<string, number> }> {
    let superAdmin = isSuperAdmin;
    if (superAdmin === undefined) {
      const user = await loadSessionUser(this.prisma.client, userId);
      superAdmin = user?.isSuperAdmin ?? false;
    }
    const visibleTypes = await this.resolveVisibleTypes(userId, superAdmin);
    if (visibleTypes.length === 0) {
      return { total: 0, byType: {} };
    }
    const where: Prisma.ApprovalRequestWhereInput = {
      status: 'PENDING',
      requestType: { in: visibleTypes.map((entry) => entry.requestType) },
    };
    // DEPARTMENT 档：待办数量只统计闭包覆盖记录
    if (visibleTypes.some((entry) => entry.dataScope === 'DEPARTMENT')) {
      const closure = await this.closures.closureOfUser(userId);
      const coveredIds = await this.findCoveredRequestIds(closure, visibleTypes);
      where.id = { in: coveredIds };
    }
    const groups = await this.prisma.client.approvalRequest.groupBy({
      by: ['requestType'],
      where,
      _count: { _all: true },
    });
    const byType: Record<string, number> = {};
    let total = 0;
    for (const group of groups) {
      byType[group.requestType] = group._count._all;
      total += group._count._all;
    }
    return { total, byType };
  }

  /**
   * 解析可见申请类型（含数据范围档位）。
   *
   * 超管 / COMPANY：全部类型；DEPARTMENT：排除 STOCK_IN / STOCK_CHANGE
   * （`isCompanyOnlyRequestType`）并按部门闭包裁剪。
   *
   * @param userId 用户
   * @param isSuperAdminHint 可选超管提示
   * @returns 可见类型条目（requestType + dataScope）
   */
  private async resolveVisibleTypes(
    userId: number,
    isSuperAdminHint?: boolean,
  ): Promise<Array<{ requestType: AssetRequestType; dataScope: DataScope | null }>> {
    const access = await getFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPROVAL_FUNCTION_CODE);
    if (!access.registered || !access.systemOpen) {
      return [];
    }
    const user = isSuperAdminHint === undefined ? await loadSessionUser(this.prisma.client, userId) : null;
    const isSuperAdmin = isSuperAdminHint ?? user?.isSuperAdmin ?? false;
    if (!isSuperAdmin && !access.allowed) {
      return [];
    }
    const dataScope: DataScope | null = isSuperAdmin ? null : access.dataScope;
    if (dataScope === null || dataScope === 'COMPANY') {
      return ALL_ASSET_TYPES.map((requestType) => ({ requestType, dataScope }));
    }
    return ALL_ASSET_TYPES.filter((type) => !isCompanyOnlyRequestType(type)).map((requestType) => ({
      requestType,
      dataScope,
    }));
  }

  /**
   * 断言可访问该申请（功能 + 公司专属类型范围）；否则 404。
   *
   * @param userId 用户
   * @param requestType 申请类型
   */
  private async assertCanAccessRequest(userId: number, requestType: string): Promise<void> {
    const access = await getFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPROVAL_FUNCTION_CODE);
    if (!access.registered) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    if (!access.systemOpen) {
      throw new BusinessException(frameworkErrors.SYSTEM_NOT_OPEN, { system: access.systemName });
    }
    if (!access.allowed) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    // DEPARTMENT 不可见公司专属类型（主 PRD §3.2）；闭包断言由 assertScopeCovers 承担
    if (access.dataScope === 'DEPARTMENT' && isCompanyOnlyRequestType(requestType)) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
  }

  /**
   * 处理/详情：DEPARTMENT 档断言申请对象全部部门快照 ∈ 审批人闭包
   * （快照来源：申请人 / 受领人名单 / 借出时部门快照）。
   *
   * @param tx 事务客户端
   * @param head 审批头
   * @param userId 审批人
   */
  private async assertScopeCovers(tx: Prisma.TransactionClient, head: { id: number; requestType: string }, userId: number): Promise<void> {
    const access = await getFunctionAccess(this.prisma.client, userId, CONSUMABLE_APPROVAL_FUNCTION_CODE);
    if (access.dataScope !== 'DEPARTMENT') {
      return;
    }
    const closure = await this.closures.closureOfUser(userId);
    const scope = toApproverScope(access.dataScope, closure);
    const objectDepartmentIds = await this.resolveObjectDepartmentIds(tx, head);
    assertScopeCoversAll(scope, objectDepartmentIds, head.requestType);
  }

  /** 从审批头解析申请对象部门 id 列表（多对象批次展平；空 → 仅公司范围可覆盖） */
  private async resolveObjectDepartmentIds(
    tx: Prisma.TransactionClient,
    head: { id: number; requestType: string },
  ): Promise<Array<number | null>> {
    if (head.requestType === 'AGENT_REQUEST' || head.requestType === 'AGENT_SETTLEMENT') {
      const refId = head.requestType === 'AGENT_SETTLEMENT'
        ? (await tx.approvalRequest.findUnique({ where: { id: head.id }, select: { refRequestId: true } }))?.refRequestId ?? null
        : head.id;
      if (refId === null) {
        return [];
      }
      const recipients = await tx.agentRecipient.findMany({ where: { requestId: refId } });
      return recipients.flatMap((recipient) =>
        extractDepartmentIdsFromSnapshot(recipient.departmentSnapshot as unknown),
      );
    }
    if (head.requestType === 'RETURN' || head.requestType === 'WRITE_OFF') {
      // 借出时部门快照（PERSONAL 单条记录的快照数组展开）
      const rows = await tx.$queryRaw<Array<{ department_snapshot: Prisma.JsonValue | null }>>`
        SELECT bai.borrow_record_id, br.department_snapshot
        FROM asset.borrow_action_items bai
        INNER JOIN asset.borrow_records br ON br.id = bai.borrow_record_id
        WHERE bai.request_id = ${head.id}
      `;
      return rows.flatMap((row) => extractDepartmentIdsFromSnapshot(row.department_snapshot as unknown));
    }
    // STOCK_IN / STOCK_CHANGE / CONSUMABLE_REQUEST：申请人部门快照
    const rows = await tx.$queryRaw<Array<{ applicant_department_snapshot: Prisma.JsonValue | null }>>`
      SELECT applicant_department_snapshot FROM asset.approval_requests WHERE id = ${head.id} LIMIT 1
    `;
    return extractDepartmentIdsFromSnapshot(rows[0]?.applicant_department_snapshot as unknown);
  }

  /** 构造列表 where（DEPARTMENT 档按闭包覆盖记录裁剪） */
  private async buildWhere(
    query: ApprovalListQueryDto,
    visibleTypes: ReadonlyArray<{ requestType: AssetRequestType; dataScope: DataScope | null }>,
    userId: number,
  ): Promise<Prisma.ApprovalRequestWhereInput> {
    const where: Prisma.ApprovalRequestWhereInput = {
      requestType: { in: visibleTypes.map((entry) => entry.requestType) },
    };
    if (query.requestType !== undefined) {
      if (query.requestType === 'CONSUMABLE_REQUEST') {
        // 代交申领归入「消耗品申领」筛选（asset PRD §9 六类统一展示；代交同为消耗品审批）
        where.requestType = { in: ['CONSUMABLE_REQUEST', 'AGENT_REQUEST'] };
      } else if (!visibleTypes.some((entry) => entry.requestType === query.requestType)) {
        where.id = -1;
      } else {
        where.requestType = query.requestType as AssetRequestType;
      }
    }
    if (query.status === 'PENDING') {
      where.status = 'PENDING';
    } else if (query.status === 'PROCESSED') {
      where.status = { in: ['APPROVED', 'REJECTED', 'CANCELLED'] };
    } else if (
      query.status === 'DRAFT' ||
      query.status === 'APPROVED' ||
      query.status === 'REJECTED' ||
      query.status === 'CANCELLED'
    ) {
      where.status = query.status;
    }
    if (query.applicantName) {
      where.applicantName = { contains: query.applicantName };
    }
    if (query.processorName) {
      where.processorName = { contains: query.processorName };
    }
    if (query.keyword) {
      where.OR = [
        { applicationNo: { contains: query.keyword } },
        { applicantName: { contains: query.keyword } },
        { processorName: { contains: query.keyword } },
      ];
    }
    // DEPARTMENT 档：按申请对象部门快照裁剪（全部 ∈ 闭包；空快照不覆盖）
    if (visibleTypes.some((entry) => entry.dataScope === 'DEPARTMENT') && where.id === undefined) {
      const closure = await this.closures.closureOfUser(userId);
      const coveredIds = await this.findCoveredRequestIds(closure, visibleTypes);
      where.id = { in: coveredIds };
    }
    return where;
  }

  /** 闭包覆盖的审批头 id 集合（各类型快照全部 ∈ 闭包） */
  private async findCoveredRequestIds(
    closure: ReadonlySet<number>,
    visibleTypes: ReadonlyArray<{ requestType: AssetRequestType; dataScope: DataScope | null }>,
  ): Promise<number[]> {
    const departmentScoped = visibleTypes.filter((entry) => entry.dataScope === 'DEPARTMENT');
    if (closure.size === 0 || departmentScoped.length === 0) {
      return [];
    }
    const closureIds = [...closure];
    const ids = new Set<number>();
    for (const entry of departmentScoped) {
      if (entry.requestType === 'RETURN' || entry.requestType === 'WRITE_OFF') {
        // 借出时部门快照（borrow_action_items → borrow_records；形状兼容数组/单对象）
        const rows = await this.prisma.client.$queryRaw<Array<{ id: number }>>`
          SELECT DISTINCT bai.request_id AS id
          FROM asset.borrow_action_items bai
          INNER JOIN asset.borrow_records br ON br.id = bai.borrow_record_id
          WHERE br.department_snapshot IS NOT NULL
            AND jsonb_array_length(
              CASE WHEN jsonb_typeof(br.department_snapshot) = 'array'
                   THEN br.department_snapshot
                   ELSE jsonb_build_array(br.department_snapshot) END
            ) > 0
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(br.department_snapshot) = 'array'
                     THEN br.department_snapshot
                     ELSE jsonb_build_array(br.department_snapshot) END
              ) el
              WHERE (el->>'id')::int <> ALL(${closureIds})
            )
        `;
        rows.forEach((row) => ids.add(row.id));
        continue;
      }
      if (entry.requestType === 'AGENT_REQUEST') {
        // 受领人名单部门快照（按本申请 id；形状兼容数组/单对象）
        const rows = await this.prisma.client.$queryRaw<Array<{ id: number }>>`
          SELECT DISTINCT ar.id
          FROM asset.approval_requests ar
          WHERE ar.request_type = 'AGENT_REQUEST'
            AND EXISTS (
              SELECT 1 FROM asset.agent_recipients arp
              WHERE arp.request_id = ar.id
                AND jsonb_array_length(
                  CASE WHEN jsonb_typeof(arp.department_snapshot) = 'array'
                       THEN arp.department_snapshot
                       ELSE jsonb_build_array(arp.department_snapshot) END
                ) > 0
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(arp.department_snapshot) = 'array'
                         THEN arp.department_snapshot
                         ELSE jsonb_build_array(arp.department_snapshot) END
                  ) el
                  WHERE (el->>'id')::int <> ALL(${closureIds})
                )
            )
        `;
        rows.forEach((row) => ids.add(row.id));
        continue;
      }
      if (entry.requestType === 'AGENT_SETTLEMENT') {
        // 受领人名单部门快照（按 ref_request_id 指向的代领清单；形状兼容数组/单对象）
        const rows = await this.prisma.client.$queryRaw<Array<{ id: number }>>`
          SELECT DISTINCT ar.id
          FROM asset.approval_requests ar
          WHERE ar.request_type = 'AGENT_SETTLEMENT'
            AND EXISTS (
              SELECT 1 FROM asset.agent_recipients arp
              WHERE arp.request_id = ar.ref_request_id
                AND jsonb_array_length(
                  CASE WHEN jsonb_typeof(arp.department_snapshot) = 'array'
                       THEN arp.department_snapshot
                       ELSE jsonb_build_array(arp.department_snapshot) END
                ) > 0
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(arp.department_snapshot) = 'array'
                         THEN arp.department_snapshot
                         ELSE jsonb_build_array(arp.department_snapshot) END
                  ) el
                  WHERE (el->>'id')::int <> ALL(${closureIds})
                )
            )
        `;
        rows.forEach((row) => ids.add(row.id));
        continue;
      }
      // STOCK_IN / STOCK_CHANGE / CONSUMABLE_REQUEST：申请人部门快照
      // （快照形状兼容数组（多部门）与单对象（测试/占位数据））
      const rows = await this.prisma.client.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM asset.approval_requests
        WHERE request_type = ${entry.requestType}
          AND applicant_department_snapshot IS NOT NULL
          AND jsonb_array_length(
            CASE WHEN jsonb_typeof(applicant_department_snapshot) = 'array'
                 THEN applicant_department_snapshot
                 ELSE jsonb_build_array(applicant_department_snapshot) END
          ) > 0
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(applicant_department_snapshot) = 'array'
                   THEN applicant_department_snapshot
                   ELSE jsonb_build_array(applicant_department_snapshot) END
            ) el
            WHERE (el->>'id')::int <> ALL(${closureIds})
          )
      `;
      rows.forEach((row) => ids.add(row.id));
    }
    return [...ids];
  }

  /**
   * 审批中心导出（runExport；可见性与列表一致——DEPARTMENT 档按闭包裁剪；
   * 仅提供当前权限范围内的导出所有/导出已筛选，不提供当前页导出）。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @param res Express 响应（流式写回）
   */
  async exportList(userId: number, query: ApprovalListQueryDto, res: Response): Promise<void> {
    const visibleTypes = await this.resolveVisibleTypes(userId);
    const tableQuery = buildAssetApprovalRequestTableQuery(query);
    const maxRows = await this.readExportMaxRows();
    await runExport<AssetApprovalListItem>({
      userId,
      redis: this.redis.redis,
      maxRows,
      filename: 'asset-approvals.xlsx',
      columns: [
        { header: '申请编号', value: (row) => row.applicationNo },
        { header: '申请类型', value: (row) => row.requestType },
        { header: '申请人', value: (row) => row.applicantName },
        { header: '状态', value: (row) => row.status },
        { header: '提交时间', value: (row) => row.submittedAt?.toISOString() ?? '' },
        { header: '审批人', value: (row) => row.processorName ?? '' },
        { header: '处理时间', value: (row) => row.processedAt?.toISOString() ?? '' },
        { header: '意见', value: (row) => row.opinion ?? '' },
      ],
      transaction: (fn, options) =>
        this.prisma.client.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: options?.timeout,
        }),
      fetchCount: async (tx) => {
        const where = await this.buildWhere(query, visibleTypes, userId);
        const effectiveWhere: Prisma.ApprovalRequestWhereInput = tableQuery.where
          ? { AND: [where, tableQuery.where as Prisma.ApprovalRequestWhereInput] }
          : where;
        return (tx as PrismaService['client']).approvalRequest.count({ where: effectiveWhere });
      },
      fetchRows: async (tx, offset, limit) => {
        const where = await this.buildWhere(query, visibleTypes, userId);
        const effectiveWhere: Prisma.ApprovalRequestWhereInput = tableQuery.where
          ? { AND: [where, tableQuery.where as Prisma.ApprovalRequestWhereInput] }
          : where;
        const client = tx as PrismaService['client'];
        const rows = await client.approvalRequest.findMany({
          where: effectiveWhere,
          orderBy: (tableQuery.orderBy as Prisma.ApprovalRequestOrderByWithRelationInput[] | undefined) ?? [{ submittedAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
        });
        return rows.map((row) => this.toListItem(row));
      },
      res,
    });
    const operator = await loadAssetOperationLogOperator(this.prisma.client, userId);
    await this.prisma.client.assetOperationLog.create({
      data: {
        operatorId: operator.id,
        operatorName: operator.name,
        operatorDepartments: operator.departments as Prisma.InputJsonValue,
        system: 'ASSET',
        feature: CONSUMABLE_APPROVAL_FUNCTION_CODE,
        actionType: 'EXPORT',
        summary: '导出了审批中心记录',
      },
    });
  }

  /** 读平台设置 export.max.rows（经只读视图；缺省 100000） */
  private async readExportMaxRows(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<Array<{ value: string }>>`
      SELECT value FROM backstage.platform_settings WHERE key = 'export.max.rows' LIMIT 1
    `;
    const value = Number(rows[0]?.value ?? 100000);
    return Number.isFinite(value) && value > 0 ? value : 100000;
  }

  private toListItem(row: {
    id: number;
    applicationNo: string;
    requestType: string;
    applicantId: number;
    applicantName: string;
    status: string;
    version: number;
    submittedAt: Date | null;
    processorId: number | null;
    processorName: string | null;
    processedAt: Date | null;
    opinion: string | null;
    refRequestId: number | null;
  }): AssetApprovalListItem {
    return {
      id: row.id,
      applicationNo: row.applicationNo,
      requestType: row.requestType,
      applicantId: row.applicantId,
      applicantName: row.applicantName,
      status: row.status,
      version: row.version,
      submittedAt: row.submittedAt,
      processorId: row.processorId,
      processorName: row.processorName,
      processedAt: row.processedAt,
      opinion: row.opinion,
      refRequestId: row.refRequestId,
    };
  }
}

/** 详情查询加载的明细关系（与 getDetail include 一致） */
interface ApprovalHeadWithDetails {
  requestType: string;
  stockInItems: unknown[];
  stockChangeItems: unknown[];
  consumableRequestItems: unknown[];
  agentRecipients: unknown[];
  borrowActionItems: unknown[];
  agentSettlementItems: unknown[];
}

/**
 * 申请对象明细（主 PRD §3.2 审批详情；名称快照而非裸 ID）。
 *
 * - STOCK_IN → 入库明细；STOCK_CHANGE → 库存变更明细；
 * - CONSUMABLE_REQUEST → 申领明细；AGENT_REQUEST → 申领明细 + 受领人名单；
 * - RETURN / WRITE_OFF → 借还明细（含借还记录快照）；AGENT_SETTLEMENT → 代领结清明细。
 *
 * @param head 含明细关系的审批头
 * @returns 按申请类型的申请对象结构
 */
function resolveAssetDetail(head: ApprovalHeadWithDetails): unknown {
  switch (head.requestType) {
    case 'STOCK_IN':
      return head.stockInItems;
    case 'STOCK_CHANGE':
      return head.stockChangeItems;
    case 'CONSUMABLE_REQUEST':
      return head.consumableRequestItems;
    case 'AGENT_REQUEST':
      // 代领申请对象 = 共享申领清单 + 受领人名单
      return { items: head.consumableRequestItems, recipients: head.agentRecipients };
    case 'RETURN':
    case 'WRITE_OFF':
      return head.borrowActionItems;
    case 'AGENT_SETTLEMENT':
      return head.agentSettlementItems;
    default:
      return null;
  }
}
