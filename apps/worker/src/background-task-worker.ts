import { Worker, type Job } from 'bullmq';
import {
  bucketStart,
  computeErrorFingerprint,
  upsertErrorLog,
  type RawSqlClient,
} from '@wbme/logging';
import {
  claimRunning,
  isTerminalTaskStatus,
  loadTaskByUuid,
  markFailed,
  markSucceeded,
  TASK_MAX_ATTEMPTS,
  TASK_QUEUE_NAME,
  type BackgroundTaskRow,
  type SqlClient,
  type TaskType,
} from '@wbme/tasks';
import { REDIS_NAMESPACE } from '@wbme/server';
import { getTaskProcessor } from './processors';

import type { ProcessorContext } from './processors/types';

/** BullMQ Worker 封装 */
export class BackgroundTaskWorker {
  private worker: Worker | null = null;

  constructor(
    private readonly redisUrl: string,
    private readonly sql: SqlClient,
    private readonly rawSql: RawSqlClient,
    private readonly leaseOwner: string,
    private readonly deployCommit: string,
  ) {}

  /**
   * 启动 BullMQ Worker。
   */
  start(): void {
    this.worker = new Worker(
      TASK_QUEUE_NAME,
      async (job: Job<{ taskUuid: string }>) => this.handleJob(job),
      {
        connection: { url: this.redisUrl },
        prefix: REDIS_NAMESPACE.QUEUE,
        concurrency: 2,
      },
    );
    this.worker.on('failed', (job, error) => {
      if (!job) {
        return;
      }
      const attempts = job.opts.attempts ?? TASK_MAX_ATTEMPTS;
      if (job.attemptsMade >= attempts) {
        console.error(`[worker] 任务最终失败 jobId=${job.id}: ${error.message}`);
      }
    });
  }

  /**
   * 关闭 Worker。
   */
  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }

  private async handleJob(job: Job<{ taskUuid: string }>): Promise<void> {
    const taskUuid = job.data.taskUuid ?? job.id;
    if (!taskUuid) {
      throw new Error('任务缺少 taskUuid');
    }

    const task = await loadTaskByUuid(this.sql, taskUuid);
    if (!task) {
      console.warn(`[worker] 任务不存在 taskUuid=${taskUuid}，跳过`);
      return;
    }
    if (isTerminalTaskStatus(task.status)) {
      return;
    }

    const claimed = await claimRunning(this.sql, taskUuid, this.leaseOwner);
    if (!claimed) {
      console.warn(`[worker] 未能领取执行租约 taskUuid=${taskUuid}`);
      return;
    }

    const ctx: ProcessorContext = {
      sql: this.sql,
      leaseOwner: this.leaseOwner,
      deployCommit: this.deployCommit,
    };

    try {
      const processor = getTaskProcessor(task.taskType as TaskType);
      await processor(task as BackgroundTaskRow, ctx);
      const ok = await markSucceeded(this.sql, taskUuid, this.leaseOwner);
      if (!ok) {
        console.warn(`[worker] markSucceeded 未匹配 taskUuid=${taskUuid}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = job.opts.attempts ?? TASK_MAX_ATTEMPTS;
      const isFinal = job.attemptsMade + 1 >= attempts;
      if (isFinal) {
        await markFailed(this.sql, taskUuid, this.leaseOwner, message);
        await this.recordTaskError(task.taskType as TaskType, message);
      }
      throw error;
    }
  }

  private async recordTaskError(taskType: TaskType, sample: string): Promise<void> {
    const now = new Date();
    const fingerprint = computeErrorFingerprint({
      service: '@wbme/worker',
      deployCommit: this.deployCommit,
      errorCategory: 'BACKGROUND_TASK',
      entryPoint: `BACKGROUND_TASK:${taskType}`,
      stackLocation: taskType,
    });
    const ok = await upsertErrorLog(this.rawSql, {
      level: 'ERROR',
      service: '@wbme/worker',
      source: `BACKGROUND_TASK:${taskType}`,
      errorCategory: 'BACKGROUND_TASK',
      deployCommit: this.deployCommit,
      fingerprint,
      bucketStart: bucketStart(now),
      occurredAt: now,
      requestId: null,
      sample,
    });
    if (!ok) {
      console.error(`[worker] 错误日志写入失败 taskType=${taskType}`);
    }
  }
}
