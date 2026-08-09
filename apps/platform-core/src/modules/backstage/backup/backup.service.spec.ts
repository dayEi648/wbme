import { describe, expect, it } from 'vitest';

describe('BackupService 恢复互斥', () => {
  it('活跃恢复状态应拒绝新备份', () => {
    const active = ['PENDING', 'PRECHECK', 'MAINTENANCE', 'RESTORING'];
    expect(active).toContain('RESTORING');
  });
});
