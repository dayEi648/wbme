import { Queue } from 'bullmq';
import {
  beijingDateString,
  claimOutboxBatch,
  insertPendingTaskSql,
  isPastScheduledBackupBoundary,
  markQueued,
  OUTBOX_SCHEDULER_INTERVAL_MS,
  releaseEnqueueLease,
  SAFELY_REPLAYABLE_TASK_TYPES,
  stableTaskUuid,
  TASK_TYPE_SCHEDULED_BACKUP,
  TASK_QUEUE_NAME,
  type SqlClient,
} from '@wbme/tasks';
import { REDIS_NAMESPACE } from '@wbme/server';
import { DEFAULT_JOB_OPTIONS } from './job-options';

/** 每日备份调度内存状态（进程内，重启后靠 stable uuid 去重） */
let lastScheduledBackupCycleDate: string | null = null;

/**
 * 若已过北京时间 02:00 且当日尚无定时备份任务，则创建 PENDING_ENQUEUE。
 *
 * @param sql SQL 客户端
 * @param now 当前时间
 */
export async function ensureDailyScheduledBackup(sql: SqlClient, now: Date = new Date()): Promise<void> {
  if (!isPastScheduledBackupBoundary(now)) {
    return;
  }
  const cycleDate = beijingDateString(now);
  if (lastScheduledBackupCycleDate === cycleDate) {
    return;
  }
  const taskUuid = stableTaskUuid(`${TASK_TYPE_SCHEDULED_BACKUP}:${cycleDate}`);
  const result = await insertPendingTaskSql(sql, {
    taskUuid,
    taskType: TASK_TYPE_SCHEDULED_BACKUP,
    module: 'backstage',
    initiatorType: 'SCHEDULER',
    ref: { cycleDate },
  }, now);
  if (result.created) {
    console.log(`[scheduler] 已创建当日定时备份任务 cycleDate=${cycleDate} uuid=${taskUuid}`);
  }
  lastScheduledBackupCycleDate = cycleDate;
}

/**
 * Outbox 调度器：领取待投递任务并写入 BullMQ。
 */
export class OutboxScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly sql: SqlClient,
    private readonly queue: Queue,
    private readonly schedulerId: string,
  ) {}

  /**
   * 启动调度循环。
   */
  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, OUTBOX_SCHEDULER_INTERVAL_MS);
    void this.tick();
  }

  /**
   * 停止调度循环。
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 单次调度 tick。
   */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = new Date();
      await ensureDailyScheduledBackup(this.sql, now);
      const batch = await claimOutboxBatch(
        this.sql,
        this.schedulerId,
        SAFELY_REPLAYABLE_TASK_TYPES,
        now,
      );
      for (const row of batch) {
        try {
          await this.queue.add(
            row.taskType,
            { taskUuid: row.taskUuid },
            {
              jobId: row.taskUuid,
              ...DEFAULT_JOB_OPTIONS,
            },
          );
          const queued = await markQueued(this.sql, row.taskUuid, this.schedulerId);
          if (!queued) {
            console.warn(`[outbox] markQueued 未匹配 taskUuid=${row.taskUuid}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[outbox] 投递失败 taskUuid=${row.taskUuid}: ${message}`);
          await releaseEnqueueLease(this.sql, row.taskUuid, this.schedulerId, 0, message, now);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/**
 * 创建 BullMQ 队列实例。
 *
 * @param redisUrl Redis 连接 URL
 * @returns Queue
 */
export function createTaskQueue(redisUrl: string): Queue {
  return new Queue(TASK_QUEUE_NAME, {
    connection: { url: redisUrl },
    prefix: REDIS_NAMESPACE.QUEUE,
  });
}
