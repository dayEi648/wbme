import { loadEnvFile } from 'node:process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 加载仓库根 .env（集成测试使用真实本地 PostgreSQL；CI 由环境变量注入）
try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // 环境变量由外部注入时跳过
}
import { MigrationReadinessService } from './migration-readiness';

const DATABASE_URL = process.env.DATABASE_URL;

/** 测试用临时 schema（自建自删，不触碰真实迁移元数据） */
const SCRATCH_SCHEMA = '_t_readiness_test';

/**
 * 迁移版本就绪检查集成测试（主 PRD §9.9；真实 PostgreSQL）：
 * 全绿迁移 → 就绪；悬挂迁移/双向漂移/元数据缺失/连接失败 → 不就绪。
 */
describe.skipIf(!DATABASE_URL)('MigrationReadinessService（主 PRD §9.9 启动结构版本校验）', () => {
  let client: Client;
  let migrationsDir: string;
  const services: MigrationReadinessService[] = [];

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${SCRATCH_SCHEMA}"`);
    await client.query(
      `CREATE TABLE "${SCRATCH_SCHEMA}"."_prisma_migrations" (
         migration_name TEXT NOT NULL,
         finished_at TIMESTAMPTZ,
         rolled_back_at TIMESTAMPTZ
       )`,
    );
    migrationsDir = mkdtempSync(resolve(tmpdir(), 'wbme-readiness-'));
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`);
    await client.end();
    rmSync(migrationsDir, { recursive: true, force: true });
    for (const service of services) {
      await service.onModuleDestroy();
    }
  });

  /** 构造检查器（默认指向临时 schema 与临时目录） */
  function makeService(options: { connectionString?: string; metadataSchema?: string; migrationsDir?: string } = {}): MigrationReadinessService {
    const service = new MigrationReadinessService({
      connectionString: options.connectionString === undefined ? DATABASE_URL : options.connectionString,
      metadataSchema: options.metadataSchema ?? SCRATCH_SCHEMA,
      migrationsDir: options.migrationsDir ?? migrationsDir,
    });
    services.push(service);
    return service;
  }

  /** 在临时目录写入迁移名清单 */
  function writeMigrations(names: string[]): void {
    rmSync(migrationsDir, { recursive: true, force: true });
    migrationsDir = mkdtempSync(resolve(tmpdir(), 'wbme-readiness-'));
    for (const name of names) {
      mkdirSync(resolve(migrationsDir, name));
      writeFileSync(resolve(migrationsDir, name, 'migration.sql'), '-- test');
    }
  }

  /** 重置临时元数据表并写入迁移行 */
  async function writeApplied(rows: Array<{ name: string; finished: boolean; rolledBack?: boolean }>): Promise<void> {
    await client.query(`DELETE FROM "${SCRATCH_SCHEMA}"."_prisma_migrations"`);
    for (const row of rows) {
      await client.query(
        `INSERT INTO "${SCRATCH_SCHEMA}"."_prisma_migrations" (migration_name, finished_at, rolled_back_at)
         VALUES ($1, ${row.finished ? 'now()' : 'NULL'}, ${row.rolledBack ? 'now()' : 'NULL'})`,
        [row.name],
      );
    }
  }

  it('迁移全绿（已应用与目录一致）→ 就绪', async () => {
    await writeApplied([{ name: '20260101_init', finished: true }]);
    writeMigrations(['20260101_init']);
    const result = await makeService().check();
    expect(result.ready).toBe(true);
  });

  it('存在悬挂迁移（started 未 finished 未 rolled_back）→ 不就绪', async () => {
    await writeApplied([
      { name: '20260101_init', finished: true },
      { name: '20260201 broken', finished: false },
    ]);
    writeMigrations(['20260101_init', '20260201 broken']);
    const result = await makeService().check();
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('未完成迁移');
  });

  it('已回滚迁移不算悬挂（rolled_back 行可继续）', async () => {
    await writeApplied([
      { name: '20260101_init', finished: true },
      { name: '20260201 broken', finished: false, rolledBack: true },
    ]);
    writeMigrations(['20260101_init']);
    const result = await makeService().check();
    expect(result.ready).toBe(true);
  });

  it('目录迁移未应用 → 不就绪（发布顺序错误/迁移未执行）', async () => {
    await writeApplied([{ name: '20260101_init', finished: true }]);
    writeMigrations(['20260101_init', '20260301_new']);
    const result = await makeService().check();
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('迁移未应用');
  });

  it('已应用迁移不在目录 → 不就绪（代码回滚/目录错配漂移）', async () => {
    await writeApplied([
      { name: '20260101_init', finished: true },
      { name: '20260102_extra', finished: true },
    ]);
    writeMigrations(['20260101_init']);
    const result = await makeService().check();
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('不在目录');
  });

  it('迁移元数据表不存在 → 不就绪（迁移从未执行）', async () => {
    await client.query(`DROP TABLE IF EXISTS "${SCRATCH_SCHEMA}"."_prisma_migrations"`);
    const result = await makeService().check();
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('元数据表不存在');
    // 恢复临时表供后续用例
    await client.query(
      `CREATE TABLE "${SCRATCH_SCHEMA}"."_prisma_migrations" (
         migration_name TEXT NOT NULL,
         finished_at TIMESTAMPTZ,
         rolled_back_at TIMESTAMPTZ
       )`,
    );
  });

  it('数据库连接失败 → 不就绪（不抛出）', async () => {
    const result = await makeService({ connectionString: 'postgresql://127.0.0.1:59999/wbme' }).check();
    expect(result.ready).toBe(false);
  });

  it('未配置连接串 → 不就绪', async () => {
    const result = await makeService({ connectionString: '' }).check();
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('DATABASE_URL');
  });

  it('真实开发库（base 元数据 + platform-core 迁移目录）→ 就绪', async () => {
    const result = await makeService({
      metadataSchema: 'base',
      migrationsDir: resolve(__dirname, '../../../../apps/platform-core/prisma/migrations'),
    }).check();
    expect(result.ready).toBe(true);
  });
});
