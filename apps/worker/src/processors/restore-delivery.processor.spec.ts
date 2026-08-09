import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';
import { processRestoreDelivery } from './restore-delivery.processor';

const ctx = {} as ProcessorContext;

function taskRow(ref: unknown): BackgroundTaskRow {
  return { ref } as BackgroundTaskRow;
}

describe('processRestoreDelivery（T4-8 恢复投递）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('ref 缺失时抛错（任务进入失败重试）', async () => {
    await expect(processRestoreDelivery(taskRow(null), ctx)).rejects.toThrow('ref 无效');
    await expect(processRestoreDelivery(taskRow({ backupId: 1 }), ctx)).rejects.toThrow('ref 无效');
  });

  it('INTERNAL_SERVICE_TOKEN 未配置时抛错', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', '');
    await expect(
      processRestoreDelivery(taskRow({ restoreUuid: 'r-1', backupId: 1 }), ctx),
    ).rejects.toThrow('INTERNAL_SERVICE_TOKEN');
  });

  it('向 recovery-executor 投递恢复请求（URL/头/体/超时）', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'token-abc');
    vi.stubEnv('RECOVERY_EXECUTOR_URL', 'http://recovery:3010/');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await processRestoreDelivery(taskRow({ restoreUuid: 'r-1', backupId: 7 }), ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://recovery:3010/recovery/delivery');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer token-abc',
      'x-wbme-caller': 'worker',
    });
    expect(JSON.parse(String(init.body))).toEqual({ restoreUuid: 'r-1', backupId: 7 });
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  it('目标非 2xx 时抛错并携带状态与响应摘要', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'token-abc');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '{"error":{"code":"SYSTEM_MAINTENANCE"}}' }),
    );
    await expect(processRestoreDelivery(taskRow({ restoreUuid: 'r-1', backupId: 7 }), ctx)).rejects.toThrow(
      'HTTP 503',
    );
  });
});
