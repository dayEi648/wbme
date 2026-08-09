import type { ImmediateBackupTaskRef, ScheduledBackupTaskRef, SqlClient } from '@wbme/tasks';
import { TASK_TYPE_EMERGENCY_BACKUP, TASK_TYPE_SCHEDULED_BACKUP } from '@wbme/tasks';
import { runImmediateBackup, type BackupProcessorDeps, type BackupTaskType } from './backup.processor';
import type { TaskProcessor } from './types';

/**
 * 将备份执行器适配为统一 TaskProcessor（定时/立即/紧急备份共用；主 PRD §9.1）。
 *
 * @param task 任务行
 * @param ctx 处理器上下文（含 SQL）
 */
export const processBackupTask: TaskProcessor = async (task, ctx) => {
  const ref = { ...((task.ref ?? {}) as ImmediateBackupTaskRef & ScheduledBackupTaskRef) };
  if (!ref.backupId) {
    ref.backupId = await ensureBackupRow(ctx.sql, {
      taskUuid: task.taskUuid,
      taskType: taskTypeOf(task.taskType),
      initiatorId: task.initiatorId,
    });
  }
  const deps = createBackupDeps(ctx.sql);
  await runImmediateBackup(ref, deps, taskTypeOf(task.taskType));
};

/** 任务类型 → 备份记录/清单类型 */
function taskTypeOf(taskType: string): BackupTaskType {
  if (taskType === TASK_TYPE_SCHEDULED_BACKUP) {
    return 'SCHEDULED';
  }
  if (taskType === TASK_TYPE_EMERGENCY_BACKUP) {
    return 'EMERGENCY';
  }
  return 'IMMEDIATE';
}

/**
 * 备份任务创建时可能尚未有 backups 行：执行前幂等补齐。
 *
 * @param sql SQL 客户端
 * @param input 任务关联信息
 * @returns 备份记录 id
 */
async function ensureBackupRow(
  sql: SqlClient,
  input: { taskUuid: string; taskType: 'SCHEDULED' | 'IMMEDIATE' | 'EMERGENCY'; initiatorId: number | null },
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
 * 扫描 backups/ 前缀下的孤儿对象（数据库无对应备份记录且残留超过 24h），删除并记录日志。
 *
 * 对象上传先于备份记录写回成功：若记录写回失败，对象残留且无记录 → 孤儿。
 * 按 backstage PRD §10 只清理「超 24h 仍缺少合法配对清单或备份对象」的残留；
 * 恢复进行中（存在未完成恢复）跳过整轮——外部恢复控制清单可能引用该前缀对象
 * （恢复控制清单存于恢复执行器持久化目录，Worker 不共享时以未完成恢复状态近似判断）。
 *
 * @param sql SQL 客户端
 * @param storage 文件存储实例（需带最后修改时间）
 */
async function scanOrphanBackupObjects(
  sql: SqlClient,
  storage: { listPrefixWithMeta(prefix: string): Promise<Array<{ key: string; lastModified: Date | null }>>; deleteObject(key: string): Promise<void> },
): Promise<void> {
  const activeRestore = await sql.queryRows<{ id: number }>(
    `SELECT id FROM backstage.restores
     WHERE status IN ('PENDING', 'PRECHECK', 'MAINTENANCE', 'RESTORING') LIMIT 1`,
  );
  if (activeRestore.length > 0) {
    console.log('[backup] 恢复流程进行中，跳过孤儿备份对象清理');
    return;
  }
  const { OSS_PREFIX_BACKUPS } = await import('@wbme/files');
  const items = await storage.listPrefixWithMeta(OSS_PREFIX_BACKUPS);
  if (items.length === 0) {
    return;
  }
  // 对象键形如 backups/{backupId}/dump.fc|manifest.json；非标准形状不动（防御）
  const backupIds = new Set<number>();
  for (const item of items) {
    const match = /^backups\/(\d+)\//.exec(item.key);
    if (match?.[1]) {
      backupIds.add(Number(match[1]));
    }
  }
  if (backupIds.size === 0) {
    return;
  }
  // 仅 SUCCEEDED 视为合法配对（backstage PRD §10：清单/对象成对且记录成功才保留；
  // FAILED 行（清单上传失败等）留下的对象按孤儿清理）
  const rows = await sql.queryRows<{ id: number }>(
    `SELECT id FROM backstage.backups WHERE id = ANY($1::int[]) AND status = 'SUCCEEDED'`,
    [[...backupIds]],
  );
  const known = new Set(rows.map((r) => r.id));
  const ageCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const orphanKeys = items
    .filter((item) => {
      const match = /^backups\/(\d+)\//.exec(item.key);
      if (!match?.[1] || known.has(Number(match[1]))) {
        return false;
      }
      const lastModified = item.lastModified?.getTime() ?? 0;
      return lastModified > 0 && lastModified < ageCutoff;
    })
    .map((item) => item.key);
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
      const storage = await createFileStorage();
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
