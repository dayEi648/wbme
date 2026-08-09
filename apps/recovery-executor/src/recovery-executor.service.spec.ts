import { describe, expect, it } from 'vitest';
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
});
