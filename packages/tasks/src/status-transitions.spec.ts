import { describe, expect, it } from 'vitest';
import {
  computeEnqueueBackoffSeconds,
  isTerminalTaskStatus,
  markQueued,
  claimRunning,
  markSucceeded,
  renewRunningLease,
  failTimedOutTasks,
} from './status-transitions';
import { TASK_RUNNING_LEASE_SECONDS } from './constants';
import type { SqlClient } from './sql-client';

function createMockClient(handlers: {
  query?: (text: string, values?: readonly unknown[]) => Promise<{ rowCount: number | null }>;
  queryRows?: <T>(text: string, values?: readonly unknown[]) => Promise<T[]>;
}): SqlClient {
  return {
    query: handlers.query ?? (async () => ({ rowCount: 0 })),
    queryRows: handlers.queryRows ?? (async () => []),
  };
}

describe('isTerminalTaskStatus', () => {
  it('识别终态', () => {
    expect(isTerminalTaskStatus('SUCCEEDED')).toBe(true);
    expect(isTerminalTaskStatus('FAILED')).toBe(true);
    expect(isTerminalTaskStatus('CANCELLED')).toBe(true);
    expect(isTerminalTaskStatus('QUEUED')).toBe(false);
  });
});

describe('computeEnqueueBackoffSeconds', () => {
  it('指数退避有上限', () => {
    expect(computeEnqueueBackoffSeconds(0)).toBe(30);
    expect(computeEnqueueBackoffSeconds(1)).toBe(60);
    expect(computeEnqueueBackoffSeconds(10)).toBe(computeEnqueueBackoffSeconds(8));
  });
});

describe('status transition SQL helpers', () => {
  it('markQueued 在条件匹配时返回 true', async () => {
    const client = createMockClient({
      query: async () => ({ rowCount: 1 }),
    });
    expect(await markQueued(client, 'uuid', 'owner')).toBe(true);
  });

  it('claimRunning 在未匹配时返回 false', async () => {
    const client = createMockClient({
      query: async () => ({ rowCount: 0 }),
    });
    expect(await claimRunning(client, 'uuid', 'worker-1')).toBe(false);
  });

  it('markSucceeded 传递租约持有者', async () => {
    let capturedOwner: unknown;
    const client = createMockClient({
      query: async (_text, values) => {
        capturedOwner = values?.[1];
        return { rowCount: 1 };
      },
    });
    await markSucceeded(client, 'uuid', 'worker-1');
    expect(capturedOwner).toBe('worker-1');
  });
});

describe('markQueued 重领归队（批次8复核修复）', () => {
  it('SQL 覆盖重领来源：PENDING_ENQUEUE 首投与 QUEUED/RUNNING 重投', async () => {
    let capturedText = '';
    const client = createMockClient({
      query: async (text) => {
        capturedText = text;
        return { rowCount: 1 };
      },
    });
    expect(await markQueued(client, 'uuid', 'scheduler-1')).toBe(true);
    // 重领行（QUEUED/RUNNING 残留）也必须能归队并清空投递租约，
    // 否则调度器 120s 投递租约会挡住 Worker 的 claimRunning，重投链路空转
    expect(capturedText).toContain("'PENDING_ENQUEUE'");
    expect(capturedText).toContain("'QUEUED'");
    expect(capturedText).toContain("'RUNNING'");
  });
});

describe('renewRunningLease', () => {
  it('续期成功返回 true，并按当前时间重置租约与 timeout_at', async () => {
    let capturedValues: readonly unknown[] | undefined;
    const client = createMockClient({
      query: async (_text, values) => {
        capturedValues = values;
        return { rowCount: 1 };
      },
    });
    const now = new Date('2026-08-11T00:00:00.000Z');
    expect(await renewRunningLease(client, 'uuid', 'worker-1', now)).toBe(true);
    expect(capturedValues?.[0]).toBe('uuid');
    expect(capturedValues?.[1]).toBe('worker-1');
    expect(capturedValues?.[2]).toEqual(new Date(now.getTime() + TASK_RUNNING_LEASE_SECONDS * 1_000));
    expect(capturedValues?.[3]).toEqual(new Date(now.getTime() + TASK_RUNNING_LEASE_SECONDS * 2 * 1_000));
  });

  it('任务已不在本租约下（rowCount=0）返回 false', async () => {
    const client = createMockClient({
      query: async () => ({ rowCount: 0 }),
    });
    expect(await renewRunningLease(client, 'uuid', 'worker-1')).toBe(false);
  });
});

describe('failTimedOutTasks', () => {
  it('传入当前时间并返回被终态化的任务数（SQL 占位符与参数个数一致）', async () => {
    let capturedText = '';
    let capturedValues: readonly unknown[] | undefined;
    const client = createMockClient({
      query: async (text, values) => {
        capturedText = text;
        capturedValues = values;
        return { rowCount: 2 };
      },
    });
    const now = new Date('2026-08-11T00:00:00.000Z');
    expect(await failTimedOutTasks(client, now)).toBe(2);
    expect(capturedValues).toEqual([now]);
    // 防回归：SQL 引用的最大占位符不得超过传入参数个数（批次8曾 $2 vs [now] 恒报错）
    const maxPlaceholder = Math.max(...[...capturedText.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(maxPlaceholder).toBeLessThanOrEqual(capturedValues?.length ?? 0);
  });
});
