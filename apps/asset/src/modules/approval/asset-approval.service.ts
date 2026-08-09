import { Inject, Injectable } from '@nestjs/common';
import {
  APPLICATION_NO_PREFIX_ASSET,
  assertOpinionIfRequired,
  assertPending,
  assertTransitionAllowed,
  generateApplicationNo,
  isCompanyOnlyRequestType,
  resolveProcessTransition,
  throwIfTransitionLost,
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
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { getFunctionAccess, loadSessionUser, loadUserName } from '../../shared/cross-schema-auth';

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

/**
 * asset 审批头服务（主 PRD §3.2 / T5-3）。
 *
 * - 六类 + 代领结清审批头创建、处理、取消、列表与待办统计；
 * - 批准/驳回业务副作用本期为 no-op；
 * - T5 数据范围：COMPANY 可见全部类型；DEPARTMENT 排除 STOCK_IN/STOCK_CHANGE
 *   （`isCompanyOnlyRequestType`）；部门闭包过滤延期 T6。
 */
@Injectable()
export class AssetApprovalService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 测试/内部：创建 PENDING 审批头 + SUBMIT 动作（明细行非 FK 强制时可省略）。
   *
   * @param input 申请类型与申请人
   * @returns 审批头 id
   * @throws PENDING_LIMIT_REACHED 代领结清单待审批冲突
   */
  async submitTestHeader(input: SubmitTestHeaderInput): Promise<{ requestId: number }> {
    if (input.requestType === 'AGENT_SETTLEMENT' && input.refRequestId === undefined) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        reason: 'AGENT_SETTLEMENT_REQUIRES_REF_REQUEST_ID',
      });
    }
    const prefix = APPLICATION_NO_PREFIX_ASSET[input.requestType] ?? 'AS';
    const applicationNo = generateApplicationNo(prefix);
    const now = new Date();
    const deptSnapshot = (input.applicantDepartmentSnapshot ?? {
      id: 1,
      name: '占位部门',
    }) as Prisma.InputJsonValue;

    return withPendingLimitMapping(async () => {
      const request = await this.prisma.client.$transaction(async (tx) => {
        const head = await tx.approvalRequest.create({
          data: {
            applicationNo,
            requestType: input.requestType,
            applicantId: input.applicantId,
            applicantName: input.applicantName,
            applicantDepartmentSnapshot: deptSnapshot,
            proxyId: input.proxyId ?? null,
            proxyName: input.proxyName ?? null,
            refRequestId: input.refRequestId ?? null,
            status: 'PENDING',
            submittedAt: now,
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
        return head;
      });
      return { requestId: request.id };
    });
  }

  /**
   * 审批处理（内核状态迁移；业务副作用 T5 为 no-op）。
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
  ): Promise<void> {
    const transition = resolveProcessTransition(action);
    assertOpinionIfRequired(transition.requiresOpinion, opinion);

    await this.prisma.client.$transaction(async (tx) => {
      const head = await tx.approvalRequest.findUnique({ where: { id } });
      if (!head) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      await this.assertCanAccessRequest(processorId, head.requestType);
      if (head.status !== 'PENDING') {
        throw new BusinessException(approvalErrors.STATUS_CONFLICT);
      }
      assertTransitionAllowed(head.status, transition.status);

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

      // T5：批准/驳回无业务副作用（库存入账等 T7 接入）
      await tx.approvalActionRecord.create({
        data: {
          requestId: id,
          action: transition.action,
          actorId: processorId,
          actorName: processorName,
          opinion: opinion ?? null,
        },
      });
    });
  }

  /**
   * 申请人/代交人取消待审批（cancelSource=USER）。
   *
   * @param id 审批头 id
   * @param actorId 操作人
   */
  async cancel(id: number, actorId: number): Promise<void> {
    const transition = resolveProcessTransition('CANCEL', 'USER');
    await this.prisma.client.$transaction(async (tx) => {
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
      await tx.approvalActionRecord.create({
        data: {
          requestId: id,
          action: 'CANCEL',
          actorId,
          actorName,
          cancelSource: 'USER',
        },
      });
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
    const where = this.buildWhere(query, visibleTypes);
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
    return {
      total,
      items: rows.map((row) => this.toListItem(row)),
    };
  }

  /**
   * 详情；范围外/不存在 → 404。
   *
   * @param userId 当前用户
   * @param id 审批头 id
   * @returns 详情
   */
  async getDetail(userId: number, id: number): Promise<{
    request: AssetApprovalListItem & {
      proxyId: number | null;
      proxyName: string | null;
      cancelSource: string | null;
      cancelledAt: Date | null;
    };
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
      include: { actions: { orderBy: { createdAt: 'asc' } } },
    });
    if (!head) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    await this.assertCanAccessRequest(userId, head.requestType);
    return {
      request: {
        ...this.toListItem(head),
        proxyId: head.proxyId,
        proxyName: head.proxyName,
        cancelSource: head.cancelSource,
        cancelledAt: head.cancelledAt,
      },
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
    const groups = await this.prisma.client.approvalRequest.groupBy({
      by: ['requestType'],
      where: { status: 'PENDING', requestType: { in: [...visibleTypes] } },
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
   * 解析可见申请类型。
   *
   * T5：DEPARTMENT 不裁剪部门行，仅排除公司专属类型；T6 再接入部门闭包。
   *
   * @param userId 用户
   * @param isSuperAdminHint 可选超管提示
   * @returns 可见类型
   */
  private async resolveVisibleTypes(
    userId: number,
    isSuperAdminHint?: boolean,
  ): Promise<AssetRequestType[]> {
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
    // 超管 / COMPANY：全部类型；DEPARTMENT：排除 STOCK_IN / STOCK_CHANGE
    if (dataScope === null || dataScope === 'COMPANY') {
      return [...ALL_ASSET_TYPES];
    }
    return ALL_ASSET_TYPES.filter((type) => !isCompanyOnlyRequestType(type));
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
    // T5：DEPARTMENT 无部门闭包，但仍不可见公司专属类型（主 PRD §3.2）
    if (access.dataScope === 'DEPARTMENT' && isCompanyOnlyRequestType(requestType)) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
  }

  /** 构造列表 where */
  private buildWhere(
    query: ApprovalListQueryDto,
    visibleTypes: readonly AssetRequestType[],
  ): Prisma.ApprovalRequestWhereInput {
    const where: Prisma.ApprovalRequestWhereInput = {
      requestType: { in: [...visibleTypes] },
    };
    if (query.requestType !== undefined) {
      if (!(visibleTypes as readonly string[]).includes(query.requestType)) {
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
    return where;
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
