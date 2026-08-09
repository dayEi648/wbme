import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ImmediateBackupTaskRef } from '@wbme/tasks';

const execFileAsync = promisify(execFile);

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

/**
 * 执行立即/定时备份：pg_dump → 校验 → 上传 OSS backups/ 前缀。
 *
 * @param ref 任务 ref
 * @param deps 数据库与状态回调
 */
export async function runImmediateBackup(ref: ImmediateBackupTaskRef, deps: BackupProcessorDeps): Promise<void> {
  const dryRun = process.env.BACKUP_DRY_RUN === '1';
  // 动态导入避免单元测试加载 ali-oss（其模块初始化会探测网卡）
  const { createFileStorage } = await import('@wbme/files');
  const storage = createFileStorage();
  const workDir = await mkdtemp(join(tmpdir(), 'wbme-backup-'));
  const dumpPath = join(workDir, 'dump.fc');
  try {
    if (!dryRun) {
      await execFileAsync('pg_dump', ['-Fc', '-f', dumpPath, deps.databaseUrl], { env: process.env });
      await execFileAsync('pg_restore', ['--list', dumpPath]);
    } else {
      await import('node:fs/promises').then((fs) => fs.writeFile(dumpPath, Buffer.from('WBME_DRY_RUN_BACKUP')));
    }
    const body = await readFile(dumpPath);
    const checksum = createHash('sha256').update(body).digest('hex');
    const { objectKey, manifestKey } = await storage.presignBackupUpload(ref.backupId!, body);
    let pgVersion: string | null = null;
    try {
      const { stdout } = await execFileAsync('psql', [deps.databaseUrl, '-tAc', 'SHOW server_version;']);
      pgVersion = stdout.trim() || null;
    } catch {
      pgVersion = null;
    }
    if (!ref.backupId) {
      throw new Error('立即备份任务缺少 backupId');
    }
    await deps.updateBackupSucceeded(ref.backupId, {
      checksum,
      fileSize: BigInt(body.length),
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
