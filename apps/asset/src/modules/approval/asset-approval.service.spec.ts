import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import { DepartmentClosureService } from '../../shared/department-closure.service';
import { ensurePermissionCatalog } from '../../test-support/ensure-permission-catalog';
import { AssetApprovalService } from './asset-approval.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/**
 * asset 审批头集成测试（T5-3）：
 * 代领结清单待审批唯一、部门范围排除公司专属类型、并发处理 STATUS_CONFLICT。
 */
describeDb('asset 审批头（T5-3）', () => {
  let prisma: PrismaService;
  let service: AssetApprovalService;
  const applicantIds: number[] = [];
  let processorId = 0;
  let deptUserId = 0;
  let previousAssetStatus: string | null = null;

  /** 固定测试申请人 id 段（int4 范围内） */
  const BASE_APPLICANT = 8_900_601;

  /** 测试部门 id（闭包数据；申请人快照使用同部门） */
  const TEST_DEPARTMENT_ID = 8_900_600;

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new AssetApprovalService(prisma, new DepartmentClosureService(prisma), null, { redis: null } as never);

    // CI 全新库只跑迁移不跑 seed：先注册权限目录（幂等），保证目录依赖的测试在任意环境一致
    await ensurePermissionCatalog(prisma);

    const statusRows = await prisma.client.$queryRaw<Array<{ product_status: string }>>`
      SELECT product_status::text AS product_status
      FROM backstage.systems
      WHERE code = 'ASSET'
      LIMIT 1
    `;
    previousAssetStatus = statusRows[0]?.product_status ?? null;
    await prisma.client.$executeRaw`
      UPDATE backstage.systems
      SET product_status = 'OPEN'
      WHERE code = 'ASSET'
    `;

    const phoneAdmin = '+8613900000699';
    const phoneDept = '+8613900000698';
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phoneAdmin}`;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE phone = ${phoneDept}`;

    const adminRows = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('asset审批测试超管', 'MALE', ${phoneAdmin}, 'ACTIVE', true, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    processorId = adminRows[0]!.id;

    const deptRows = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('asset部门审批人', 'MALE', ${phoneDept}, 'ACTIVE', false, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    deptUserId = deptRows[0]!.id;

    // T7：部门闭包数据（hr.departments + hr.user_departments；department_closure 视图实时计算含自身）
    await prisma.client.$executeRaw`
      INSERT INTO hr.departments (id, name, status, created_at, updated_at)
      VALUES (${TEST_DEPARTMENT_ID}, 'asset审批测试部门', 'ACTIVE', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await prisma.client.$executeRaw`
      DELETE FROM hr.user_departments WHERE user_id = ${deptUserId}
    `;
    await prisma.client.$executeRaw`
      INSERT INTO hr.user_departments (user_id, department_id, created_by)
      VALUES (${deptUserId}, ${TEST_DEPARTMENT_ID}, ${deptUserId})
    `;

    // 部门范围消耗品审批授权（目录功能须已对账入库）
    await prisma.client.$executeRaw`
      DELETE FROM backstage.employee_grants
      WHERE user_id = ${deptUserId} AND function_code = 'consumable_approval'
    `;
    await prisma.client.$executeRaw`
      INSERT INTO backstage.employee_grants (user_id, function_code, data_scope, granted_by)
      VALUES (${deptUserId}, 'consumable_approval', 'DEPARTMENT', ${processorId})
    `;

    for (let i = 0; i < 30; i++) {
      applicantIds.push(BASE_APPLICANT + i);
    }
    await prisma.client.approvalActionRecord.deleteMany({
      where: { request: { applicantId: { in: applicantIds } } },
    });
    await prisma.client.approvalRequest.deleteMany({
      where: { applicantId: { in: applicantIds } },
    });
  });

  afterAll(async () => {
    await prisma.client.approvalActionRecord.deleteMany({
      where: { request: { applicantId: { in: applicantIds } } },
    });
    await prisma.client.approvalRequest.deleteMany({
      where: { applicantId: { in: applicantIds } },
    });
    if (deptUserId > 0) {
      await prisma.client.$executeRaw`
        DELETE FROM backstage.employee_grants WHERE user_id = ${deptUserId}
      `;
      await prisma.client.$executeRaw`DELETE FROM hr.user_departments WHERE user_id = ${deptUserId}`;
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${deptUserId}`;
    }
    await prisma.client.$executeRaw`
      DELETE FROM hr.departments WHERE id = ${TEST_DEPARTMENT_ID}
    `;
    if (processorId > 0) {
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${processorId}`;
    }
    if (previousAssetStatus !== null) {
      await prisma.client.$executeRaw`
        UPDATE backstage.systems
        SET product_status = CAST(${previousAssetStatus} AS backstage."ProductStatus")
        WHERE code = 'ASSET'
      `;
    }
    await prisma.client.$disconnect();
  });

  it('AGENT_SETTLEMENT 同 refRequestId 第二条 PENDING → PENDING_LIMIT_REACHED', async () => {
    const applicantId = BASE_APPLICANT;
    const refRequestId = 88_001;
    await service.submitTestHeader({
      requestType: 'AGENT_SETTLEMENT',
      applicantId,
      applicantName: '结清申请人',
      refRequestId,
    });
    await expect(
      service.submitTestHeader({
        requestType: 'AGENT_SETTLEMENT',
        applicantId: applicantId + 1,
        applicantName: '结清申请人2',
        refRequestId,
      }),
    ).rejects.toMatchObject({ entry: { code: 'PENDING_LIMIT_REACHED' } });
  });

  it('DEPARTMENT 范围列表排除 STOCK_IN / STOCK_CHANGE（含闭包裁剪）', async () => {
    const applicantId = BASE_APPLICANT + 10;
    const deptSnapshot = { id: TEST_DEPARTMENT_ID, name: 'asset审批测试部门' };
    await service.submitTestHeader({
      requestType: 'STOCK_IN',
      applicantId,
      applicantName: '入库申请人',
      applicantDepartmentSnapshot: deptSnapshot,
    });
    await service.submitTestHeader({
      requestType: 'CONSUMABLE_REQUEST',
      applicantId,
      applicantName: '申领申请人',
      applicantDepartmentSnapshot: deptSnapshot,
    });

    const deptList = await service.list(deptUserId, { page: 1, pageSize: 50, status: 'PENDING' });
    const types = new Set(deptList.items.map((item) => item.requestType));
    expect(types.has('STOCK_IN')).toBe(false);
    expect(types.has('CONSUMABLE_REQUEST')).toBe(true);

    const adminList = await service.list(processorId, { page: 1, pageSize: 50, status: 'PENDING' });
    const adminTypes = new Set(adminList.items.map((item) => item.requestType));
    expect(adminTypes.has('STOCK_IN')).toBe(true);
  });

  it('并发 process → 仅一个成功，另一个 STATUS_CONFLICT', async () => {
    const applicantId = BASE_APPLICANT + 20;
    const { requestId } = await service.submitTestHeader({
      requestType: 'RETURN',
      applicantId,
      applicantName: '并发归还',
    });
    const results = await Promise.allSettled([
      service.process(requestId, 'APPROVE', processorId),
      service.process(requestId, 'APPROVE', processorId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      status: 'rejected',
      reason: { entry: { code: 'STATUS_CONFLICT' } },
    });
  });

  it('申请人可在无审批授权时取消自己的待审批（本人取消入口回归历史记录视图，主 PRD §3.2）', async () => {
    const applicantId = processorId;
    const { requestId } = await service.submitTestHeader({
      requestType: 'CONSUMABLE_REQUEST',
      applicantId,
      applicantName: '我的资产申请人',
    });

    await service.cancel(requestId, applicantId);
    const header = await prisma.client.approvalRequest.findUnique({ where: { id: requestId } });
    expect(header?.status).toBe('CANCELLED');
    expect(header?.cancelledBy).toBe(applicantId);
  });

  it('process 幂等（M7）：同键重试重放原结果且不重复写审批动作', async () => {
    const applicantId = BASE_APPLICANT + 27;
    const { requestId } = await service.submitTestHeader({
      requestType: 'RETURN',
      applicantId,
      applicantName: '幂等处理申请人',
    });
    const key = 'asset-approval-process-m7';
    const first = await service.process(requestId, 'APPROVE', processorId, undefined, key);
    // 同键重试：重放原结果（主 PRD §3.2 幂等键重试返回原结果），不抛 STATUS_CONFLICT
    const replay = await service.process(requestId, 'APPROVE', processorId, undefined, key);
    expect(replay).toBe(first);

    // 审批头仅一条 APPROVED 状态流转，无重复副作用
    const header = await prisma.client.approvalRequest.findUnique({ where: { id: requestId } });
    expect(header?.status).toBe('APPROVED');
    expect(header?.processedAt).not.toBeNull();

    // 审批动作记录中 APPROVE 只追加一条（提交时另有 SUBMIT 动作；重放不重复写处理副作用）
    const approveActionCount = await prisma.client.approvalActionRecord.count({
      where: { requestId, action: 'APPROVE' },
    });
    expect(approveActionCount).toBe(1);
  });
});
