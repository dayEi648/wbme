import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../../prisma.service';
import { ProfileChangeService } from './profile-change.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

/**
 * 资料修改审批集成测试（base PRD §6、backstage PRD §3/§5）：
 * 超管直改生效；员工创建审批单（单待审批 409）；审批通过才生效、驳回不改正式资料。
 */
describe('资料修改审批（P3/X1）', () => {
  let prisma: PrismaService;
  let service: ProfileChangeService;
  const createdIds: number[] = [];

  /** 固定测试手机号段（清理用） */
  const TEST_PHONES = ['+8613900000501', '+8613900000502', '+8613900000503'];

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new ProfileChangeService(prisma);
    // 幂等清理上次运行残留（固定测试手机号段；approval_actions 外键无级联需先行删除）
    const leftovers = await prisma.client.user.findMany({
      where: { phone: { in: TEST_PHONES } },
      select: { id: true },
    });
    if (leftovers.length > 0) {
      const ids = leftovers.map((u) => u.id);
      await prisma.client.approvalActionRecord.deleteMany({ where: { request: { applicantId: { in: ids } } } });
      await prisma.client.approvalRequest.deleteMany({ where: { applicantId: { in: ids } } });
      await prisma.client.user.deleteMany({ where: { id: { in: ids } } });
    }
  });

  afterAll(async () => {
    // 清理顺序：动作流水（外键无级联）→ 审批头（明细级联删除）→ 用户
    await prisma.client.approvalActionRecord.deleteMany({ where: { request: { applicantId: { in: createdIds } } } });
    await prisma.client.approvalRequest.deleteMany({ where: { applicantId: { in: createdIds } } });
    await prisma.client.user.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.client.$disconnect();
  });

  async function createUser(isSuperAdmin: boolean, phone: string): Promise<number> {
    const user = await prisma.client.user.create({
      data: {
        name: '资料测试',
        gender: 'MALE',
        phone,
        status: 'ACTIVE',
        isSuperAdmin,
        passwordHash: 'test-hash',
      },
    });
    createdIds.push(user.id);
    return user.id;
  }

  it('超管修改立即生效（不走审批）', async () => {
    const id = await createUser(true, '+8613900000501');
    const result = await service.submitProfileChange(id, true, { name: '超管新名' });
    expect(result.applied).toBe(true);
    const user = await prisma.client.user.findUnique({ where: { id } });
    expect(user?.name).toBe('超管新名');
  });

  it('员工提交创建审批单；再次提交 409（单待审批限制）', async () => {
    const id = await createUser(false, '+8613900000502');
    const first = await service.submitProfileChange(id, false, { name: '员工新名' });
    expect(first.applied).toBe(false);
    expect(first.requestId).toBeTruthy();
    // 审批通过前正式资料不变
    const before = await prisma.client.user.findUnique({ where: { id } });
    expect(before?.name).toBe('资料测试');
    // 单待审批限制（条件唯一索引兜底）
    await expect(service.submitProfileChange(id, false, { gender: 'FEMALE' })).rejects.toMatchObject({
      entry: { code: 'PROFILE_CHANGE_PENDING_EXISTS' },
    });
  });

  it('X1 APPROVE 审批通过才生效；REJECT 驳回不改正式资料', async () => {
    const id = await createUser(false, '+8613900000503');
    const { requestId } = await service.submitProfileChange(id, false, { name: '审批生效名', gender: 'FEMALE' });

    // REJECT：不改资料
    await service.processProfileChange(requestId as number, 'REJECT', id, '不同意');
    const rejected = await prisma.client.user.findUnique({ where: { id } });
    expect(rejected?.name).toBe('资料测试');
    expect(rejected?.gender).toBe('MALE');

    // 终态不可重复处理（CONFLICT）
    await expect(service.processProfileChange(requestId as number, 'APPROVE', id)).rejects.toMatchObject({
      entry: { code: 'CONFLICT' },
    });

    // 再次提交 → APPROVE：生效
    const second = await service.submitProfileChange(id, false, { name: '审批生效名', gender: 'FEMALE' });
    await service.processProfileChange(second.requestId as number, 'APPROVE', id);
    const approved = await prisma.client.user.findUnique({ where: { id } });
    expect(approved?.name).toBe('审批生效名');
    expect(approved?.gender).toBe('FEMALE');
  });
});
