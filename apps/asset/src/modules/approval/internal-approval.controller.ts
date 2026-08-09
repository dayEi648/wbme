import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InternalPendingCountQueryDto } from '@wbme/contracts';
import { AllowedCallers, InternalAuthGuard, Public } from '@wbme/server';
import { AssetApprovalService } from './asset-approval.service';

/**
 * asset 审批内部接口（主 PRD §9.4 / T5-3）。
 * 供 platform-core 门户角标聚合；跳过会话守卫，走内部令牌认证。
 */
@Public()
@UseGuards(InternalAuthGuard)
@Controller('internal/v1/approval-requests')
export class InternalApprovalController {
  constructor(private readonly approval: AssetApprovalService) {}

  /**
   * 按用户统计可见待审批数（门户角标）。
   *
   * @param query userId
   * @returns total + byType
   */
  @Get('pending-count')
  @AllowedCallers('platform-core')
  async pendingCount(
    @Query() query: InternalPendingCountQueryDto,
  ): Promise<{ total: number; byType: Record<string, number> }> {
    return this.approval.pendingCount(query.userId);
  }
}
