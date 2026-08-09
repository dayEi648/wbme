import { spawn } from 'node:child_process';

/**
 * 迁移前「立即备份」钩子（主 PRD §9.9）。
 *
 * 优先级：
 * 1. `PRE_MIGRATION_BACKUP_WAIT=1`：调用 platform-core 内部立即备份并轮询成功；
 * 2. `PRE_MIGRATION_BACKUP_CMD`：执行部署注入的 shell 命令；
 * 3. 均未配置：跳过（开发默认）。
 */

/** 命令执行结果 */
export interface HookExecResult {
  ok: boolean;
  code: number | null;
}

/** 命令执行器（注入替身便于测试） */
export type HookExec = (command: string) => Promise<HookExecResult>;

/** 平台备份客户端（注入便于测试） */
export interface PlatformBackupClient {
  triggerImmediateBackup(): Promise<{ backupId: number }>;
  waitBackupSucceeded(backupId: number, timeoutMs: number): Promise<boolean>;
}

/** 默认执行器：经 shell 执行部署环境注入的命令 */
function defaultExec(command: string): Promise<HookExecResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { stdio: 'inherit', shell: true, env: process.env });
    child.on('close', (code) => resolvePromise({ ok: code === 0, code }));
    child.on('error', () => resolvePromise({ ok: false, code: null }));
  });
}

/** 默认平台备份客户端：HTTP 调用 platform-core（需 PRE_MIGRATION_BACKUP_TOKEN） */
function defaultPlatformBackupClient(env: NodeJS.ProcessEnv): PlatformBackupClient {
  const baseUrl = (env.PLATFORM_CORE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const token = env.PRE_MIGRATION_BACKUP_TOKEN?.trim();
  return {
    async triggerImmediateBackup(): Promise<{ backupId: number }> {
      if (!token) {
        throw new Error('PRE_MIGRATION_BACKUP_TOKEN 未配置');
      }
      const res = await fetch(`${baseUrl}/api/v1/backups/immediate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Idempotency-Key': `pre-migration:${Date.now()}`,
        },
        body: JSON.stringify({ idempotencyKey: `pre-migration:${new Date().toISOString().slice(0, 10)}` }),
      });
      if (!res.ok) {
        throw new Error(`立即备份请求失败: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { backupId?: number; data?: { backupId?: number } };
      const backupId = body.backupId ?? body.data?.backupId;
      if (!backupId) {
        throw new Error('立即备份响应缺少 backupId');
      }
      return { backupId };
    },
    async waitBackupSucceeded(backupId: number, timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const res = await fetch(`${baseUrl}/api/v1/backups?page=1&pageSize=5`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const payload = (await res.json()) as { items?: Array<{ id: number; status: string }> };
          const row = payload.items?.find((item) => item.id === backupId);
          if (row?.status === 'SUCCEEDED') {
            return true;
          }
          if (row?.status === 'FAILED') {
            return false;
          }
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
      return false;
    },
  };
}

/**
 * 执行迁移前备份钩子。
 *
 * @param exec 命令执行器
 * @param env 环境变量
 * @param platformClient 平台备份客户端（测试注入）
 * @throws 备份失败时抛出（调用方停止迁移）
 */
export async function runPreMigrationBackup(
  exec: HookExec = defaultExec,
  env: NodeJS.ProcessEnv = process.env,
  platformClient?: PlatformBackupClient,
): Promise<void> {
  if (env.PRE_MIGRATION_BACKUP_WAIT === '1') {
    console.log('[pre-migration-backup] 通过 platform-core 立即备份 ...');
    const client = platformClient ?? defaultPlatformBackupClient(env);
    const { backupId } = await client.triggerImmediateBackup();
    const timeoutMs = Number(env.PRE_MIGRATION_BACKUP_TIMEOUT_MS ?? 600_000);
    const ok = await client.waitBackupSucceeded(backupId, timeoutMs);
    if (!ok) {
      throw new Error(`[pre-migration-backup] 等待备份 #${backupId} 成功超时或失败`);
    }
    console.log('[pre-migration-backup] 平台立即备份完成');
    return;
  }

  const command = env.PRE_MIGRATION_BACKUP_CMD?.trim();
  if (!command) {
    console.log('[pre-migration-backup] 未配置 PRE_MIGRATION_BACKUP_CMD / PRE_MIGRATION_BACKUP_WAIT，跳过');
    return;
  }
  console.log('[pre-migration-backup] 执行迁移前备份命令 ...');
  const result = await exec(command);
  if (!result.ok) {
    throw new Error(`[pre-migration-backup] 迁移前备份失败（退出码 ${result.code ?? '未知'}），按发布纪律停止迁移`);
  }
  console.log('[pre-migration-backup] 迁移前备份完成');
}
