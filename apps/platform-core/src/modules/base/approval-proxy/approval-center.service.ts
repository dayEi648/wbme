import { Inject, Injectable } from '@nestjs/common';
import type { ApprovalListQueryDto } from '@wbme/contracts';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';

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
 * backstage 审批中心查询（主 PRD §3.2 / T5-2；本期仅 PROFILE_CHANGE）。
 * user_manage 为公司范围：持有者可见全部资料修改审批。
 */
@Injectable()
export class ApprovalCenterService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 分页列表。
   *
   * @param query 筛选与分页
   * @returns items + total
   */
  async list(query: ApprovalListQueryDto): Promise<{ items: ApprovalListItem[]; total: number }> {
    const where = this.buildWhere(query);
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
      items: rows.map((row) => ({
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
      })),
    };
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

  /** 构造列表 where */
  private buildWhere(query: ApprovalListQueryDto): Prisma.ApprovalRequestWhereInput {
    const where: Prisma.ApprovalRequestWhereInput = {
      // backstage 本期仅 PROFILE_CHANGE；非法 requestType 由空结果体现
      requestType: 'PROFILE_CHANGE',
    };
    if (query.requestType !== undefined && query.requestType !== 'PROFILE_CHANGE') {
      // 强制无匹配（非本模块类型）
      where.id = -1;
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
}
