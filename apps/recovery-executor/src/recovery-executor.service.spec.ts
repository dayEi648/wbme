import { describe, expect, it } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecoveryExecutorService } from './recovery-executor.service';

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
});
