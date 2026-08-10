import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApprovalListQueryDto,
  CancelApprovalDto,
  ProcessApprovalDto,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { AssetApprovalService } from './asset-approval.service';

/**
 * asset 审批中心（主 PRD §3.2：六类 + 代领结清）。
 * 会话守卫全局生效；功能授权与公司专属类型过滤在服务内完成。
 */
@Controller('approval-requests')
export class ApprovalController {
  constructor(private readonly approval: AssetApprovalService) {}

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

  /** 当前用户提交或代交的申请历史；不要求审批权限，待审批项可由申请人取消。 */
  @Get('mine')
  async listMine(@CurrentUser() userId: number, @Query() query: ApprovalListQueryDto): Promise<unknown> {
    return this.approval.listMine(userId, query);
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
   * 审批中心导出（runExport；可见性与列表一致——DEPARTMENT 档按闭包裁剪）。
   *
   * @param userId 当前用户
   * @param query 筛选
   * @param res 流式响应
   */
  @Get('export/all')
  async exportAll(@CurrentUser() userId: number, @Query() query: ApprovalListQueryDto, @Res() res: Response): Promise<void> {
    await this.approval.exportList(userId, query, res);
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
    await this.approval.process(requestId, dto.action, processorId, dto.opinion, dto.idempotencyKey);
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
    @Body() dto: CancelApprovalDto,
  ): Promise<{ ok: true }> {
    await this.approval.cancel(requestId, actorId, dto.idempotencyKey);
    return { ok: true };
  }
}
