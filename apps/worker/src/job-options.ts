import { BULLMQ_RETENTION, TASK_MAX_ATTEMPTS } from '@wbme/tasks';

/** BullMQ 默认任务选项（保留策略 + 重试，主 PRD §9.1） */
export const DEFAULT_JOB_OPTIONS = {
  attempts: TASK_MAX_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: BULLMQ_RETENTION.removeOnComplete,
  removeOnFail: BULLMQ_RETENTION.removeOnFail,
};

/**
 * 恢复投递专用选项：不自动重试（backstage PRD §10「恢复任务不自动重试」）。
 * 投递响应丢失时 BullMQ 重投会让执行器重复接受同一清单（即便已幂等化，
 * 也避免对同一数据库重复启动破坏性管道）；失败由人工核查后重新发起。
 */
export const RESTORE_DELIVERY_JOB_OPTIONS = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 1,
};
