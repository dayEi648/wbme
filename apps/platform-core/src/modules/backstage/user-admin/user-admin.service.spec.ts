import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { getRequestContext, REQUEST_CONTEXT_STORAGE, type RequestContext } from '@wbme/server';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { PrismaService } from '../../../prisma.service';
import { ensurePermissionCatalog } from '../../../test-support/ensure-permission-catalog';
import { AdminAuthController } from '../../base/auth/admin-auth.controller';
import { ApprovalController } from '../../base/approval-proxy/approval.controller';
import { AuthorizationService } from '../permission/authorization.service';
import { FunctionPermissionGuard, REQUIRED_FUNCTION_KEY } from '../permission/function-permission.guard';
import { UserAdminController } from './user-admin.controller';
import { UserAdminService } from './user-admin.service';

const DATABASE_URL = process.env.DATABASE_URL;

/** 测试数据统一前缀（姓名/手机号），便于隔离与清理 */
const TEST_NAME_PREFIX = 'T35_';
const TEST_PHONE_PREFIX = '+8613935';
const KEY_PREFIX = 't35-';

/**
 * 用户管理集成测试（backstage PRD §3；实现规划 T3-5 前半；真实 PostgreSQL）。
 * 范围：创建/唯一性/列表筛选/详情/编辑白名单/超管目标保护/守卫切换断言。
 * 批量注销与恢复（账号生命周期编排）在后续迭代补充。
 */
