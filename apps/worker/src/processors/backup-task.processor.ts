import type { ImmediateBackupTaskRef, ScheduledBackupTaskRef, SqlClient } from '@wbme/tasks';
import { TASK_TYPE_SCHEDULED_BACKUP } from '@wbme/tasks';
import { runImmediateBackup, type BackupProcessorDeps } from './backup.processor';
import type { TaskProcessor } from './types';

/**
 * 将备份执行器适配为统一 TaskProcessor（定时/立即备份共用；主 PRD §9.1 / T4-7）。
 *
 * @param task 任务行
 * @param ctx 处理器上下文（含 SQL）
 */
export const processBackupTask: TaskProcessor = async (task, ctx) => {
  const ref = { ...((task.ref ?? {}) as ImmediateBackupTaskRef & ScheduledBackupTaskRef) };
  if (!ref.backupId) {
    ref.backupId = await ensureBackupRow(ctx.sql, {
      taskUuid: task.taskUuid,
      taskType: task.taskType === TASK_TYPE_SCHEDULED_BACKUP ? 'SCHEDULED' : 'IMMEDIATE',
      initiatorId: task.initiatorId,
    });
  }
  const deps = createBackupDeps(ctx.sql);
  await runImmediateBackup(ref, deps);
};

/**
 * 定时备份任务创建时可能尚未有 backups 行：执行前幂等补齐。
 *
 * @param sql SQL 客户端
 * @param input 任务关联信息
 * @returns 备份记录 id
 */
async function ensureBackupRow(
  sql: SqlClient,
  input: { taskUuid: string; taskType: 'SCHEDULED' | 'IMMEDIATE'; initiatorId: number | null },
): Promise<number> {
  const existing = await sql.queryRows<{ id: number }>(
    `SELECT id FROM backstage.backups WHERE task_uuid = $1::uuid LIMIT 1`,
    [input.taskUuid],
  );
  if (existing[0]?.id) {
    return existing[0].id;
  }
  const inserted = await sql.queryRows<{ id: number }>(
    `INSERT INTO backstage.backups (
       task_uuid, task_type, status, backup_time, started_at, created_by, created_at
     ) VALUES ($1::uuid, $2::backstage."BackupType", 'RUNNING', NOW(), NOW(), $3, NOW())
     RETURNING id`,
    [input.taskUuid, input.taskType, input.initiatorId],
  );
  const id = inserted[0]?.id;
  if (!id) {
    throw new Error('创建备份记录失败');
  }
  return id;
}

/**
 * 扫描 backups/ 前缀下的孤儿对象（数据库无对应备份记录），删除并记录日志。
 *
 * 对象上传先于备份记录写回成功：若记录写回失败，对象残留且无记录 → 孤儿。
 *
 * @param sql SQL 客户端
 * @param storage 文件存储实例
 */
async function scanOrphanBackupObjects(
  sql: SqlClient,
  storage: { listPrefix(prefix: string): Promise<string[]>; deleteObject(key: string): Promise<void> },
): Promise<void> {
  const { OSS_PREFIX_BACKUPS } = await import('@wbme/files');
  const keys = await storage.listPrefix(OSS_PREFIX_BACKUPS);
  if (keys.length === 0) {
    return;
  }
  // 对象键形如 backups/{backupId}/dump.fc|manifest.json
  const backupIds = new Set<number>();
  for (const key of keys) {
    const match = /^backups\/(\d+)\//.exec(key);
    if (match?.[1]) {
      backupIds.add(Number(match[1]));
    }
  }
  if (backupIds.size === 0) {
    return;
  }
  const rows = await sql.queryRows<{ id: number }>(
    `SELECT id FROM backstage.backups WHERE id = ANY($1::int[])`,
    [[...backupIds]],
  );
  const known = new Set(rows.map((r) => r.id));
  const orphanKeys = keys.filter((key) => {
    const match = /^backups\/(\d+)\//.exec(key);
    return match?.[1] ? !known.has(Number(match[1])) : true;
  });
  for (const key of orphanKeys) {
    await storage.deleteObject(key).catch((error: unknown) => {
      console.warn(`[backup] 孤儿对象删除失败 key=${key}: ${error instanceof Error ? error.message : error}`);
    });
  }
  if (orphanKeys.length > 0) {
    console.log(`[backup] 孤儿对象清理完成：${orphanKeys.length} 个`);
  }
}

/**
 * 构造备份处理器对 PostgreSQL backups 表的回调。
 *
 * @param sql Worker SQL 客户端
 * @returns 备份依赖
 */
function createBackupDeps(sql: SqlClient): BackupProcessorDeps {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL 未配置，无法执行备份');
  }
  return {
    databaseUrl,
    async updateBackupSucceeded(backupId, data) {
      if (!backupId) {
        return;
      }
      await sql.query(
        `UPDATE backstage.backups
         SET status = 'SUCCEEDED',
             checksum = $2,
             file_size = $3,
             oss_object_key = $4,
             oss_manifest_key = $5,
             pg_version = $6,
             finished_at = NOW(),
             error = NULL
         WHERE id = $1`,
        [backupId, data.checksum, data.fileSize.toString(), data.ossObjectKey, data.ossManifestKey, data.pgVersion],
      );
    },
    async updateBackupFailed(backupId, error) {
      if (!backupId) {
        return;
      }
      await sql.query(
        `UPDATE backstage.backups
         SET status = 'FAILED', error = $2, finished_at = NOW()
         WHERE id = $1 AND status = 'RUNNING'`,
        [backupId, error.slice(0, 2000)],
      );
    },
    async getRetentionDays() {
      const rows = await sql.queryRows<{ value: string }>(
        `SELECT value FROM backstage.system_settings WHERE key = 'backup.retention.days' LIMIT 1`,
      );
      const parsed = Number(rows[0]?.value);
      return Number.isFinite(parsed) && parsed >= 7 && parsed <= 365 ? parsed : 30;
    },
    async deleteOldBackups(before) {
      // 先删 OSS 对象与清单、全部成功后删记录（backstage PRD §10：任一对象清理失败必须保留失败记录）
      const { createFileStorage } = await import('@wbme/files');
      const storage = createFileStorage();
      const rows = await sql.queryRows<{ id: number; objectKey: string | null; manifestKey: string | null }>(
        `SELECT id, oss_object_key, oss_manifest_key FROM backstage.backups
         WHERE status = 'SUCCEEDED' AND backup_time < $1 AND task_type IN ('SCHEDULED', 'IMMEDIATE')`,
        [before.toISOString()],
      );
      const deletableIds: number[] = [];
      for (const row of rows) {
        const keys = [row.objectKey, row.manifestKey].filter((k): k is string => k !== null);
        try {
          for (const key of keys) {
            await storage.deleteObject(key);
          }
          deletableIds.push(row.id);
        } catch (error) {
          // 对象清理失败：保留记录（记录与对象均保留，等待人工介入；下次清理再试）
          console.warn(`[backup] 备份对象清理失败 backupId=${row.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (deletableIds.length > 0) {
        await sql.query(
          `DELETE FROM backstage.backups WHERE id = ANY($1::int[])`,
          [deletableIds],
        );
      }
      // 孤儿对象扫描：对象已存在但数据库无对应记录（记录更新失败残留），一并清除
      await scanOrphanBackupObjects(sql, storage);
    },
  };
}
