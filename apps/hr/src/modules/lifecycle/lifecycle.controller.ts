import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { HrCancelPositionApplicationsDto, HrRestoreApplyDto, HrRestorePreviewDto } from '@wbme/contracts';
import { AllowedCallers, InternalAuthGuard, Public } from '@wbme/server';
import { LifecycleService } from './lifecycle.service';

/**
 * 账号生命周期内部接口（backstage PRD §3 / hr PRD §5）：
 * - restore-preview / restore-apply：调用方 platform-core（恢复预览与最终确认必须实际调用 hr）；
 * - cancel-position-applications：调用方 worker（注销生命周期任务消费，幂等）。
 * hr 停机时调用方侧映射 HR_SERVICE_UNAVAILABLE（DEPENDENCY），本模块不承担该降级。
 */
@Public()
@UseGuards(InternalAuthGuard)
@Controller('internal/v1/lifecycle')
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}

  /** 恢复预览（只读兼容性检查；不写数据） */
  @Post('restore-preview')
  @AllowedCallers('platform-core')
  async restorePreview(@Body() dto: HrRestorePreviewDto): Promise<{ targets: unknown[] }> {
    return this.lifecycle.restorePreview(dto);
  }

  /** 恢复应用（单事务整批；restoreRequestId 幂等；4xx 由调用方映射 CONFLICT 重新预览） */
  @Post('restore-apply')
  @AllowedCallers('platform-core')
  async restoreApply(@Body() dto: HrRestoreApplyDto): Promise<{ applied: true }> {
    return this.lifecycle.restoreApply(dto);
  }

  /** 幂等取消"注销前已提交且仍待审批"的岗位申请（worker 生命周期任务消费） */
  @Post('cancel-position-applications')
  @AllowedCallers('worker')
  async cancelPositionApplications(@Body() dto: HrCancelPositionApplicationsDto): Promise<{ ok: true; cancelledCount: number }> {
    return this.lifecycle.cancelPositionApplications(dto.userId, dto.deactivatedAt);
  }
}