describe.skipIf(!DATABASE_URL)('用户管理（T3-5 前半：创建/编辑/守卫切换）', () => {
  let prisma: PrismaService;
  let service: UserAdminService;
  let authorization: AuthorizationService;
  let phoneSeq = 0;

  let superOp: { id: number; name: string };
  let userAdmin: { id: number; name: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new UserAdminService(prisma);
    authorization = new AuthorizationService(prisma);
    // CI 全新库只有迁移没有 seed：目录注册由本规格幂等保证，不依赖执行顺序
    await ensurePermissionCatalog(prisma);
    await cleanupLeftovers();
    superOp = await createUser({ name: `${TEST_NAME_PREFIX}超管`, isSuperAdmin: true });
    userAdmin = await createUser({ name: `${TEST_NAME_PREFIX}用管` });
    await prisma.client.employeeGrant.create({
      data: { userId: userAdmin.id, functionCode: 'user_manage', dataScope: 'COMPANY', grantedBy: superOp.id },
    });
  });

  afterAll(async () => {
    await cleanupLeftovers();
    await prisma.client.$disconnect();
  });

  /** 清理本规格产生的授权行、操作日志与测试账号（按前缀识别） */
  async function cleanupLeftovers(): Promise<void> {
    const legacy = await prisma.client.user.findMany({
      where: { phone: { startsWith: TEST_PHONE_PREFIX } },
      select: { id: true },
    });
    const ids = legacy.map((row) => row.id);
    if (ids.length > 0) {
      await prisma.client.employeeGrant.deleteMany({ where: { OR: [{ userId: { in: ids } }, { grantedBy: { in: ids } }] } });
      await prisma.client.backstageOperationLog.deleteMany({ where: { operatorId: { in: ids } } });
      await prisma.client.user.deleteMany({ where: { id: { in: ids } } });
    }
  }

  async function createUser(options: { name: string; isSuperAdmin?: boolean }): Promise<{ id: number; name: string }> {
    phoneSeq += 1;
    const user = await prisma.client.user.create({
      data: {
        name: options.name,
        gender: 'MALE',
        phone: `${TEST_PHONE_PREFIX}${String(phoneSeq).padStart(6, '0')}`,
        status: 'ACTIVE',
        isSuperAdmin: options.isSuperAdmin ?? false,
        passwordHash: 't35-hash',
      },
    });
    return { id: user.id, name: user.name };
  }

  it('创建用户：待激活无密码账号、手机号规范化入库、写操作日志；幂等重放返回原结果', async () => {
    const created = await service.createUser(superOp.id, {
      name: `${TEST_NAME_PREFIX}新建`,
      phone: '13935009901',
      gender: 'FEMALE',
      idempotencyKey: `${KEY_PREFIX}create-1`,
    });
    const user = await prisma.client.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(created.status).toBe('PENDING_ACTIVATION');
    expect(user.status).toBe('PENDING_ACTIVATION');
    expect(user.passwordHash).toBeNull();
    expect(user.phone).toBe('+8613935009901');
    expect(user.gender).toBe('FEMALE');
    const binding = await prisma.client.dingtalkBinding.count({ where: { userId: user.id } });
    expect(binding).toBe(0);
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}create-1` },
    });
    expect(log?.feature).toBe('user_manage');
    expect(log?.actionType).toBe('CREATE');
    expect(log?.summary).toContain('创建用户');

    const replayed = await service.createUser(superOp.id, {
      name: `${TEST_NAME_PREFIX}新建`,
      phone: '13935009901',
      gender: 'FEMALE',
      idempotencyKey: `${KEY_PREFIX}create-1`,
    });
    expect(replayed).toEqual(created);
    expect(await prisma.client.user.count({ where: { phone: '+8613935009901' } })).toBe(1);
  });

  it('创建唯一性：手机号被占用 PHONE_TAKEN、非法手机号 VALIDATION_FAILED', async () => {
    const active = await createUser({ name: `${TEST_NAME_PREFIX}占位` });
    const activeUser = await prisma.client.user.findUniqueOrThrow({ where: { id: active.id } });
    await expect(
      service.createUser(superOp.id, { name: `${TEST_NAME_PREFIX}撞号`, phone: activeUser.phone, gender: 'MALE' }),
    ).rejects.toMatchObject({ entry: { code: 'PHONE_TAKEN' } });
    await expect(
      service.createUser(superOp.id, { name: `${TEST_NAME_PREFIX}坏号`, phone: 'not-a-phone', gender: 'MALE' }),
    ).rejects.toMatchObject({ entry: { code: 'VALIDATION_FAILED' } });
  });

  it('列表与详情：状态筛选（已注销为管理专用例外）、激活/钉钉绑定状态字段、模糊检索', async () => {
    const pending = await service.createUser(superOp.id, { name: `${TEST_NAME_PREFIX}待激活`, phone: '13935009902', gender: 'MALE' });
    const active = await createUser({ name: `${TEST_NAME_PREFIX}正常` });
    const deactivated = await createUser({ name: `${TEST_NAME_PREFIX}已注销` });
    await prisma.client.user.update({
      where: { id: deactivated.id },
      data: { status: 'DEACTIVATED', deletedAt: new Date(), deletedBy: superOp.id },
    });

    const all = await service.listUsers({ page: 1, pageSize: 100, keyword: TEST_NAME_PREFIX });
    const ids = all.data.map((item) => item.id);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(deactivated.id); // 缺省不含已注销

    const deactivatedList = await service.listUsers({ page: 1, pageSize: 100, status: 'DEACTIVATED', keyword: TEST_NAME_PREFIX });
    expect(deactivatedList.data.map((item) => item.id)).toContain(deactivated.id);
    expect(deactivatedList.data.map((item) => item.id)).not.toContain(active.id);
    expect(deactivatedList.data.find((item) => item.id === deactivated.id)?.deactivatedAt).not.toBeNull();

    const pendingList = await service.listUsers({ page: 1, pageSize: 100, status: 'PENDING_ACTIVATION', keyword: TEST_NAME_PREFIX });
    expect(pendingList.data.map((item) => item.id)).toContain(pending.id);
    expect(pendingList.data.map((item) => item.id)).not.toContain(active.id);

    const detail = await service.getUserDetail(pending.id);
    expect(detail).toMatchObject({ status: 'PENDING_ACTIVATION', hasDingtalkBinding: false, gender: 'MALE' });
    expect(detail.phoneMasked).toContain('****');
    await expect(service.getUserDetail(999999999)).rejects.toMatchObject({ entry: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('编辑基本资料：仅姓名性别生效、写变更前后日志；无变更/已注销/超管目标保护', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}编辑` });
    const result = await service.updateUser(superOp.id, target.id, {
      name: `${TEST_NAME_PREFIX}编辑后`,
      gender: 'FEMALE',
      idempotencyKey: `${KEY_PREFIX}update-1`,
    });
    expect(result).toEqual({ ok: true });
    const updated = await prisma.client.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.name).toBe(`${TEST_NAME_PREFIX}编辑后`);
    expect(updated.gender).toBe('FEMALE');
    expect(updated.phone).toContain(TEST_PHONE_PREFIX); // 手机号只读不受影响
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, idempotencyKey: `${KEY_PREFIX}update-1` },
    });
    expect(log?.summary).toContain('变更前');
    expect(log?.summary).toContain('变更后');

    // 无实际变更
    await expect(
      service.updateUser(superOp.id, target.id, { name: `${TEST_NAME_PREFIX}编辑后`, gender: 'FEMALE' }),
    ).rejects.toMatchObject({ entry: { code: 'VALIDATION_FAILED' } });
    // 已注销目标不可编辑
    const deactivated = await createUser({ name: `${TEST_NAME_PREFIX}编辑注销` });
    await prisma.client.user.update({ where: { id: deactivated.id }, data: { status: 'DEACTIVATED', deletedAt: new Date() } });
    await expect(
      service.updateUser(superOp.id, deactivated.id, { name: `${TEST_NAME_PREFIX}改`, gender: 'MALE' }),
    ).rejects.toMatchObject({ entry: { code: 'ACCOUNT_DEACTIVATED' } });
    // 超管目标保护：普通"用户管理"持有者不能编辑超管
    await expect(
      service.updateUser(userAdmin.id, superOp.id, { name: `${TEST_NAME_PREFIX}越权`, gender: 'MALE' }),
    ).rejects.toMatchObject({ entry: { code: 'SUPER_ADMIN_TARGET_ONLY' } });
    // 超管可以编辑超管
    await expect(
      service.updateUser(superOp.id, superOp.id, { name: `${TEST_NAME_PREFIX}超管改名`, gender: 'MALE' }),
    ).resolves.toEqual({ ok: true });
  });

  it('守卫切换断言：用户管理域控制器均声明 user_manage 功能要求；守卫 401/403/放行', async () => {
    // 类级功能声明（UserAdminController / AdminAuthController 整类受保护）
    expect(Reflect.getMetadata(REQUIRED_FUNCTION_KEY, UserAdminController)).toBe('user_manage');
    expect(Reflect.getMetadata(REQUIRED_FUNCTION_KEY, AdminAuthController)).toBe('user_manage');
    // 审批中心（T5-2）：声明在方法级——管理端点逐个要求 user_manage，cancel 仅需登录（提交人/代交人可取消）
    const approvalHandlers = ['pendingCount', 'list', 'detail', 'process'];
    for (const method of approvalHandlers) {
      expect(Reflect.getMetadata(REQUIRED_FUNCTION_KEY, ApprovalController.prototype[method as keyof ApprovalController])).toBe(
        'user_manage',
      );
    }
    expect(Reflect.getMetadata(REQUIRED_FUNCTION_KEY, ApprovalController.prototype.cancel)).toBeUndefined();

    const handler = (): void => undefined;
    const context = { getHandler: () => handler, getClass: () => class {} } as never;
    const reflector = {
      get: (key: string, metaTarget: unknown) => (key === REQUIRED_FUNCTION_KEY && metaTarget === handler ? 'user_manage' : undefined),
    } as unknown as Reflector;
    const guard = new FunctionPermissionGuard(reflector, authorization);
    const runGuard = (userId: number | undefined): Promise<boolean> =>
      REQUEST_CONTEXT_STORAGE.run(
        { requestId: 'r', traceId: 't', startedAt: 0, service: 'test', userId } as RequestContext,
        () => guard.canActivate(context),
      );

    await expect(runGuard(undefined)).rejects.toMatchObject({ entry: { code: 'UNAUTHORIZED' } });
    const plain = await createUser({ name: `${TEST_NAME_PREFIX}无权` });
    await expect(runGuard(plain.id)).rejects.toMatchObject({ entry: { code: 'FORBIDDEN' } });
    await expect(runGuard(userAdmin.id)).resolves.toBe(true);
    await expect(runGuard(superOp.id)).resolves.toBe(true);
    expect(getRequestContext()?.grantedFunction).toBeUndefined(); // 超出上下文 run 外无残留
  });
});
