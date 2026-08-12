import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';
import { processAccountLifecycle } from './account-lifecycle.processor';

const ctx = {} as ProcessorContext;

function taskRow(ref: unknown): BackgroundTaskRow {
  return { ref } as BackgroundTaskRow;
}

describe('processAccountLifecycle（账号生命周期消费）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('ref 缺失或 event 非 DEACTIVATED 时抛错', async () => {
    await expect(processAccountLifecycle(taskRow(null), ctx)).rejects.toThrow('ref 无效');
    await expect(processAccountLifecycle(taskRow({ event: 'RESTORED' }), ctx)).rejects.toThrow('ref 无效');
  });

  it('INTERNAL_SERVICE_TOKEN 未配置时抛错（不静默跳过）', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', '');
    await expect(
      processAccountLifecycle(taskRow({ event: 'DEACTIVATED', userId: 42, deactivatedAt: '2026-08-01T00:00:00Z' }), ctx),
    ).rejects.toThrow('INTERNAL_SERVICE_TOKEN');
  });

  it('调用 hr 内部接口幂等取消岗位申请（URL/头/体/超时）', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'token-abc');
    vi.stubEnv('HR_INTERNAL_BASE_URL', 'http://hr:43003');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await processAccountLifecycle(
      taskRow({ event: 'DEACTIVATED', userId: 42, deactivatedAt: '2026-08-01T00:00:00Z' }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://hr:43003/internal/v1/lifecycle/cancel-position-applications');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer token-abc', 'x-wbme-caller': 'worker' });
    expect(JSON.parse(String(init.body))).toEqual({
      userId: 42,
      deactivatedAt: '2026-08-01T00:00:00Z',
    });
  });

  it('hr 返回业务错误时抛错保留状态码（任务重试而非吞掉）', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'token-abc');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 409, text: async () => '{"error":{"code":"STATUS_CONFLICT"}}' }),
    );
    await expect(
      processAccountLifecycle(taskRow({ event: 'DEACTIVATED', userId: 42, deactivatedAt: '2026-08-01T00:00:00Z' }), ctx),
    ).rejects.toThrow('HTTP 409');
  });
});
