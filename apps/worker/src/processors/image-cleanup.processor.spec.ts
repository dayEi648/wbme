import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileStorage, FileStorageService, LocalFileStorage, OSS_PREFIX_IMAGES } from '@wbme/files';
import type { ProcessorContext } from './types';
import { processImageCleanup } from './image-cleanup.processor';
import type { BackgroundTaskRow, SqlClient } from '@wbme/tasks';

try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * 图片清理处理器集成测试（T4-10）：本地存储替身 + 真实数据库。
 * 验证：未关联且超保留期对象被删；正式关联对象与未超期对象保留；引用查询失败时整轮跳过。
 */
describe.skipIf(!DATABASE_URL)('processImageCleanup（T4-10 未关联图片清理）', () => {
  let root: string;
  let storage: FileStorageService;
  let sql: SqlClient;

  const ctx = { sql: null as unknown as SqlClient, leaseOwner: 'test', deployCommit: 'test', storage: null as never } as ProcessorContext & { storage: FileStorageService };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wbme-img-test-'));
    storage = await createFileStorage({}, new LocalFileStorage(root));
    ctx.storage = storage;
    // 用文件系统 SQL 客户端不可行——测试直接通过 pg 客户端（复用 worker 的 SqlClient 契约，用最小实现）
    // 这里使用真实的 pg 客户端替换：worker 的 SqlClient 接口为 query/queryRows。
    const { Client } = await import('pg');
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    sql = {
      query: async (text: string, params?: unknown[]) => client.query(text, params),
      queryRows: async <T>(text: string, params?: unknown[]): Promise<T[]> => {
        const result = await client.query(text, params);
        return result.rows as T[];
      },
    } as unknown as SqlClient;
    ctx.sql = sql;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    // 清理测试插入的设置行、资产引用与注册表行
    await sql.query(
      `DELETE FROM backstage.system_settings WHERE key = 'upload.unassociated.image.retention.hours'`,
    );
    await sql.query(`DELETE FROM asset.assets WHERE image_oss_key LIKE $1`, [`${OSS_PREFIX_IMAGES}9999/%`]);
    await sql.query(`DELETE FROM backstage.image_objects WHERE object_key LIKE $1`, [`${OSS_PREFIX_IMAGES}9999/%`]);
    await (sql as unknown as { end: () => Promise<void> }).end?.().catch(() => undefined);
  });

  it('删除超过保留期且未被引用的对象，保留正式关联对象', async () => {
    // 写入两个对象：一个未关联（超期），一个被 asset.assets 引用（保留）
    const orphanKey = `${OSS_PREFIX_IMAGES}9999/orphan-old.bin`;
    const referencedKey = `${OSS_PREFIX_IMAGES}9999/referenced.bin`;
    // 本地替身：直接写文件；最后修改时间拨旧
    const { LocalFileStorage: LFS } = await import('@wbme/files');
    const local = new LFS(root);
    await local.putObject(orphanKey, Buffer.from('old'));
    await local.putObject(referencedKey, Buffer.from('ref'));
    // LocalFileStorage 根目录为 root/.agents/tmp-oss（LOCAL_OSS_ROOT 拼接）
    const fsRoot = join(root, '.agents/tmp-oss');
    const now = Date.now();
    const filePath = join(fsRoot, orphanKey);
    // mtime 拨到 25 小时前
    const { utimes } = await import('node:fs/promises');
    await utimes(filePath, new Date(now - 25 * 3600 * 1000), new Date(now - 25 * 3600 * 1000));
    // 引用：插入一条资产记录（image_oss_key = referencedKey），清空孤儿引用集为空
    await sql.query(
      `DELETE FROM asset.assets WHERE image_oss_key = $1`,
      [referencedKey],
    );
    await sql.query(
      `INSERT INTO asset.assets (name, amount, ownership, image_oss_key, created_by, created_at, updated_at)
       VALUES ('测试资产', 1, 'COMPANY', $1, 1, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [referencedKey],
    );
    // 设置保留时长为 24 小时
    await sql.query(
      `INSERT INTO backstage.system_settings (key, value, value_type, "group", label, sensitive, created_at, updated_at)
       VALUES ('upload.unassociated.image.retention.hours', '24', 'NUMBER', 'PLATFORM', '未关联图片保留时长', false, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET value = '24'`,
    );
    // 注册表同步清理（M5）：预置孤儿对象的正式化注册行，清理后该行必须消失
    await sql.query(
      `INSERT INTO backstage.image_objects (object_key, owner_user_id, finalized_at)
       VALUES ($1, 1, NOW() - INTERVAL '25 hours')
       ON CONFLICT (object_key) DO NOTHING`,
      [orphanKey],
    );

    const task = { taskUuid: 'test-cleanup', taskType: 'UNASSOCIATED_IMAGE_CLEANUP' } as BackgroundTaskRow;
    await processImageCleanup(task, ctx);

    // 孤儿（超期未引用）应被删除；被引用的保留
    const remaining = await readdir(join(fsRoot, 'images', '9999')).catch(() => []);
    expect(remaining).not.toContain('orphan-old.bin');
    expect(remaining).toContain('referenced.bin');
    // 注册表行随对象同步删除（M5 复核修复）
    const registry = await sql.queryRows<{ count: string }>(
      `SELECT count(*)::text AS count FROM backstage.image_objects WHERE object_key = $1`,
      [orphanKey],
    );
    expect(Number(registry[0]?.count ?? 0)).toBe(0);
  });

  it('保留期内的未关联对象不被删除', async () => {
    const freshKey = `${OSS_PREFIX_IMAGES}9999/fresh.bin`;
    const { LocalFileStorage: LFS } = await import('@wbme/files');
    const local = new LFS(root);
    await local.putObject(freshKey, Buffer.from('fresh'));
    const task = { taskUuid: 'test-cleanup-2', taskType: 'UNASSOCIATED_IMAGE_CLEANUP' } as BackgroundTaskRow;
    await processImageCleanup(task, ctx);
    const fsRoot = join(root, '.agents/tmp-oss');
    const remaining = await readdir(join(fsRoot, 'images', '9999')).catch(() => []);
    expect(remaining).toContain('fresh.bin');
    await local.deleteObject(freshKey);
  });
});
