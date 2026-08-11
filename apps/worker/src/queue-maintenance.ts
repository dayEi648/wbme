import type { Queue } from 'bullmq';
import {
  bucketStart,
  computeErrorFingerprint,
  upsertErrorLog,
  type RawSqlClient,
} from '@wbme/logging';
import { BULLMQ_RETENTION, QUEUE_MAINTENANCE_INTERVAL_MS } from '@wbme/tasks';

/** 队列维护错误日志 source/errorCategory */
const QUEUE_MAINTENANCE_SOURCE = 'QUEUE_MAINTENANCE';

/**
 * BullMQ 队列惰性清理（主 PRD §9.1 启动与每小时维护）。
 *
 * 清理失败时写入集中系统日志（§9.1「清理失败记录系统日志」），便于健康页与
 * 审计定位；写入本身 fire-and-forget，不阻塞下一轮清理周期。
 */
export class QueueMaintenance {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly queue: Queue,
    private readonly rawSql: RawSqlClient,
    private readonly deployCommit: string,
  ) {}

  /**
   * 立即执行一次清理并启动定时维护。
   */
  start(): void {
    void this.clean();
    this.timer = setInterval(() => {
      void this.clean();
    }, QUEUE_MAINTENANCE_INTERVAL_MS);
  }

  /**
   * 停止定时维护。
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 按 PRD 保留策略清理 completed/failed 作业。
   */
  async clean(): Promise<void> {
    try {
      await this.queue.clean(BULLMQ_RETENTION.removeOnComplete.age * 1_000, 1_000, 'completed');
      await this.queue.clean(BULLMQ_RETENTION.removeOnFail.age * 1_000, 5_000, 'failed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[queue-maintenance] 清理失败: ${message}`);
      // 写入集中系统日志（主 PRD §9.1）；fire-and-forget，失败不抛错
      void this.recordFailure(message);
    }
  }

  private async recordFailure(message: string): Promise<void> {
    const now = new Date();
    const fingerprint = computeErrorFingerprint({
      service: '@wbme/worker',
      deployCommit: this.deployCommit,
      errorCategory: QUEUE_MAINTENANCE_SOURCE,
      entryPoint: QUEUE_MAINTENANCE_SOURCE,
      stackLocation: QUEUE_MAINTENANCE_SOURCE,
    });
    const ok = await upsertErrorLog(this.rawSql, {
      level: 'ERROR',
      service: '@wbme/worker',
      source: QUEUE_MAINTENANCE_SOURCE,
      errorCategory: QUEUE_MAINTENANCE_SOURCE,
      deployCommit: this.deployCommit,
      fingerprint,
      bucketStart: bucketStart(now),
      occurredAt: now,
      requestId: null,
      sample: message,
    });
    if (!ok) {
      console.error(`[queue-maintenance] 系统日志写入失败（stderr 兜底）: ${message}`);
    }
  }
}
