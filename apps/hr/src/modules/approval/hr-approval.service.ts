import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import {
  APPLICATION_NO_PREFIX_OVERTIME,
  APPLICATION_NO_PREFIX_POSITION_CHANGE,
  assertOpinionIfRequired,
  assertPending,
  assertTransitionAllowed,
  generateApplicationNo,
  resolveProcessTransition,
  throwIfTransitionLost,
  toApproverScope,
  assertScopeCoversAll,
  withPendingLimitMapping,
  extractDepartmentIdsFromSnapshot,
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
import { RedisService, runExport } from '@wbme/server';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { getFunctionAccess, loadSessionUser, loadUserName } from '../../shared/cross-schema-auth';
import type { ApprovalSideEffect } from './approval-side-effect';
import { PositionApplicationService } from '../org/position-application.service';

/** hr 审批申请类型 */
export type HrRequestType = 'OVERTIME' | 'POSITION_CHANGE';

/** 审批头创建入参（overtime/position-application 共用） */
export interface CreateRequestHeadInput {
  requestType: HrRequestType;
  applicantId: number;
  applicantName: string;
  /** 申请人部门快照 [{id, name}]（提交时） */
  applicantDepartmentSnapshot: Prisma.InputJsonValue;
  proxyId?: number;
  proxyName?: string;
}

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

/** 可见类型条目（携带数据范围档位：DEPARTMENT 档须按部门闭包过滤） */
interface VisibleTypeEntry {
  requestType: HrRequestType;
  dataScope: DataScope | null;
}

/**
 * hr 审批头服务（主 PRD §3.2 / T5-3，T6 接入部门闭包与业务副作用）。
 *
 * - 加班/岗位变更审批头创建、处理、取消、列表、导出与待办统计；
 * - T6：DEPARTMENT 档按部门闭包过滤（hr.department_closure 视图）；
 *   批准业务副作用经 PositionApplicationService 注入（POSITION_CHANGE 由岗位申请服务注册，
 *   OVERTIME 无副作用）；T5 的"按公司可视/副作用 no-op"简化已移除。
 */
@Injectable()
export class HrApprovalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly closure: DepartmentClosureService,
    // 批准副作用：直接注入实现类（forwardRef 打破与 PositionApplicationService 的构造循环；
    // 两者互相引用，标准 Nest 循环注入模式。测试手工构造时省略参数 = null）
    @Optional() @Inject(forwardRef(() => PositionApplicationService)) private readonly sideEffect: ApprovalSideEffect | null = null,
    private readonly redis: RedisService = { redis: null } as unknown as RedisService,
  ) {}

  /**
   * 在调用方事务内创建审批头 + SUBMIT 动作（明细由调用方创建）。
   * 岗位变更单待审批冲突经条件唯一索引映射为 PENDING_LIMIT_REACHED。
   *
   * @param tx 事务客户端
   * @param input 审批头内容
   * @returns 审批头（含 id/applicationNo）
   * @throws PENDING_LIMIT_REACHED 岗位变更单待审批冲突
   */
  async createRequestHead(
    tx: Prisma.TransactionClient,
    input: CreateRequestHeadInput,
  ): Promise<{ id: number; applicationNo: string }> {
    const prefix =
      input.requestType === 'OVERTIME'
        ? APPLICATION_NO_PREFIX_OVERTIME
        : APPLICATION_NO_PREFIX_POSITION_CHANGE;
    const applicationNo = generateApplicationNo(prefix);
    return withPendingLimitMapping(async () => {
      const head = await tx.hrApprovalRequest.create({
        data: {
          applicationNo,
          requestType: input.requestType,
          applicantId: input.applicantId,
          applicantName: input.applicantName,
          applicantDepartmentSnapshot: input.applicantDepartmentSnapshot,
          proxyId: input.proxyId ?? null,
          proxyName: input.proxyName ?? null,
          status: 'PENDING',
          submittedAt: new Date(),
          createdBy: input.applicantId,
        },
      });
      await tx.hrApprovalAction.create({
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
   * 测试/内部：创建 PENDING 审批头 + SUBMIT 动作（及类型明细）。
   *
   * @param input 申请类型与申请人
   * @returns 审批头 id
   * @throws PENDING_LIMIT_REACHED 岗位变更单待审批冲突
   */
  /** 测试辅助：仅 hr-approval.service.spec 调用，未挂任何路由，禁止接入控制器（会绕过权限校验写真实审批单） */
  async submitTestHeader(input: SubmitTestHeaderInput): Promise<{ requestId: number }> {
    const now = new Date();
    const deptSnapshot = (input.applicantDepartmentSnapshot ?? { id: 1, name: '占位部门' }) as Prisma.InputJsonValue;

    return this.prisma.client.$transaction(async (tx) => {
      const head = await this.createRequestHead(tx, {
        requestType: input.requestType,
        applicantId: input.applicantId,
        applicantName: input.applicantName,
        applicantDepartmentSnapshot: deptSnapshot,
        proxyId: input.proxyId,
        proxyName: input.proxyName,
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
      return { requestId: head.id };
    });
  }

  /**
   * 审批处理（内核状态迁移 + 批准业务副作用 + DEPARTMENT 闭包范围断言）。
   *
   * @param id 审批头 id
   * @param action APPROVE | REJECT
   * @param processorId 处理人
   * @param opinion 意见（驳回必填）
   * @throws RESOURCE_NOT_FOUND 无权/不存在；STATUS_CONFLICT 并发冲突；SCOPE_NOT_COVERED 范围未覆盖
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
      const access = await this.assertCanAccessType(processorId, head.requestType);
      if (head.status !== 'PENDING') {
        throw new BusinessException(approvalErrors.STATUS_CONFLICT);
      }
      assertTransitionAllowed(head.status, transition.status);

      // T6：DEPARTMENT 档须覆盖批次全部申请对象（加班明细部门快照/岗位申请部门快照）；
      // 批准与驳回统一断言（主 PRD §3.2：列表、详情与处理接口执行相同的权限与范围校验）
      await this.assertScopeCovers(tx, head, access, processorId);

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

      // T6：批准业务副作用（POSITION_CHANGE 组织生效；OVERTIME 无副作用）。
      // 副作用校验抛错 → 事务回滚 → 申请保持待审批（主 PRD §3.2 批准前重校验）。
      if (action === 'APPROVE' && this.sideEffect) {
        await this.sideEffect.apply(tx, head, processorId);
      }

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
   * 分页列表（按授予功能过滤可见类型；DEPARTMENT 档按部门闭包过滤）。
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
    const where = await this.buildWhere(query, visibleTypes, userId);
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
   * 审批中心导出（hr PRD §4「支持导出」；复用 T4-11 runExport：行数上限/单用户并发/120s 超时/一致性快照）。
   * 可见性与数据范围与列表完全一致（resolveVisibleTypes + buildWhere）。
   *
   * @param userId 导出人
   * @param query 筛选条件
   * @param res Express 响应（流式写回）
   */
  async exportList(userId: number, query: ApprovalListQueryDto, res: Response): Promise<void> {
    const visibleTypes = await this.resolveVisibleTypes(userId);
    const where = visibleTypes.length === 0 ? { id: -1 } : await this.buildWhere(query, visibleTypes, userId);
    const maxRows = await this.readExportMaxRows();
    await runExport<{
      application_no: string;
      request_type: string;
      applicant_name: string;
      processor_name: string | null;
      status: string;
      opinion: string | null;
      submitted_at: Date | null;
      processed_at: Date | null;
    }>({
      userId,
      redis: this.redis.redis,
      maxRows,
      filename: 'hr-approvals.xlsx',
      columns: [
        { header: '申请编号', value: (row) => row.application_no },
        { header: '申请类型', value: (row) => row.request_type },
        { header: '申请人', value: (row) => row.applicant_name },
        { header: '处理人', value: (row) => row.processor_name ?? '' },
        { header: '状态', value: (row) => row.status },
        { header: '处理意见', value: (row) => row.opinion ?? '' },
        { header: '提交时间', value: (row) => row.submitted_at?.toISOString() ?? '' },
        { header: '处理时间', value: (row) => row.processed_at?.toISOString() ?? '' },
      ],
      transaction: (fn, options) =>
        this.prisma.client.$transaction(fn, {
          isolationLevel: 'RepeatableRead',
          timeout: options?.timeout,
        }),
      fetchCount: async (tx) => {
        const client = tx as PrismaService['client'];
        return client.hrApprovalRequest.count({ where });
      },
      fetchRows: async (tx, offset, limit) => {
        const client = tx as PrismaService['client'];
        const rows = await client.hrApprovalRequest.findMany({
          where,
          orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
        });
        return rows.map((r) => ({
          application_no: r.applicationNo,
          request_type: String(r.requestType),
          applicant_name: r.applicantName,
          processor_name: r.processorName,
          status: String(r.status),
          opinion: r.opinion,
          submitted_at: r.submittedAt,
          processed_at: r.processedAt,
        }));
      },
      res,
    });
  }

  /** 导出行数上限（backstage.platform_settings 视图；缺省 100000） */
  private async readExportMaxRows(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<Array<{ value: string }>>`
      SELECT value FROM backstage.platform_settings WHERE key = 'export.max.rows' LIMIT 1
    `;
    const value = Number(rows[0]?.value ?? 100000);
    return Number.isFinite(value) && value > 0 ? value : 100000;
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
    const access = await this.assertCanAccessType(userId, head.requestType);
    await this.assertHeadCovered(userId, head, access);
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
   * 可见待审批数量（按类型 breakdown；DEPARTMENT 档按闭包裁剪）。
   *
   * @param userId 用户 id
   * @param isSuperAdmin 是否超管（可省略，将从视图读取）
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
    const where = await this.buildWhere({}, visibleTypes, userId);
    const groups = await this.prisma.client.hrApprovalRequest.groupBy({
      by: ['requestType'],
      where: { ...where, status: 'PENDING' },
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
   * 解析用户可见的申请类型集合（携带数据范围档位）。
   *
   * 超管/公司档全量可见；DEPARTMENT 档按部门闭包过滤（T6 接入，
   * 替代 T5 的"DEPARTMENT 按公司可视"简化）。
   *
   * @param userId 用户
   * @param isSuperAdminHint 可选超管提示
   * @returns 可见类型（含档位）
   */
  private async resolveVisibleTypes(
    userId: number,
    isSuperAdminHint?: boolean,
  ): Promise<VisibleTypeEntry[]> {
    const user = isSuperAdminHint === undefined ? await loadSessionUser(this.prisma.client, userId) : null;
    const isSuperAdmin = isSuperAdminHint ?? user?.isSuperAdmin ?? false;
    const types: VisibleTypeEntry[] = [];
    for (const [functionCode, requestTypes] of Object.entries(FUNCTION_TO_TYPES)) {
      const access = await getFunctionAccess(this.prisma.client, userId, functionCode);
      if (!access.registered || !access.systemOpen) {
        continue;
      }
      if (isSuperAdmin || access.allowed) {
        for (const requestType of requestTypes) {
          types.push({ requestType, dataScope: isSuperAdmin ? null : access.dataScope });
        }
      }
    }
    return types;
  }

  /**
   * 断言用户可访问该申请类型（系统开放 + 功能授权）；否则 404。
   *
   * @param userId 用户
   * @param requestType 申请类型
   * @returns 数据范围档位
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
    return access.dataScope;
  }

  /**
   * 断言当前审批人 DEPARTMENT 档范围覆盖批次全部申请对象（T6 部门闭包）。
   * 对象部门 = 加班明细部门快照（多部门员工全部部门）/ 岗位申请申请人部门快照；
   * 无部门（空快照）仅公司范围可覆盖。范围未覆盖抛 SCOPE_NOT_COVERED。
   *
   * @param tx 事务客户端
   * @param head 审批头
   * @param dataScope 审批人档位
   * @param userId 审批人
   */
  private async assertScopeCovers(
    tx: Prisma.TransactionClient,
    head: { id: number; requestType: string },
    dataScope: DataScope | null,
    userId: number,
  ): Promise<void> {
    const closure = await this.closure.closureOfUser(userId);
    const scope = toApproverScope(dataScope, closure);
    const objectDepartmentIds = await this.resolveObjectDepartmentIds(tx, head);
    assertScopeCoversAll(scope, objectDepartmentIds, head.requestType);
  }

  /**
   * 列表/详情/待办：DEPARTMENT 档裁剪为闭包覆盖的记录（不存在的记录表现为 404/不可见）。
   *
   * @param userId 当前用户
   * @param head 审批头（含明细）
   * @param dataScope 档位
   */
  private async assertHeadCovered(
    userId: number,
    head: { id: number; requestType: string; overtimeItems: Array<{ departmentSnapshot: Prisma.JsonValue }> },
    dataScope: DataScope | null,
  ): Promise<void> {
    if (dataScope === null || dataScope === 'COMPANY') {
      return;
    }
    const closure = await this.closure.closureOfUser(userId);
    const scope = toApproverScope(dataScope, closure);
    // 明细快照为数组（多部门员工全部部门），逐元素展开
    const ids = head.overtimeItems.flatMap((item) =>
      extractDepartmentIdsFromSnapshot(item.departmentSnapshot as unknown),
    );
    assertScopeCoversAll(scope, ids, head.requestType);
  }

  /** 从审批头解析申请对象部门 id 列表（多对象批次展平；空 → 仅公司范围可覆盖） */
  private async resolveObjectDepartmentIds(
    tx: Prisma.TransactionClient,
    head: { id: number; requestType: string },
  ): Promise<Array<number | null>> {
    if (head.requestType === 'OVERTIME') {
      const items = await tx.overtimeItem.findMany({ where: { requestId: head.id } });
      // 明细快照为数组（多部门员工全部部门），逐元素展开（extractDepartmentIdsFromSnapshot）
      return items.flatMap((item) => extractDepartmentIdsFromSnapshot(item.departmentSnapshot as unknown));
    }
    const detail = await tx.positionChangeRequest.findUnique({ where: { requestId: head.id } });
    if (!detail) {
      return [];
    }
    return (detail.departmentSnapshot as unknown as Array<{ id: number }> | null)?.map((item) => item.id) ?? [];
  }

  /**
   * 构造列表 where（DEPARTMENT 档追加闭包覆盖记录过滤）。
   *
   * @param query 筛选条件
   * @param visibleTypes 可见类型（含档位）
   * @param userId 当前用户（闭包计算）
   */
  private async buildWhere(
    query: Partial<ApprovalListQueryDto>,
    visibleTypes: readonly VisibleTypeEntry[],
    userId: number,
  ): Promise<Prisma.HrApprovalRequestWhereInput> {
    const where: Prisma.HrApprovalRequestWhereInput = {
      requestType: { in: visibleTypes.map((entry) => entry.requestType) },
    };
    if (query.requestType !== undefined) {
      const known = visibleTypes.some((entry) => entry.requestType === query.requestType);
      if (!known) {
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
    // T6：DEPARTMENT 档加班记录按闭包裁剪（快照部门全部 ∈ 审批人闭包）
    const departmentScopedOvertime = visibleTypes.some(
      (entry) => entry.requestType === 'OVERTIME' && entry.dataScope === 'DEPARTMENT',
    );
    const departmentScopedPosition = visibleTypes.some(
      (entry) => entry.requestType === 'POSITION_CHANGE' && entry.dataScope === 'DEPARTMENT',
    );
    if (departmentScopedOvertime || departmentScopedPosition) {
      // 仅当未被"不可见类型"哨兵占用时才按闭包裁剪：
      // 不可见类型筛选应返回空（范围外表现为不存在，主 PRD §3.2），不能被闭包覆盖
      if (where.id === undefined) {
        const closure = await this.closure.closureOfUser(userId);
        const coveredIds = await this.findCoveredRequestIds(closure, {
          overtime: departmentScopedOvertime,
          position: departmentScopedPosition,
        });
        where.id = { in: coveredIds };
      }
    }
    return where;
  }

  /** 闭包覆盖的审批头 id 集合（明细部门快照全部 ∈ 闭包；空快照不覆盖） */
  private async findCoveredRequestIds(
    closure: ReadonlySet<number>,
    scoped: { overtime: boolean; position: boolean },
  ): Promise<number[]> {
    // 空闭包（无部门审批人）守卫：与 overtime-summary 的 statsForUsers 对齐，避免 $queryRaw 空数组参数
    if (closure.size === 0) {
      return [];
    }
    const closureIds = [...closure];
    const ids = new Set<number>();
    if (scoped.overtime) {
      const rows = await this.prisma.client.$queryRaw<Array<{ id: number }>>`
        SELECT DISTINCT oi.request_id AS id FROM hr.overtime_items oi
        WHERE jsonb_array_length(oi.department_snapshot) > 0
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(oi.department_snapshot) el
            WHERE (el->>'id')::int <> ALL(${closureIds})
          )
      `;
      rows.forEach((row) => ids.add(row.id));
    }
    if (scoped.position) {
      const rows = await this.prisma.client.$queryRaw<Array<{ id: number }>>`
        SELECT DISTINCT pcr.request_id AS id FROM hr.position_change_requests pcr
        WHERE jsonb_array_length(pcr.department_snapshot) > 0
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(pcr.department_snapshot) el
            WHERE (el->>'id')::int <> ALL(${closureIds})
          )
      `;
      rows.forEach((row) => ids.add(row.id));
    }
    return [...ids];
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
