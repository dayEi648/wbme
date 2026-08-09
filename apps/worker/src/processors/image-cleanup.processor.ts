import type { BackgroundTaskRow } from '@wbme/tasks';
import { IMAGE_RETENTION_DEFAULT_HOURS } from '../retention.constants';
import type { ProcessorContext } from './types';

/**
 * 未关联业务图片清理（主 PRD §9.1 / T4-10）。
 *
 * 扫描 images/ 前缀下对象，删除「未被任何业务表引用」且「超过保留时长」的对象：
 * - 引用集查询资产业务表（asset.assets 主图、asset.consumables 品种图）；
 *   查询失败时整轮跳过（宁可保留不可误删）；
 * - 保留时长读系统设置 upload.unassociated.image.retention.hours（默认 24 小时）。
 *
 * @param task 任务行
 * @param ctx 处理器上下文
 * @throws 清理失败（由 Worker 重试/终态失败）
 */
export async function processImageCleanup(task: BackgroundTaskRow, ctx: ProcessorContext): Promise<void> {
  const { createFileStorage } = await import('@wbme/files');
  const storage = ctx.storage ?? createFileStorage();

  const retentionHours = await readRetentionHours(ctx);
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);

  const objects = await storage.listPrefixWithMeta('images/');
  if (objects.length === 0) {
    return;
  }

  // 业务引用集：查询失败即跳过本轮（防误删正式关联图片）
  let referenced: Set<string>;
  try {
    referenced = await loadReferencedImageKeys(ctx);
  } catch (error) {
    console.warn(
      `[image-cleanup] 引用集查询失败，本轮跳过（taskUuid=${task.taskUuid}）：${
        error instanceof Error ? error.message : error
      }`,
    );
    return;
  }

  let removed = 0;
  let skipped = 0;
  for (const { key, lastModified } of objects) {
    if (referenced.has(key)) {
      skipped += 1;
      continue;
    }
    // 时间未知（本地竞态等）按未过期处理，下一轮再判
    if (!lastModified || lastModified > cutoff) {
      skipped += 1;
      continue;
    }
    await storage.deleteObject(key);
    removed += 1;
  }
  console.log(`[image-cleanup] 完成：删除 ${removed} 个未关联对象，保留 ${skipped} 个（含正式关联）`);
}

/** 读取未关联图片保留时长（小时）；缺省或非法回退默认 24 */
async function readRetentionHours(ctx: ProcessorContext): Promise<number> {
  const rows = await ctx.sql.queryRows<{ value: string }>(
    `SELECT value FROM backstage.system_settings WHERE key = 'upload.unassociated.image.retention.hours' LIMIT 1`,
  );
  const parsed = Number(rows[0]?.value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 24 * 365 ? parsed : IMAGE_RETENTION_DEFAULT_HOURS;
}

/** 业务图片引用集（资产主图 + 消耗品品种图；生产多库时表不存在 → 抛错由调用方跳过） */
async function loadReferencedImageKeys(ctx: ProcessorContext): Promise<Set<string>> {
  const rows = await ctx.sql.queryRows<{ key: string }>(
    `SELECT image_oss_key AS key FROM asset.assets WHERE image_oss_key IS NOT NULL
     UNION
     SELECT image_oss_key AS key FROM asset.consumables WHERE image_oss_key IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.key));
}
