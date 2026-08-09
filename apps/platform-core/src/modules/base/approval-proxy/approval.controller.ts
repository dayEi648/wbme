import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApprovalListQueryDto,
  CancelApprovalDto,
  ProcessApprovalDto,
  USER_MANAGE_FUNCTION_CODE,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { FunctionPermissionGuard, RequireFunction } from '../../backstage/permission/function-permission.guard';
import { ApprovalCenterService } from './approval-center.service';
import { ProfileChangeService } from './profile-change.service';

/**
 * backstage 审批中心（主 PRD §3.2 / T5-2；本期 PROFILE_CHANGE）。
 * 列表/详情/处理需 user_manage；取消仅需登录且操作人为申请人。
 */
@ApiTags('审批')
@Controller('approval-requests')
@UseGuards(FunctionPermissionGuard)
export class ApprovalController {
  constructor(
    private readonly profileChange: ProfileChangeService,
    private readonly approvalCenter: ApprovalCenterService,
  ) {}

  /** 待审批数量 */
  @Get('pending-count')
  @RequireFunction(USER_MANAGE_FUNCTION_CODE)
  async pendingCount(): Promise<{ total: number; byType: Record<string, number> }> {
    return this.approvalCenter.pendingCount();
  }

  /** 审批列表 */
  @Get()
  @RequireFunction(USER_MANAGE_FUNCTION_CODE)
  async list(@Query() query: ApprovalListQueryDto): Promise<unknown> {
    return this.approvalCenter.list(query);
  }

  /** 审批列表导出（导出所有/导出已筛选；xlsx 附件） */
  @Post('export')
  @RequireFunction(USER_MANAGE_FUNCTION_CODE)
  async export(
    @Query() query: ApprovalListQueryDto,
    @CurrentUser() userId: number,
    @Res() res: Response,
  ): Promise<void> {
    await this.approvalCenter.export(userId, query, res);
  }

  /** 审批详情 */
  @Get(':id')
  @RequireFunction(USER_MANAGE_FUNCTION_CODE)
  async detail(@Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.approvalCenter.getDetail(id);
  }

  /** 处理资料修改审批（APPROVE / REJECT） */
  @Post(':id/process')
  @RequireFunction(USER_MANAGE_FUNCTION_CODE)
  async process(
    @Param('id', ParseIntPipe) requestId: number,
    @CurrentUser() processorId: number,
    @Body() dto: ProcessApprovalDto,
  ): Promise<{ ok: true }> {
    await this.profileChange.processProfileChange(requestId, dto.action, processorId, dto.opinion);
    return { ok: true };
  }

  /** 申请人取消待审批（cancelSource=USER） */
  @Post(':id/cancel')
  async cancel(
    @Param('id', ParseIntPipe) requestId: number,
    @CurrentUser() actorId: number,
    @Body() _dto: CancelApprovalDto,
  ): Promise<{ ok: true }> {
    await this.profileChange.cancelProfileChange(requestId, actorId);
    return { ok: true };
  }
}
