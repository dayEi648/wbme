import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ImmediateBackupTaskRef } from '@wbme/tasks';

const execFileAsync = promisify(execFile);

/** pg 工具路径（默认依赖 PATH；macOS EDB 安装位于 /Library/PostgreSQL/18/bin，可经环境变量注入） */
const PG_DUMP_PATH = process.env.PG_DUMP_PATH ?? 'pg_dump';
const PG_RESTORE_PATH = process.env.PG_RESTORE_PATH ?? 'pg_restore';
const PSQL_PATH = process.env.PSQL_PATH ?? 'psql';

/** 备份处理器依赖（由 Worker 注入 Prisma 客户端） */
export interface BackupProcessorDeps {
  databaseUrl: string;
  updateBackupSucceeded: (backupId: number, data: {
    checksum: string;
    fileSize: bigint;
    ossObjectKey: string;
    ossManifestKey: string;
    pgVersion: string | null;
  }) => Promise<void>;
  updateBackupFailed: (backupId: number, error: string) => Promise<void>;
  getRetentionDays: () => Promise<number>;
  deleteOldBackups: (before: Date) => Promise<void>;
}

/** 备份任务类型（清单记录与 backups.task_type 一致） */
export type BackupTaskType = 'SCHEDULED' | 'IMMEDIATE' | 'EMERGENCY';

/** 解析 pg_dump --version 输出中的主版本号 */
async function getPgDumpMajorVersion(): Promise<number> {
  const { stdout } = await execFileAsync(PG_DUMP_PATH, ['--version']);
  const match = stdout.match(/\(PostgreSQL\)\s+(\d+)/);
  if (!match?.[1]) {
    throw new Error(`无法识别 pg_dump 版本输出：${stdout.trim()}`);
  }
  return parseInt(match[1], 10);
}

/** 查询 PostgreSQL 服务器主版本号 */
async function getPgServerMajorVersion(databaseUrl: string): Promise<number> {
  const { stdout } = await execFileAsync(PSQL_PATH, [databaseUrl, '-tAc', 'SHOW server_version_num;']);
  const num = parseInt(stdout.trim(), 10);
  if (Number.isNaN(num)) {
    throw new Error(`无法识别 PostgreSQL 服务器版本号：${stdout.trim()}`);
  }
  // server_version_num 格式为 MMmmpp（主版本 * 10000 + 小版本 * 100 + 补丁）
  return Math.floor(num / 10000);
}

/**
 * 校验 pg_dump 客户端版本不低于服务器版本，防止大版本漂移导致备份硬失败。
 * （导出供直接单测——S2 复核补测）
 */
export async function assertPgClientCompatible(databaseUrl: string): Promise<void> {
  const [clientMajor, serverMajor] = await Promise.all([
    getPgDumpMajorVersion(),
    getPgServerMajorVersion(databaseUrl),
  ]);
  if (clientMajor < serverMajor) {
    throw new Error(
      `pg_dump 主版本(${clientMajor}.x)低于 PostgreSQL 服务器主版本(${serverMajor}.x)，备份不可用；请升级 postgresql-client 至 ${serverMajor} 及以上`,
    );
  }
}

/**
 * 执行备份（定时/立即/恢复前紧急共用）：pg_dump → 校验 → 上传 OSS backups/ 前缀。
 *
 * @param ref 任务 ref
 * @param deps 数据库与状态回调
 * @param taskType 备份类型（写入最小清单，恢复后按此补回目录）
 */
export async function runImmediateBackup(
  ref: ImmediateBackupTaskRef,
  deps: BackupProcessorDeps,
  taskType: BackupTaskType,
): Promise<void> {
  const dryRun = process.env.BACKUP_DRY_RUN === '1';
  // 动态导入避免单元测试加载 ali-oss（其模块初始化会探测网卡）
  const { createFileStorage } = await import('@wbme/files');
  const storage = await createFileStorage();
  const workDir = await mkdtemp(join(tmpdir(), 'wbme-backup-'));
  const dumpPath = join(workDir, 'dump.fc');
  try {
    if (!ref.backupId) {
      throw new Error('备份任务缺少 backupId');
    }
    let pgVersion: string | null = null;
    try {
      const { stdout } = await execFileAsync(PSQL_PATH, [deps.databaseUrl, '-tAc', 'SHOW server_version;']);
      pgVersion = stdout.trim() || null;
    } catch {
      pgVersion = null;
    }
    if (!dryRun) {
      await assertPgClientCompatible(deps.databaseUrl);
      await execFileAsync(PG_DUMP_PATH, ['-Fc', '-f', dumpPath, deps.databaseUrl], { env: process.env });
      await execFileAsync(PG_RESTORE_PATH, ['--list', dumpPath]);
    } else {
      await import('node:fs/promises').then((fs) => fs.writeFile(dumpPath, Buffer.from('WBME_DRY_RUN_BACKUP')));
    }
    // 流式上传 + 流式 SHA-256（问题16 修复）：大备份不整体读入内存（worker 256m 上限防 OOM）
    const fileSize = (await stat(dumpPath)).size;
    const { objectKey, manifestKey, checksum } = await storage.presignBackupUpload(
      ref.backupId,
      createReadStream(dumpPath),
      {
        taskType,
        backupTime: new Date().toISOString(),
        pgVersion,
        size: fileSize,
      },
    );
    await deps.updateBackupSucceeded(ref.backupId, {
      checksum,
      fileSize: BigInt(fileSize),
      ossObjectKey: objectKey,
      ossManifestKey: manifestKey,
      pgVersion,
    });
    const retentionDays = await deps.getRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    await deps.deleteOldBackups(cutoff);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.updateBackupFailed(ref.backupId ?? 0, message);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
