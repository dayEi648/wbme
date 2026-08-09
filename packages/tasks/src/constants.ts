/**
 * 统一后台任务常量（主 PRD §9.1）。
 */

/** 任务类型：账号生命周期处理 */
export const TASK_TYPE_ACCOUNT_LIFECYCLE = 'ACCOUNT_LIFECYCLE';

/** 任务类型：每日定时数据库备份 */
export const TASK_TYPE_SCHEDULED_BACKUP = 'SCHEDULED_BACKUP';

/** 任务类型：用户发起立即备份（含保留清理） */
export const TASK_TYPE_IMMEDIATE_BACKUP = 'IMMEDIATE_BACKUP';

/** 任务类型：恢复请求投递至 recovery-executor */
export const TASK_TYPE_RESTORE_DELIVERY = 'RESTORE_DELIVERY';

/** 任务类型：恢复前紧急备份（整库恢复自动创建的回退副本，backstage PRD §10） */
export const TASK_TYPE_EMERGENCY_BACKUP = 'EMERGENCY_BACKUP';

/** 任务类型：未关联业务图片清理 */
export const TASK_TYPE_UNASSOCIATED_IMAGE_CLEANUP = 'UNASSOCIATED_IMAGE_CLEANUP';

/** 任务类型：待审批超时自动取消扫描 */
export const TASK_TYPE_APPROVAL_TIMEOUT_SCAN = 'APPROVAL_TIMEOUT_SCAN';

/** 封闭任务类型集合 */
export const TASK_TYPES = [
  TASK_TYPE_ACCOUNT_LIFECYCLE,
  TASK_TYPE_SCHEDULED_BACKUP,
  TASK_TYPE_IMMEDIATE_BACKUP,
  TASK_TYPE_RESTORE_DELIVERY,
  TASK_TYPE_EMERGENCY_BACKUP,
  TASK_TYPE_UNASSOCIATED_IMAGE_CLEANUP,
  TASK_TYPE_APPROVAL_TIMEOUT_SCAN,
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** BullMQ 队列名（与 {@link REDIS_NAMESPACE.QUEUE} 组合为 Redis 键前缀） */
export const TASK_QUEUE_NAME = 'wbme-background';

/** BullMQ 成功/失败记录保留策略（主 PRD §9.1 固定基础设施常量） */
export const BULLMQ_RETENTION = {
  removeOnComplete: { age: 604_800, count: 1_000 },
  removeOnFail: { age: 2_592_000, count: 5_000 },
} as const;

/** Outbox 调度循环领取投递租约时长（秒） */
export const TASK_ENQUEUE_LEASE_SECONDS = 120;

/** Worker 执行租约时长（秒） */
export const TASK_RUNNING_LEASE_SECONDS = 600;

/** BullMQ / 任务最大尝试次数 */
export const TASK_MAX_ATTEMPTS = 10;

/** 投递失败退避基数（秒） */
export const TASK_ENQUEUE_BACKOFF_BASE_SECONDS = 30;

/** Outbox 每批领取上限 */
export const TASK_ENQUEUE_BATCH_SIZE = 50;

/** Outbox 调度间隔（毫秒） */
export const OUTBOX_SCHEDULER_INTERVAL_MS = 2_000;

/** 队列惰性清理间隔（毫秒，主 PRD §9.1 启动与每小时） */
export const QUEUE_MAINTENANCE_INTERVAL_MS = 3_600_000;

/**
 * 执行租约过期后可安全重放的任务类型（主 PRD §9.1）。
 * RESTORE_DELIVERY 不在其中：recovery-executor 写入外部控制清单后重复投递
 * 会重置清单并重跑恢复管道（主 PRD §9.1「数据库恢复在写入外部控制清单后
 * 不再由通用任务扫描器重放」），故其租约过期按失败处理、由人工介入。
 */
export const SAFELY_REPLAYABLE_TASK_TYPES: readonly TaskType[] = [
  TASK_TYPE_ACCOUNT_LIFECYCLE,
  TASK_TYPE_SCHEDULED_BACKUP,
  TASK_TYPE_IMMEDIATE_BACKUP,
  TASK_TYPE_EMERGENCY_BACKUP,
  TASK_TYPE_UNASSOCIATED_IMAGE_CLEANUP,
  TASK_TYPE_APPROVAL_TIMEOUT_SCAN,
];
