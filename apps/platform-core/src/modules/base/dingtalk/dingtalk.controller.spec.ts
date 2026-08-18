import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { redisKey, REDIS_NAMESPACE, REDIS_CLIENT } from '@wbme/server';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 Redis；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import type { INestApplication } from '@nestjs/common';
import { BusinessException, accountErrors } from '@wbme/contracts';
import { GlobalExceptionFilter, PUBLIC_ROUTE_KEY } from '@wbme/server';
import { PrismaService } from '../../../prisma.service';
import { AuthService } from '../auth/auth.service';
import { FlowSessionService } from '../auth/flows/flow-session.service';
import { DINGTALK_GATEWAY } from './dingtalk.gateway';
import { FakeDingtalkGateway } from './dingtalk.gateway.fake';
import { DingtalkStateService } from './dingtalk.state.service';
import { DingtalkController } from './dingtalk.controller';

const REDIS_URL = process.env.REDIS_URL;
const TEST_PUBLIC_ORIGIN = 'http://localhost:45173';

/** 测试用假 Prisma（仅覆盖回调路径用到的查询） */
function fakePrismaService() {
  const bindings: Array<{ unionId: string }> = [];
  const users: Array<{ phone: string; status: string }> = [];
  return {
    client: {
      dingtalkBinding: {
        findFirst: async (args: { where: { dingtalkUnionId?: string } }) =>
          bindings.find((b) => b.unionId === args.where.dingtalkUnionId) ?? null,
      },
      user: {
        findFirst: async (args: { where: { phone?: string } }) =>
          users.find((u) => u.phone === args.where.phone) ?? null,
      },
    },
    __bindings: bindings,
    __users: users,
  };
}

