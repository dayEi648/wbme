import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { BusinessException } from '@wbme/contracts';
import { CsrfService, SessionService } from '@wbme/server';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL/Redis）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { PrismaService } from '../../../../prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { SecurityLogService } from '../../security-log/security-log.service';
import { LoginProtectionService } from '../../login-protection/login-protection.service';
import { PasswordService } from '../password.service';
import { TokenService } from '../token.service';
import { PhoneSyncService } from '../phone-sync.service';
import { AuthService } from '../auth.service';
import { FlowSessionService } from './flow-session.service';
import { ActivationFlow } from './activation.flow';
import { AdminInvitationService } from '../admin-invitation.service';

const REDIS_URL = process.env.REDIS_URL;

/**
 * 激活全链路集成测试（真实 PG + Redis；测试数据即建即清，base PRD §2）：
 * M1 生成邀请 → A6 redeem → （钉钉回调写入流程会话）→ A7 confirm 单事务激活。
 */
describe.skipIf(!REDIS_URL)('激活流程集成（base PRD §2 双通道一次性/手机号唯一/原子事务）', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let activation: ActivationFlow;
  let invitations: AdminInvitationService;
  let flows: FlowSessionService;

  /** 测试专用手机号段（1390000xxxx） */
  const TEST_PHONE = '+8613900000011';
  let adminId = -1;
  let phoneSeq = 20;

  beforeAll(async () => {
    prisma = new PrismaService();
    redis = new Redis(REDIS_URL ?? 'redis://localhost:6379');
    flows = new FlowSessionService(redis);
    const settings = new SettingsService(prisma);
    const securityLog = new SecurityLogService(prisma);
    const token = new TokenService();
    const password = new PasswordService();
    const csrf = new CsrfService('test-signing-key-at-least-32-chars-long!!');
    const session = new SessionService(redis);
    const protection = new LoginProtectionService(redis, settings, securityLog, prisma);
    const phoneSync = new PhoneSyncService(prisma, securityLog);
    const auth = new AuthService(prisma, password, protection, securityLog, settings, session, csrf, phoneSync);
    activation = new ActivationFlow(prisma, token, flows, password, settings, securityLog, auth);
    invitations = new AdminInvitationService(prisma, token, settings, securityLog);

    // CHECK 约束：ACTIVE 账号必须有 password_hash
    const admin = await prisma.client.user.create({
      data: { name: '测试超管', gender: 'MALE', phone: '+8613900000010', status: 'ACTIVE', isSuperAdmin: true, passwordHash: 'test-hash' },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.client.operationLog.deleteMany({ where: { operatorId: adminId } });
    await prisma.client.securityLog.deleteMany({ where: { OR: [{ actorId: adminId }, { targetUserId: adminId }] } });
    await prisma.client.user.deleteMany({ where: { id: adminId } });
    await prisma.client.$disconnect();
    await redis.quit();
  });

  /** 每个用例独立创建待激活账号（用例结束清理） */
  async function createPendingUser(name = '待激活员工'): Promise<{ id: number; phone: string }> {
    phoneSeq += 1;
    const phone = `+86139000${String(phoneSeq).padStart(4, '0')}`;
    const user = await prisma.client.user.create({
      data: { name, gender: 'FEMALE', phone, status: 'PENDING_ACTIVATION' },
    });
    return { id: user.id, phone };
  }

  async function cleanupUser(userId: number): Promise<void> {
    await prisma.client.dingtalkBinding.deleteMany({ where: { userId } });
    await prisma.client.activationInvitation.deleteMany({ where: { userId } });
    await prisma.client.securityLog.deleteMany({ where: { OR: [{ targetUserId: userId }, { actorId: userId }] } });
    await prisma.client.user.deleteMany({ where: { id: userId } });
  }

  it('M1 生成邀请 → A6 兑换成功并返回待激活用户（手机号脱敏）', async () => {
    const pending = await createPendingUser();
    try {
      const { activationUrl } = await invitations.issueActivationInvitation(adminId, pending.id);
      expect(activationUrl).toMatch(/#.+$/);
      const rawToken = activationUrl.split('#')[1] ?? '';
      expect(rawToken.length).toBeGreaterThanOrEqual(32);
      const result = await activation.redeem(rawToken);
      expect(result.userId).toBe(pending.id);
      expect(result.name).toBe('待激活员工');
      expect(result.phoneMasked).not.toContain(pending.phone.replace('+86', '')); // 脱敏不泄露完整手机号
    } finally {
      await cleanupUser(pending.id);
    }
  });

  it('确认后邀请一次性使用，账号生效且绑定钉钉', async () => {
    const pending = await createPendingUser('激活员工');
    try {
      const { activationUrl } = await invitations.issueActivationInvitation(adminId, pending.id);
      const rawToken = activationUrl.split('#')[1] ?? '';
      const mobile = pending.phone.replace('+86', '');
      const flowId = await flows.issue('ACTIVATION', { userId: pending.id, unionId: `int-union-${pending.id}`, mobile, stateCode: '86' });

      const result = await activation.confirm(
        flowId,
        { unionId: `int-union-${pending.id}`, mobile, stateCode: '86', name: '激活后姓名', gender: 'MALE', password: 'Test12345678' },
        '10.1.1.1',
      );
      expect(result.user.status).toBe('ACTIVE');
      expect(result.user.name).toBe('激活后姓名');

      // 邀请已 USED：再次兑换拒绝
      await expect(activation.redeem(rawToken)).rejects.toBeInstanceOf(BusinessException);

      // 绑定与密码已写入（可直接用平台密码登录）
      const user = await prisma.client.user.findUnique({ where: { id: pending.id } });
      expect(user?.status).toBe('ACTIVE');
      expect(user?.passwordHash).toBeTruthy();
      const binding = await prisma.client.dingtalkBinding.findFirst({ where: { userId: pending.id, status: 'BOUND' } });
      expect(binding?.dingtalkUnionId).toBe(`int-union-${pending.id}`);
    } finally {
      await cleanupUser(pending.id);
    }
  });

  it('unionId 已被其他账号绑定时拒绝激活', async () => {
    const pending = await createPendingUser();
    try {
      // 先占一个绑定
      await prisma.client.dingtalkBinding.create({
        data: { userId: adminId, dingtalkUnionId: 'occupied-union', status: 'BOUND' },
      });
      const flowId = await flows.issue('ACTIVATION', { userId: pending.id, unionId: 'occupied-union', mobile: '13900000099', stateCode: '86' });
      await expect(
        activation.confirm(
          flowId,
          { unionId: 'occupied-union', mobile: '13900000099', stateCode: '86', name: 'X', gender: 'MALE', password: 'Test12345678' },
          '10.1.1.2',
        ),
      ).rejects.toMatchObject({ entry: { code: 'DINGTALK_ALREADY_BOUND' } });
    } finally {
      await prisma.client.dingtalkBinding.deleteMany({ where: { dingtalkUnionId: 'occupied-union' } });
      await cleanupUser(pending.id);
    }
  });

  it('手机号被其他待激活/正常账号占用时拒绝激活（PHONE_TAKEN）', async () => {
    const pending = await createPendingUser();
    const occupant = await createPendingUser('占用方');
    try {
      // 占用方账号持有 TEST_PHONE（模拟预留手机号被他人占用）
      await prisma.client.user.update({ where: { id: occupant.id }, data: { phone: TEST_PHONE } });
      await invitations.issueActivationInvitation(adminId, pending.id); // 有效邀请（占用检查在邀请校验之后）
      const mobile = TEST_PHONE.replace('+86', '');
      const flowId = await flows.issue('ACTIVATION', { userId: pending.id, unionId: `int-union-${pending.id}`, mobile, stateCode: '86' });
      await expect(
        activation.confirm(
          flowId,
          { unionId: `int-union-${pending.id}`, mobile, stateCode: '86', name: 'X', gender: 'MALE', password: 'Test12345678' },
          '10.1.1.3',
        ),
      ).rejects.toMatchObject({ entry: { code: 'PHONE_TAKEN' } });
    } finally {
      await cleanupUser(pending.id);
      await cleanupUser(occupant.id);
    }
  });

  it('重新生成邀请立即使旧邀请失效（双通道同一凭证，任一生效另一同步失效）', async () => {
    const pending = await createPendingUser();
    try {
      const first = await invitations.issueActivationInvitation(adminId, pending.id);
      const second = await invitations.issueActivationInvitation(adminId, pending.id);
      const firstToken = first.activationUrl.split('#')[1] ?? '';
      const secondToken = second.activationUrl.split('#')[1] ?? '';
      // 旧邀请立即失效
      await expect(activation.redeem(firstToken)).rejects.toBeInstanceOf(BusinessException);
      // 新邀请可兑换
      const result = await activation.redeem(secondToken);
      expect(result.userId).toBe(pending.id);
    } finally {
      await cleanupUser(pending.id);
    }
  });
});
