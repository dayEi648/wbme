import { Inject, Injectable } from '@nestjs/common';
import {
  APPLICATION_NO_PREFIX_OVERTIME,
  APPLICATION_NO_PREFIX_POSITION_CHANGE,
  assertOpinionIfRequired,
  assertPending,
  assertTransitionAllowed,
  generateApplicationNo,
  resolveProcessTransition,
  throwIfTransitionLost,
  withPendingLimitMapping,
} from '@wbme/approval';
import {
  BusinessException,
  OVERTIME_APPROVAL_FUNCTION_CODE,
  ORG_STRUCTURE_FUNCTION_CODE,
  ApprovalListQueryDto,
  approvalErrors,
  frameworkErrors,
  type DataScope,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { getFunctionAccess, loadSessionUser, loadUserName } from '../../shared/cross-schema-auth';

/** hr 审批申请类型 */
export type HrRequestType = 'OVERTIME' | 'POSITION_CHANGE';

/** 列表项 */
export interface HrApprovalListItem {
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
}

/** 测试/内部提交入参 */
export interface SubmitTestHeaderInput {
  requestType: HrRequestType;
  applicantId: number;
  applicantName: string;
  /** 申请人部门快照（可选） */
  applicantDepartmentSnapshot?: { id?: number; departmentId?: number; name?: string };
  proxyId?: number;
  proxyName?: string;
}

/** 功能编码 → 可见申请类型 */
const FUNCTION_TO_TYPES: Readonly<Record<string, readonly HrRequestType[]>> = {
  [OVERTIME_APPROVAL_FUNCTION_CODE]: ['OVERTIME'],
  [ORG_STRUCTURE_FUNCTION_CODE]: ['POSITION_CHANGE'],
};

/**
 * hr 审批头服务（主 PRD §3.2 / T5-3）。
 *
 * - 加班/岗位变更审批头创建、处理、取消、列表与待办统计；
 * - 批准/驳回业务副作用本期为 no-op（T6 接入组织生效等）；
 * - T5 数据范围简化：DEPARTMENT 档对 hr 类型按公司可视（不裁剪部门），
 *   T6 再接入真实部门闭包过滤。
 */
@Injectable()
export class HrApprovalService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 测试/内部：创建 PENDING 审批头 + SUBMIT 动作（及类型明细）。
   *
   * @param input 申请类型与申请人
   * @returns 审批头 id
   * @throws PENDING_LIMIT_REACHED 岗位变更单待审批冲突
   */
  async submitTestHeader(input: SubmitTestHeaderInput): Promise<{ requestId: number }> {
    const prefix =
      input.requestType === 'OVERTIME'
        ? APPLICATION_NO_PREFIX_OVERTIME
        : APPLICATION_NO_PREFIX_POSITION_CHANGE;
    const applicationNo = generateApplicationNo(prefix);
    const now = new Date();
    const deptSnapshot = (input.applicantDepartmentSnapshot ?? { id: 1, name: '占位部门' }) as Prisma.InputJsonValue;

    return withPendingLimitMapping(async () => {
      const request = await this.prisma.client.$transaction(async (tx) => {
        const head = await tx.hrApprovalRequest.create({
          data: {
            applicationNo,
            requestType: input.requestType,
            applicantId: input.applicantId,
            applicantName: input.applicantName,
            applicantDepartmentSnapshot: deptSnapshot,
            proxyId: input.proxyId ?? null,
            proxyName: input.proxyName ?? null,
            status: 'PENDING',
            submittedAt: now,
            createdBy: input.applicantId,
          },
        });
        if (input.requestType === 'POSITION_CHANGE') {
          await tx.positionChangeRequest.create({
            data: {
              requestId: head.id,
              userId: input.applicantId,
              userName: input.applicantName,
              departmentSnapshot: deptSnapshot,
              targetDepartmentId: 1,
              targetDepartmentName: '占位部门',
              targetPositionId: 1,
              targetPositionName: '占位岗位',
            },
          });
        } else {
          await tx.overtimeItem.create({
            data: {
              requestId: head.id,
              userId: input.applicantId,
              userName: input.applicantName,
              departmentSnapshot: deptSnapshot,
              overtimeDate: new Date(now.toISOString().slice(0, 10)),
              startMinute: 18 * 60,
              endMinute: 20 * 60,
              reason: 'T5 测试加班',
              holidaySnapshot: { dateType: 'WORKDAY', weekday: now.getUTCDay() } as Prisma.InputJsonValue,
            },
          });
        }
        await tx.hrApprovalAction.create({
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
   * @throws RESOURCE_NOT_FOUND 无权/不存在；STATUS_CONFLICT 并发冲突
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
      const head = await tx.hrApprovalRequest.findUnique({ where: { id } });
      if (!head) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      await this.assertCanAccessType(processorId, head.requestType);
      if (head.status !== 'PENDING') {
        throw new BusinessException(approvalErrors.STATUS_CONFLICT);
      }
      assertTransitionAllowed(head.status, transition.status);

      const processorName = await loadUserName(tx, processorId);
      const now = new Date();
      const updated = await tx.hrApprovalRequest.updateMany({
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

      // T5：批准/驳回无业务副作用（T6 接入岗位生效、加班台账等）
      await tx.hrApprovalAction.create({
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
      const head = await tx.hrApprovalRequest.findUnique({ where: { id } });
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
      const updated = await tx.hrApprovalRequest.updateMany({
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
      await tx.hrApprovalAction.create({
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
   * 分页列表（按授予功能过滤可见类型）。
   *
   * @param userId 当前用户
   * @param query 筛选与分页
   * @returns items + total
   */
  async list(userId: number, query: ApprovalListQueryDto): Promise<{ items: HrApprovalListItem[]; total: number }> {
    const visibleTypes = await this.resolveVisibleTypes(userId);
    if (visibleTypes.length === 0) {
      return { items: [], total: 0 };
    }
    const where = this.buildWhere(query, visibleTypes);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.hrApprovalRequest.count({ where }),
      this.prisma.client.hrApprovalRequest.findMany({
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
   * 详情 + 明细 + 动作时间线；范围外/不存在 → 404。
   *
   * @param userId 当前用户
   * @param id 审批头 id
   * @returns 详情
   */
  async getDetail(userId: number, id: number): Promise<{
    request: HrApprovalListItem & {
      proxyId: number | null;
      proxyName: string | null;
      cancelSource: string | null;
      cancelledAt: Date | null;
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
    const head = await this.prisma.client.hrApprovalRequest.findUnique({
      where: { id },
      include: {
        overtimeItems: true,
        positionChangeRequest: true,
        actions: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!head) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    await this.assertCanAccessType(userId, head.requestType);
    return {
      request: {
        ...this.toListItem(head),
        proxyId: head.proxyId,
        proxyName: head.proxyName,
        cancelSource: head.cancelSource,
        cancelledAt: head.cancelledAt,
      },
      detail:
        head.requestType === 'OVERTIME'
          ? head.overtimeItems
          : head.positionChangeRequest,
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
   * @param isSuperAdmin 是否超管（可省略，将从 base.users 读取）
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
    const groups = await this.prisma.client.hrApprovalRequest.groupBy({
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
   * 解析用户可见的申请类型集合。
   *
   * T5：DEPARTMENT 档不裁剪部门（等同该类型全量可见）；T6 接入部门闭包。
   *
   * @param userId 用户
   * @param isSuperAdminHint 可选超管提示
   * @returns 可见类型
   */
  private async resolveVisibleTypes(
    userId: number,
    isSuperAdminHint?: boolean,
  ): Promise<HrRequestType[]> {
    const user = isSuperAdminHint === undefined ? await loadSessionUser(this.prisma.client, userId) : null;
    const isSuperAdmin = isSuperAdminHint ?? user?.isSuperAdmin ?? false;
    const types = new Set<HrRequestType>();
    for (const [functionCode, requestTypes] of Object.entries(FUNCTION_TO_TYPES)) {
      const access = await getFunctionAccess(this.prisma.client, userId, functionCode);
      if (!access.registered || !access.systemOpen) {
        continue;
      }
      if (isSuperAdmin || access.allowed) {
        // T5：dataScope 为 DEPARTMENT 时仍列出该 requestType 全部（无部门闭包）；T6 再过滤
        for (const requestType of requestTypes) {
          types.add(requestType);
        }
      }
    }
    return [...types];
  }

  /**
   * 断言用户可访问该申请类型（系统开放 + 功能授权）；否则 404。
   *
   * @param userId 用户
   * @param requestType 申请类型
   */
  private async assertCanAccessType(userId: number, requestType: string): Promise<DataScope | null> {
    const functionCode =
      requestType === 'OVERTIME'
        ? OVERTIME_APPROVAL_FUNCTION_CODE
        : requestType === 'POSITION_CHANGE'
          ? ORG_STRUCTURE_FUNCTION_CODE
          : null;
    if (!functionCode) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const access = await getFunctionAccess(this.prisma.client, userId, functionCode);
    if (!access.registered) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    if (!access.systemOpen) {
      throw new BusinessException(frameworkErrors.SYSTEM_NOT_OPEN, { system: access.systemName });
    }
    if (!access.allowed) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    // T5：DEPARTMENT 按公司可视，不校验部门快照；T6 再 assertScopeCoversAll
    return access.dataScope;
  }

  /** 构造列表 where */
  private buildWhere(
    query: ApprovalListQueryDto,
    visibleTypes: readonly HrRequestType[],
  ): Prisma.HrApprovalRequestWhereInput {
    const where: Prisma.HrApprovalRequestWhereInput = {
      requestType: { in: [...visibleTypes] },
    };
    if (query.requestType !== undefined) {
      if (!(visibleTypes as readonly string[]).includes(query.requestType)) {
        where.id = -1;
      } else {
        where.requestType = query.requestType as HrRequestType;
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
  }): HrApprovalListItem {
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
    };
  }
}
