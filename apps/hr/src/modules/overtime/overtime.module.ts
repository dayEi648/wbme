import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { HolidayModule } from '../holiday/holiday.module';
import { SettingsModule } from '../settings/settings.module';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { OvertimeController } from './overtime.controller';
import { OvertimeExportService } from './overtime-export.service';
import { OvertimeSubmissionService } from './overtime-submission.service';
import { OvertimeSummaryService } from './overtime-summary.service';

/**
 * 加班模块（T6-5）：统一表单批次提交、取消、个人/管理视图与汇总、导出。
 * 依赖：审批头（ApprovalModule）、节假日适配器（HolidayModule）、人事设置（SettingsModule）。
 */
@Module({
  imports: [ApprovalModule, HolidayModule, SettingsModule],
  controllers: [OvertimeController],
  providers: [OvertimeSubmissionService, OvertimeSummaryService, OvertimeExportService, DepartmentClosureService],
})
export class OvertimeModule {}
