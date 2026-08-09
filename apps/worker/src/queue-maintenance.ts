import type { Queue } from 'bullmq';
import { BULLMQ_RETENTION, QUEUE_MAINTENANCE_INTERVAL_MS } from '@wbme/tasks';

/**
 * BullMQ 队列惰性清理（主 PRD §9.1 启动与每小时维护）。
 */
export class QueueMaintenance {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly queue: Queue) {}

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
    }
  }
}
