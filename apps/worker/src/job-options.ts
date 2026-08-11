import { BULLMQ_RETENTION, TASK_MAX_ATTEMPTS } from '@wbme/tasks';

/** BullMQ 默认任务选项（保留策略 + 重试，主 PRD §9.1） */
export const DEFAULT_JOB_OPTIONS = {
  attempts: TASK_MAX_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: BULLMQ_RETENTION.removeOnComplete,
  removeOnFail: BULLMQ_RETENTION.removeOnFail,
};

/**
 * 恢复投递专用选项：有限重试（attempts=3 + 指数退避，批次8复核修复）。
 *
 * 依据主 PRD §9.1「数据库恢复在写入外部控制清单前可以按上述投递规则重新交付」：
 * recovery-executor 的 acceptDelivery 对同一 restoreUuid 幂等（清单已存在且未完成时
 * 忽略重投、已完成 DONE 时幂等忽略），重投安全；一次性失败即终态（attempts:1）会让
 * 瞬态网络错误直接假死任务行。不违背 backstage PRD §10「恢复任务不自动重试」——
 * 后者指清单写入后的执行阶段不重放破坏性管道（由执行器清单状态机保证），而非投递环节。
 */
export const RESTORE_DELIVERY_JOB_OPTIONS = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 3,
};
