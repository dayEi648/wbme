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
import { DepartmentService } from './department.service';
import { PositionApplicationService } from './position-application.service';
import { PositionService } from './position.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/** 固定测试 id 段 */
const BASE_ID = 8_903_001;

/**
 * 岗位申请集成测试（T6-6）：
 * 提交资格（无/单部门）、待审批期间改多部门 → 批准 POSITION_APPLY_STALE 且保持 PENDING、
 * 批准成功副作用（部门/岗位更新 + user_org_version 递增）、待审批唯一限制。
 */
describeDb('岗位申请（T6-6）', () => {
  let prisma: PrismaService;
  let departments: DepartmentService;
  let positions: PositionService;
  let approval: HrApprovalService;
  let applications: PositionApplicationService;
  let employee: HrOperationLogOperator;
  let employeeUserId = 0;
  let processorId = 0;
  let previousHrStatus: string | null = null;
  const createdDepartmentIds: number[] = [];
  const createdPositionIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    departments = new DepartmentService(prisma);
    positions = new PositionService(prisma);
    // 延迟注入：PositionApplicationService 依赖审批头服务，审批头服务依赖其副作用
    applications = new PositionApplicationService(prisma);
    approval = new HrApprovalService(prisma, new DepartmentClosureService(prisma), applications);
    applications.bindApprovalService(approval);
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

    // 普通员工申请人（无部门）
    const phone = `+8613900000${String(BASE_ID).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone}`;
    const inserted = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('岗位申请测试员工', 'MALE', ${phone}, 'ACTIVE', false, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    employeeUserId = inserted[0]!.id;
    employee = { id: employeeUserId, name: '岗位申请测试员工', departments: [] };

    // 审批人（超管，org_structure 豁免）
    const phone2 = `+8613900001${String(BASE_ID).slice(-4)}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phone2}`;
    const processor = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('岗位申请测试审批人', 'MALE', ${phone2}, 'ACTIVE', true, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    processorId = processor[0]!.id;
  });

  afterAll(async () => {
    const requestIds = await prisma.client.hrApprovalRequest.findMany({
      where: { applicantId: employeeUserId },
      select: { id: true },
    });
    await prisma.client.hrApprovalAction.deleteMany({ where: { requestId: { in: requestIds.map((r) => r.id) } } });
    await prisma.client.positionChangeRequest.deleteMany({ where: { requestId: { in: requestIds.map((r) => r.id) } } });
    await prisma.client.hrApprovalRequest.deleteMany({ where: { applicantId: employeeUserId } });
    await prisma.client.hrOperationLog.deleteMany({ where: { operatorId: employeeUserId } });
    await prisma.client.userDepartment.deleteMany({ where: { userId: employeeUserId } });
    await prisma.client.userPosition.deleteMany({ where: { userId: employeeUserId } });
    if (createdPositionIds.length > 0) {
      await prisma.client.positionDepartment.deleteMany({ where: { positionId: { in: createdPositionIds } } });
      await prisma.client.position.deleteMany({ where: { id: { in: createdPositionIds } } });
    }
    await prisma.client.department.deleteMany({ where: { id: { in: createdDepartmentIds } } });
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ANY(${[employeeUserId, processorId]})`;
    if (previousHrStatus !== null) {
      await prisma.client.$executeRaw`
        UPDATE backstage.systems SET product_status = ${previousHrStatus}::backstage."ProductStatus" WHERE code = 'HR'
      `;
    }
    await prisma.client.$disconnect();
  });

  it('无部门员工提交成功：审批头 + 目标明细；批准后部门/岗位更新 + 版本递增', async () => {
    const deptA = await departments.create(employee, { name: '目标部门A' });
    createdDepartmentIds.push(deptA.id);
    const position = await positions.create(employee, { name: '目标岗位A', departmentIds: [deptA.id], allowSelfApply: true });
    createdPositionIds.push(position.id);

    const result = await applications.submit(employee, deptA.id, position.id, `pos-key-${Date.now()}`);
    const head = await prisma.client.hrApprovalRequest.findUnique({ where: { id: result.requestId } });
    expect(head?.status).toBe('PENDING');
    const beforeVersion = await prisma.client.$queryRaw<Array<{ v: number }>>`SELECT user_org_version AS v FROM hr.org_meta`;
    await approval.process(result.requestId, 'APPROVE', processorId);
    const after = await prisma.client.hrApprovalRequest.findUnique({ where: { id: result.requestId } });
    expect(after?.status).toBe('APPROVED');
    const orgRows = await prisma.client.$queryRaw<
      Array<{ department_id: number; position_id: number | null }>
    >`
      SELECT department_id, position_id FROM hr.user_org WHERE user_id = ${employeeUserId}
    `;
    expect(orgRows.map((row) => row.department_id)).toEqual([deptA.id]);
    expect(orgRows[0]?.position_id).toBe(position.id);
    const afterVersion = await prisma.client.$queryRaw<Array<{ v: number }>>`SELECT user_org_version AS v FROM hr.org_meta`;
    expect(Number(afterVersion[0]!.v)).toBeGreaterThan(Number(beforeVersion[0]!.v ?? 0));
  });

  it('待审批期间被改为多部门 → 批准 POSITION_APPLY_STALE 且保持 PENDING', async () => {
    const deptB = await departments.create(employee, { name: '目标部门B' });
    createdDepartmentIds.push(deptB.id);
    const position = await positions.create(employee, { name: '目标岗位B', departmentIds: [deptB.id], allowSelfApply: true });
    createdPositionIds.push(position.id);

    // 员工当前无部门（上一用例批准后属 A）——需先清空再提交
    await prisma.client.userDepartment.deleteMany({ where: { userId: employeeUserId } });
    const result = await applications.submit(employee, deptB.id, position.id);
    try {
      // 待审批期间管理员将其调整为多部门（A + B）
      await prisma.client.userDepartment.createMany({
        data: [
          { userId: employeeUserId, departmentId: createdDepartmentIds[0]!, createdBy: processorId },
          { userId: employeeUserId, departmentId: deptB.id, createdBy: processorId },
        ],
      });
      await expect(approval.process(result.requestId, 'APPROVE', processorId)).rejects.toMatchObject({
        entry: { code: hrErrors.POSITION_APPLY_STALE.code },
      });
      const head = await prisma.client.hrApprovalRequest.findUnique({ where: { id: result.requestId } });
      expect(head?.status).toBe('PENDING'); // 保持待审批，审批人可驳回或申请人可取消
    } finally {
      // 清理多部门关系（还原单部门状态供后续用例）
      await prisma.client.userDepartment.deleteMany({ where: { userId: employeeUserId } });
      await prisma.client.userDepartment.create({
        data: { userId: employeeUserId, departmentId: deptB.id, createdBy: processorId },
      });
      // 驳回该申请
      await approval.process(result.requestId, 'REJECT', processorId, '条件变化，驳回');
    }
  });

  it('同一员工同时最多一条待审批岗位申请（PENDING_LIMIT_REACHED）', async () => {
    const position = await positions.create(employee, { name: '目标岗位C', departmentIds: [createdDepartmentIds[1]!], allowSelfApply: true });
    createdPositionIds.push(position.id);
    const first = await applications.submit(employee, createdDepartmentIds[1]!, position.id);
    await expect(applications.submit(employee, createdDepartmentIds[1]!, position.id)).rejects.toMatchObject({
      entry: { code: 'PENDING_LIMIT_REACHED' },
    });
    // 申请人取消待审批，释放唯一约束（供后续用例）
    await approval.cancel(first.requestId, employeeUserId);
  });

  it('目标岗位不允许自助申请 → POSITION_APPLY_TARGET_UNAVAILABLE', async () => {
    const dept = await departments.create(employee, { name: '目标部门D' });
    createdDepartmentIds.push(dept.id);
    const position = await positions.create(employee, { name: '非自助岗位', departmentIds: [dept.id], allowSelfApply: false });
    createdPositionIds.push(position.id);
    await expect(applications.submit(employee, dept.id, position.id)).rejects.toMatchObject({
      entry: { code: hrErrors.POSITION_APPLY_TARGET_UNAVAILABLE.code },
    });
  });
});
