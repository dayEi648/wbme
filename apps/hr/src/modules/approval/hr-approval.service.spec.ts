import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import { ensurePermissionCatalog } from '../../test-support/ensure-permission-catalog';
import { HrApprovalService } from './hr-approval.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/**
 * hr 审批头集成测试（T5-3）：
 * 岗位变更单待审批限制、加班可多条待审批、并发处理 STATUS_CONFLICT。
 */
describeDb('hr 审批头（T5-3）', () => {
  let prisma: PrismaService;
  let service: HrApprovalService;
  /** 本用例占用的申请人 id（清理用） */
  const applicantIds: number[] = [];
  let processorId = 0;
  let previousHrStatus: string | null = null;

  /** 固定测试申请人 id 段（int4 范围内，避免与真实用户冲突） */
  const BASE_APPLICANT = 8_900_501;

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new HrApprovalService(prisma);

    // CI 全新库只跑迁移不跑 seed：先注册权限目录（幂等），保证目录依赖的测试在任意环境一致
    await ensurePermissionCatalog(prisma);

    // 打开 HR 系统以便 process 通过系统可用性校验（测毕还原）
    const statusRows = await prisma.client.$queryRaw<Array<{ product_status: string }>>`
      SELECT product_status::text AS product_status
      FROM backstage.systems
      WHERE code = 'HR'
      LIMIT 1
    `;
    previousHrStatus = statusRows[0]?.product_status ?? null;
    await prisma.client.$executeRaw`
      UPDATE backstage.systems
      SET product_status = 'OPEN'
      WHERE code = 'HR'
    `;

    // 超管处理人（跨 schema 写入 base.users）
    const phone = '+8613900000599';
    await prisma.client.$executeRaw`
      DELETE FROM base.users WHERE phone = ${phone}
    `;
    const inserted = await prisma.client.$queryRaw<Array<{ id: number }>>`
      INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES ('hr审批测试超管', 'MALE', ${phone}, 'ACTIVE', true, 'test-hash', NOW(), NOW())
      RETURNING id
    `;
    processorId = inserted[0]!.id;

    // 清理上次残留审批
    for (let i = 0; i < 20; i++) {
      applicantIds.push(BASE_APPLICANT + i);
    }
    await prisma.client.hrApprovalAction.deleteMany({
      where: { request: { applicantId: { in: applicantIds } } },
    });
    await prisma.client.hrApprovalRequest.deleteMany({
      where: { applicantId: { in: applicantIds } },
    });
  });

  afterAll(async () => {
    await prisma.client.hrApprovalAction.deleteMany({
      where: { request: { applicantId: { in: applicantIds } } },
    });
    await prisma.client.hrApprovalRequest.deleteMany({
      where: { applicantId: { in: applicantIds } },
    });
    if (processorId > 0) {
      await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${processorId}`;
    }
    if (previousHrStatus !== null) {
      await prisma.client.$executeRaw`
        UPDATE backstage.systems
        SET product_status = CAST(${previousHrStatus} AS backstage."ProductStatus")
        WHERE code = 'HR'
      `;
    }
    await prisma.client.$disconnect();
  });

  it('POSITION_CHANGE 第二条待审批 → PENDING_LIMIT_REACHED', async () => {
    const applicantId = BASE_APPLICANT;
    await service.submitTestHeader({
      requestType: 'POSITION_CHANGE',
      applicantId,
      applicantName: '岗位申请人',
    });
    await expect(
      service.submitTestHeader({
        requestType: 'POSITION_CHANGE',
        applicantId,
        applicantName: '岗位申请人',
      }),
    ).rejects.toMatchObject({ entry: { code: 'PENDING_LIMIT_REACHED' } });
  });

  it('OVERTIME 允许同一申请人多条 PENDING', async () => {
    const applicantId = BASE_APPLICANT + 1;
    const first = await service.submitTestHeader({
      requestType: 'OVERTIME',
      applicantId,
      applicantName: '加班申请人',
    });
    const second = await service.submitTestHeader({
      requestType: 'OVERTIME',
      applicantId,
      applicantName: '加班申请人',
    });
    expect(first.requestId).not.toBe(second.requestId);
    const pending = await prisma.client.hrApprovalRequest.count({
      where: { applicantId, requestType: 'OVERTIME', status: 'PENDING' },
    });
    expect(pending).toBe(2);
  });

  it('并发 process → 仅一个成功，另一个 STATUS_CONFLICT', async () => {
    const applicantId = BASE_APPLICANT + 2;
    const { requestId } = await service.submitTestHeader({
      requestType: 'OVERTIME',
      applicantId,
      applicantName: '并发申请人',
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
