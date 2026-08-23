import { describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@wbme/tasks';
import { processLogRetentionCleanup } from './log-retention-cleanup.processor';

describe('processLogRetentionCleanup', () => {
  it('按配置清理过期日志并保留幂等记录', async () => {
    const queries: string[] = [];
    const sql = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return { rowCount: 0 };
      }),
      queryRows: vi.fn(async () => {
        return [
          { key: 'log.cleanup.operation_log.default.days', value: '365' },
          { key: 'log.cleanup.operation_log.query.days', value: '30' },
          { key: 'log.cleanup.error_log.days', value: '180' },
          { key: 'log.cleanup.security_log.days', value: '365' },
        ];
      }),
    } as unknown as SqlClient;

    await processLogRetentionCleanup(
      {
        taskUuid: '00000000-0000-4000-8000-000000000001',
        taskType: 'LOG_RETENTION_CLEANUP',
        module: 'backstage',
        initiatorId: null,
        initiatorType: 'SCHEDULER',
        ref: null,
        status: 'RUNNING',
        progress: 0,
        attempts: 1,
      },
      {
        sql,
        leaseOwner: 'test',
        deployCommit: 'test',
      },
    );

    // 至少验证操作日志清理 SQL 包含幂等保留条件，且覆盖了各 schema。
    const operationDeleteQueries = queries.filter((q) => q.includes('operation_logs') && q.includes('DELETE'));
    expect(operationDeleteQueries.length).toBeGreaterThan(0);
    expect(operationDeleteQueries[0]).toContain('idempotency_key IS NULL');
    expect(operationDeleteQueries.some((q) => q.includes('"asset"."operation_logs"'))).toBe(true);
    expect(operationDeleteQueries.some((q) => q.includes('"fin"."operation_logs"'))).toBe(true);

    // 错误日志与安全日志也应生成清理 SQL。
    expect(queries.some((q) => q.includes('backstage."error_logs"'))).toBe(true);
    expect(queries.some((q) => q.includes('backstage."security_logs"'))).toBe(true);
  });
});
