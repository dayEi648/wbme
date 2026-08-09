import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import {
  OvertimeManageQueryDto,
  OvertimeManageSummaryDto,
  OvertimeMineQueryDto,
  OvertimeSubmitDto,
  OvertimeSummaryQueryDto,
  OVERTIME_HISTORY_FUNCTION_CODE,
} from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess, getFunctionAccess } from '../../shared/cross-schema-auth';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { HrApprovalService } from '../approval/hr-approval.service';
import { OvertimeExportService } from './overtime-export.service';
import { OvertimeSubmissionService } from './overtime-submission.service';
import { OvertimeSummaryService } from './overtime-summary.service';

/**
 * 加班管理（hr PRD §3）：
 * 统一表单提交（"加班申请"本人档 / "代交加班"部门公司档）、取消（提交人/代提人）、
 * 个人视图（本人已批准记录 + 月度汇总，隐含本人历史）、
 * 管理视图（"加班历史记录"功能：员工列表 + 月度统计 + 下钻 + 导出）。
 */
@Controller('overtime')
export class OvertimeController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly submission: OvertimeSubmissionService,
    private readonly approval: HrApprovalService,
    private readonly summary: OvertimeSummaryService,
    private readonly exportService: OvertimeExportService,
    private readonly closure: DepartmentClosureService,
  ) {}

  /** 提交加班批次（全有或全无；提交前展示日期类型/时长由前端先查节假日） */
  @Post('applications')
  async submit(@CurrentUser() userId: number, @Body() dto: OvertimeSubmitDto): Promise<{ requestId: number; applicationNo: string }> {
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.submission.submit(operator, dto);
  }

  /** 取消本人/代提的待审批批次（批准或驳回后不能取消） */
  @Post('applications/:id/cancel')
  async cancel(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<{ ok: true }> {
    await this.approval.cancel(id, userId);
    return { ok: true };
  }

  /** 个人视图：本人已批准加班记录（隐含本人历史；分页） */
  @Get('mine')
  async mine(@CurrentUser() userId: number, @Query() query: OvertimeMineQueryDto): Promise<unknown> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const monthFilter = query.month ? monthRangeOf(query.month) : null;
    const where: Prisma.OvertimeItemWhereInput = {
      userId,
      request: { status: 'APPROVED' },
      ...(monthFilter ? { overtimeDate: { gte: monthFilter.start, lt: monthFilter.end } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.client.overtimeItem.count({ where }),
      this.prisma.client.overtimeItem.findMany({
        where,
        orderBy: [{ overtimeDate: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        overtimeDate: formatDate(row.overtimeDate),
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        minutes: row.endMinute - row.startMinute,
        hours: Math.round(((row.endMinute - row.startMinute) / 60) * 100) / 100,
        reason: row.reason,
        dateType: (row.holidaySnapshot as { dateType?: string })?.dateType ?? null,
        applicationNo: row.requestId,
      })),
      pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /** 个人月度汇总（分钟精度；小时两位小数） */
  @Get('mine/summary')
  async summaryMine(@CurrentUser() userId: number, @Query() query: OvertimeSummaryQueryDto): Promise<unknown> {
    return this.summary.summaryMine(userId, query.month);
  }

  /** 管理视图：员工列表 + 月度统计（加班历史记录功能，DEPARTMENT 闭包/COMPANY） */
  @Get('records')
  async records(@CurrentUser() userId: number, @Query() query: OvertimeManageQueryDto): Promise<unknown> {
    const userIds = await this.resolveHistoryScope(userId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const stats = await this.summary.statsForUsers(userIds, query.month);
    let filtered = stats;
    if (query.keyword) {
      const keyword = query.keyword.toLowerCase();
      filtered = stats.filter((item) => item.name.toLowerCase().includes(keyword));
    }
    const total = filtered.length;
    const items = filtered.slice((page - 1) * pageSize, page * pageSize);
    return {
      data: items,
      pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /** 管理月度汇总（全体范围内员工合计） */
  @Get('records/summary')
  async recordsSummary(@CurrentUser() userId: number, @Query() query: OvertimeManageSummaryDto): Promise<unknown> {
    const userIds = await this.resolveHistoryScope(userId);
    const stats = await this.summary.statsForUsers(userIds, query.month);
    const totalMinutes = stats.reduce((sum, item) => sum + item.minutes, 0);
    return { employeeCount: stats.length, totalMinutes, totalHours: Math.round((totalMinutes / 60) * 100) / 100 };
  }

  /** 管理视图导出（runExport 流式；导出完成写 EXPORT 操作日志） */
  @Get('records/export')
  async exportRecords(
    @CurrentUser() userId: number,
    @Query() query: OvertimeManageSummaryDto,
    @Res() res: Response,
  ): Promise<void> {
    const userIds = await this.resolveHistoryScope(userId);
    await this.exportService.export(userId, userIds, query.month, res);
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    await this.prisma.client.hrOperationLog.create({
      data: {
        operatorId: operator.id,
        operatorName: operator.name,
        operatorDepartments: operator.departments as object,
        system: 'HR',
        feature: OVERTIME_HISTORY_FUNCTION_CODE,
        actionType: 'EXPORT',
        summary: '导出了加班历史记录',
      },
    });
  }

  /**
   * 解析加班历史管理范围（overtime_history 功能）：
   * DEPARTMENT → 当前用户部门闭包内员工；COMPANY → 全部在职员工。
   * 无授权 → 404（范围外资源不泄露存在性）。
   */
  private async resolveHistoryScope(userId: number): Promise<Set<number>> {
    const access = await getFunctionAccess(this.prisma.client, userId, OVERTIME_HISTORY_FUNCTION_CODE);
    if (!access.registered || !access.allowed) {
      await assertFunctionAccess(this.prisma.client, userId, OVERTIME_HISTORY_FUNCTION_CODE);
      return new Set<number>();
    }
    if (access.dataScope === 'DEPARTMENT') {
      const closure = await this.closure.closureOfUser(userId);
      if (closure.size === 0) {
        return new Set<number>();
      }
      const rows = await this.prisma.client.$queryRaw<Array<{ user_id: number }>>`
        SELECT DISTINCT user_id FROM hr.user_org WHERE department_id = ANY(${[...closure] as number[]})
      `;
      return new Set(rows.map((row) => row.user_id));
    }
    // COMPANY（含超管）：全部在职员工
    const rows = await this.prisma.client.$queryRaw<Array<{ user_id: number }>>`
      SELECT user_id FROM backstage.user_accounts WHERE status = 'ACTIVE' AND deleted_at IS NULL
    `;
    return new Set(rows.map((row) => row.user_id));
  }
}

/** YYYY-MM → [当月 1 日, 下月 1 日]（Date.UTC） */
function monthRangeOf(month: string): { start: Date; end: Date } {
  const [year, monthIndex] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(year!, monthIndex! - 1, 1)), end: new Date(Date.UTC(year!, monthIndex!, 1)) };
}

/** Date → YYYY-MM-DD（UTC 日历值） */
function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
