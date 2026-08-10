import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import {
  BusinessException,
  CancelApprovalDto,
  DateTypeQueryDto,
  OvertimeManageQueryDto,
  OvertimeManageSummaryDto,
  OvertimeMineQueryDto,
  OvertimeSubmitDto,
  OvertimeSummaryQueryDto,
  OVERTIME_HISTORY_FUNCTION_CODE,
  frameworkErrors,
} from '@wbme/contracts';
import { CurrentUser, EXPORT_TIMEOUT_MS, filterAndSortTableRows, RequestTimeout } from '@wbme/server';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { assertFunctionAccess, getFunctionAccess } from '../../shared/cross-schema-auth';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { HolidayAdapter } from '../holiday/holiday.adapter';
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
    private readonly holiday: HolidayAdapter,
  ) {}

  /** 日期类型查询（hr PRD §3：提交前展示日期类型、时长与补交提示；统一经后端节假日适配器，不让前端直连第三方） */
  @Get('date-type')
  async dateType(@Query() query: DateTypeQueryDto): Promise<{ date: string; dateType: string; weekday: number; source: string; digest: string; fetchedAt: string }> {
    const normalized = await this.holiday.resolve(query.date);
    return { date: query.date, ...normalized };
  }

  /** 提交加班批次（全有或全无；提交前展示日期类型/时长由前端先查节假日） */
  @Post('applications')
  async submit(@CurrentUser() userId: number, @Body() dto: OvertimeSubmitDto): Promise<{ requestId: number; applicationNo: string }> {
    const operator = await loadHrOperationLogOperator(this.prisma.client, userId);
    return this.submission.submit(operator, dto);
  }

  /** 取消本人/代提的待审批加班批次（批准或驳回后不能取消；断言目标为加班申请，L12） */
  @Post('applications/:id/cancel')
  async cancel(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelApprovalDto,
  ): Promise<{ ok: true }> {
    await this.approval.cancel(id, userId, 'OVERTIME', dto.idempotencyKey);
    return { ok: true };
  }

  /**
   * 当前用户可取消的待审批加班批次。
   *
   * 申请人或代交人均可见，用于在没有审批权限时仍能完成本人申请的取消闭环；
   * 不返回其它申请人的记录，也不依赖审批功能授权。
   *
   * @param userId 当前用户
   * @param query 分页与月份筛选
   * @returns 待审批批次及其最小展示摘要
   */
  @Get('applications/mine')
  async myPendingApplications(@CurrentUser() userId: number, @Query() query: OvertimeMineQueryDto): Promise<unknown> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const monthFilter = query.month ? monthRangeOf(query.month) : null;
    const where: Prisma.HrApprovalRequestWhereInput = {
      requestType: 'OVERTIME',
      status: 'PENDING',
      OR: [{ applicantId: userId }, { proxyId: userId }],
      ...(monthFilter ? { overtimeItems: { some: { overtimeDate: { gte: monthFilter.start, lt: monthFilter.end } } } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.client.hrApprovalRequest.count({ where }),
      this.prisma.client.hrApprovalRequest.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          overtimeItems: {
            select: { overtimeDate: true, startMinute: true, endMinute: true, userName: true },
            orderBy: [{ overtimeDate: 'asc' }, { id: 'asc' }],
          },
        },
      }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        applicationNo: row.applicationNo,
        applicantName: row.applicantName,
        proxyName: row.proxyName,
        submittedAt: row.submittedAt,
        itemCount: row.overtimeItems.length,
        overtimeDate: row.overtimeItems[0] ? formatDate(row.overtimeItems[0].overtimeDate) : null,
        timeRange: row.overtimeItems[0] ? `${formatMinute(row.overtimeItems[0].startMinute)}-${formatMinute(row.overtimeItems[0].endMinute)}` : null,
        employees: row.overtimeItems.map((item) => item.userName).join('、'),
        status: row.status,
      })),
      pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) },
    };
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
        // 申请编号取审批头（与提交/导出/审批中心口径一致；row.requestId 为数字批次 id）
        include: { request: { select: { applicationNo: true } } },
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
        applicationNo: row.request?.applicationNo ?? String(row.requestId),
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
    const userIds = await this.filterHistoryScopeByDepartment(await this.resolveHistoryScope(userId), query.departmentId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const stats = await this.summary.statsForUsers(userIds, query.month);
    const filtered = filterAndSortTableRows(
      stats,
      query.filters ? query : {
        ...query,
        filters: query.keyword
          ? JSON.stringify({ logic: 'AND', conditions: [{ field: 'keyword', operator: 'CONTAINS', value: query.keyword }] })
          : undefined,
      },
      {
        id: { type: 'number', value: (item) => item.userId },
        userId: { type: 'number', value: (item) => item.userId },
        name: { type: 'text', value: (item) => item.name },
        keyword: { type: 'text', value: (item) => item.name },
        month: { type: 'text', value: () => query.month ?? '' },
        minutes: { type: 'number', value: (item) => item.minutes },
        hours: { type: 'number', value: (item) => item.hours },
        count: { type: 'number', value: (item) => item.count },
      },
    );
    const total = filtered.length;
    const items = filtered.slice((page - 1) * pageSize, page * pageSize);
    return {
      data: items.map((item) => ({ ...item, id: item.userId, month: query.month ?? null })),
      pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /** 管理月度汇总（全体范围内员工合计） */
  @Get('records/summary')
  async recordsSummary(@CurrentUser() userId: number, @Query() query: OvertimeManageSummaryDto): Promise<unknown> {
    const userIds = await this.filterHistoryScopeByDepartment(await this.resolveHistoryScope(userId), query.departmentId);
    const stats = await this.summary.statsForUsers(userIds, query.month);
    const totalMinutes = stats.reduce((sum, item) => sum + item.minutes, 0);
    return { employeeCount: stats.length, totalMinutes, totalHours: Math.round((totalMinutes / 60) * 100) / 100 };
  }

  /** 管理视图导出（runExport 流式；导出完成写 EXPORT 操作日志） */
  @Get('records/export')
  @RequestTimeout(EXPORT_TIMEOUT_MS)
  async exportRecords(
    @CurrentUser() userId: number,
    @Query() query: OvertimeManageQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const userIds = await this.filterHistoryScopeByDepartment(await this.resolveHistoryScope(userId), query.departmentId);
    await this.exportService.export(userId, userIds, query.month, query.keyword, res);
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

  /** 管理视图下钻：只读取当前权限范围内指定员工的当月已批准明细。 */
  @Get('records/:targetUserId')
  async recordDetails(
    @CurrentUser() userId: number,
    @Param('targetUserId', ParseIntPipe) targetUserId: number,
    @Query() query: OvertimeManageSummaryDto,
  ): Promise<{ data: unknown[] }> {
    const userIds = await this.filterHistoryScopeByDepartment(await this.resolveHistoryScope(userId), query.departmentId);
    if (!userIds.has(targetUserId)) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    return { data: await this.summary.detailForUser(targetUserId, query.month) };
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

  /** 将既有授权范围与可选部门精确相交，避免部门筛选扩大可见员工集合。 */
  private async filterHistoryScopeByDepartment(userIds: ReadonlySet<number>, departmentId: number | undefined): Promise<Set<number>> {
    if (departmentId === undefined || userIds.size === 0) return new Set(userIds);
    const rows = await this.prisma.client.$queryRaw<Array<{ user_id: number }>>`
      SELECT DISTINCT user_id
      FROM hr.user_org
      WHERE department_id = ${departmentId} AND user_id = ANY(${[...userIds] as number[]})
    `;
    return new Set(rows.map((row) => row.user_id));
  }
}

/** YYYY-MM → [当月 1 日, 下月 1 日]（Date.UTC）；非法月份显式抛校验错误（L14，不静默进位） */
function monthRangeOf(month: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) {
    throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { message: '月份格式非法：YYYY-MM' });
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return { start: new Date(Date.UTC(year, monthIndex, 1)), end: new Date(Date.UTC(year, monthIndex + 1, 1)) };
}

/** Date → YYYY-MM-DD（UTC 日历值） */
function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 当日分钟数 → HH:mm（1440 按 24:00 展示）。 */
function formatMinute(minute: number): string {
  if (minute === 1_440) return '24:00';
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