describe.skipIf(!REDIS_URL)('DingtalkController（A4/A5 扫码授权，base PRD §2）', () => {
  let app: INestApplication;
  let redis: Redis;
  let gateway: FakeDingtalkGateway;
  let prisma: ReturnType<typeof fakePrismaService>;

  const authService = {
    loginWithDingtalk: async () => null,
    bindDingtalk: async () => undefined,
  } as {
    loginWithDingtalk: (input: unknown, ip: string) => Promise<unknown>;
    bindDingtalk: (userId: number, input: unknown, ip: string) => Promise<void>;
  };

  beforeAll(async () => {
    redis = new Redis(REDIS_URL ?? 'redis://localhost:6379');
    process.env.PUBLIC_ORIGIN = TEST_PUBLIC_ORIGIN;
    // 显式 stub 回调地址（避免测试结果依赖本地 .env 的 DINGTALK_REDIRECT_URI 取值）
    process.env.DINGTALK_REDIRECT_URI = `${TEST_PUBLIC_ORIGIN}/api/v1/auth/dingtalk/callback`;
    process.env.DINGTALK_CORP_ID = 'test-corp';

    gateway = new FakeDingtalkGateway();
    prisma = fakePrismaService();

    const moduleRef = await Test.createTestingModule({
      controllers: [DingtalkController],
      providers: [
        { provide: DINGTALK_GATEWAY, useValue: gateway },
        DingtalkStateService,
        FlowSessionService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  async function cleanStates(): Promise<void> {
    const keys = await redis.keys(redisKey(REDIS_NAMESPACE.DINGTALK_STATE, '*'));
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  it('A4 未配置钉钉返回 DINGTALK_CONFIG_MISSING', async () => {
    const unconfigured = new FakeDingtalkGateway({}, false);
    const local = await Test.createTestingModule({
      controllers: [DingtalkController],
      providers: [
        { provide: DINGTALK_GATEWAY, useValue: unconfigured },
        DingtalkStateService,
        FlowSessionService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();
    const localApp = local.createNestApplication();
    localApp.useGlobalFilters(new GlobalExceptionFilter());
    await localApp.init();
    const res = await request(localApp.getHttpServer()).get('/auth/dingtalk/authorize?purpose=LOGIN');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DINGTALK_CONFIG_MISSING');
    await localApp.close();
  });

  it('A4 返回含 state 的授权 URL', async () => {
    await cleanStates();
    const res = await request(app.getHttpServer()).get('/auth/dingtalk/authorize?purpose=LOGIN');
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain('login.dingtalk.com/oauth2/auth');
    expect(res.body.authorizeUrl).toContain('state=');
    // 回调地址须指向后端 /api/v1 路由（经前端/Nginx 代理转发，base PRD §2）
    expect(res.body.authorizeUrl).toContain(`redirect_uri=${encodeURIComponent(`${TEST_PUBLIC_ORIGIN}/api/v1/auth/dingtalk/callback`)}`);
  });

  it('A4 流程类用途（ACTIVATION）缺少流程 Cookie 拒绝', async () => {
    const res = await request(app.getHttpServer()).get('/auth/dingtalk/authorize?purpose=ACTIVATION');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FLOW_SESSION_INVALID');
  });

  it('A5 组织不匹配：corpId 不一致 → 302 error', async () => {
    await cleanStates();
    gateway.behavior.orgMismatch = true;
    const state = await new DingtalkStateService(redis).issue('LOGIN');
    const res = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/login?error=DINGTALK_ORG_MISMATCH`);
    gateway.behavior.orgMismatch = false;
  });

  it('A5 state 重放：同一 state 第二次拒绝', async () => {
    await cleanStates();
    authService.loginWithDingtalk = async () => null;
    gateway.behavior.orgMismatch = false;
    const state = await new DingtalkStateService(redis).issue('LOGIN');
    const first = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/register`); // 未绑定 → 注册
    const second = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(second.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/login?error=DINGTALK_STATE_INVALID`);
  });

  it('A5 未绑定扫码注册：流程会话保留钉钉授权手机号（base PRD §2 手机号取自授权结果）', async () => {
    await cleanStates();
    authService.loginWithDingtalk = async () => null;
    const state = await new DingtalkStateService(redis).issue('LOGIN');
    const res = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/register`);
    const cookies = String(res.headers['set-cookie'] ?? []);
    const flowCookie = cookies.match(/wbme_flow=([^;]+)/);
    expect(flowCookie).toBeTruthy();
    const flow = await new FlowSessionService(redis).read(decodeURIComponent(flowCookie![1]!), 'REGISTRATION');
    expect(flow?.mobile).toBe('13800138000');
    expect(flow?.stateCode).toBe('86');
    expect(flow?.unionId).toBe('fake-union-001');
  });

  it('A5 流程类回调：state 携带流程标识 → 302 完成页并写入钉钉身份（base PRD §2 state/nonce+流程标识）', async () => {
    await cleanStates();
    const flows = new FlowSessionService(redis);
    const flowId = await flows.issue('ACTIVATION', { userId: 7 });
    const state = await new DingtalkStateService(redis).issue('ACTIVATION', flowId);
    const res = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/activate/complete`);
    const flow = await flows.read(flowId, 'ACTIVATION');
    expect(flow?.unionId).toBe('fake-union-001');
    expect(flow?.mobile).toBe('13800138000');
  });

  it('A5 非本组织成员 → 302 DINGTALK_ORG_MISMATCH（不误报依赖不可用，base PRD §2）', async () => {
    await cleanStates();
    authService.loginWithDingtalk = async () => null;
    gateway.behavior.notMember = true;
    const state = await new DingtalkStateService(redis).issue('LOGIN');
    const res = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/login?error=DINGTALK_ORG_MISMATCH`);
    gateway.behavior.notMember = false;
  });

  it('A5 已绑定账号扫码 → 302 /portal 并下发会话 Cookie', async () => {
    await cleanStates();
    prisma.__bindings.push({ unionId: 'fake-union-001' });
    authService.loginWithDingtalk = async () => ({
      user: { id: 4, name: '测试', gender: 'MALE', phoneMasked: '+86 138****8000', status: 'ACTIVE', isSuperAdmin: true },
      sessionId: 'test-session-123',
      sessionExpiresAt: Date.now() + 60_000,
      csrfToken: 'csrf-token',
    });
    const state = await new DingtalkStateService(redis).issue('LOGIN');
    const res = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/portal`);
    const cookies = String(res.headers['set-cookie'] ?? []);
    expect(cookies).toContain('wbme_session=test-session-123');
    expect(cookies).toContain('wbme_csrf=csrf-token');
  });

  it('A4 公开端点 purpose=BIND 拒绝（自助绑定须走登录态专用端点）', async () => {
    const res = await request(app.getHttpServer()).get('/auth/dingtalk/authorize?purpose=BIND');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('自助绑定发起端点无会话上下文 → 401（绑定目标用户必须由会话守卫确认）', async () => {
    const res = await request(app.getHttpServer()).get('/auth/dingtalk/bind/authorize');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('A5 BIND 回调成功 → 302 安全页并以 state 携带的用户标识完成绑定', async () => {
    await cleanStates();
    let boundUserId: number | undefined;
    authService.bindDingtalk = async (userId: number) => {
      boundUserId = userId;
    };
    const state = await new DingtalkStateService(redis).issue('BIND', undefined, 42);
    const res = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/me?tab=security&dingtalkBind=success`);
    expect(boundUserId).toBe(42);
  });

  it('A5 BIND 回调业务失败（已绑定）→ 302 安全页带错误码，不跳登录页', async () => {
    await cleanStates();
    authService.bindDingtalk = async () => {
      throw new BusinessException(accountErrors.DINGTALK_ALREADY_BOUND);
    };
    const state = await new DingtalkStateService(redis).issue('BIND', undefined, 42);
    const res = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/me?tab=security&dingtalkBind=DINGTALK_ALREADY_BOUND`);
  });

  it('A5 BIND 回调 state 未携带用户标识 → 302 DINGTALK_STATE_INVALID', async () => {
    await cleanStates();
    authService.bindDingtalk = async () => undefined;
    const state = await new DingtalkStateService(redis).issue('BIND');
    const res = await request(app.getHttpServer()).get(`/auth/dingtalk/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${TEST_PUBLIC_ORIGIN}/me?tab=security&dingtalkBind=DINGTALK_STATE_INVALID`);
  });
});

describe('DingtalkController 路由公开性（主 PRD §9.6）', () => {
  it('自助绑定发起为登录态路由（无 @Public 元数据）；授权发起与回调保持公开', () => {
    expect(Reflect.getMetadata(PUBLIC_ROUTE_KEY, DingtalkController.prototype.bindAuthorize)).toBeUndefined();
    expect(Reflect.getMetadata(PUBLIC_ROUTE_KEY, DingtalkController.prototype.authorize)).toBe(true);
    expect(Reflect.getMetadata(PUBLIC_ROUTE_KEY, DingtalkController.prototype.callback)).toBe(true);
  });
});
