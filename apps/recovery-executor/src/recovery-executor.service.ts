import { mkdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { RestoreDeliveryTaskRef } from '@wbme/tasks';

const execFileAsync = promisify(execFile);

/** 恢复阶段 */
export type RestoreStage =
  | 'PRECHECK'
  | 'MAINTENANCE'
  | 'RESTORING'
  | 'MIGRATE_FORWARD'
  | 'CANCEL_TASKS'
  | 'REINSTATE_BACKUPS'
  | 'CLEAR_REDIS'
  | 'READINESS'
  | 'DONE';

/** 外部控制清单（数据库外唯一事实来源；backstage PRD §10） */
export interface RestoreControlManifest {
  restoreUuid: string;
  backupId: number;
  stage: RestoreStage;
  updatedAt: string;
  error?: string;
}

/** 恢复执行器依赖（测试可注入替身） */
export interface RecoveryExecutorDeps {
  /** 数据库连接串（目标库；pg_restore 覆盖与状态校验） */
  databaseUrl: string;
  /** 文件存储（取回备份文件 / 扫描备份前缀） */
  storage: {
    getObject(key: string): Promise<Buffer>;
    listPrefix(prefix: string): Promise<string[]>;
  };
  /** Redis 连接串（恢复后清空） */
  redisUrl: string;
  /** 迁移执行命令（缺省跳过并告警） */
  migrateCmd?: string;
}

const DEFAULT_STATE_DIR = '.agents/restore-state';
const RECOVERY_COOKIE_NAME = 'wbme_recovery_session';
/** 恢复控制凭证有效窗口（毫秒，1 小时；与 Cookie maxAge 一致，服务端侧强制） */
const RECOVERY_SESSION_TTL_MS = 60 * 60 * 1000;
/** 停写等待窗口（毫秒）：等待已进入的写事务自然结束（生产由 Nginx/容器编排保证无新连接） */
const WRITE_DRAIN_WAIT_MS = 5_000;

/**
 * 恢复执行状态机（backstage PRD §10）。
 *
 * 外部控制清单为恢复期间唯一事实来源（数据库会被覆盖）；backstage.restores
 * 为镜像尽力同步（失败不阻塞）。任一阶段失败保持维护状态并保存脱敏原因，
 * 由超级管理员经恢复专用控制会话手动重试。
 */
@Injectable()
export class RecoveryExecutorService {
  private readonly logger = new Logger(RecoveryExecutorService.name);
  private readonly stateDir: string;
  private readonly dryRun: boolean;
  private readonly deps: RecoveryExecutorDeps | null;
  private manifest: RestoreControlManifest | null = null;
  /** 管道单飞互斥：同一进程内只允许一条恢复管道执行 */
  private pipelineInFlight = false;

  /**
   * @param deps 运行时依赖；缺省按环境变量构造（测试注入替身）
   */
  constructor(deps?: RecoveryExecutorDeps) {
    this.stateDir = process.env.RESTORE_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
    this.dryRun = process.env.RESTORE_DRY_RUN === '1';
    this.deps = deps ?? null;
  }

  /** 健康检查 */
  health(): { ok: true } {
    return { ok: true };
  }

  /** 当前恢复状态 */
  async getStatus(): Promise<{ maintenance: boolean; manifest: RestoreControlManifest | null }> {
    await this.loadManifest();
    const maintenance = await this.isMaintenanceMode();
    return { maintenance, manifest: this.manifest };
  }

  /**
   * 接收 RESTORE_DELIVERY：持久化外部清单并进入维护状态。
   *
   * 幂等语义（backstage PRD §10「清单写入后不再重放」）：
   * - 既有清单 stage ≠ DONE 且 restoreUuid 相同 → 忽略重复投递（恢复进行中）；
   * - 既有清单 restoreUuid 不同 → 拒绝（避免覆盖进行中的恢复，清单被覆盖会重跑破坏性管道）。
   *
   * @param ref 任务 ref
   */
  async acceptDelivery(ref: RestoreDeliveryTaskRef): Promise<void> {
    await this.ensureStateDir();
    const existing = await this.loadManifestIfExists();
    if (existing) {
      if (existing.restoreUuid === ref.restoreUuid && existing.stage !== 'DONE') {
        this.logger.warn(`恢复投递重复（restoreUuid=${ref.restoreUuid} stage=${existing.stage}），忽略重投`);
        return;
      }
      if (existing.restoreUuid !== ref.restoreUuid) {
        throw new Error(`已有进行中的恢复 ${existing.restoreUuid}，拒绝接收新的投递 ${ref.restoreUuid}`);
      }
    }
    this.manifest = {
      restoreUuid: ref.restoreUuid,
      backupId: ref.backupId,
      stage: 'PRECHECK',
      updatedAt: new Date().toISOString(),
    };
    await this.writeManifest();
    await this.setMaintenanceMarker(true);
    await this.syncRestoreRow({ status: 'MAINTENANCE', stage: 'PRECHECK' }).catch(() => undefined);
    void this.runPipeline();
  }

  /** 重试当前阶段（人工触发；破坏性步骤前由页面二次确认） */
  async retry(): Promise<void> {
    if (!this.manifest) {
      await this.loadManifest();
    }
    if (!this.manifest) {
      return;
    }
    void this.runPipeline();
  }

  /**
   * 签发恢复会话 Cookie 值（超管登录后由 platform-core 调用内部接口设置）。
   *
   * @param superAdminUserId 超管用户 id
   * @param secret HMAC 密钥
   */
  issueRecoverySessionToken(superAdminUserId: number, secret: string): string {
    const nonce = randomBytes(16).toString('hex');
    const payload = `${superAdminUserId}:${Date.now()}:${nonce}`;
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    return `${payload}:${sig}`;
  }

  /**
   * 校验恢复会话 Cookie。
   *
   * @param token Cookie 值
   * @param secret HMAC 密钥
   */
  verifyRecoverySessionToken(token: string, secret: string): boolean {
    const parts = token.split(':');
    if (parts.length < 4) {
      return false;
    }
    const sig = parts.pop()!;
    const payload = parts.join(':');
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    try {
      if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
        return false;
      }
    } catch {
      return false;
    }
    // 签发时间窗（backstage PRD §10：控制凭证有有效期限，不无限有效）
    const issuedAt = Number(parts[1]);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > RECOVERY_SESSION_TTL_MS) {
      return false;
    }
    // 恢复完成（DONE）后控制凭证立即失效（PRD §10「清单完成或明确终止后立即失效」）
    if (this.manifest?.stage === 'DONE') {
      return false;
    }
    return true;
  }

  /**
   * 恢复管道主循环：按阶段推进，任一步失败保持维护状态。
   * 单飞互斥：同一进程内只允许一条管道执行（重复投递/重试并发进入时后到者直接返回）。
   */
  private async runPipeline(): Promise<void> {
    if (!this.manifest || this.pipelineInFlight) {
      return;
    }
    this.pipelineInFlight = true;
    try {
      await this.runPipelineInner();
    } finally {
      this.pipelineInFlight = false;
    }
  }

  private async runPipelineInner(): Promise<void> {
    if (!this.manifest) {
      return;
    }
    const stages: RestoreStage[] = [
      'PRECHECK',
      'MAINTENANCE',
      'RESTORING',
      'MIGRATE_FORWARD',
      'CANCEL_TASKS',
      'REINSTATE_BACKUPS',
      'CLEAR_REDIS',
      'READINESS',
      'DONE',
    ];
    try {
      // 从清单记录的阶段续跑（失败时 stage 已指向失败阶段 → 重试当前阶段；
      // backstage PRD §10「明确选择重试当前阶段」，不重放已完成阶段）
      const manifest = this.manifest;
      const startIndex = Math.max(0, stages.findIndex((s) => s === manifest.stage));
      for (let i = startIndex; i < stages.length; i += 1) {
        const stage = stages[i]!;
        this.manifest.stage = stage;
        this.manifest.updatedAt = new Date().toISOString();
        delete this.manifest.error;
        await this.writeManifest();
        this.logger.log(`恢复阶段 ${stage}${this.dryRun ? ' (dry-run)' : ''}`);
        await this.executeStage(stage);
      }
      this.manifest.stage = 'DONE';
      this.manifest.updatedAt = new Date().toISOString();
      await this.writeManifest();
      await this.setMaintenanceMarker(false);
      await this.syncRestoreRow({ status: 'SUCCEEDED', stage: 'DONE' }).catch(() => undefined);
      this.logger.log('恢复完成，已退出维护状态');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.manifest) {
        this.manifest.error = message;
        await this.writeManifest();
      }
      await this.syncRestoreRow({ status: 'FAILED', stage: this.manifest?.stage ?? null, error: message }).catch(
        () => undefined,
      );
      // 保持维护状态：由超级管理员人工重试或改用紧急备份（PRD §10）
      this.logger.error(`恢复失败，保持维护状态: ${message}`);
    }
  }

  /** 执行单个阶段（dry-run 时仅推进状态机，不触数据库/外部系统） */
  private async executeStage(stage: RestoreStage): Promise<void> {
    if (this.dryRun) {
      // 维护标记与镜像记录是 dry-run 中唯一真实副作用（便于验证状态机）
      if (stage === 'MAINTENANCE') {
        await this.setMaintenanceMarker(true);
      }
      await this.sleep(50);
      return;
    }
    switch (stage) {
      case 'PRECHECK':
        await this.stagePrecheck();
        break;
      case 'MAINTENANCE':
        await this.stageMaintenance();
        break;
      case 'RESTORING':
        await this.stageRestoring();
        break;
      case 'MIGRATE_FORWARD':
        await this.stageMigrateForward();
        break;
      case 'CANCEL_TASKS':
        await this.stageCancelTasks();
        break;
      case 'REINSTATE_BACKUPS':
        await this.stageReinstateBackups();
        break;
      case 'CLEAR_REDIS':
        await this.stageClearRedis();
        break;
      case 'READINESS':
        await this.stageReadiness();
        break;
      case 'DONE':
        break;
    }
  }

  /** 预检：所选备份记录完整、校验和与对象可达 */
  private async stagePrecheck(): Promise<void> {
    const db = await this.openDb();
    try {
      const rows = await db.queryRows<{
        status: string;
        checksum: string | null;
        oss_object_key: string | null;
        file_size: string | null;
      }>(
        `SELECT status, checksum, oss_object_key, file_size::text AS file_size
         FROM backstage.backups WHERE id = $1`,
        [this.manifest!.backupId],
      );
      const backup = rows[0];
      if (!backup) {
        throw new Error(`备份记录不存在 backupId=${this.manifest!.backupId}`);
      }
      if (backup.status !== 'SUCCEEDED' || !backup.checksum || !backup.oss_object_key) {
        throw new Error(`备份未通过校验（状态=${backup.status}），禁止恢复`);
      }
      // 对象可达性（对象缺失在 RESTORING 下载阶段暴露；此处校验键存在即可提前失败）
      const storage = await this.getStorage();
      const keys = await storage.listPrefix(`backups/${this.manifest!.backupId}/`);
      if (keys.length === 0) {
        throw new Error('备份对象在存储中不可达');
      }
    } finally {
      await db.end();
    }
  }

  /** 维护：确保标记在位、镜像恢复记录、等待存量写事务自然结束 */
  private async stageMaintenance(): Promise<void> {
    await this.setMaintenanceMarker(true);
    await this.syncRestoreRow({ status: 'MAINTENANCE', stage: 'MAINTENANCE' }).catch(() => undefined);
    // 有界停写窗口：生产环境 Nginx 已返回 503 且各应用连接池被编排关闭；
    // 此处等待存量事务自然结束（PRD §10「等待已进入的写事务结束」的 MVP 近似）
    await this.sleep(WRITE_DRAIN_WAIT_MS);
  }

  /** 恢复：下载备份 → 校验 → pg_restore 覆盖目标库 */
  private async stageRestoring(): Promise<void> {
    if (this.dryRun) {
      return;
    }
    const storage = await this.getStorage();
    const backup = await this.loadBackupRow();
    const workDir = await mkdtemp(join(tmpdir(), 'wbme-restore-'));
    const dumpPath = join(workDir, 'dump.fc');
    try {
      const body = await storage.getObject(backup.oss_object_key!);
      await writeFile(dumpPath, body);
      if (backup.checksum) {
        const digest = createHash('sha256').update(body).digest('hex');
        if (digest !== backup.checksum) {
          throw new Error('备份校验和不匹配，禁止覆盖数据库');
        }
      }
      await this.pgRestoreList(dumpPath);
      const restore = this.pgRestorePath();
      await execFileAsync(restore, ['-Fc', '--clean', '--if-exists', '-d', this.getDeps().databaseUrl, dumpPath], {
        env: process.env,
        timeout: 30 * 60 * 1000,
      });
      this.logger.log('pg_restore 完成');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** 正向迁移：复用 Migration Runner 执行备份后未包含、当前部署需要的迁移 */
  private async stageMigrateForward(): Promise<void> {
    if (this.dryRun) {
      this.logger.log('dry-run 跳过正向迁移');
      return;
    }
    const migrateCmd = process.env.RECOVERY_MIGRATE_CMD ?? this.getDeps().migrateCmd;
    if (!migrateCmd) {
      // backstage PRD §10：正向迁移必须执行，缺失按失败处理并保持维护状态（不得带错结构退出）
      throw new Error('RECOVERY_MIGRATE_CMD 未配置：正向迁移必须执行（backstage PRD §10）');
    }
    const { exec } = await import('node:child_process');
    const { promisify: p } = await import('node:util');
    await p(exec)(migrateCmd, { env: process.env, timeout: 30 * 60 * 1000 });
    this.logger.log('正向迁移完成');
  }

  /** 取消旧快照中恢复出的历史非终态任务（PRD §10：不得重新执行） */
  private async stageCancelTasks(): Promise<void> {
    const db = await this.openDb();
    try {
      await db.query(
        `UPDATE backstage.background_tasks
         SET status = 'CANCELLED', last_error = '因整库恢复取消', finished_at = NOW()
         WHERE status IN ('PENDING_ENQUEUE', 'QUEUED', 'RUNNING')`,
      );
    } finally {
      await db.end();
    }
  }

  /** 补回 OSS 中完整存在的备份记录（清单合法、对象完整；幂等） */
  private async stageReinstateBackups(): Promise<void> {
    const storage = await this.getStorage();
    const db = await this.openDb();
    try {
      const keys = await storage.listPrefix('backups/');
      const backupIds = new Set<number>();
      for (const key of keys) {
        const match = /^backups\/(\d+)\/manifest\.json$/.exec(key);
        if (match?.[1]) {
          backupIds.add(Number(match[1]));
        }
      }
      for (const backupId of backupIds) {
        const existing = await db.queryRows<{ id: number }>(
          `SELECT id FROM backstage.backups WHERE id = $1 LIMIT 1`,
          [backupId],
        );
        if (existing[0]?.id) {
          continue;
        }
        // 读取最小清单并校验完整性（无清单/不合法不得登记）
        try {
          const manifest = JSON.parse(
            (await storage.getObject(`backups/${backupId}/manifest.json`)).toString('utf8'),
          ) as {
            backupId: number;
            taskType?: string;
            backupTime?: string;
            size?: number;
            checksum?: string;
            pgVersion?: string | null;
            objectKey?: string;
          };
          if (
            manifest.backupId !== backupId ||
            typeof manifest.size !== 'number' ||
            typeof manifest.checksum !== 'string'
          ) {
            this.logger.warn(`备份清单不合法，不登记 backupId=${backupId}`);
            continue;
          }
          const objectKeys = await storage.listPrefix(`backups/${backupId}/`);
          const hasObject = objectKeys.some((k) => k.endsWith('/dump.fc'));
          if (!hasObject) {
            this.logger.warn(`备份对象不完整，不登记 backupId=${backupId}`);
            continue;
          }
          await db.query(
            `INSERT INTO backstage.backups
               (id, task_uuid, task_type, status, backup_time, file_size, checksum,
                oss_object_key, oss_manifest_key, pg_version, started_at, finished_at, created_at)
             VALUES ($1, NULL, $2::backstage."BackupType", 'SUCCEEDED', $3, $4::bigint, $5,
                     $6, $7, $8, $3, $3, NOW())
             ON CONFLICT (id) DO NOTHING`,
            [
              backupId,
              manifest.taskType === 'EMERGENCY' ? 'EMERGENCY' : manifest.taskType === 'IMMEDIATE' ? 'IMMEDIATE' : 'SCHEDULED',
              new Date(manifest.backupTime ?? new Date().toISOString()).toISOString(),
              manifest.size,
              manifest.checksum,
              `backups/${backupId}/dump.fc`,
              `backups/${backupId}/manifest.json`,
              manifest.pgVersion ?? null,
            ],
          );
          this.logger.log(`幂等补回备份记录 backupId=${backupId}`);
        } catch (error) {
          this.logger.warn(
            `备份清单读取/校验失败，不登记 backupId=${backupId}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    } finally {
      await db.end();
    }
  }

  /** 清空平台专用 Redis 数据集（会话/限流/锁/作业全部失效） */
  private async stageClearRedis(): Promise<void> {
    if (this.dryRun || process.env.RECOVERY_SKIP_REDIS_FLUSH === '1') {
      return;
    }
    const { Redis } = await import('ioredis');
    const redis = new Redis(this.getDeps().redisUrl, { lazyConnect: true });
    try {
      await redis.connect();
      await redis.flushdb();
      this.logger.log('Redis 应用数据集已清空');
    } finally {
      redis.disconnect();
    }
  }

  /** 恢复后校验：数据库连接、迁移元数据、至少一名可用超管 */
  private async stageReadiness(): Promise<void> {
    const db = await this.openDb();
    try {
      // 迁移完整性：元数据表存在且有已应用记录（backstage PRD §10「迁移完整性、结构版本」）
      const migrations = await db.queryRows<{ n: string }>(
        `SELECT count(*)::text AS n FROM base._prisma_migrations WHERE finished_at IS NOT NULL`,
      );
      if (Number(migrations[0]?.n ?? 0) === 0) {
        throw new Error('迁移元数据缺失或无可应用记录，结构版本校验失败');
      }
      // 核心数据：权限目录已注册（各服务启动对账的前提）
      const functions = await db.queryRows<{ n: string }>(
        `SELECT count(*)::text AS n FROM backstage.function_registry`,
      );
      if (Number(functions[0]?.n ?? 0) === 0) {
        throw new Error('权限目录为空，核心数据校验失败');
      }
      const admins = await db.queryRows<{ n: string }>(
        `SELECT count(*)::text AS n FROM base.users
         WHERE is_super_admin = true AND status = 'ACTIVE' AND deleted_at IS NULL`,
      );
      if (Number(admins[0]?.n ?? 0) === 0) {
        throw new Error('恢复后不存在可用超级管理员，保持维护状态');
      }
      // 应运行服务就绪由部署编排（Nginx/容器健康检查）保证；执行器侧仅校验数据库侧事实
      this.logger.log('恢复后校验通过（迁移完整性 + 权限目录 + 超管存在）');
    } finally {
      await db.end();
    }
  }

  // ---- 基础设施 ----

  private getDeps(): RecoveryExecutorDeps {
    if (this.deps) {
      return this.deps;
    }
    const databaseUrl = process.env.DATABASE_URL?.trim();
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!databaseUrl || !redisUrl) {
      throw new Error('DATABASE_URL / REDIS_URL 未配置，恢复执行器无法工作');
    }
    return {
      databaseUrl,
      redisUrl,
      storage: {
        getObject: async (key) => {
          const { createFileStorage } = await import('@wbme/files');
          return createFileStorage().getObject(key);
        },
        listPrefix: async (prefix) => {
          const { createFileStorage } = await import('@wbme/files');
          return createFileStorage().listPrefix(prefix);
        },
      },
      migrateCmd: process.env.RECOVERY_MIGRATE_CMD,
    };
  }

  private async getStorage(): Promise<RecoveryExecutorDeps['storage']> {
    return this.getDeps().storage;
  }

  private async openDb(): Promise<{ queryRows: <T>(sql: string, params?: unknown[]) => Promise<T[]>; query: (sql: string, params?: unknown[]) => Promise<unknown>; end: () => Promise<void> }> {
    const { Client } = await import('pg');
    const client = new Client({ connectionString: this.getDeps().databaseUrl });
    await client.connect();
    return {
      queryRows: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        const result = await client.query(sql, params);
        return result.rows as T[];
      },
      query: async (sql: string, params?: unknown[]): Promise<unknown> => {
        const result = await client.query(sql, params);
        return result;
      },
      end: () => client.end(),
    };
  }

  private async loadBackupRow(): Promise<{ checksum: string | null; oss_object_key: string | null }> {
    const db = await this.openDb();
    try {
      const rows = await db.queryRows<{ checksum: string | null; oss_object_key: string | null }>(
        `SELECT checksum, oss_object_key FROM backstage.backups WHERE id = $1`,
        [this.manifest!.backupId],
      );
      const row = rows[0];
      if (!row?.oss_object_key) {
        throw new Error(`备份对象键缺失 backupId=${this.manifest!.backupId}`);
      }
      return row;
    } finally {
      await db.end();
    }
  }

  /** pg_restore --list 归档完整性校验（pg 工具路径可经环境变量注入） */
  private async pgRestoreList(dumpPath: string): Promise<void> {
    const restore = this.pgRestorePath();
    await execFileAsync(restore, ['--list', dumpPath], { env: process.env });
  }

  private pgRestorePath(): string {
    return process.env.PG_RESTORE_PATH ?? 'pg_restore';
  }

  /** 镜像同步 backstage.restores（尽力而为：恢复中数据库可能被覆盖） */
  private async syncRestoreRow(data: { status: string; stage: RestoreStage | null; error?: string }): Promise<void> {
    const db = await this.openDb();
    try {
      await db.query(
        `UPDATE backstage.restores
         SET status = $2::backstage."RestoreStatus", stage = $3, error = $4, finished_at = NOW()
         WHERE restore_uuid = $1`,
        [this.manifest!.restoreUuid, data.status, data.stage, data.error ?? null],
      );
    } finally {
      await db.end();
    }
  }

  private async ensureStateDir(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
  }

  private manifestPath(): string {
    return join(this.stateDir, 'control-manifest.json');
  }

  private maintenancePath(): string {
    return join(this.stateDir, 'maintenance.marker');
  }

  private async writeManifest(): Promise<void> {
    if (!this.manifest) {
      return;
    }
    // 原子替换：先写临时文件再 rename，避免半写状态（PRD §10 恢复控制状态独立性）
    const tmp = `${this.manifestPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.manifest, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.manifestPath());
  }

  private async loadManifest(): Promise<void> {
    this.manifest = await this.loadManifestIfExists();
  }

  /** 读取既有清单（不存在/损坏 → null；不写入实例状态） */
  private async loadManifestIfExists(): Promise<RestoreControlManifest | null> {
    try {
      const raw = await readFile(this.manifestPath(), 'utf8');
      return JSON.parse(raw) as RestoreControlManifest;
    } catch {
      return null;
    }
  }

  private async isMaintenanceMode(): Promise<boolean> {
    try {
      await readFile(this.maintenancePath(), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  private async setMaintenanceMarker(enabled: boolean): Promise<void> {
    await this.ensureStateDir();
    const path = this.maintenancePath();
    if (enabled) {
      await writeFile(path, new Date().toISOString(), 'utf8');
    } else {
      await rm(path, { force: true });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { RECOVERY_COOKIE_NAME };
