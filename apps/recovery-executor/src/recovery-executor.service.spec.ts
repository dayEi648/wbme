import { describe, expect, it } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecoveryExecutorService } from './recovery-executor.service';

/** 就绪检查所需的控制会话密钥（readiness 依赖） */
const SESSION_SECRET = 'test-session-secret-32-chars-long!!';

describe('RecoveryExecutorService 状态机', () => {
  it('dry-run 管道应到达 DONE', async () => {
    process.env.RESTORE_DRY_RUN = '1';
    process.env.RESTORE_STATE_DIR = '.agents/restore-state-test';
    const service = new RecoveryExecutorService();
    await service.acceptDelivery({ restoreUuid: 'test-uuid', backupId: 1 });
    await new Promise((r) => setTimeout(r, 800));
    const status = await service.getStatus();
    expect(status.manifest?.stage).toBe('DONE');
    expect(status.maintenance).toBe(false);
  });

  it('任一阶段失败保持维护状态并保存原因（人工介入）', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wbme-restore-fail-'));
    process.env.RESTORE_DRY_RUN = '0';
    process.env.RESTORE_STATE_DIR = stateDir;
    // 数据库不可达（无效端口）：PRECHECK 阶段必然失败
    const service = new RecoveryExecutorService({
      databaseUrl: 'postgresql://nobody:nobody@127.0.0.1:1/nope',
      redisUrl: 'redis://127.0.0.1:1',
      storage: {
        getObject: async () => Buffer.from(''),
        listPrefix: async () => [],
      },
    });
    await service.acceptDelivery({ restoreUuid: 'fail-uuid', backupId: 999 });
    // 等待管道失败（PRECHECK 连接失败快速返回）
    await new Promise((r) => setTimeout(r, 800));
    const status = await service.getStatus();
    expect(status.maintenance).toBe(true);
    expect(status.manifest?.stage).not.toBe('DONE');
    expect(status.manifest?.error).toBeTruthy();
    // 清单文件保留（原子替换写入）
    const manifestRaw = await readFile(join(stateDir, 'control-manifest.json'), 'utf8');
    expect(JSON.parse(manifestRaw).restoreUuid).toBe('fail-uuid');
    await rm(stateDir, { recursive: true, force: true });
  });

  it('beginShutdown 后就绪探针立即失败、新投递的恢复管道在阶段边界停止推进（L4）', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wbme-restore-shutdown-'));
    process.env.RESTORE_DRY_RUN = '1';
    process.env.RESTORE_STATE_DIR = stateDir;
    process.env.RECOVERY_SESSION_SECRET = SESSION_SECRET;
    // readiness 要求依赖配置完整（dry-run 不实际连接，无效端口即可）
    process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/nope';
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const service = new RecoveryExecutorService();
    try {
      // 就绪基线（状态目录可写 + 控制配置完整）
      expect((await service.readiness()).ready).toBe(true);
      // 停机标记 → 就绪立即失败（主 PRD §9.13）
      service.beginShutdown();
      const result = await service.readiness();
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('优雅停机中');
      // 停机后新投递：清单落盘（先写后执行）+ 维护标记保持，但管道在 PRECHECK 阶段边界即停止推进
      await service.acceptDelivery({ restoreUuid: 'shutdown-uuid', backupId: 2 });
      await new Promise((r) => setTimeout(r, 500));
      const status = await service.getStatus();
      expect(status.manifest?.stage).toBe('PRECHECK');
      expect(status.maintenance).toBe(true);
      // 清单文件保留（重启/超管可续跑）
      const manifestRaw = await readFile(join(stateDir, 'control-manifest.json'), 'utf8');
      expect(JSON.parse(manifestRaw).restoreUuid).toBe('shutdown-uuid');
    } finally {
      delete process.env.RECOVERY_SESSION_SECRET;
      delete process.env.DATABASE_URL;
      delete process.env.REDIS_URL;
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
