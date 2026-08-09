import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import {
  ApprovalListQueryDto,
  CancelApprovalDto,
  ProcessApprovalDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import type { Response } from 'express';
import { PrismaService } from '../../prisma.service';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { HrApprovalService } from './hr-approval.service';

/**
 * hr 审批中心（主 PRD §3.2：OVERTIME / POSITION_CHANGE）。
 * 会话守卫全局生效；功能授权与数据范围在服务内按授予类型过滤（无 Nest 功能守卫）。
 */
@Controller('approval-requests')
export class ApprovalController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly approval: HrApprovalService,
  ) {}

  /**
   * 待审批数量。
   *
   * @param userId 当前用户
   * @returns total + byType
   */
  @Get('pending-count')
  async pendingCount(@CurrentUser() userId: number): Promise<{ total: number; byType: Record<string, number> }> {
    return this.approval.pendingCount(userId);
  }

  /**
   * 审批列表。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @returns 分页列表
   */
  @Get()
  async list(@CurrentUser() userId: number, @Query() query: ApprovalListQueryDto): Promise<unknown> {
    return this.approval.list(userId, query);
  }

  /**
   * 审批列表导出（hr PRD §4「支持导出」；可见性与数据范围与列表一致）。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @param res 流式响应
   */
  @Get('export')
  async exportList(
    @CurrentUser() userId: number,
    @Query() query: ApprovalListQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.approval.exportList(userId, query, res);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    await this.prisma.client.hrOperationLog.create({
      data: {
        operatorId: operator.id,
        operatorName: operator.name,
        operatorDepartments: operator.departments as object,
        system: 'HR',
        feature: 'approval_center',
        actionType: 'EXPORT',
        summary: '导出了审批中心列表',
      },
    });
  }

  /**
   * 审批详情。
   *
   * @param userId 当前用户
   * @param id 审批头 id
   * @returns 详情
   */
  @Get(':id')
  async detail(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.approval.getDetail(userId, id);
  }

  /**
   * 处理审批（APPROVE / REJECT；业务副作用随状态迁移同事务执行）。
   *
   * @param requestId 审批头 id
   * @param processorId 处理人
   * @param dto 处理入参
   * @returns ok
   */
  @Post(':id/process')
  async process(
    @Param('id', ParseIntPipe) requestId: number,
    @CurrentUser() processorId: number,
    @Body() dto: ProcessApprovalDto,
  ): Promise<{ ok: true }> {
    await this.approval.process(requestId, dto.action, processorId, dto.opinion);
    return { ok: true };
  }

  /**
   * 申请人/代交人取消待审批。
   *
   * @param requestId 审批头 id
   * @param actorId 操作人
   * @returns ok
   */
  @Post(':id/cancel')
  async cancel(
    @Param('id', ParseIntPipe) requestId: number,
    @CurrentUser() actorId: number,
    @Body() _dto: CancelApprovalDto,
  ): Promise<{ ok: true }> {
    await this.approval.cancel(requestId, actorId);
    return { ok: true };
  }
}
