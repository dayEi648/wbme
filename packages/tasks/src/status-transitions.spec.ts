import { describe, expect, it } from 'vitest';
import {
  computeEnqueueBackoffSeconds,
  isTerminalTaskStatus,
  markQueued,
  claimRunning,
  markSucceeded,
} from './status-transitions';
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
