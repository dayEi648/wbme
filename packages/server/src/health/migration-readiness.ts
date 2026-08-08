import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * 迁移版本就绪检查（主 PRD §9.9、实现规划 T1-3/T0-5）。
 *
 * 每个部署单元在 /readyz 校验自己拥有的 schema 迁移版本：
 * - PostgreSQL 连通性（SELECT 1）；
 * - 迁移元数据表存在（`_prisma_migrations` 落位于本单元声明 schema，迁移历史隔离）；
 * - 无悬挂/失败迁移（started 但未 finished 且未 rolled_back）；
 * - 无双向漂移：目录中存在但未应用的迁移（发布顺序错误/迁移未执行）、
 *   已应用但目录中不存在的迁移（代码回滚或目录错配）；
 * 任一不满足即不就绪（readyz 503）。按 PRD 口径不就绪 ≠ 退出进程——进程保持存活，
 * 探针持续失败直至迁移补齐（与 Redis 启动强依赖退出进程的语义不同，见各应用 main.ts）。
 *
 * 结果 reason 仅供服务端日志/排障，探针响应只返回最小状态（主 PRD §9.13 不泄露细节）。
 */

/** 就绪检查结果（reason 仅供服务端日志，不进探针响应） */
export interface MigrationReadinessResult {
  ready: boolean;
  reason?: string;
}

/** 就绪检查接口（健康探针按此调用；便于替身测试） */
export interface MigrationReadinessChecker {
  check(): Promise<MigrationReadinessResult>;
}

/** 健康探针注入令牌：各部署单元按自身 schema/迁移目录提供 */
export const MIGRATION_READINESS = Symbol('WBME_MIGRATION_READINESS');

/** 连接与查询超时（探针路径不允许长时间挂起） */
const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 2_000;

/** schema 标识符安全校验（元数据表名需内嵌 SQL，只允许安全标识符） */
const SAFE_SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/i;

export class MigrationReadinessService implements MigrationReadinessChecker {
  private readonly pool: Pool | null;
  private readonly metadataSchema: string;
  private readonly migrationsDir: string;

  /**
   * @param options.connectionString 运行时数据库连接串（无 ?schema= 参数；缺省/空 → 恒不就绪）
   * @param options.metadataSchema 迁移元数据表所在 schema（platform-core → base，代表 base+backstage
   *   合并迁移序列；asset/hr/fin → 各自同名 schema）
   * @param options.migrationsDir 本单元迁移目录（漂移对照）
   */
  constructor(options: { connectionString: string | undefined; metadataSchema: string; migrationsDir: string }) {
    if (!SAFE_SCHEMA_PATTERN.test(options.metadataSchema)) {
      throw new Error(`非法迁移元数据 schema 标识：${options.metadataSchema}`);
    }
    this.metadataSchema = options.metadataSchema;
    this.migrationsDir = options.migrationsDir;
    this.pool = options.connectionString
      ? new Pool({
          connectionString: options.connectionString,
          max: 1,
          connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
          query_timeout: QUERY_TIMEOUT_MS,
        })
      : null;
  }

  /** 释放连接池（应用关闭生命周期调用） */
  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /**
   * 执行就绪检查。
   * @returns ready=false 时携带仅供服务端日志的 reason；任何异常（连接失败/查询错误）归一为不就绪
   */
  async check(): Promise<MigrationReadinessResult> {
    if (!this.pool) {
      return { ready: false, reason: 'DATABASE_URL 未配置' };
    }
    try {
      // 连通性
      await this.pool.query('SELECT 1');
      // 元数据表存在性
      const tableCheck = await this.pool.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = '_prisma_migrations'`,
        [this.metadataSchema],
      );
      if (tableCheck.rowCount === 0) {
        return { ready: false, reason: `迁移元数据表不存在（schema=${this.metadataSchema}，迁移未执行）` };
      }
      // 悬挂/失败迁移
      const hanging = await this.pool.query(
        `SELECT migration_name FROM "${this.metadataSchema}"."_prisma_migrations"
         WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
      );
      if (hanging.rowCount !== null && hanging.rowCount > 0) {
        return { ready: false, reason: `存在未完成迁移：${(hanging.rows[0] as { migration_name: string }).migration_name}` };
      }
      // 双向漂移对照
      const applied = await this.pool.query(
        `SELECT migration_name FROM "${this.metadataSchema}"."_prisma_migrations" WHERE finished_at IS NOT NULL`,
      );
      const appliedNames = new Set((applied.rows as Array<{ migration_name: string }>).map((row) => row.migration_name));
      const directoryNames = this.readMigrationDirectory();
      for (const name of directoryNames) {
        if (!appliedNames.has(name)) {
          return { ready: false, reason: `迁移未应用：${name}` };
        }
      }
      for (const name of appliedNames) {
        if (!directoryNames.includes(name)) {
          return { ready: false, reason: `已应用迁移不在目录中：${name}` };
        }
      }
      return { ready: true };
    } catch (error) {
      return { ready: false, reason: `迁移就绪检查失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** 读取迁移目录中的迁移名清单（含 migration.sql 的子目录名；目录不存在视为无迁移） */
  private readMigrationDirectory(): string[] {
    if (!existsSync(this.migrationsDir)) {
      return [];
    }
    return readdirSync(this.migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(resolve(this.migrationsDir, entry.name, 'migration.sql')))
      .map((entry) => entry.name);
  }
}
