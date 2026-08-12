import { spawn } from 'node:child_process';

/**
 * 迁移前「立即备份」钩子（主 PRD §9.9）。
 *
 * 优先级：
 * 1. `PRE_MIGRATION_BACKUP_WAIT=1`：调用 platform-core 内部立即备份并轮询成功；
 * 2. `PRE_MIGRATION_BACKUP_CMD`：执行部署注入的 shell 命令；
 * 3. 均未配置：跳过（开发默认）。
 *
 * 空库豁免：触发备份失败时，若数据库为全新库（无任何业务表，无数据可备份）则跳过备份
 * 继续迁移；否则照常中止。覆盖"首次部署不经 release.sh 直接 up -d"等 platform-core
 * 尚未启动的场景（全新库不存在可备份数据，迁移前备份没有意义）。
 */

/** 业务 schema 清单（与各部署单元迁移元数据落位一致：platform-core→base，其余同名） */
const BUSINESS_SCHEMAS = ['base', 'backstage', 'asset', 'hr', 'fin'] as const;

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

/** 默认平台备份客户端：HTTP 调用 platform-core 内部端点（需 INTERNAL_SERVICE_TOKEN） */
function defaultPlatformBackupClient(env: NodeJS.ProcessEnv): PlatformBackupClient {
  const baseUrl = (env.PLATFORM_CORE_INTERNAL_BASE_URL ?? env.PLATFORM_CORE_URL ?? 'http://localhost:43001').replace(/\/$/, '');
  const token = env.INTERNAL_SERVICE_TOKEN?.trim();
  return {
    async triggerImmediateBackup(): Promise<{ backupId: number }> {
      if (!token) {
        throw new Error('INTERNAL_SERVICE_TOKEN 未配置');
      }
      const res = await fetch(`${baseUrl}/internal/v1/backups/immediate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-WBME-Caller': 'migration-runner',
        },
        // 不传幂等键：由服务端生成分钟级自动键（internal:caller:windowKey）。
        // 若钩子传天级键而服务端指纹按分钟，同日重试（备份失败修复后再发版等）会
        // 因同键异指纹抛 409 锁死发布链路直到次日——改服务端自动键后同分钟重试重放、
        // 跨分钟重试新建备份（S4 复核修复）。
        body: '{}',
      });
      if (!res.ok) {
        throw new Error(`立即备份请求失败: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { backupId?: number; taskUuid?: string; data?: { backupId?: number; taskUuid?: string } };
      const backupId = body.backupId ?? body.data?.backupId;
      if (!backupId) {
        throw new Error('立即备份响应缺少 backupId');
      }
      return { backupId };
    },
    async waitBackupSucceeded(backupId: number, timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const res = await fetch(`${baseUrl}/internal/v1/backups/immediate/status/${backupId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-WBME-Caller': 'migration-runner',
          },
        });
        if (res.ok) {
          const payload = (await res.json()) as { status?: string };
          if (payload.status === 'SUCCEEDED') {
            return true;
          }
          if (payload.status === 'FAILED') {
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
 * 判断数据库是否为全新库（业务 schema 无任何表，即无数据可备份）。
 *
 * @param env 环境变量（DATABASE_URL）
 * @returns true 全新库；无法确认时返回 false（保守：不做豁免）
 */
async function isFreshDatabase(env: NodeJS.ProcessEnv): Promise<boolean> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    return false;
  }
  let client: import('pg').Client | undefined;
  try {
    const { Client } = await import('pg');
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = ANY($1)`,
      [[...BUSINESS_SCHEMAS]],
    );
    return Number(rows[0]?.count ?? 0) === 0;
  } catch {
    // 连接失败/查询失败：无法确认空库，不做豁免（保守中止由调用方抛错处理）
    return false;
  } finally {
    await client?.end().catch(() => undefined);
  }
}

/** 空库判定函数（测试注入替身） */
export type FreshDbCheck = (env: NodeJS.ProcessEnv) => Promise<boolean>;

/**
 * 执行迁移前备份钩子。
 *
 * @param exec 命令执行器
 * @param env 环境变量
 * @param platformClient 平台备份客户端（测试注入）
 * @param freshDbCheck 空库判定（测试注入；默认直连 DATABASE_URL 查询）
 * @throws 备份失败时抛出（调用方停止迁移）
 */
export async function runPreMigrationBackup(
  exec: HookExec = defaultExec,
  env: NodeJS.ProcessEnv = process.env,
  platformClient?: PlatformBackupClient,
  freshDbCheck: FreshDbCheck = isFreshDatabase,
): Promise<void> {
  if (env.PRE_MIGRATION_BACKUP_WAIT === '1') {
    console.log('[pre-migration-backup] 通过 platform-core 立即备份 ...');
    const client = platformClient ?? defaultPlatformBackupClient(env);
    let backupId: number;
    try {
      ({ backupId } = await client.triggerImmediateBackup());
    } catch (error) {
      // 空库豁免：全新库无数据可备份，跳过备份继续迁移（覆盖 platform-core 未启动的首次部署）
      if (await freshDbCheck(env)) {
        console.log('[pre-migration-backup] 全新数据库（无业务表）且备份触发失败，跳过迁移前备份（无数据可备份）');
        return;
      }
      throw error;
    }
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
