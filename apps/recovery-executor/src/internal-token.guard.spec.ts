import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalTokenFailure, InternalTokenFailureRecorder } from './internal-security-log.service';
import { InternalTokenGuard } from './internal-token.guard';

function mockContext(headers: Record<string, string | undefined>): never {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers,
        socket: { remoteAddress: '10.0.0.8' },
      }),
    }),
  } as never;
}

function recorder(): InternalTokenFailureRecorder & { recordInternalTokenFailure: ReturnType<typeof vi.fn> } {
  return { recordInternalTokenFailure: vi.fn().mockResolvedValue(undefined) };
}

describe('InternalTokenGuard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('令牌错误返回 401 并记录集中安全事件所需的脱敏字段', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'correct-token');
    const log = recorder();
    const guard = new InternalTokenGuard(['worker'], log);

    await expect(
      guard.canActivate(mockContext({ authorization: 'Bearer wrong-token', 'x-wbme-caller': 'worker', 'x-request-id': 'req-1' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(log.recordInternalTokenFailure).toHaveBeenCalledWith({
      reason: 'TOKEN_INVALID',
      caller: 'worker',
      sourceIp: '10.0.0.8',
      requestId: 'req-1',
    } satisfies InternalTokenFailure);
  });

  it('调用方未授权返回 403 并记录失败事件', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'correct-token');
    const log = recorder();
    const guard = new InternalTokenGuard(['worker'], log);

    await expect(
      guard.canActivate(mockContext({ authorization: 'Bearer correct-token', 'x-wbme-caller': 'platform-core' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(log.recordInternalTokenFailure).toHaveBeenCalledWith({
      reason: 'CALLER_NOT_ALLOWED',
      caller: 'platform-core',
      sourceIp: '10.0.0.8',
      requestId: null,
    } satisfies InternalTokenFailure);
  });

  it('令牌与调用方均正确时放行且不追加失败日志', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'correct-token');
    const log = recorder();
    const guard = new InternalTokenGuard(['worker'], log);

    await expect(
      guard.canActivate(mockContext({ authorization: 'Bearer correct-token', 'x-wbme-caller': 'worker' })),
    ).resolves.toBe(true);
    expect(log.recordInternalTokenFailure).not.toHaveBeenCalled();
  });
});
