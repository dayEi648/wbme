import { BULLMQ_RETENTION, TASK_MAX_ATTEMPTS } from '@wbme/tasks';

/** BullMQ 默认任务选项（保留策略 + 重试，主 PRD §9.1） */
export const DEFAULT_JOB_OPTIONS = {
  attempts: TASK_MAX_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: BULLMQ_RETENTION.removeOnComplete,
  removeOnFail: BULLMQ_RETENTION.removeOnFail,
};
