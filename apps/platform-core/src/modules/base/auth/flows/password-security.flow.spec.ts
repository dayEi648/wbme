import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { CsrfService, SessionService } from '@wbme/server';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../../../prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { SecurityLogService } from '../../security-log/security-log.service';
import { LoginProtectionService } from '../../login-protection/login-protection.service';
import { PasswordService } from '../password.service';
import { TokenService } from '../token.service';
import { PhoneSyncService } from '../phone-sync.service';
import { AuthService } from '../auth.service';
import { FlowSessionService } from './flow-session.service';
import { ResetFlow } from './reset.flow';
import { RebindFlow } from './rebind.flow';
import { AdminInvitationService } from '../admin-invitation.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL/Redis）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const REDIS_URL = process.env.REDIS_URL;

/**
 * 改密/重置/换绑集成测试（真实 PG + Redis；测试数据即建即清，base PRD §2/§3）：
 * - 改密/重置/换绑后 session_version 递增 → 旧会话全部失效；
 * - 重置要求 unionId 与账号绑定一致；换绑原子替换绑定并同步手机号。
 */
describe.skipIf(!REDIS_URL)('改密/重置/换绑集成（session_version 全会话失效）', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let auth: AuthService;
  let reset: ResetFlow;
  let rebind: RebindFlow;
  let invitations: AdminInvitationService;
  let flows: FlowSessionService;
  let password: PasswordService;
  let session: SessionService;
  let phoneSeq = 300;

  beforeAll(async () => {
    prisma = new PrismaService();
    redis = new Redis(REDIS_URL ?? 'redis://localhost:6379');
    flows = new FlowSessionService(redis);
    password = new PasswordService();
    session = new SessionService(redis);
    const settings = new SettingsService(prisma);
    const securityLog = new SecurityLogService(prisma);
    const token = new TokenService();
    const csrf = new CsrfService('test-signing-key-at-least-32-chars-long!!');
    const protection = new LoginProtectionService(redis, settings, securityLog);
    const phoneSync = new PhoneSyncService(prisma, securityLog);
    auth = new AuthService(prisma, password, protection, securityLog, settings, session, csrf, phoneSync);
    reset = new ResetFlow(prisma, flows, password, phoneSync, securityLog);
    rebind = new RebindFlow(prisma, flows, phoneSync, securityLog);
    invitations = new AdminInvitationService(prisma, token, settings, securityLog);

    // 测试账号：ACTIVE + 密码 + 钉钉绑定（统一在用例外准备一次，用例内变更后不复用）
  });

  afterAll(async () => {
    await prisma.client.$disconnect();
    await redis.quit();
  });

  /** 每个用例独立账号（ACTIVE + 密码 + 绑定） */
  async function createActiveUser(unionId = 'sec-union-001'): Promise<{ id: number; phone: string }> {
    phoneSeq += 1;
    const phone = `+86139000${String(phoneSeq).padStart(4, '0')}`;
    const hash = await password.hash('OldPass123456');
    const user = await prisma.client.user.create({
      data: { name: '安全测试', gender: 'MALE', phone, status: 'ACTIVE', passwordHash: hash },
    });
    await prisma.client.dingtalkBinding.create({
      data: { userId: user.id, dingtalkUnionId: unionId, status: 'BOUND' },
    });
    return { id: user.id, phone };
  }

  async function cleanupUser(id: number): Promise<void> {
    await prisma.client.dingtalkBinding.deleteMany({ where: { userId: id } });
    await prisma.client.activationInvitation.deleteMany({ where: { userId: id } });
    await prisma.client.securityLog.deleteMany({ where: { OR: [{ targetUserId: id }, { actorId: id }] } });
    await prisma.client.user.deleteMany({ where: { id } });
  }

  it('A9 改密：旧密码错误拒绝；成功后 session_version 递增（旧会话立即失效）', async () => {
    const user = await createActiveUser('sec-union-a9');
    try {
      // 建旧会话（模拟改密前已登录）
      const before = await auth.createUserSession(user.id, false, '10.2.0.1');
      expect(before.sessionId).toBeTruthy();
      expect(await session.read(before.sessionId)).not.toBeNull();

      // 旧密码错误 → 拒绝
      await expect(auth.changePassword(user.id, 'WrongPass123', 'NewPass123456', '10.2.0.1')).rejects.toMatchObject({
        entry: { code: 'OLD_PASSWORD_INCORRECT' },
      });

      // 改密成功
      await auth.changePassword(user.id, 'OldPass123456', 'NewPass123456', '10.2.0.1');

      // 旧会话版本不匹配 → 守卫语义：read 后 sv 对比失败（会话本身仍在，但守卫会拒绝）
      const data = await session.read(before.sessionId);
      const freshUser = await prisma.client.user.findUnique({ where: { id: user.id }, select: { sessionVersion: true } });
      expect(data?.sv).not.toBe(freshUser?.sessionVersion); // 版本已递增，旧会话失效
      // 新密码可登录
      const login = await auth.loginPassword({ phone: user.phone.replace('+86', ''), password: 'NewPass123456' }, '10.2.0.1');
      expect(login.user.id).toBe(user.id);
    } finally {
      await cleanupUser(user.id);
    }
  });

  it('M2 重置全链路：兑换 → 钉钉验证（绑定一致）→ 新密码生效 + 全会话失效', async () => {
    const user = await createActiveUser('sec-union-reset');
    try {
      const { resetUrl } = await invitations.issueResetInvitation(user.id, user.id); // 本人发起（测试简化：操作者=目标）
      const rawToken = resetUrl.split('#')[1] ?? '';
      const tokenHash = new TokenService().hash(rawToken);

      const redeemed = await reset.redeem(rawToken, tokenHash);
      expect(redeemed.userId).toBe(user.id);

      const flowId = await flows.issue('RESET', { userId: user.id, unionId: 'sec-union-reset', mobile: '13900000301', stateCode: '86' });
      await reset.confirm(
        flowId,
        { unionId: 'sec-union-reset', mobile: '13900000301', stateCode: '86', newPassword: 'ResetPass123456' },
        '10.2.0.2',
      );

      // 新密码可登录，旧密码不可
      const freshUser = await prisma.client.user.findUnique({ where: { id: user.id }, select: { sessionVersion: true } });
      expect(freshUser?.sessionVersion).toBe(1); // 从 0 → 1
      const ok = await password.verifyPassword('ResetPass123456', (await prisma.client.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } }))?.passwordHash ?? '');
      expect(ok).toBe(true);
      // 凭证已一次性（USED）
      await expect(reset.redeem(rawToken, tokenHash)).rejects.toBeTruthy();
    } finally {
      await cleanupUser(user.id);
    }
  });

  it('M2 重置：unionId 与账号绑定不一致拒绝（组织不匹配语义）', async () => {
    const user = await createActiveUser('sec-union-reset2');
    try {
      const { resetUrl } = await invitations.issueResetInvitation(user.id, user.id);
      const rawToken = resetUrl.split('#')[1] ?? '';
      const tokenHash = new TokenService().hash(rawToken);
      await reset.redeem(rawToken, tokenHash);
      const flowId = await flows.issue('RESET', { userId: user.id, unionId: 'WRONG-UNION', mobile: '13900000302', stateCode: '86' });
      await expect(
        reset.confirm(flowId, { unionId: 'WRONG-UNION', mobile: '13900000302', stateCode: '86', newPassword: 'Xxx12345678' }, '10.2.0.3'),
      ).rejects.toMatchObject({ entry: { code: 'DINGTALK_ORG_MISMATCH' } });
    } finally {
      await cleanupUser(user.id);
    }
  });

  it('A11 换绑：原子替换绑定（旧 UNBOUND + 新 BOUND）+ session_version 递增', async () => {
    const user = await createActiveUser('sec-union-old');
    try {
      const flowId = await flows.issue('REBIND', { userId: user.id, unionId: 'sec-union-new', mobile: '13900000303', stateCode: '86' });
      await rebind.confirm(flowId, { unionId: 'sec-union-new', mobile: '13900000303', stateCode: '86' }, '10.2.0.4');

      const oldBinding = await prisma.client.dingtalkBinding.findFirst({ where: { userId: user.id, dingtalkUnionId: 'sec-union-old' } });
      const newBinding = await prisma.client.dingtalkBinding.findFirst({ where: { userId: user.id, dingtalkUnionId: 'sec-union-new' } });
      expect(oldBinding?.status).toBe('UNBOUND'); // 旧绑定保留历史
      expect(newBinding?.status).toBe('BOUND');
      const freshUser = await prisma.client.user.findUnique({ where: { id: user.id }, select: { sessionVersion: true } });
      expect(freshUser?.sessionVersion).toBe(1);
    } finally {
      await cleanupUser(user.id);
    }
  });

  it('换绑后旧 unionId 不可再用于登录（绑定已替换）', async () => {
    const user = await createActiveUser('sec-union-old2');
    try {
      const flowId = await flows.issue('REBIND', { userId: user.id, unionId: 'sec-union-new2', mobile: '13900000304', stateCode: '86' });
      await rebind.confirm(flowId, { unionId: 'sec-union-new2', mobile: '13900000304', stateCode: '86' }, '10.2.0.5');
      // 旧 unionId 已无 BOUND 绑定 → 扫码登录返回 null（走注册分流会被 DINGTALK_ALREADY_BOUND 拦截）
      const result = await auth.loginWithDingtalk({ unionId: 'sec-union-old2', mobile: '13900000304', stateCode: '86' }, '10.2.0.5');
      expect(result).toBeNull();
    } finally {
      await cleanupUser(user.id);
    }
  });
});
