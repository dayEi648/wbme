import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecoveryExecutorService } from './recovery-executor.service';

/** pg 动态 import mock：pg_stat_activity 查询结果可编程（drainQueue 逐次出队，验证轮询循环） */
const pgMock = vi.hoisted(() => ({
  /** 逐次出队的查询结果；队列耗尽后返回 emptyFallback */
  drainQueue: [] as Array<Array<Record<string, unknown>>>,
  /** 队列耗尽后的回退结果（默认空 = 排空；超时用例置为活跃行使轮询永不排空） */
  emptyFallback: [] as Array<Record<string, unknown>>,
  statActivityQueries: 0,
}));

vi.mock('pg', () => {
  class MockClient {
    private readonly url: string;
    constructor(config: { connectionString?: string }) {
      this.url = config.connectionString ?? '';
    }
    async connect(): Promise<void> {
      if (this.url.includes(':1/')) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      }
    }
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (sql.includes('pg_stat_activity')) {
        pgMock.statActivityQueries += 1;
        return { rows: pgMock.drainQueue.shift() ?? pgMock.emptyFallback };
      }
      if (sql.includes('backstage.backups')) {
        // PRECHECK/RESTORING 备份记录：状态齐备；校验和取空 Buffer 的真实 sha256
        // （RESTORING 下载 mock 空对象后必须通过校验，才能推进到 pg_restore 失败点）
        return {
          rows: [
            {
              status: 'SUCCEEDED',
              checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              oss_object_key: 'backups/1/x',
              file_size: '10',
            },
          ],
        };
      }
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }
  return { Client: MockClient };
});

/**
 * M4 停写确认（backstage PRD §10：除恢复执行器外不存在仍可写目标数据库的连接）：
 * 轮询 pg_stat_activity 直到活跃写连接为 0；超时记录明细并中止恢复（保持维护状态）。
 * 停写等待/轮询时长经 RESTORE_WRITE_DRAIN_MAX_WAIT_MS / RESTORE_WRITE_DRAIN_POLL_MS 注入短窗口。
 */
describe('RecoveryExecutorService 停写确认（M4 轮询）', () => {
  const DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/wbme-test';
  const REDIS_URL = 'redis://127.0.0.1:6379';

  it('轮询成功：活跃写连接排空后继续恢复流程', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wbme-drain-ok-'));
    process.env.RESTORE_DRY_RUN = '0';
    process.env.RESTORE_STATE_DIR = stateDir;
    // stageMaintenance 直读环境变量（pg mock 接受任意非 :1/ 连接串）
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.REDIS_URL = REDIS_URL;
    process.env.RESTORE_WRITE_DRAIN_MAX_WAIT_MS = '500';
    process.env.RESTORE_WRITE_DRAIN_POLL_MS = '20';
    pgMock.statActivityQueries = 0;
    // 第一次查询 1 个活跃写连接 → 等待重查；第二次排空 → 放行
    pgMock.drainQueue = [
      [{ pid: 42, application_name: 'worker', client_addr: '10.0.0.5', state: 'idle in transaction', xact_start: new Date(), query: 'SELECT 1' }],
      [],
    ];
    const service = new RecoveryExecutorService({
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      storage: {
        getObject: async () => Buffer.from(''),
        listPrefix: async () => ['backups/1/x'],
      },
    });
    try {
      await service.acceptDelivery({ restoreUuid: 'drain-ok-uuid', backupId: 1 });
      // 管道推进（mock pg_restore 不存在 → 在 RESTORING 失败）：等待失败落盘后断言
      await vi.waitFor(async () => {
        const status = await service.getStatus();
        expect(status.manifest?.stage ?? '').toBe('RESTORING');
        expect(status.manifest?.error ?? '').toContain('pg_restore');
      });
      // 轮询真实发生（至少 2 次查询：命中活跃 → 排空放行）
      expect(pgMock.statActivityQueries).toBeGreaterThanOrEqual(2);
      const status = await service.getStatus();
      expect(status.maintenance).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('轮询超时：仍存在活跃写连接 → 中止恢复并保持维护状态，错误含连接明细', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wbme-drain-timeout-'));
    process.env.RESTORE_DRY_RUN = '0';
    process.env.RESTORE_STATE_DIR = stateDir;
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.REDIS_URL = REDIS_URL;
    process.env.RESTORE_WRITE_DRAIN_MAX_WAIT_MS = '80';
    process.env.RESTORE_WRITE_DRAIN_POLL_MS = '20';
    pgMock.statActivityQueries = 0;
    // 恒有活跃写连接 → 直到超时
    pgMock.drainQueue = [];
    pgMock.drainQueue.push([
      { pid: 42, application_name: 'worker', client_addr: '10.0.0.5', state: 'active', xact_start: new Date(), query: 'UPDATE ...' },
    ]);
    pgMock.drainQueue.push([
      { pid: 42, application_name: 'worker', client_addr: '10.0.0.5', state: 'active', xact_start: new Date(), query: 'UPDATE ...' },
    ]);
    pgMock.drainQueue.push([
      { pid: 42, application_name: 'worker', client_addr: '10.0.0.5', state: 'active', xact_start: new Date(), query: 'UPDATE ...' },
    ]);
    pgMock.drainQueue.push([
      { pid: 42, application_name: 'worker', client_addr: '10.0.0.5', state: 'active', xact_start: new Date(), query: 'UPDATE ...' },
    ]);
    pgMock.drainQueue.push([
      { pid: 42, application_name: 'worker', client_addr: '10.0.0.5', state: 'active', xact_start: new Date(), query: 'UPDATE ...' },
    ]);
    pgMock.drainQueue.push([
      { pid: 42, application_name: 'worker', client_addr: '10.0.0.5', state: 'active', xact_start: new Date(), query: 'UPDATE ...' },
    ]);
    const service = new RecoveryExecutorService({
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      storage: {
        getObject: async () => Buffer.from(''),
        listPrefix: async () => ['backups/1/x'],
      },
    });
    try {
      await service.acceptDelivery({ restoreUuid: 'drain-timeout-uuid', backupId: 1 });
      await vi.waitFor(async () => {
        const status = await service.getStatus();
        expect(status.manifest?.stage ?? '').toBe('MAINTENANCE');
        expect(status.manifest?.error ?? '').toContain('停写等待超时');
        expect(status.manifest?.error ?? '').toContain('pid=42');
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
