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
  renewRunningLease,
  TASK_MAX_ATTEMPTS,
  TASK_QUEUE_NAME,
  TASK_RUNNING_LEASE_SECONDS,
  type BackgroundTaskRow,
  type SqlClient,
  type TaskType,
} from '@wbme/tasks';
import { REDIS_NAMESPACE } from '@wbme/server';
import { getTaskProcessor } from './processors';

import type { ProcessorContext } from './processors/types';

/**
 * 执行租约暂不可领（旧租约未过期/状态竞态）。
 * 与「真执行失败」区分：不标记任务 FAILED、不写集中错误日志——任务行仍归旧租约持有者，
 * 由 BullMQ 按 attempts+退避重试（撑到租约过期后领取成功），或由调度器租约重领后重新投递。
 */
export class LeaseNotClaimableError extends Error {}

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
        // 串行消费（主 PRD §9.1「单实例 Worker 逐条消费，天然串行」）：
        // 备份/恢复类任务必须同一时刻只有一个 pg_dump/pg_restore（backstage PRD §10）
        concurrency: 1,
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
      // 租约暂不可领（典型：Worker 崩溃后 BullMQ stalled 重跑，旧执行租约尚未过期）。
      // 不得 return 假完成——BullMQ 侧假 completed 的残留 job 会架空调度器租约重领后的
      // 重投链路（同 jobId 去重静默丢弃），任务行空转到 timeout_at 被误标 FAILED。
      // 改为抛出：BullMQ 按 attempts+退避重试，撑到租约过期后领取成功。
      console.warn(`[worker] 执行租约暂不可领取 taskUuid=${taskUuid}，交由 BullMQ 重试/调度器租约重领`);
      throw new LeaseNotClaimableError(`执行租约暂不可领取 taskUuid=${taskUuid}`);
    }

    // 租约续期心跳（问题13 修复）：长任务（如大库备份 >10 分钟）执行期间定期续期，
    // 防止 lease_expires_at 过期被 claimOutboxBatch 重领导致同一任务被重复执行。
    // 续期间隔为租约时长的一半，Node 单线程下 await execFileAsync 期间能正常触发。
    const leaseRenewer = setInterval(() => {
      void renewRunningLease(this.sql, taskUuid, this.leaseOwner).catch(() => undefined);
    }, Math.floor(TASK_RUNNING_LEASE_SECONDS / 2) * 1_000);
    leaseRenewer.unref?.();

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
        await this.recordTaskError(task as BackgroundTaskRow, message);
      }
      throw error;
    } finally {
      clearInterval(leaseRenewer);
    }
  }

  /**
   * 记录任务最终失败到集中错误日志（主 PRD §9.1 第 254 行）。
   *
   * 归属与可定位性（问题3 修复）：
   * - service 字段 = 任务所属模块（backstage/asset/hr），健康页可按模块筛选/跳转日志；
   * - source 固定为 `BACKGROUND_TASK:<任务类型>`（PRD 原文口径，不含模块）；
   * - requestId 写入 taskUuid，sample 前缀同 taskUuid，便于定位具体任务行；
   * - entryPoint/fingerprint 输入含模块，保证同类型不同模块的失败聚合独立。
   */
  private async recordTaskError(task: BackgroundTaskRow, sample: string): Promise<void> {
    const now = new Date();
    const module = task.module;
    const taskType = task.taskType as TaskType;
    const source = `BACKGROUND_TASK:${taskType}`;
    const fingerprint = computeErrorFingerprint({
      service: module,
      deployCommit: this.deployCommit,
      errorCategory: 'BACKGROUND_TASK',
      entryPoint: source,
      stackLocation: `${module}:${taskType}`,
    });
    const ok = await upsertErrorLog(this.rawSql, {
      level: 'ERROR',
      service: module,
      source,
      errorCategory: 'BACKGROUND_TASK',
      deployCommit: this.deployCommit,
      fingerprint,
      bucketStart: bucketStart(now),
      occurredAt: now,
      requestId: task.taskUuid,
      sample: `[taskUuid=${task.taskUuid}] ${sample}`,
    });
    if (!ok) {
      console.error(
        `[worker] 错误日志写入失败 module=${module} taskType=${taskType} taskUuid=${task.taskUuid}`,
      );
    }
  }
}
