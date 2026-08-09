import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { CsrfService, SessionService, redisKey, REDIS_NAMESPACE } from '@wbme/server';
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
import { AdminInvitationService } from '../admin-invitation.service';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL/Redis）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const REDIS_URL = process.env.REDIS_URL;

/**
 * 改密/重置集成测试（真实 PG + Redis；测试数据即建即清，base PRD §2/§3）：
 * - 改密/重置后 session_version 递增 → 旧会话全部失效；
 * - 重置要求 unionId 与账号绑定一致。
 */
describe.skipIf(!REDIS_URL)('改密/重置集成（session_version 全会话失效）', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let auth: AuthService;
  let reset: ResetFlow;
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
    const protection = new LoginProtectionService(redis, settings, securityLog, prisma);
    const phoneSync = new PhoneSyncService(prisma, securityLog);
    auth = new AuthService(prisma, password, protection, securityLog, settings, session, csrf, phoneSync);
    reset = new ResetFlow(prisma, flows, password, phoneSync, securityLog);
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

      // 与真实控制器一致：兑换成功后签发携带 tokenHash 的重置流程会话（password.controller.ts resetRedeem）
      const flowId = await flows.issue('RESET', {
        userId: user.id,
        tokenHash,
        unionId: 'sec-union-reset',
        mobile: '13900000301',
        stateCode: '86',
      });
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

  it('M2 重置：凭证被重新生成（REVOKED）后旧凭证 confirm 拒绝（事务内一次性校验）', async () => {
    const user = await createActiveUser('sec-union-revoked');
    try {
      const { resetUrl } = await invitations.issueResetInvitation(user.id, user.id);
      const rawToken = resetUrl.split('#')[1] ?? '';
      const tokenHash = new TokenService().hash(rawToken);
      await reset.redeem(rawToken, tokenHash);
      // 管理员重新生成 → 旧凭证 REVOKED（base PRD §2：重新生成立即失效）
      await invitations.issueResetInvitation(user.id, user.id);
      const flowId = await flows.issue('RESET', {
        userId: user.id,
        tokenHash,
        unionId: 'sec-union-revoked',
        mobile: '13900000305',
        stateCode: '86',
      });
      await expect(
        reset.confirm(
          flowId,
          { unionId: 'sec-union-revoked', mobile: '13900000305', stateCode: '86', newPassword: 'Xxx12345678' },
          '10.2.0.8',
        ),
      ).rejects.toMatchObject({ entry: { code: 'INVITATION_INVALID' } });
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
      const flowId = await flows.issue('RESET', {
        userId: user.id,
        tokenHash,
        unionId: 'WRONG-UNION',
        mobile: '13900000302',
        stateCode: '86',
      });
      await expect(
        reset.confirm(flowId, { unionId: 'WRONG-UNION', mobile: '13900000302', stateCode: '86', newPassword: 'Xxx12345678' }, '10.2.0.3'),
      ).rejects.toMatchObject({ entry: { code: 'DINGTALK_ORG_MISMATCH' } });
    } finally {
      await cleanupUser(user.id);
    }
  });

  it('A10\' 自助重置发起：已绑定账号可发起；未注册/格式非法统一拒绝（不泄露手机号是否注册）', async () => {
    const user = await createActiveUser('sec-union-init');
    try {
      // 已绑定 ACTIVE 账号 → 发起成功（返回 userId，可用于签发 RESET 流程）
      const initiated = await reset.initiateByPhone(user.phone, '10.2.0.6');
      expect(initiated.userId).toBe(user.id);

      // 未注册手机号 → 统一拒绝
      await expect(reset.initiateByPhone('+8613999999999', '10.2.0.6')).rejects.toMatchObject({
        entry: { code: 'RESET_SELF_UNAVAILABLE' },
      });
      // 格式非法同样统一拒绝
      await expect(reset.initiateByPhone('not-a-phone', '10.2.0.6')).rejects.toMatchObject({
        entry: { code: 'RESET_SELF_UNAVAILABLE' },
      });
    } finally {
      await cleanupUser(user.id);
    }
  });

  it('A10\' 自助重置发起：ACTIVE 但未绑定钉钉的账号拒绝', async () => {
    phoneSeq += 1;
    const phone = `+86139000${String(phoneSeq).padStart(4, '0')}`;
    const hash = await password.hash('OldPass123456');
    const unbounded = await prisma.client.user.create({
      data: { name: '未绑定测试', gender: 'MALE', phone, status: 'ACTIVE', passwordHash: hash },
    });
    try {
      await expect(reset.initiateByPhone(phone, '10.2.0.7')).rejects.toMatchObject({
        entry: { code: 'RESET_SELF_UNAVAILABLE' },
      });
    } finally {
      await prisma.client.securityLog.deleteMany({ where: { OR: [{ targetUserId: unbounded.id }, { actorId: unbounded.id }] } });
      await prisma.client.user.deleteMany({ where: { id: unbounded.id } });
    }
  });

  it('A10\' 自助重置全链路：initiate → 钉钉验证 → confirm 成功，且不误消费账号现有 VALID 邀请', async () => {
    const user = await createActiveUser('sec-union-self');
    try {
      // 管理员恰好为该账号签发了一张 VALID 邀请（自助路径不得消费它）
      const { resetUrl } = await invitations.issueResetInvitation(user.id, user.id);
      const rawToken = resetUrl.split('#')[1] ?? '';
      const tokenHash = new TokenService().hash(rawToken);

      // 自助发起（流程会话无 tokenHash）
      const initiated = await reset.initiateByPhone(user.phone, '10.2.0.9');
      expect(initiated.userId).toBe(user.id);
      const flowId = await flows.issue('RESET', {
        userId: user.id,
        unionId: 'sec-union-self',
        mobile: '13900000309',
        stateCode: '86',
      });

      // 无凭证路径确认成功（此前 bug：无 tokenHash 时 count=0 抛 INVITATION_INVALID）
      await reset.confirm(
        flowId,
        { unionId: 'sec-union-self', mobile: '13900000309', stateCode: '86', newPassword: 'SelfReset123456' },
        '10.2.0.9',
      );
      const fresh = await prisma.client.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
      expect(await password.verifyPassword('SelfReset123456', fresh?.passwordHash ?? '')).toBe(true);

      // 该 VALID 邀请未被误消费：仍可被管理员凭证路径兑换
      const redeemed = await reset.redeem(rawToken, tokenHash);
      expect(redeemed.userId).toBe(user.id);
    } finally {
      await cleanupUser(user.id);
    }
  });

  it('A1 密码登录：待激活账号明确提示 + 计入 IP 锁失败计数、不记账号锁（base PRD §2/§4）', async () => {
    const user = await prisma.client.user.create({
      data: { name: '待激活员工', gender: 'MALE', phone: '+8613900040000', status: 'PENDING_ACTIVATION' },
    });
    const ip = '10.3.0.1';
    try {
      await expect(
        auth.loginPassword({ phone: '+8613900040000', password: 'Whatever123456' }, ip),
      ).rejects.toMatchObject({ entry: { code: 'ACCOUNT_PENDING_ACTIVATION' } });
      // 状态前置拒绝计入 IP 锁失败计数（PRD §4：IP 锁按来源 IP 累计全部失败）
      const ipFail = await redis.get(redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'ip_fail', ip));
      expect(ipFail).toBe('1');
      // 不记账号锁（待激活账号无密码，账号锁只针对密码校验失败；防撞库探测锁定真实员工）
      const accountFail = await redis.get(redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'acct_fail', user.id));
      expect(accountFail).toBeNull();
    } finally {
      await cleanupUser(user.id);
      await redis.del(redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'ip_fail', ip));
    }
  });

});
