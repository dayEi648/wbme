import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException } from '@wbme/contracts';
import Redis from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 Redis；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { redisKey, REDIS_NAMESPACE } from '../redis/redis-constants';
import { REQUEST_CONTEXT_STORAGE, type RequestContext } from '../request-context';
import { SESSION_COOKIE } from './session-constants';
import { SessionGuard } from './session.guard';
import type { SessionUserLoader } from './session-user.loader';
import { SessionService } from './session.service';

const REDIS_URL = process.env.REDIS_URL;

/**
 * 本测试独用的 Redis db（独立于其它包/文件的 db 0 与 session.service.spec 的 db 1）。
 * 原因：会话测试的 afterEach 清理 `session:*` 键，若与其它集成测试
 * （platform-core 等同样写入 `session:*` 键）并行跑会互相清键导致偶发失败。
 */
const TEST_REDIS_DB = 2;

/** 测试用户（仅内存态，不落库） */
const TEST_USER_ID = 424242;

/**
 * 会话守卫集成测试（真实 Redis；base PRD §3、主 PRD §9.6）：
 * 会话校验主流程 + 提权旋转接线（目标用户旧会话标识在下次请求透明轮换）。
 */
describe.skipIf(!REDIS_URL)('SessionGuard（会话校验 + 提权旋转，T3-4）', () => {
  const redis = new Redis(REDIS_URL ?? 'redis://localhost:6379', { db: TEST_REDIS_DB });
  const session = new SessionService(redis);
  const loader: SessionUserLoader = {
    load: async (userId) =>
      userId === TEST_USER_ID
        ? { id: TEST_USER_ID, status: 'ACTIVE', sessionVersion: 0, isSuperAdmin: false }
        : null,
  };
  const guard = new SessionGuard(session, new Reflector(), loader, async () => 60_000);

  afterEach(async () => {
    const keys = await redis.keys(redisKey(REDIS_NAMESPACE.SESSION, '*'));
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  /** 构造守卫执行上下文与响应 Cookie 捕获 */
  function fakeContext(sessionId?: string): { context: ExecutionContext; cookies: Array<{ name: string; value: string }> } {
    const cookies: Array<{ name: string; value: string }> = [];
    const context = {
      getHandler: () => (): void => undefined,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({ cookies: sessionId ? { [SESSION_COOKIE]: sessionId } : {}, headers: {} }),
        getResponse: () => ({
          cookie: (name: string, value: string) => {
            cookies.push({ name, value });
          },
        }),
      }),
    } as unknown as ExecutionContext;
    return { context, cookies };
  }

  /** 在请求上下文内执行守卫 */
  function activate(context: ExecutionContext): Promise<boolean> {
    const requestContext = { requestId: 'r', traceId: 't', startedAt: 0, service: 'test' } as RequestContext;
    return REQUEST_CONTEXT_STORAGE.run(requestContext, () => guard.canActivate(context));
  }

  it('无会话 Cookie 拒绝 401 SESSION_EXPIRED', async () => {
    const { context } = fakeContext();
    const error = await activate(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).entry.code).toBe('SESSION_EXPIRED');
  });

  it('有效会话放行；无提权标记时不写新 Cookie', async () => {
    const created = await session.create({
      userId: TEST_USER_ID,
      sessionVersion: 0,
      rememberMe: false,
      idleTimeoutMs: 60_000,
      absoluteTimeoutMs: 3_600_000,
    });
    const { context, cookies } = fakeContext(created.sessionId);
    await expect(activate(context)).resolves.toBe(true);
    expect(cookies).toHaveLength(0);
  });

  it('提权标记命中：旧标识失效、响应下发新会话 Cookie、新会话数据平移', async () => {
    const created = await session.create({
      userId: TEST_USER_ID,
      sessionVersion: 0,
      rememberMe: true,
      idleTimeoutMs: 60_000,
      absoluteTimeoutMs: 3_600_000,
    });
    await session.markElevation(TEST_USER_ID);
    // 跨过毫秒边界，保证旋转后的 iat 严格晚于标记时间（同毫秒命中按安全侧会再旋转一次）
    await new Promise((r) => setTimeout(r, 2));

    const { context, cookies } = fakeContext(created.sessionId);
    await expect(activate(context)).resolves.toBe(true);
    // 旧标识已失效，新标识经 Set-Cookie 下发
    expect(await session.read(created.sessionId)).toBeNull();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.name).toBe(SESSION_COOKIE);
    const nextSessionId = cookies[0]?.value ?? '';
    expect(nextSessionId).not.toBe(created.sessionId);
    const data = await session.read(nextSessionId);
    expect(data?.u).toBe(TEST_USER_ID);
    expect(data?.rm).toBe(true);

    // 新会话再次请求：不重复旋转（iat 已晚于标记），不再写 Cookie
    const second = fakeContext(nextSessionId);
    await expect(activate(second.context)).resolves.toBe(true);
    expect(second.cookies).toHaveLength(0);
  });
});
