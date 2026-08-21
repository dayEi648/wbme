import { Inject, Injectable } from '@nestjs/common';
import type { ApprovalListQueryDto } from '@wbme/contracts';
import { BusinessException, createPaginationResponse, frameworkErrors, USER_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { buildTablePrismaQuery, collectTableFilterFields, normalizeTableFilters, runExport, RedisService } from '@wbme/server';
import { SETTING_KEYS, SettingsService } from '../settings/settings.service';
import type { Response } from 'express';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import {
  loadOperationLogOperator,
  writeBackstageOperationLog,
} from '../../backstage/permission/operation-log.util';

/** 审批中心结构化筛选白名单：keyword 匹配单号/申请人/处理人，status/requestType 为枚举。 */
const APPROVAL_REQUEST_TABLE_FIELDS = {
  keyword: { prismaField: ['applicationNo', 'applicantName', 'processorName'], type: 'text' },
  status: { prismaField: 'status', type: 'enum' },
  requestType: { prismaField: 'requestType', type: 'enum' },
} as const;

/** 审批中心列表项 */
export interface ApprovalListItem {
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

/**
 * backstage 审批中心查询（主 PRD §3.2；当前承载 PROFILE_CHANGE）。
 * user_manage 为公司范围：持有者可见全部资料修改审批。
 */
@Injectable()
export class ApprovalCenterService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 分页列表。
   *
   * @param query 筛选与分页
   * @returns 统一 `data + pagination` 分页响应
   */
  async list(query: ApprovalListQueryDto): Promise<{
    data: ApprovalListItem[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const { where, orderBy } = this.buildWhere(query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.approvalRequest.count({ where }),
      this.prisma.client.approvalRequest.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return createPaginationResponse(rows.map(toListItem), total, page, pageSize);
  }

  /**
   * 导出审批列表为 xlsx 流（与列表同一筛选、排序与快照）。
   *
   * @param userId 导出人（需 user_manage）
   * @param query 与列表相同的筛选条件
   * @param res Express 响应
   */
  async export(userId: number, query: ApprovalListQueryDto, res: Response): Promise<void> {
    const maxRows = await this.settings.getNumber(SETTING_KEYS.EXPORT_MAX_ROWS);
    const { where, orderBy } = this.buildWhere(query);
    await runExport<ApprovalListItem>({
      userId,
      redis: this.redis.redis,
      maxRows,
      filename: 'approval-requests.xlsx',
      columns: [
        { header: '审批号', value: (row) => row.applicationNo },
        { header: '类型', value: (row) => row.requestType },
        { header: '申请人', value: (row) => row.applicantName },
        { header: '状态', value: (row) => row.status },
        { header: '提交时间', value: (row) => row.submittedAt?.toISOString() ?? '' },
        { header: '处理人', value: (row) => row.processorName ?? '' },
        { header: '处理时间', value: (row) => row.processedAt?.toISOString() ?? '' },
        { header: '处理意见', value: (row) => row.opinion ?? '' },
      ],
      transaction: (fn, options) =>
        this.prisma.client.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: options?.timeout,
        }),
      fetchCount: async (tx) => {
        const client = tx as PrismaService['client'];
        return client.approvalRequest.count({ where });
      },
      fetchRows: async (tx, offset, limit) => {
        const client = tx as PrismaService['client'];
        const rows = await client.approvalRequest.findMany({
          where,
          orderBy,
          skip: offset,
          take: limit,
        });
        return rows.map(toListItem);
      },
      res,
    });
    await this.recordExportLog(userId);
  }

  /** 导出完成后写 EXPORT 操作日志（主 PRD §3.3） */
  private async recordExportLog(operatorId: number): Promise<void> {
    const operator = await loadOperationLogOperator(this.prisma.client, operatorId);
    await this.prisma.client.$transaction((tx) =>
      writeBackstageOperationLog(tx, {
        operator,
        feature: USER_MANAGE_FUNCTION_CODE,
        actionType: 'EXPORT',
        summary: '导出审批列表',
      }),
    );
  }

  /**
   * 详情 + 明细 + 动作时间线；范围外/不存在 → 404。
   *
   * @param id 审批头 id
   * @returns 详情
   */
  async getDetail(id: number): Promise<{
    request: ApprovalListItem & {
      proxyId: number | null;
      proxyName: string | null;
      cancelSource: string | null;
      cancelledAt: Date | null;
    };
    detail: {
      userId: number;
      userName: string;
      oldName: string;
      newName: string;
      oldGender: string;
      newGender: string;
    } | null;
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
        profileChangeRequest: true,
        actions: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!head || head.requestType !== 'PROFILE_CHANGE') {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    return {
      request: {
        id: head.id,
        applicationNo: head.applicationNo,
        requestType: head.requestType,
        applicantId: head.applicantId,
        applicantName: head.applicantName,
        status: head.status,
        version: head.version,
        submittedAt: head.submittedAt,
        processorId: head.processorId,
        processorName: head.processorName,
        processedAt: head.processedAt,
        opinion: head.opinion,
        proxyId: head.proxyId,
        proxyName: head.proxyName,
        cancelSource: head.cancelSource,
        cancelledAt: head.cancelledAt,
      },
      detail: head.profileChangeRequest
        ? {
            userId: head.profileChangeRequest.userId,
            userName: head.profileChangeRequest.userName,
            oldName: head.profileChangeRequest.oldName,
            newName: head.profileChangeRequest.newName,
            oldGender: head.profileChangeRequest.oldGender,
            newGender: head.profileChangeRequest.newGender,
          }
        : null,
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
   * @returns total + byType
   */
  async pendingCount(): Promise<{ total: number; byType: Record<string, number> }> {
    const total = await this.prisma.client.approvalRequest.count({
      where: { requestType: 'PROFILE_CHANGE', status: 'PENDING' },
    });
    return { total, byType: { PROFILE_CHANGE: total } };
  }

  /** 构造列表 where 与 orderBy；结构化筛选与具名参数按字段让位。 */
  private buildWhere(query: ApprovalListQueryDto): {
    where: Prisma.ApprovalRequestWhereInput;
    orderBy: Array<Record<string, 'asc' | 'desc'>>;
  } {
    const structuredFields = query.filters ? collectTableFilterFields(normalizeTableFilters(query.filters)) : new Set<string>();
    const where: Prisma.ApprovalRequestWhereInput = {
      // backstage 当前承载 PROFILE_CHANGE；本模块固定范围不受结构化筛选影响
      requestType: 'PROFILE_CHANGE',
    };
    // requestType 具名参数仅对非本模块类型强制空集；结构化 requestType 由白名单直接映射
    if (!structuredFields.has('requestType') && query.requestType !== undefined && query.requestType !== 'PROFILE_CHANGE') {
      // 强制无匹配（非本模块类型）
      where.id = -1;
    }
    // status 具名参数含 PROCESSED 虚拟值；结构化 status 直接映射真实列
    if (!structuredFields.has('status')) {
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
    }
    if (!structuredFields.has('applicantName') && query.applicantName) {
      where.applicantName = { contains: query.applicantName };
    }
    if (!structuredFields.has('processorName') && query.processorName) {
      where.processorName = { contains: query.processorName };
    }
    if (!structuredFields.has('keyword') && query.keyword) {
      where.OR = [
        { applicationNo: { contains: query.keyword } },
        { applicantName: { contains: query.keyword } },
        { processorName: { contains: query.keyword } },
      ];
    }
    const tableQuery = buildTablePrismaQuery(query, APPROVAL_REQUEST_TABLE_FIELDS);
    if (tableQuery.where) {
      where.AND = [tableQuery.where];
    }
    return { where, orderBy: tableQuery.orderBy ?? [{ submittedAt: 'desc' }, { id: 'desc' }] };
  }
}

/** 审批头行 → 列表/导出共用条目（同一字段口径） */
function toListItem(row: {
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
}): ApprovalListItem {
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
