import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BusinessException, integrationErrors } from '@wbme/contracts';
import { stableTaskUuid, TASK_TYPE_ACCOUNT_LIFECYCLE } from '@wbme/tasks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma.service';
import { ensurePermissionCatalog } from '../../../test-support/ensure-permission-catalog';
import type { HrLifecycleGateway, HrRestorePreviewResponse } from './hr-lifecycle.client';
import { UserLifecycleService } from './user-lifecycle.service';

const DATABASE_URL = process.env.DATABASE_URL;

/** 测试数据统一前缀（姓名/手机号），便于隔离与清理 */
const TEST_NAME_PREFIX = 'T36_';
const TEST_PHONE_PREFIX = '+8613936';
const KEY_PREFIX = 't36-';

/**
 * 账号生命周期编排集成测试（backstage PRD §3；T3-5 后半；真实 PostgreSQL，hr 侧用注入替身）。
 * 覆盖：注销三件套同事务、整批回滚逐目标原因、最后超管/自我注销保护、邀请失效、
 * 恢复预览 DEPENDENCY 零变更、手机号占用、确认两阶段顺序与重试幂等、权限兼容性清理、待激活恢复。
 */
describe.skipIf(!DATABASE_URL)('账号生命周期（T3-5 后半：批量注销/恢复）', () => {
  let prisma: PrismaService;
  let phoneSeq = 0;
  const testUserIds: number[] = [];

  let superOp: { id: number; name: string };
  /** hr 替身默认行为记录（各用例替换实现） */
  let hrCalls: string[];

  beforeAll(async () => {
    prisma = new PrismaService();
    // CI 全新库只有迁移没有 seed：目录注册由本规格幂等保证，不依赖执行顺序
    await ensurePermissionCatalog(prisma);
    await cleanupLeftovers();
    superOp = await createUser({ name: `${TEST_NAME_PREFIX}超管`, isSuperAdmin: true });
  });

  afterAll(async () => {
    await cleanupLeftovers();
    await prisma.client.$disconnect();
  });

  /** 以指定 hr 行为构造编排服务 */
  function makeService(gateway: Partial<HrLifecycleGateway>, client?: PrismaClient): UserLifecycleService {
    const stub: HrLifecycleGateway = {
      restorePreview: async () => ({ targets: [] }),
      restoreApply: async () => ({ applied: true }),
      ...gateway,
    };
    return new UserLifecycleService(client ? ({ client } as PrismaService) : prisma, stub);
  }

  /** 默认 hr 替身：记录调用并回显逐目标可恢复 */
  function recordingGateway(opts: { failPreview?: boolean; failApply?: boolean; onApply?: () => Promise<void> } = {}): HrLifecycleGateway {
    return {
      restorePreview: async (_requestId, targets) => {
        hrCalls.push('preview');
        if (opts.failPreview) {
          throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
        }
        const response: HrRestorePreviewResponse = {
          targets: targets.map((target) => ({ userId: target.userId, restorable: true })),
        };
        return response;
      },
      restoreApply: async () => {
        hrCalls.push('apply');
        if (opts.onApply) {
          await opts.onApply();
        }
        if (opts.failApply) {
          throw new BusinessException(integrationErrors.HR_SERVICE_UNAVAILABLE);
        }
        return { applied: true };
      },
    };
  }

  /** 清理本规格产生的全部数据（按前缀/操作者识别） */
  async function cleanupLeftovers(): Promise<void> {
    const legacy = await prisma.client.user.findMany({
      where: { phone: { startsWith: TEST_PHONE_PREFIX } },
      select: { id: true },
    });
    const ids = legacy.map((row) => row.id);
    if (ids.length > 0) {
      await prisma.client.employeeGrant.deleteMany({ where: { OR: [{ userId: { in: ids } }, { grantedBy: { in: ids } }] } });
      await prisma.client.backstageOperationLog.deleteMany({ where: { operatorId: { in: ids } } });
      await prisma.client.backgroundTask.deleteMany({ where: { taskType: TASK_TYPE_ACCOUNT_LIFECYCLE, initiatorId: { in: ids } } });
      const approvals = await prisma.client.approvalRequest.findMany({ where: { applicantId: { in: ids } }, select: { id: true } });
      const approvalIds = approvals.map((row) => row.id);
      if (approvalIds.length > 0) {
        await prisma.client.profileChangeRequest.deleteMany({ where: { requestId: { in: approvalIds } } });
        await prisma.client.approvalActionRecord.deleteMany({ where: { requestId: { in: approvalIds } } });
        await prisma.client.approvalRequest.deleteMany({ where: { id: { in: approvalIds } } });
      }
      await prisma.client.activationInvitation.deleteMany({ where: { userId: { in: ids } } });
      await prisma.client.user.deleteMany({ where: { id: { in: ids } } });
    }
  }

  async function createUser(options: {
    name: string;
    isSuperAdmin?: boolean;
    status?: 'PENDING_ACTIVATION' | 'ACTIVE';
  }): Promise<{ id: number; name: string; phone: string }> {
    phoneSeq += 1;
    const status = options.status ?? 'ACTIVE';
    const user = await prisma.client.user.create({
      data: {
        name: options.name,
        gender: 'MALE',
        phone: `${TEST_PHONE_PREFIX}${String(phoneSeq).padStart(6, '0')}`,
        status,
        isSuperAdmin: options.isSuperAdmin ?? false,
        passwordHash: status === 'PENDING_ACTIVATION' ? null : 't36-hash',
      },
    });
    testUserIds.push(user.id);
    return { id: user.id, name: user.name, phone: user.phone };
  }

  async function getUser(id: number) {
    return prisma.client.user.findUniqueOrThrow({ where: { id } });
  }

  it('批量注销：同事务三件套（账号/邀请/资料审批取消/生命周期任务）+ 逐人日志 + 幂等重放', async () => {
    const pending = await createUser({ name: `${TEST_NAME_PREFIX}注销待激活`, status: 'PENDING_ACTIVATION' });
    await prisma.client.activationInvitation.create({
      data: { userId: pending.id, tokenHash: 't36-token', expiresAt: new Date(Date.now() + 3600_000) },
    });
    const active = await createUser({ name: `${TEST_NAME_PREFIX}注销正常` });
    // 正常用户有一条待审批资料修改申请（账号资料型 → 注销时自动取消）
    const approval = await prisma.client.approvalRequest.create({
      data: {
        applicationNo: `T36PC${Date.now()}`,
        requestType: 'PROFILE_CHANGE',
        applicantId: active.id,
        applicantName: active.name,
        status: 'PENDING',
        submittedAt: new Date(),
      },
    });
    await prisma.client.profileChangeRequest.create({
      data: {
        requestId: approval.id,
        userId: active.id,
        userName: active.name,
        oldName: active.name,
        newName: `${TEST_NAME_PREFIX}改名`,
        oldGender: 'MALE',
        newGender: 'FEMALE',
      },
    });

    const service = makeService({});
    const result = await service.batchDeactivate(superOp.id, {
      userIds: [pending.id, active.id],
      idempotencyKey: `${KEY_PREFIX}deact-1`,
    });
    expect(result).toEqual({ ok: true, userIds: [pending.id, active.id] });

    // ① 账号注销：状态/注销标记/会话版本/生命周期版本
    const pendingAfter = await getUser(pending.id);
    expect(pendingAfter.status).toBe('DEACTIVATED');
    expect(pendingAfter.deletedAt).not.toBeNull();
    expect(pendingAfter.deletedBy).toBe(superOp.id);
    expect(pendingAfter.sessionVersion).toBe(1); // 撤销全部会话
    expect(pendingAfter.lifecycleVersion).toBe(1);
    const activeAfter = await getUser(active.id);
    expect(activeAfter.status).toBe('DEACTIVATED');
    expect(activeAfter.sessionVersion).toBe(1);
    // 待激活目标未使用邀请立即失效
    const invitation = await prisma.client.activationInvitation.findFirstOrThrow({ where: { userId: pending.id } });
    expect(invitation.status).toBe('REVOKED');
    // ② 待审批资料修改申请自动取消（cancel_source=ACCOUNT_DEACTIVATED）+ 取消流水
    const approvalAfter = await prisma.client.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    expect(approvalAfter.status).toBe('CANCELLED');
    expect(approvalAfter.cancelSource).toBe('ACCOUNT_DEACTIVATED');
    const cancelAction = await prisma.client.approvalActionRecord.findFirstOrThrow({ where: { requestId: approval.id } });
    expect(cancelAction.action).toBe('CANCEL');
    expect(cancelAction.cancelSource).toBe('ACCOUNT_DEACTIVATED');
    // ③ 逐人生命周期任务（PENDING_ENQUEUE + 稳定业务键 + ref 内容）
    const tasks = await prisma.client.backgroundTask.findMany({
      where: { taskType: TASK_TYPE_ACCOUNT_LIFECYCLE, initiatorId: superOp.id },
    });
    expect(tasks).toHaveLength(2);
    const activeTask = tasks.find((task) => (task.ref as { userId?: number }).userId === active.id);
    expect(activeTask).toBeDefined();
    expect(activeTask?.status).toBe('PENDING_ENQUEUE');
    expect(activeTask?.taskUuid).toBe(stableTaskUuid(`${TASK_TYPE_ACCOUNT_LIFECYCLE}:DEACTIVATED:${active.id}:1`));
    expect(activeTask?.ref).toMatchObject({ event: 'DEACTIVATED', userId: active.id, lifecycleVersion: 1 });
    // 逐人日志 + 批次日志（含幂等键）
    const detailLogs = await prisma.client.backstageOperationLog.count({
      where: { operatorId: superOp.id, feature: 'user_manage', actionType: 'DELETE', summary: { startsWith: '注销用户：' } },
    });
    expect(detailLogs).toBe(2);

    // 幂等重放：同键返回原结果，不重复建任务/日志
    const replayed = await service.batchDeactivate(superOp.id, {
      userIds: [pending.id, active.id],
      idempotencyKey: `${KEY_PREFIX}deact-1`,
    });
    expect(replayed).toEqual(result);
    expect(
      await prisma.client.backgroundTask.count({ where: { taskType: TASK_TYPE_ACCOUNT_LIFECYCLE, initiatorId: superOp.id } }),
    ).toBe(2);
  });

  it('批量注销整批回滚：已注销目标/操作人自身/超管目标逐目标原因，全部不变更', async () => {
    const ok = await createUser({ name: `${TEST_NAME_PREFIX}整批正常` });
    const deactivated = await createUser({ name: `${TEST_NAME_PREFIX}整批已注销` });
    await prisma.client.user.update({ where: { id: deactivated.id }, data: { status: 'DEACTIVATED', deletedAt: new Date() } });
    const plainAdmin = await createUser({ name: `${TEST_NAME_PREFIX}用管` });
    const error = await makeService({})
      .batchDeactivate(plainAdmin.id, { userIds: [ok.id, deactivated.id, plainAdmin.id, superOp.id] })
      .catch((caught: unknown) => caught);
    const exception = error as BusinessException;
    expect(exception.entry.code).toBe('USER_BATCH_BLOCKED');
    const failures = exception.details?.failures as Array<{ userId: number; code: string }>;
    expect(failures).toContainEqual({ userId: deactivated.id, code: 'TARGET_DEACTIVATED', message: '目标账号已注销' });
    expect(failures).toContainEqual({ userId: plainAdmin.id, code: 'SELF_MODIFICATION', message: '不能注销自己的账号' });
    expect(failures).toContainEqual({
      userId: superOp.id,
      code: 'SUPER_ADMIN_TARGET',
      message: '超级管理员账号仅可由超级管理员管理',
    });
    // 整批不变更：ok 目标状态不变、无任务、无日志
    expect((await getUser(ok.id)).status).toBe('ACTIVE');
    expect(
      await prisma.client.backgroundTask.count({ where: { taskType: TASK_TYPE_ACCOUNT_LIFECYCLE, initiatorId: plainAdmin.id } }),
    ).toBe(0);
  });

  it('最后一名可用超管保护：批内含全部可用超管则整批拒绝（零写入）', async () => {
    // 服务层不校验操作人状态（守卫层已保证 ACTIVE）：构造人工"已注销状态超管"操作人以确定性触发保护；
    // 批内包含当前全部可用超管（含本机开发库的种子超管），整批被保护规则拒绝、不发生任何写入
    const artificialOperator = await prisma.client.user.create({
      data: {
        name: `${TEST_NAME_PREFIX}人工超管`,
        gender: 'MALE',
        phone: `${TEST_PHONE_PREFIX}999999`,
        status: 'DEACTIVATED', // 不计入"可用超管"，但服务站角色校验通过（deletedAt 为空）
        isSuperAdmin: true,
        passwordHash: 't36-hash',
      },
    });
    testUserIds.push(artificialOperator.id);
    const activeSupers = await prisma.client.user.findMany({
      where: { isSuperAdmin: true, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    const error = await makeService({})
      .batchDeactivate(artificialOperator.id, { userIds: activeSupers.map((row) => row.id) })
      .catch((caught: unknown) => caught);
    const exception = error as BusinessException;
    expect(exception.entry.code).toBe('USER_BATCH_BLOCKED');
    const failures = exception.details?.failures as Array<{ userId: number; code: string }>;
    expect(failures.length).toBe(activeSupers.length);
    expect(failures.every((failure) => failure.code === 'LAST_SUPER_ADMIN')).toBe(true);
    // 零写入：所有可用超管仍为正常状态
    const stillActive = await prisma.client.user.count({ where: { isSuperAdmin: true, status: 'ACTIVE', deletedAt: null } });
    expect(stillActive).toBe(activeSupers.length);
  });

  it('恢复预览：hr 不可用 → HR_SERVICE_UNAVAILABLE 且零变更；可用时返回逐目标差异（手机号占用/失效授权）', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}预览` });
    // 失效授权（目录外 + 档位失效）与有效授权
    await prisma.client.employeeGrant.createMany({
      data: [
        { userId: target.id, functionCode: 'ghost_function', dataScope: 'COMPANY', grantedBy: superOp.id },
        { userId: target.id, functionCode: 'my_assets', dataScope: 'COMPANY', grantedBy: superOp.id },
        { userId: target.id, functionCode: 'my_assets', dataScope: 'SELF', grantedBy: superOp.id },
      ],
    });
    const lifecycle = makeService({});
    await lifecycle.batchDeactivate(superOp.id, { userIds: [target.id] });

    // hr 不可用：预览直接 503，账号保持已注销、无任何变更
    hrCalls = [];
    const unavailable = makeService({ restorePreview: recordingGateway({ failPreview: true }).restorePreview });
    await expect(unavailable.previewRestore(superOp.id, { userIds: [target.id] })).rejects.toMatchObject({
      entry: { code: 'HR_SERVICE_UNAVAILABLE' },
    });
    expect(hrCalls).toEqual(['preview']);
    expect((await getUser(target.id)).status).toBe('DEACTIVATED');

    // hr 可用：逐目标差异（ghost_function/my_assets(COMPANY) 将被移除；my_assets(SELF) 保留）
    const ok = makeService(recordingGateway());
    const preview = await ok.previewRestore(superOp.id, { userIds: [target.id] });
    expect(preview.restoreRequestId).toBeTruthy();
    expect(preview.items).toHaveLength(1);
    const item = preview.items[0];
    expect(item?.restorable).toBe(true);
    expect(item?.restoreStatus).toBe('ACTIVE');
    expect(item?.lifecycleVersion).toBe(1);
    expect(item?.revokedGrants.map((grant) => `${grant.functionCode}:${grant.dataScope}`).sort()).toEqual([
      'ghost_function:COMPANY',
      'my_assets:COMPANY',
    ]);

    // 手机号占用：占用方为待激活/正常账号 → 该目标标记不可恢复
    const occupiedTarget = await createUser({ name: `${TEST_NAME_PREFIX}占用源` });
    await prisma.client.user.update({
      where: { id: occupiedTarget.id },
      data: { status: 'DEACTIVATED', deletedAt: new Date(), deletedBy: superOp.id },
    });
    await prisma.client.user.create({
      data: {
        name: `${TEST_NAME_PREFIX}占用方`,
        gender: 'FEMALE',
        phone: occupiedTarget.phone,
        status: 'ACTIVE',
        passwordHash: 't36-hash',
      },
    });
    const preview2 = await makeService(recordingGateway()).previewRestore(superOp.id, { userIds: [occupiedTarget.id] });
    expect(preview2.items[0]?.restorable).toBe(false);
    expect(preview2.items[0]?.blockedReason).toBe('PHONE_OCCUPIED');
  });

  it('恢复确认：hr 整批应用先于本地事务；权限兼容性清理；待激活恢复仍待激活', async () => {
    const active = await createUser({ name: `${TEST_NAME_PREFIX}恢复` });
    await prisma.client.employeeGrant.createMany({
      data: [
        { userId: active.id, functionCode: 'my_assets', dataScope: 'SELF', grantedBy: superOp.id },
        { userId: active.id, functionCode: 'ghost_function', dataScope: 'COMPANY', grantedBy: superOp.id },
      ],
    });
    const pending = await createUser({ name: `${TEST_NAME_PREFIX}恢复待激活`, status: 'PENDING_ACTIVATION' });
    const service0 = makeService({});
    await service0.batchDeactivate(superOp.id, { userIds: [active.id, pending.id] });
    const activeLv = (await getUser(active.id)).lifecycleVersion;
    const pendingLv = (await getUser(pending.id)).lifecycleVersion;
    const restoreRequestId = randomUUID();

    // 替身断言：hr apply 被调用时目标仍处于已注销（证明 hr 先于本地恢复）
    hrCalls = [];
    const service = makeService(
      recordingGateway({
        onApply: async () => {
          expect((await getUser(active.id)).status).toBe('DEACTIVATED');
        },
      }),
    );
    const result = await service.confirmRestore(superOp.id, {
      restoreRequestId,
      targets: [
        { userId: active.id, lifecycleVersion: activeLv },
        { userId: pending.id, lifecycleVersion: pendingLv },
      ],
      idempotencyKey: `${KEY_PREFIX}restore-1`,
    });
    expect(result).toEqual({ ok: true, userIds: [active.id, pending.id] });
    expect(hrCalls).toEqual(['apply']);

    const activeAfter = await getUser(active.id);
    expect(activeAfter.status).toBe('ACTIVE');
    expect(activeAfter.deletedAt).toBeNull();
    expect(activeAfter.restoredBy).toBe(superOp.id);
    expect(activeAfter.restoredAt).not.toBeNull();
    expect(activeAfter.lifecycleVersion).toBe(activeLv + 1);
    expect(activeAfter.permissionVersion).toBe(1);
    // 权限兼容性清理：失效授权物理删除，有效授权保留
    const grants = await prisma.client.employeeGrant.findMany({ where: { userId: active.id } });
    expect(grants.map((row) => row.functionCode)).toEqual(['my_assets']);
    // 待激活恢复后仍待激活
    expect((await getUser(pending.id)).status).toBe('PENDING_ACTIVATION');
    // 逐人日志含移除明细
    const log = await prisma.client.backstageOperationLog.findFirst({
      where: { operatorId: superOp.id, actionType: 'UPDATE', summary: { contains: '移除失效授权' } },
    });
    expect(log?.summary).toContain('ghost_function');

    // 幂等重放：同键返回原结果，不再调 hr
    const replayed = await service.confirmRestore(superOp.id, {
      restoreRequestId,
      targets: [
        { userId: active.id, lifecycleVersion: activeLv },
        { userId: pending.id, lifecycleVersion: pendingLv },
      ],
      idempotencyKey: `${KEY_PREFIX}restore-1`,
    });
    expect(replayed).toEqual(result);
    expect(hrCalls).toEqual(['apply']);
  });

  it('恢复确认前置：生命周期版本不符/未注销目标整批拒绝且不调 hr；hr 失败零变更', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}确认校验` });
    const service = makeService({});
    await service.batchDeactivate(superOp.id, { userIds: [target.id] });
    const current = await getUser(target.id);

    // 版本不符（预校验失败，不调 hr）
    hrCalls = [];
    const error = await makeService(recordingGateway())
      .confirmRestore(superOp.id, {
        restoreRequestId: randomUUID(),
        targets: [{ userId: target.id, lifecycleVersion: current.lifecycleVersion + 9 }],
      })
      .catch((caught: unknown) => caught);
    expect((error as BusinessException).entry.code).toBe('USER_BATCH_BLOCKED');
    expect(((error as BusinessException).details?.failures as Array<{ code: string }>)[0]?.code).toBe('VERSION_CONFLICT');
    expect(hrCalls).toEqual([]);

    // hr 应用失败：本地零变更（账号保持已注销）
    hrCalls = [];
    const failing = makeService(recordingGateway({ failApply: true }));
    await expect(
      failing.confirmRestore(superOp.id, {
        restoreRequestId: randomUUID(),
        targets: [{ userId: target.id, lifecycleVersion: current.lifecycleVersion }],
      }),
    ).rejects.toMatchObject({ entry: { code: 'HR_SERVICE_UNAVAILABLE' } });
    expect(hrCalls).toEqual(['apply']);
    expect((await getUser(target.id)).status).toBe('DEACTIVATED');
  });

  it('hr 成功而本地失败：同恢复请求 ID 重试，hr 幂等返回后本地完成恢复', async () => {
    const target = await createUser({ name: `${TEST_NAME_PREFIX}两阶段` });
    const service0 = makeService({});
    await service0.batchDeactivate(superOp.id, { userIds: [target.id] });
    const lv = (await getUser(target.id)).lifecycleVersion;
    const restoreRequestId = randomUUID();

    // 首次：hr apply 成功，本地事务首个 updateMany 注入失败 → 整体回滚
    let applyCount = 0;
    const gateway = recordingGateway({ onApply: async () => void (applyCount += 1) });
    const failingClient = clientFailingFirstUserUpdate(prisma.client);
    await expect(
      makeService(gateway, failingClient).confirmRestore(superOp.id, {
        restoreRequestId,
        targets: [{ userId: target.id, lifecycleVersion: lv }],
      }),
    ).rejects.toThrow('注入故障');
    expect(applyCount).toBe(1);
    expect((await getUser(target.id)).status).toBe('DEACTIVATED'); // 本地回滚：仍已注销

    // 重试（同 restoreRequestId）：hr 幂等返回原结果（替身记录再次被调），本地事务完成恢复
    const retried = await makeService(gateway).confirmRestore(superOp.id, {
      restoreRequestId,
      targets: [{ userId: target.id, lifecycleVersion: lv }],
    });
    expect(retried).toEqual({ ok: true, userIds: [target.id] });
    expect(applyCount).toBe(2); // hr 侧按 restoreRequestId 幂等（真实 hr 由 T6-8 实现去重；替身仅记录调用）
    expect((await getUser(target.id)).status).toBe('ACTIVE');
  });
});

/**
 * 构造一个 Prisma 客户端包装：真实事务内首次 user.updateMany 抛出注入故障，
 * 用于验证「hr 成功而本地事务失败」时本地零写入、可同恢复请求 ID 重试。
 */
function clientFailingFirstUserUpdate(client: PrismaClient): PrismaClient {
  let fired = false;
  const transaction = client.$transaction.bind(client) as (
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>;
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== '$transaction') {
        return Reflect.get(target, property, receiver) as unknown;
      }
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        transaction((tx) => {
          const patchedTx = new Proxy(tx, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty !== 'user') {
                return Reflect.get(txTarget, txProperty, txReceiver) as unknown;
              }
              const delegate = Reflect.get(txTarget, txProperty, txReceiver) as object;
              return new Proxy(delegate, {
                get(userTarget, userProperty, userReceiver) {
                  if (userProperty === 'updateMany' && !fired) {
                    fired = true;
                    return (): Promise<never> => Promise.reject(new Error('注入故障：本地恢复事务失败'));
                  }
                  return Reflect.get(userTarget, userProperty, userReceiver);
                },
              });
            },
          });
          return callback(patchedTx);
        });
    },
  });
}
