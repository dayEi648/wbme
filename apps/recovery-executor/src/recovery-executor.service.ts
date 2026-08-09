import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { RestoreDeliveryTaskRef } from '@wbme/tasks';

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

/** 外部控制清单 */
export interface RestoreControlManifest {
  restoreUuid: string;
  backupId: number;
  stage: RestoreStage;
  updatedAt: string;
  error?: string;
}

const DEFAULT_STATE_DIR = '.agents/restore-state';
const RECOVERY_COOKIE_NAME = 'wbme_recovery_session';

/**
 * 恢复执行状态机（MVP：支持 RESTORE_DRY_RUN 模拟）。
 */
@Injectable()
export class RecoveryExecutorService {
  private readonly logger = new Logger(RecoveryExecutorService.name);
  private readonly stateDir: string;
  private readonly dryRun: boolean;
  private manifest: RestoreControlManifest | null = null;

  constructor() {
    this.stateDir = process.env.RESTORE_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
    this.dryRun = process.env.RESTORE_DRY_RUN === '1';
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
   * 接收 RESTORE_DELIVERY：写入外部清单并进入维护模式。
   *
   * @param ref 任务 ref
   */
  async acceptDelivery(ref: RestoreDeliveryTaskRef): Promise<void> {
    await this.ensureStateDir();
    this.manifest = {
      restoreUuid: ref.restoreUuid,
      backupId: ref.backupId,
      stage: 'PRECHECK',
      updatedAt: new Date().toISOString(),
    };
    await this.writeManifest();
    await this.setMaintenanceMarker(true);
    void this.runPipeline();
  }

  /** 重试当前阶段 */
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
      return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  private async runPipeline(): Promise<void> {
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
      for (const stage of stages) {
        if (this.manifest.stage === 'DONE') {
          break;
        }
        this.manifest.stage = stage;
        this.manifest.updatedAt = new Date().toISOString();
        await this.writeManifest();
        this.logger.log(`恢复阶段 ${stage}${this.dryRun ? ' (dry-run)' : ''}`);
        if (!this.dryRun && stage === 'RESTORING') {
          // TODO(T4-8 生产): pg_restore 实际执行
        }
        await this.sleep(this.dryRun ? 50 : 200);
      }
      this.manifest.stage = 'DONE';
      this.manifest.updatedAt = new Date().toISOString();
      await this.writeManifest();
      await this.setMaintenanceMarker(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.manifest) {
        this.manifest.error = message;
        await this.writeManifest();
      }
      this.logger.error(`恢复失败: ${message}`);
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
    await writeFile(this.manifestPath(), JSON.stringify(this.manifest, null, 2), 'utf8');
  }

  private async loadManifest(): Promise<void> {
    try {
      const raw = await readFile(this.manifestPath(), 'utf8');
      this.manifest = JSON.parse(raw) as RestoreControlManifest;
    } catch {
      this.manifest = null;
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
