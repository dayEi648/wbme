import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hrErrors } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';
import { ensurePermissionCatalog } from '../../test-support/ensure-permission-catalog';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import type { HrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { HrApprovalService } from '../approval/hr-approval.service';
import { HolidayAdapter } from '../holiday/holiday.adapter';
import { FakeHolidayGateway } from '../holiday/holiday.gateway';
import { SettingsService } from '../settings/settings.service';
import { OvertimeSubmissionService } from './overtime-submission.service';
import { OvertimeSummaryService } from './overtime-summary.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/** 固定测试 id 段 */
const BASE_ID = 8_902_001;

/**
 * 加班提交集成测试（T6-5）：
 * 批次原子性（逐人失败原因、零写入）、时间重叠拒绝、日期窗口、节假日快照、
 * 审批通过（超管审批人）、汇总分钟精度。
 */
describeDb('加班提交（T6-5）', () => {
  let prisma: PrismaService;
  let gateway: FakeHolidayGateway;
  let submission: OvertimeSubmissionService;
  let approval: HrApprovalService;
  let settings: SettingsService;
  let operator: HrOperationLogOperator;
  let operatorUserId = 0;
  let processorId = 0;
  let previousHrStatus: string | null = null;
  const employeeIds: number[] = [];

  /** 创建在职普通员工（跨 schema 写 base.users；phone 段与操作人错开防互删） */
  async function createEmployee(tag: string): Promise<number> {
    const phone = `+8613900001${String(BASE_ID + employeeIds.length).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const inserted = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES (${tag}, 'MALE', ${phone}, 'ACTIVE', false, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    const id = inserted[0]!.id;
    employeeIds.push(id);
    return id;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await ensurePermissionCatalog(prisma);

    // 组织版本行初始化（幂等；CI 全新库 org_meta 为空，测试不依赖执行顺序）
    await prisma.client.orgMeta.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    const statusRows = await prisma.client.$queryRaw<Array<{ product_status: string }>>`
      SELECT product_status::text AS product_status FROM backstage.systems WHERE code = 'HR' LIMIT 1
    `;
    previousHrStatus = statusRows[0]?.product_status ?? null;
    await prisma.client.$executeRaw`UPDATE backstage.systems SET product_status = 'OPEN' WHERE code = 'HR'`;

    // 节假日 Fake：默认正常返回工作日
    gateway = new FakeHolidayGateway(async (date) => {
      const week = weekdayOf(date);
      if (week >= 6) {
        return JSON.stringify({ code: 0, type: { type: 1, name: '周末', week }, holiday: { holiday: true, wage: 2, date } });
      }
      return JSON.stringify({ code: 0, type: { type: 0, name: '工作日', week }, holiday: null });
    });

    const holidayAdapter = new HolidayAdapter(prisma, gateway);
    settings = new SettingsService(prisma);
    await settings.ensureDefaults();
    approval = new HrApprovalService(prisma, new DepartmentClosureService(prisma), null);
    submission = new OvertimeSubmissionService(prisma, approval, holidayAdapter, settings, new DepartmentClosureService(prisma));

    // 操作人（普通员工，无加班功能授权 → 用超管豁免测试提交）
    const phone = '+8613900000' + String(BASE_ID).slice(-4);
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const inserted = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('加班测试提交人', 'MALE', ${phone}, 'ACTIVE', true, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    operatorUserId = inserted[0]!.id;
    operator = { id: operatorUserId, name: '加班测试提交人', departments: [] };

    // 审批人（超管）
    const phone2 = '+8613900000' + String(BASE_ID + 99).slice(-4);
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone2}`;
    const processor = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('加班测试审批人', 'MALE', ${phone2}, 'ACTIVE', true, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    processorId = processor[0]!.id;
  });

  afterAll(async () => {
    const requestIds = await prisma.client.hrApprovalRequest.findMany({
      where: { applicantId: operatorUserId },
      select: { id: true },
    });
    await prisma.client.hrApprovalAction.deleteMany({ where: { requestId: { in: requestIds.map((r) => r.id) } } });
    await prisma.client.overtimeItem.deleteMany({ where: { requestId: { in: requestIds.map((r) => r.id) } } });
    await prisma.client.hrApprovalRequest.deleteMany({ where: { applicantId: operatorUserId } });
    await prisma.client.hrOperationLog.deleteMany({ where: { operatorId: operatorUserId } });
    await prisma.client.holidayResult.deleteMany({});
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ANY(${[operatorUserId, processorId, ...employeeIds]})`;
    if (previousHrStatus !== null) {
      await prisma.client.$executeRaw`
        UPDATE backstage.systems SET product_status = ${previousHrStatus}::backstage."ProductStatus" WHERE code = 'HR'
      `;
    }
    await prisma.client.$disconnect();
  });

  it('提交成功：审批头 + 明细 + 节假日快照 + 操作日志', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const result = await submission.submit(operator, {
      overtimeDate: date,
      startMinute: 18 * 60,
      endMinute: 20 * 60,
      reason: 'T6 测试加班',
      userIds: [operatorUserId],
      idempotencyKey: `test-key-${Date.now()}`,
    });
    expect(result.requestId).toBeGreaterThan(0);
    const head = await prisma.client.hrApprovalRequest.findUnique({ where: { id: result.requestId } });
    expect(head?.status).toBe('PENDING');
    const items = await prisma.client.overtimeItem.findMany({ where: { requestId: result.requestId } });
    expect(items.length).toBe(1);
    const snapshot = items[0]!.holidaySnapshot as { dateType?: string; source?: string };
    expect(snapshot.dateType).toBeTruthy();
    expect(snapshot.source).toBeTruthy();
    // 审批通过（超管审批人）
    await approval.process(result.requestId, 'APPROVE', processorId);
    const after = await prisma.client.hrApprovalRequest.findUnique({ where: { id: result.requestId } });
    expect(after?.status).toBe('APPROVED');
  });

  it('时间段重叠拒绝（OVERTIME_OVERLAP，批次零写入）', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const before = await prisma.client.hrApprovalRequest.count();
    await expect(
      submission.submit(operator, {
        overtimeDate: date,
        startMinute: 19 * 60,
        endMinute: 21 * 60,
        reason: '重叠测试',
        userIds: [operatorUserId],
      }),
    ).rejects.toMatchObject({ entry: { code: hrErrors.OVERTIME_OVERLAP.code } });
    const after = await prisma.client.hrApprovalRequest.count();
    expect(after).toBe(before); // 零写入
  });

  it('日期窗口外拒绝（OVERTIME_DATE_OUT_OF_WINDOW）', async () => {
    const farFuture = '2030-01-01'; // 超出提前申请窗口
    await expect(
      submission.submit(operator, {
        overtimeDate: farFuture,
        startMinute: 9 * 60,
        endMinute: 10 * 60,
        reason: '窗口测试',
        userIds: [operatorUserId],
      }),
    ).rejects.toMatchObject({ entry: { code: hrErrors.OVERTIME_DATE_OUT_OF_WINDOW.code } });
  });

  it('批次原子性：一人失败整批拒绝并逐人返回原因', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    // 目标员工：在职
    const employeeId = await createEmployee('加班批次员工');
    // 已注销员工
    const phone = `+8613900000${String(BASE_ID + 50).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const deactivated = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at, deleted_at)
      VALUES ('已注销员工', 'MALE', ${phone}, 'DEACTIVATED', false, 'test-hash', NOW(), NOW(), NOW())
      RETURNING id
    `;
    const deactivatedId = deactivated[0]!.id;
    const before = await prisma.client.hrApprovalRequest.count();
    try {
      await expect(
        submission.submit(operator, {
          overtimeDate: date,
          startMinute: 10 * 60,
          endMinute: 11 * 60,
          reason: '批次原子测试',
          userIds: [employeeId, deactivatedId],
        }),
      ).rejects.toMatchObject({
        entry: { code: hrErrors.OVERTIME_BATCH_REJECTED.code },
        details: { failures: [{ userId: deactivatedId, code: hrErrors.OVERTIME_EMPLOYEE_NOT_ACTIVE.code }] },
      });
      const after = await prisma.client.hrApprovalRequest.count();
      expect(after).toBe(before); // 零写入
    } finally {
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${deactivatedId}`;
    }
  });

  it('本人档名单包含他人且无代交权限 → 拒绝', async () => {
    // 普通员工仅持"加班申请"（SELF 档）——名单只能本人
    const selfOnlyUserId = await createEmployee('本人档员工');
    await prisma.client.$executeRaw`
      INSERT INTO backstage.employee_grants (user_id, function_code, data_scope, granted_by, granted_at)
      VALUES (${selfOnlyUserId}, 'overtime_apply', 'SELF', ${operatorUserId}, NOW())
    `;
    const selfOnlyOperator: HrOperationLogOperator = { id: selfOnlyUserId, name: '本人档员工', departments: [] };
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await expect(
      submission.submit(selfOnlyOperator, {
        overtimeDate: date,
        startMinute: 14 * 60,
        endMinute: 15 * 60,
        reason: '名单测试',
        userIds: [selfOnlyUserId, operatorUserId],
      }),
    ).rejects.toMatchObject({ entry: { code: 'VALIDATION_FAILED' } });
    // 本人名单提交成功
    const result = await submission.submit(selfOnlyOperator, {
      overtimeDate: date,
      startMinute: 14 * 60,
      endMinute: 15 * 60,
      reason: '本人提交',
      userIds: [selfOnlyUserId],
    });
    expect(result.requestId).toBeGreaterThan(0);
    await prisma.client.$executeRaw`
      DELETE FROM backstage.employee_grants WHERE user_id = ${selfOnlyUserId} AND function_code = 'overtime_apply'
    `;
  });

  it('个人月度汇总：分钟精度、小时两位小数', async () => {
    // 上一用例已批准 18:00-20:00（120 分钟）
    const summary = await submissionSubmitSummary(operatorUserId);
    expect(summary.totalMinutes).toBeGreaterThanOrEqual(120);
    expect(summary.totalHours).toBeCloseTo(summary.totalMinutes / 60, 2);
  });

  /** 汇总辅助（复用 OvertimeSummaryService） */
  async function submissionSubmitSummary(userId: number): Promise<{ totalMinutes: number; totalHours: number }> {
    const summaryService = new OvertimeSummaryService(prisma);
    const result = await summaryService.summaryMine(userId);
    return { totalMinutes: result.totalMinutes, totalHours: result.totalHours };
  }
});

/** 日期星期（周一=1 … 周日=7） */
function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}
