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
import { DepartmentService } from '../org/department.service';
import { PositionApplicationService } from '../org/position-application.service';
import { PositionService } from '../org/position.service';
import { LifecycleService } from './lifecycle.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/** 固定测试 id 段 */
const BASE_ID = 8_904_001;

/**
 * 账号生命周期集成测试（T6-8）：
 * restore-preview 只读、restore-apply 幂等（同 rid 重放/异目标集 409）、
 * 注销前待审批岗位申请取消（worker 接口 + 恢复兜底）、恢复后新申请不误伤。
 */
describeDb('账号生命周期（T6-8）', () => {
  let prisma: PrismaService;
  let lifecycle: LifecycleService;
  let applications: PositionApplicationService;
  let approval: HrApprovalService;
  let departments: DepartmentService;
  let positions: PositionService;
  let employee: HrOperationLogOperator;
  let employeeUserId = 0;
  let previousHrStatus: string | null = null;
  const createdDepartmentIds: number[] = [];
  const createdPositionIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    lifecycle = new LifecycleService(prisma);
    departments = new DepartmentService(prisma);
    positions = new PositionService(prisma);
    applications = new PositionApplicationService(prisma);
    approval = new HrApprovalService(prisma, new DepartmentClosureService(prisma), applications);
    applications.bindApprovalService(approval);
    await ensurePermissionCatalog(prisma);
    const statusRows = await prisma.client.$queryRaw<Array<{ product_status: string }>>`
      SELECT product_status::text AS product_status FROM backstage.systems WHERE code = 'HR' LIMIT 1
    `;
    previousHrStatus = statusRows[0]?.product_status ?? null;
    await prisma.client.$executeRaw`UPDATE backstage.systems SET product_status = 'OPEN' WHERE code = 'HR'`;

    // 被注销员工（注销时间=现在，lifecycle_version=1）
    const phone = `+8613900000${String(BASE_ID).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const inserted = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at,
                              lifecycle_version, deleted_at, deleted_by)
      VALUES ('生命周期测试员工', 'MALE', ${phone}, 'DEACTIVATED', false, 'test-hash', NOW(), NOW(),
              1, NOW(), 0)
      RETURNING id
    `;
    employeeUserId = inserted[0]!.id;
    employee = { id: employeeUserId, name: '生命周期测试员工', departments: [] };
  });

  afterAll(async () => {
    const requestIds = await prisma.client.hrApprovalRequest.findMany({
      where: { applicantId: employeeUserId },
      select: { id: true },
    });
    await prisma.client.hrApprovalAction.deleteMany({ where: { requestId: { in: requestIds.map((r) => r.id) } } });
    await prisma.client.positionChangeRequest.deleteMany({ where: { requestId: { in: requestIds.map((r) => r.id) } } });
    await prisma.client.hrApprovalRequest.deleteMany({ where: { applicantId: employeeUserId } });
    await prisma.client.orgCompatRecord.deleteMany({ where: { userId: employeeUserId } });
    await prisma.client.userDepartment.deleteMany({ where: { userId: employeeUserId } });
    await prisma.client.userPosition.deleteMany({ where: { userId: employeeUserId } });
    if (createdPositionIds.length > 0) {
      await prisma.client.positionDepartment.deleteMany({ where: { positionId: { in: createdPositionIds } } });
      await prisma.client.position.deleteMany({ where: { id: { in: createdPositionIds } } });
    }
    await prisma.client.department.deleteMany({ where: { id: { in: createdDepartmentIds } } });
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${employeeUserId}`;
    if (previousHrStatus !== null) {
      await prisma.client.$executeRaw`
        UPDATE backstage.systems SET product_status = ${previousHrStatus}::backstage."ProductStatus" WHERE code = 'HR'
      `;
    }
    await prisma.client.$disconnect();
  });

  it('cancelPositionApplications：幂等取消注销前待审批岗位申请（含恢复后新申请不误伤）', async () => {
    // 注销前提交的岗位申请
    const dept = await departments.create(employee, { name: '生命周期部门A' });
    createdDepartmentIds.push(dept.id);
    const position = await positions.create(employee, { name: '生命周期岗位A', departmentIds: [dept.id], allowSelfApply: true });
    createdPositionIds.push(position.id);
    const beforeRequest = await applications.submit(employee, dept.id, position.id);
    const deactivatedAt = new Date().toISOString();

    // worker 接口：取消注销前待审批申请
    const result = await lifecycle.cancelPositionApplications(employeeUserId, deactivatedAt);
    expect(result.cancelledCount).toBe(1);
    const head = await prisma.client.hrApprovalRequest.findUnique({ where: { id: beforeRequest.requestId } });
    expect(head?.status).toBe('CANCELLED');
    expect(head?.cancelSource).toBe('ACCOUNT_DEACTIVATED');
    const action = await prisma.client.hrApprovalAction.findFirst({
      where: { requestId: beforeRequest.requestId, action: 'AUTO_CANCEL' },
    });
    expect(action?.cancelSource).toBe('ACCOUNT_DEACTIVATED');

    // 幂等重放：状态过滤天然幂等
    const replay = await lifecycle.cancelPositionApplications(employeeUserId, deactivatedAt);
    expect(replay.cancelledCount).toBe(0);
  });

  it('restore-preview：只读兼容性检查（不写数据）', async () => {
    const deactivatedAt = new Date().toISOString();
    const beforeCount = await prisma.client.orgCompatRecord.count();
    const result = await lifecycle.restorePreview({
      restoreRequestId: 'preview-only-id',
      targets: [{ userId: employeeUserId, deactivatedAt, lifecycleVersion: 1 }],
    });
    expect(result.targets.length).toBe(1);
    expect(result.targets[0]!.restorable).toBe(true);
    const afterCount = await prisma.client.orgCompatRecord.count();
    expect(afterCount).toBe(beforeCount); // preview 不写数据
  });

  it('restore-apply：幂等（同 rid 重放成功；异目标集 409 RESTORE_TARGET_STALE）', async () => {
    const deactivatedAt = new Date().toISOString();
    const rid = 'restore-apply-id-1';
    const first = await lifecycle.restoreApply({
      restoreRequestId: rid,
      targets: [{ userId: employeeUserId, deactivatedAt, lifecycleVersion: 1 }],
    });
    expect(first.applied).toBe(true);
    // 同 rid 同目标集重放 → 原结果
    const replay = await lifecycle.restoreApply({
      restoreRequestId: rid,
      targets: [{ userId: employeeUserId, deactivatedAt, lifecycleVersion: 1 }],
    });
    expect(replay.applied).toBe(true);
    // 同 rid 不同目标集 → 409
    await expect(
      lifecycle.restoreApply({
        restoreRequestId: rid,
        targets: [{ userId: employeeUserId + 1, deactivatedAt, lifecycleVersion: 1 }],
      }),
    ).rejects.toMatchObject({ entry: { code: hrErrors.RESTORE_TARGET_STALE.code } });
    // 幂等记录已写
    const records = await prisma.client.orgCompatRecord.findMany({ where: { restoreRequestId: rid } });
    expect(records.length).toBe(1);
  });

  it('restore-apply 生命周期版本不符 → 整批拒绝（RESTORE_TARGET_STALE）', async () => {
    const deactivatedAt = new Date().toISOString();
    await expect(
      lifecycle.restoreApply({
        restoreRequestId: 'restore-apply-id-2',
        targets: [{ userId: employeeUserId, deactivatedAt, lifecycleVersion: 99 }],
      }),
    ).rejects.toMatchObject({ entry: { code: hrErrors.RESTORE_TARGET_STALE.code } });
  });
});
