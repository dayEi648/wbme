import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OVERTIME_APPROVAL_FUNCTION_CODE } from '@wbme/contracts';
import type { RedisService } from '@wbme/server';
import { PrismaService } from '../../prisma.service';
import { DepartmentClosureService } from '../../shared/department-closure.service';
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
    service = new HrApprovalService(prisma, new DepartmentClosureService(prisma), null, { redis: {} } as unknown as RedisService);

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

  it('cancel 携带预期类型时类型不匹配拒绝（L12：加班取消接口只接受 OVERTIME）', async () => {
    // 取消人须为真实用户（cancel 写操作日志与幂等记录，需在职账号上下文）
    const applicantId = processorId;
    const { requestId } = await service.submitTestHeader({
      requestType: 'OVERTIME',
      applicantId,
      applicantName: '加班申请人',
    });
    // 类型不匹配 → RESOURCE_NOT_FOUND（不泄露存在性，与申请人校验同口径）
    await expect(service.cancel(requestId, applicantId, 'POSITION_CHANGE')).rejects.toMatchObject({
      entry: { code: 'RESOURCE_NOT_FOUND' },
    });
    // 匹配类型且本人操作 → 成功取消
    await service.cancel(requestId, applicantId, 'OVERTIME');
    const after = await prisma.client.hrApprovalRequest.findUnique({ where: { id: requestId } });
    expect(after?.status).toBe('CANCELLED');
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

  it('process 幂等（批次 3-10）：同键重试重放原结果且不重复写审批动作与操作日志', async () => {
    const applicantId = processorId;
    const { requestId } = await service.submitTestHeader({
      requestType: 'OVERTIME',
      applicantId,
      applicantName: '幂等处理申请人',
    });
    const key = 'hr-approval-process-batch3';
    await service.process(requestId, 'APPROVE', processorId, '同意', key);
    // 同键重试：重放原结果（主 PRD §3.2），不抛 STATUS_CONFLICT
    await expect(service.process(requestId, 'APPROVE', processorId, '同意', key)).resolves.toBeUndefined();

    const header = await prisma.client.hrApprovalRequest.findUnique({ where: { id: requestId } });
    expect(header?.status).toBe('APPROVED');
    // 审批动作仅一条 APPROVE（无重复副作用写入）
    const actions = await prisma.client.hrApprovalAction.findMany({ where: { requestId } });
    expect(actions.filter((a) => a.action === 'APPROVE')).toHaveLength(1);
    // 处理写 hr 操作日志（批次 3-11）：首次执行一条、重放不重复写入
    const logs = await prisma.client.hrOperationLog.findMany({
      where: { operatorId: processorId, idempotencyScope: `hr.approval.process/${requestId}`, idempotencyKey: key },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.actionType).toBe('UPDATE');
  });

  it('POSITION_CHANGE 批准时申请人已注销 → APPLICANT_DEACTIVATED 且申请保持 PENDING', async () => {
    const applicantId = BASE_APPLICANT + 3;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${applicantId}`;
    await prisma.client.$executeRaw`
      INSERT INTO base.users (id, name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES (${applicantId}, '已注销岗位申请人', 'MALE', '+8613900000603', 'ACTIVE', false, 'test-hash', NOW(), NOW())
    `;
    const { requestId } = await service.submitTestHeader({
      requestType: 'POSITION_CHANGE',
      applicantId,
      applicantName: '已注销岗位申请人',
    });
    // 注销账号（软删），模拟生命周期任务尚未消费的窗口
    await prisma.client.$executeRaw`
      UPDATE base.users SET deleted_at = NOW() WHERE id = ${applicantId}
    `;
    await expect(service.process(requestId, 'APPROVE', processorId)).rejects.toMatchObject({
      entry: { code: 'APPLICANT_DEACTIVATED' },
    });
    const head = await prisma.client.hrApprovalRequest.findUnique({ where: { id: requestId } });
    expect(head?.status).toBe('PENDING');
    // 清理：恢复并删除测试用户（审批头由 afterAll 按 applicantId 清理）
    await prisma.client.$executeRaw`
      UPDATE base.users SET deleted_at = NULL WHERE id = ${applicantId}
    `;
    await prisma.client.$executeRaw`
      DELETE FROM base.users WHERE id = ${applicantId}
    `;
  });

  it('OVERTIME 批准不因申请人注销而阻断（公司业务型）', async () => {
    const applicantId = BASE_APPLICANT + 4;
    await prisma.client.$executeRaw`DELETE FROM base.users WHERE id = ${applicantId}`;
    await prisma.client.$executeRaw`
      INSERT INTO base.users (id, name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
      VALUES (${applicantId}, '已注销加班申请人', 'MALE', '+8613900000604', 'ACTIVE', false, 'test-hash', NOW(), NOW())
    `;
    const { requestId } = await service.submitTestHeader({
      requestType: 'OVERTIME',
      applicantId,
      applicantName: '已注销加班申请人',
    });
    await prisma.client.$executeRaw`
      UPDATE base.users SET deleted_at = NOW() WHERE id = ${applicantId}
    `;
    await service.process(requestId, 'APPROVE', processorId);
    const head = await prisma.client.hrApprovalRequest.findUnique({ where: { id: requestId } });
    expect(head?.status).toBe('APPROVED');
    await prisma.client.$executeRaw`
      UPDATE base.users SET deleted_at = NULL WHERE id = ${applicantId}
    `;
    await prisma.client.$executeRaw`
      DELETE FROM base.users WHERE id = ${applicantId}
    `;
  });

  it('pendingCount 仅按显式授权计数：超管无授权 → 0；授权后按授权类型计数', async () => {
    // 制造一条 PENDING 积压，验证超管隐式全量不计入角标
    const applicantId = BASE_APPLICANT + 5;
    await service.submitTestHeader({
      requestType: 'OVERTIME',
      applicantId,
      applicantName: '角标语义申请人',
    });
    await expect(service.pendingCount(processorId)).resolves.toEqual({ total: 0, byType: {} });

    // 显式授予加班审批（COMPANY 档）→ 只统计授权类型，未授权类型不出现
    await prisma.client.$executeRaw`
      INSERT INTO backstage.employee_grants (user_id, function_code, data_scope, granted_by)
      VALUES (${processorId}, ${OVERTIME_APPROVAL_FUNCTION_CODE}, 'COMPANY', ${processorId})
    `;
    try {
      const granted = await service.pendingCount(processorId);
      expect(granted.byType.OVERTIME).toBeGreaterThanOrEqual(1);
      expect(granted.byType.POSITION_CHANGE).toBeUndefined();
      expect(granted.total).toBe(granted.byType.OVERTIME);
    } finally {
      await prisma.client.$executeRaw`
        DELETE FROM backstage.employee_grants
        WHERE user_id = ${processorId} AND function_code = ${OVERTIME_APPROVAL_FUNCTION_CODE}
      `;
    }
  });
});
