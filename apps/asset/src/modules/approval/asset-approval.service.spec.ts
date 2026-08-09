import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
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

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new AssetApprovalService(prisma);

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
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${deptUserId}`;
    }
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

  it('DEPARTMENT 范围列表排除 STOCK_IN / STOCK_CHANGE', async () => {
    const applicantId = BASE_APPLICANT + 10;
    await service.submitTestHeader({
      requestType: 'STOCK_IN',
      applicantId,
      applicantName: '入库申请人',
    });
    await service.submitTestHeader({
      requestType: 'CONSUMABLE_REQUEST',
      applicantId,
      applicantName: '申领申请人',
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
});
