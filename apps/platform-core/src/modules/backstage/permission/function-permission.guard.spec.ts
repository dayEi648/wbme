import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException } from '@wbme/contracts';
import { getRequestContext, REQUEST_CONTEXT_STORAGE, type RequestContext } from '@wbme/server';
import { describe, expect, it } from 'vitest';
import type { AuthorizationService } from './authorization.service';
import { FunctionPermissionGuard, REQUIRED_FUNCTION_KEY } from './function-permission.guard';

/** getFunctionAccess 的桩返回形态（与 AuthorizationService 一致） */
interface AccessStub {
  registered: boolean;
  systemCode: string | null;
  systemName: string | null;
  systemOpen: boolean;
  allowed: boolean;
  dataScope: 'SELF' | 'DEPARTMENT' | 'COMPANY' | null;
}

/**
 * 函数权限守卫单元测试（不依赖数据库）：守卫链顺序 ——
 * 登录态 → 目录注册 → 系统可用性 → 功能权限 → 数据范围上下文注入（主 PRD §9.6/§3.1，T3-4）。
 */
describe('FunctionPermissionGuard（主 PRD §9.6/§3.1，T3-4 守卫链）', () => {
  const handler = (): void => undefined;
  const klass = class {};
  const context = {
    getHandler: () => handler,
    getClass: () => klass,
  } as unknown as ExecutionContext;

  function setup(options: { handlerMeta?: string; classMeta?: string; access: AccessStub }): FunctionPermissionGuard {
    const reflector = {
      get: (key: string, target: unknown) => {
        if (key !== REQUIRED_FUNCTION_KEY) {
          return undefined;
        }
        return target === handler ? options.handlerMeta : options.classMeta;
      },
    } as unknown as Reflector;
    const authorization = {
      getFunctionAccess: async () => options.access,
    } as unknown as AuthorizationService;
    return new FunctionPermissionGuard(reflector, authorization);
  }

  /** 在指定用户标识的请求上下文内执行守卫，并带回守卫写入的授权上下文 */
  async function runWithUser(
    userId: number | undefined,
    guard: FunctionPermissionGuard,
  ): Promise<{ allowed: boolean; granted: unknown }> {
    const requestContext = { requestId: 'req', traceId: 'trace', startedAt: 0, service: 'test', userId } as RequestContext;
    return REQUEST_CONTEXT_STORAGE.run(requestContext, async () => {
      const allowed = await guard.canActivate(context);
      return { allowed, granted: getRequestContext()?.grantedFunction };
    });
  }

  const allowedAccess: AccessStub = {
    registered: true,
    systemCode: 'ASSET',
    systemName: '资产系统',
    systemOpen: true,
    allowed: true,
    dataScope: 'DEPARTMENT',
  };

  it('未声明功能要求的路由不拦截', async () => {
    const guard = setup({ access: { ...allowedAccess, allowed: false } });
    const result = await runWithUser(undefined, guard);
    expect(result.allowed).toBe(true);
    expect(result.granted).toBeUndefined();
  });

  it('请求上下文无用户标识（会话守卫未写入）拒绝 401', async () => {
    const guard = setup({ handlerMeta: 'fixed_asset_view', access: allowedAccess });
    const rejection = await runWithUser(undefined, guard).catch((caught: unknown) => caught);
    expect(rejection).toBeInstanceOf(BusinessException);
    expect((rejection as BusinessException).entry.code).toBe('UNAUTHORIZED');
  });

  it('路由声明了目录外功能编码：500（代码/部署缺陷，不按越权处理）', async () => {
    const guard = setup({ handlerMeta: 'ghost', access: { ...allowedAccess, registered: false, systemOpen: false } });
    const error = await runWithUser(7, guard).catch((caught: unknown) => caught);
    expect((error as BusinessException).entry.code).toBe('INTERNAL_ERROR');
  });

  it('所属系统未开放：503 SYSTEM_NOT_OPEN（含系统名称，超管也不进入）', async () => {
    const guard = setup({ handlerMeta: 'fixed_asset_view', access: { ...allowedAccess, systemOpen: false } });
    const error = await runWithUser(7, guard).catch((caught: unknown) => caught);
    const exception = error as BusinessException;
    expect(exception.entry.code).toBe('SYSTEM_NOT_OPEN');
    expect(exception.details).toEqual({ system: '资产系统' });
  });

  it('未持有功能授权：403 FORBIDDEN，不注入数据范围上下文', async () => {
    const guard = setup({ handlerMeta: 'fixed_asset_view', access: { ...allowedAccess, allowed: false } });
    const error = await runWithUser(7, guard).catch((caught: unknown) => caught);
    expect((error as BusinessException).entry.code).toBe('FORBIDDEN');
  });

  it('持有授权：放行并注入最宽合并后的数据范围', async () => {
    const guard = setup({ handlerMeta: 'fixed_asset_view', access: allowedAccess });
    await expect(runWithUser(7, guard)).resolves.toEqual({
      allowed: true,
      granted: { code: 'fixed_asset_view', dataScope: 'DEPARTMENT' },
    });
  });

  it('超管豁免：放行且数据范围为 null（不受限，仅针对访问控制）', async () => {
    const guard = setup({ handlerMeta: 'fixed_asset_view', access: { ...allowedAccess, dataScope: null } });
    await expect(runWithUser(7, guard)).resolves.toEqual({
      allowed: true,
      granted: { code: 'fixed_asset_view', dataScope: null },
    });
  });

  it('类级声明生效（处理器未声明时读取类级）', async () => {
    const guard = setup({ classMeta: 'permission_manage', access: allowedAccess });
    await expect(runWithUser(7, guard)).resolves.toMatchObject({ allowed: true });
  });
});
