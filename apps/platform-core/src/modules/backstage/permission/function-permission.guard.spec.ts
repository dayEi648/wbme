import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException, frameworkErrors } from '@wbme/contracts';
import { REQUEST_CONTEXT_STORAGE, type RequestContext } from '@wbme/server';
import { describe, expect, it } from 'vitest';
import type { AuthorizationService } from './authorization.service';
import { FunctionPermissionGuard, REQUIRED_FUNCTION_KEY } from './function-permission.guard';

/**
 * 函数权限守卫单元测试（不依赖数据库）：元数据读取、当前用户上下文与授权委托。
 */
describe('FunctionPermissionGuard（主 PRD §3.1）', () => {
  const handler = (): void => undefined;
  const klass = class {};
  const context = {
    getHandler: () => handler,
    getClass: () => klass,
  } as unknown as ExecutionContext;

  function setup(options: { handlerMeta?: string; classMeta?: string; hasFunction?: boolean }): FunctionPermissionGuard {
    const reflector = {
      get: (key: string, target: unknown) => {
        if (key !== REQUIRED_FUNCTION_KEY) {
          return undefined;
        }
        return target === handler ? options.handlerMeta : options.classMeta;
      },
    } as unknown as Reflector;
    const authorization = {
      hasFunction: async () => options.hasFunction ?? false,
    } as unknown as AuthorizationService;
    return new FunctionPermissionGuard(reflector, authorization);
  }

  /** 在指定用户标识的请求上下文内执行守卫 */
  function runWithUser(userId: number | undefined, guard: FunctionPermissionGuard): Promise<boolean> {
    const requestContext = { requestId: 'req', traceId: 'trace', startedAt: 0, service: 'test', userId } as RequestContext;
    return REQUEST_CONTEXT_STORAGE.run(requestContext, () => guard.canActivate(context));
  }

  it('未声明功能要求的路由不拦截', async () => {
    const guard = setup({});
    await expect(runWithUser(undefined, guard)).resolves.toBe(true);
  });

  it('持有功能授权（或超管豁免）放行', async () => {
    const guard = setup({ handlerMeta: 'permission_manage', hasFunction: true });
    await expect(runWithUser(7, guard)).resolves.toBe(true);
  });

  it('类级声明生效（处理器未声明时读取类级）', async () => {
    const guard = setup({ classMeta: 'permission_manage', hasFunction: true });
    await expect(runWithUser(7, guard)).resolves.toBe(true);
  });

  it('无授权拒绝 403 FORBIDDEN', async () => {
    const guard = setup({ handlerMeta: 'permission_manage', hasFunction: false });
    const error = await runWithUser(7, guard).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).entry.code).toBe(frameworkErrors.FORBIDDEN.code);
  });

  it('请求上下文无用户标识（会话守卫未写入）拒绝 401', async () => {
    const guard = setup({ handlerMeta: 'permission_manage', hasFunction: true });
    const error = await runWithUser(undefined, guard).catch((caught: unknown) => caught);
    expect((error as BusinessException).entry.code).toBe(frameworkErrors.UNAUTHORIZED.code);
  });
});
