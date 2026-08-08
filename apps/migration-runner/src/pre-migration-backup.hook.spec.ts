import { describe, expect, it } from 'vitest';
import { runPreMigrationBackup, type HookExec } from './pre-migration-backup.hook';

/**
 * 迁移前备份钩子单测（主 PRD §9.9、实现规划 T0-6）：
 * 未配置跳过 / 已配置成功 / 失败阻断迁移。
 */
describe('runPreMigrationBackup（迁移前备份钩子）', () => {
  it('未配置 PRE_MIGRATION_BACKUP_CMD：跳过且不执行命令', async () => {
    let called = 0;
    const exec: HookExec = async () => {
      called += 1;
      return { ok: true, code: 0 };
    };
    await expect(runPreMigrationBackup(exec, {})).resolves.toBeUndefined();
    expect(called).toBe(0);
  });

  it('空白配置视同未配置', async () => {
    let called = 0;
    const exec: HookExec = async () => {
      called += 1;
      return { ok: true, code: 0 };
    };
    await expect(runPreMigrationBackup(exec, { PRE_MIGRATION_BACKUP_CMD: '   ' })).resolves.toBeUndefined();
    expect(called).toBe(0);
  });

  it('已配置且执行成功：按配置调用一次并放行', async () => {
    const commands: string[] = [];
    const exec: HookExec = async (command) => {
      commands.push(command);
      return { ok: true, code: 0 };
    };
    await expect(
      runPreMigrationBackup(exec, { PRE_MIGRATION_BACKUP_CMD: '/opt/wbme/backup-now.sh' }),
    ).resolves.toBeUndefined();
    expect(commands).toEqual(['/opt/wbme/backup-now.sh']);
  });

  it('已配置但执行失败：抛出（调用方停止迁移）', async () => {
    const exec: HookExec = async () => ({ ok: false, code: 3 });
    await expect(
      runPreMigrationBackup(exec, { PRE_MIGRATION_BACKUP_CMD: '/opt/wbme/backup-now.sh' }),
    ).rejects.toThrow('迁移前备份失败');
  });
});
