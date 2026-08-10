import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  approvalErrors,
  frameworkErrors,
  hrErrors,
  OVERTIME_APPLY_FUNCTION_CODE,
  PROXY_OVERTIME_FUNCTION_CODE,
  type OvertimeSubmitDto,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { HrApprovalService } from '../approval/hr-approval.service';
import { HolidayAdapter } from '../holiday/holiday.adapter';
import { SettingsService } from '../settings/settings.service';
import { getFunctionAccess, loadSessionUser } from '../../shared/cross-schema-auth';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { executeIdempotentOperation, fingerprintPayload, type HrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { isWithinWindow, windowRange } from './overtime-date-window';
import { findOverlapping } from './overtime-overlap';

/** 逐人失败原因（OVERTIME_BATCH_REJECTED details 白名单结构） */
export interface OvertimeBatchFailure {
  userId: number;
  code: string;
  message: string;
}

/**
 * 加班批次提交服务（hr PRD §3）：
 * 多人加班批次按整批全有或全无提交——先校验全部人员的在职状态、代提授权范围、
 * 时间重叠、日期窗口与日期/时间合法性；任一人员失败时不创建审批批次或任何加班明细，
 * 逐人返回失败原因（OVERTIME_BATCH_REJECTED + details.failures）；全部通过后在同一事务
 * 创建批次及全部人员明细（含节假日判断快照），后续由审批人整批批准或驳回。
 *
 * 功能入口："加班申请"（本人档，名单固定本人）或"代交加班"（部门/公司档）任一即可。
 */
@Injectable()
export class OvertimeSubmissionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly approval: HrApprovalService,
    private readonly holiday: HolidayAdapter,
    private readonly settings: SettingsService,
    private readonly closure: DepartmentClosureService,
  ) {}

  /**
   * 提交加班批次（幂等）。
   *
   * @param operator 操作人（提交人/代提人）
   * @param dto 批次内容（日期/时间段/事由/人员名单）
   * @returns { requestId, applicationNo }
   * @throws OVERTIME_BATCH_REJECTED 任一人员校验失败（details.failures 逐人原因，零写入）
   * @throws HOLIDAY_API_UNAVAILABLE 节假日判断不可用且离线未覆盖（DEPENDENCY，无半成品）
   */
  async submit(
    operator: HrOperationLogOperator,
    dto: OvertimeSubmitDto,
  ): Promise<{ requestId: number; applicationNo: string }> {
    // 功能断言：overtime_apply(SELF) 或 proxy_overtime 任一
    const applyAccess = await getFunctionAccess(this.prisma.client, operator.id, OVERTIME_APPLY_FUNCTION_CODE);
    const proxyAccess = await getFunctionAccess(this.prisma.client, operator.id, PROXY_OVERTIME_FUNCTION_CODE);
    const hasApply = applyAccess.registered && applyAccess.systemOpen && applyAccess.allowed;
    const hasProxy = proxyAccess.registered && proxyAccess.systemOpen && proxyAccess.allowed;
    if (!hasApply && !hasProxy) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    // 超管豁免 dataScope=null（全公司语义）；非 SELF 档（部门/公司）可代交。
    // 公司档（COMPANY / 超管 null）代提范围为全部在职员工，不做部门闭包收缩（hr PRD §3）
    const canProxy = hasProxy && proxyAccess.dataScope !== 'SELF';
    const proxyScope = proxyAccess.dataScope;

    // 本人档强制名单=本人；名单含他人且无代交权限 → 拒绝
    let userIds = dto.userIds;
    if (!canProxy) {
      if (userIds.length !== 1 || userIds[0] !== operator.id) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
          reason: '仅持"加班申请"功能时名单只能包含本人',
        });
      }
    } else {
      userIds = [...new Set(dto.userIds)];
    }

    // 日期窗口为批次级前置校验（不属逐人原因；窗口外直接拒绝，hr PRD §3）
    const range = windowRange({
      advanceDays: await this.settings.getNumber('overtime.advance.days'),
      backfillDays: await this.settings.getNumber('overtime.backfill.days'),
    });
    if (!isWithinWindow(dto.overtimeDate, range)) {
      throw new BusinessException(hrErrors.OVERTIME_DATE_OUT_OF_WINDOW);
    }

    // 事务外只读校验（逐人收集失败原因；任一失败整批拒绝、零写入）
    const failures = await this.validateBatch(operator, dto, userIds, canProxy, proxyScope);
    if (failures.length > 0) {
      throw new BusinessException(hrErrors.OVERTIME_BATCH_REJECTED, { failures });
    }

    // 日期类型判断（一次调用，批次共享快照；依赖失败 → 整体 DEPENDENCY，无半成品）
    const holiday = await this.holiday.resolve(dto.overtimeDate);

    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: canProxy ? PROXY_OVERTIME_FUNCTION_CODE : OVERTIME_APPLY_FUNCTION_CODE,
      scope: 'hr.overtime.submit',
      idempotencyKey: dto.idempotencyKey,
      fingerprint: fingerprintPayload(dto),
      run: async (tx) => {
        // 事务内重验重叠（FOR UPDATE 锁该员工当日明细，防并发双提同时通过重叠校验）
        await this.assertNoOverlapInTransaction(tx, dto);
        const head = await this.approval.createRequestHead(tx, {
          requestType: 'OVERTIME',
          applicantId: operator.id,
          applicantName: operator.name,
          applicantDepartmentSnapshot: operator.departments as Prisma.InputJsonValue,
          proxyId: canProxy && !userIds.every((id) => id === operator.id) ? operator.id : undefined,
          proxyName: canProxy && !userIds.every((id) => id === operator.id) ? operator.name : undefined,
        });
        for (const targetUserId of userIds) {
          const target = await this.loadTarget(tx, targetUserId);
          await tx.overtimeItem.create({
            data: {
              requestId: head.id,
              userId: targetUserId,
              userName: target.name,
              departmentSnapshot: target.departments as Prisma.InputJsonValue,
              overtimeDate: toDbDate(dto.overtimeDate),
              startMinute: dto.startMinute,
              endMinute: dto.endMinute,
              reason: dto.reason,
              holidaySnapshot: {
                dateType: holiday.dateType,
                source: holiday.source,
                digest: holiday.digest,
                fetchedAt: holiday.fetchedAt,
              } as Prisma.InputJsonValue,
            },
          });
        }
        return {
          result: { requestId: head.id, applicationNo: head.applicationNo },
          actionType: 'CREATE' as const,
          summary: `提交了加班申请：${dto.overtimeDate} ${formatTime(dto.startMinute)}-${formatTime(dto.endMinute)}，${userIds.length} 人`,
        };
      },
    });
  }

  /** 逐人校验（事务外只读；返回失败原因数组，空数组 = 全部通过） */
  private async validateBatch(
    operator: HrOperationLogOperator,
    dto: OvertimeSubmitDto,
    userIds: number[],
    canProxy: boolean,
    proxyScope: string | null | undefined,
  ): Promise<OvertimeBatchFailure[]> {
    const failures: OvertimeBatchFailure[] = [];
    // 代提范围闭包：仅 DEPARTMENT 档按代提人部门闭包收缩；
    // COMPANY / 超管（null）档为全公司范围，不做闭包限制（hr PRD §3）
    const proxyClosure = canProxy && proxyScope === 'DEPARTMENT' ? await this.closure.closureOfUser(operator.id) : null;
    for (const targetUserId of userIds) {
      if (targetUserId === operator.id) {
        continue;
      }
      // 在职状态（经 backstage.user_accounts 视图）
      const target = await loadSessionUser(this.prisma.client, targetUserId);
      if (!target || target.status !== 'ACTIVE') {
        failures.push({
          userId: targetUserId,
          code: hrErrors.OVERTIME_EMPLOYEE_NOT_ACTIVE.code,
          message: hrErrors.OVERTIME_EMPLOYEE_NOT_ACTIVE.message,
        });
        continue;
      }
      // 代提范围（DEPARTMENT 档）：代提人闭包须覆盖该员工全部当前部门
      if (proxyClosure) {
        const targetOwnDepartments = await this.loadOwnDepartments(targetUserId);
        if (targetOwnDepartments.some((departmentId) => !proxyClosure.has(departmentId))) {
          failures.push({
            userId: targetUserId,
            code: approvalErrors.SCOPE_NOT_COVERED.code,
            message: approvalErrors.SCOPE_NOT_COVERED.message,
          });
        }
      }
      // 重叠校验（与本人当日 PENDING/APPROVED 明细）
      const overlapping = await this.findExistingOverlaps(targetUserId, dto);
      if (overlapping) {
        failures.push({
          userId: targetUserId,
          code: hrErrors.OVERTIME_OVERLAP.code,
          message: hrErrors.OVERTIME_OVERLAP.message,
        });
      }
    }
    return failures;
  }

  /** 查询员工当日重叠的既有明细（PENDING/APPROVED） */
  private async findExistingOverlaps(targetUserId: number, dto: OvertimeSubmitDto): Promise<boolean> {
    const items = await this.prisma.client.overtimeItem.findMany({
      where: {
        userId: targetUserId,
        overtimeDate: toDbDate(dto.overtimeDate),
        request: { status: { in: ['PENDING', 'APPROVED'] } },
      },
      select: { startMinute: true, endMinute: true },
    });
    return findOverlapping(dto.startMinute, dto.endMinute, items).length > 0;
  }

  /** 事务内重叠重验（FOR UPDATE 锁该员工当日明细，防并发双提） */
  private async assertNoOverlapInTransaction(tx: Prisma.TransactionClient, dto: OvertimeSubmitDto): Promise<void> {
    // 同人同日提交串行化（pg_advisory_xact_lock）：行锁锁不住"尚未插入的未来行"，
    // 两个并发提交（当日均无既有明细）会同时通过校验造成重叠双写；咨询锁按 (用户,日期)
    // 固定键互斥整个提交校验+插入，与事务同生命周期（提交/回滚自动释放）
    const dateKey = toDbDate(dto.overtimeDate);
    for (const targetUserId of [...new Set(dto.userIds)].sort((a, b) => a - b)) {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`overtime:${targetUserId}:${dateKey.toISOString()}`}))
      `;
    }
    const rows = await tx.$queryRaw<Array<{ user_id: number; start_minute: number; end_minute: number }>>`
      SELECT oi.user_id, oi.start_minute, oi.end_minute
      FROM hr.overtime_items oi
      INNER JOIN hr.approval_requests r ON r.id = oi.request_id
      WHERE oi.user_id = ANY(${dto.userIds as number[]})
        AND oi.overtime_date = ${toDbDate(dto.overtimeDate)}::date
        AND r.status IN ('PENDING', 'APPROVED')
      FOR UPDATE
    `;
    const byUser = new Map<number, Array<{ startMinute: number; endMinute: number }>>();
    for (const row of rows) {
      const list = byUser.get(row.user_id) ?? [];
      list.push({ startMinute: row.start_minute, endMinute: row.end_minute });
      byUser.set(row.user_id, list);
    }
    for (const targetUserId of dto.userIds) {
      const existing = byUser.get(targetUserId) ?? [];
      if (findOverlapping(dto.startMinute, dto.endMinute, existing).length > 0) {
        throw new BusinessException(hrErrors.OVERTIME_OVERLAP, { userId: targetUserId });
      }
    }
  }

  /** 加载目标员工姓名与部门快照（提交时快照） */
  private async loadTarget(
    tx: Prisma.TransactionClient,
    targetUserId: number,
  ): Promise<{ name: string; departments: Array<{ id: number; name: string }> }> {
    const rows = await tx.$queryRaw<Array<{ name: string; department_id: number; department_name: string }>>`
      SELECT ua.name, uo.department_id, uo.department_name
      FROM backstage.user_accounts ua
      LEFT JOIN hr.user_org uo ON uo.user_id = ua.user_id
      WHERE ua.user_id = ${targetUserId}
    `;
    const name = rows[0]?.name ?? '';
    const departments = rows
      .filter((row) => row.department_id !== null)
      .map((row) => ({ id: row.department_id, name: row.department_name }));
    return { name, departments };
  }

  /** 员工当前直接归属部门 id 列表（非闭包；代提范围校验用） */
  private async loadOwnDepartments(targetUserId: number): Promise<number[]> {
    const rows = await this.prisma.client.$queryRaw<Array<{ department_id: number }>>`
      SELECT department_id FROM hr.user_org WHERE user_id = ${targetUserId}
    `;
    return rows.map((row) => row.department_id);
  }
}

/** YYYY-MM-DD → Date（@db.Date 日历值，Date.UTC 构造避免时区偏移） */
function toDbDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

/** 分钟 → HH:mm（如 18*60 → "18:00"；1440 → "24:00"） */
export function formatTime(minute: number): string {
  if (minute === 1440) {
    return '24:00';
  }
  const hours = Math.floor(minute / 60);
  const mins = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}
