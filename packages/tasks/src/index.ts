/**
 * @wbme/tasks 包入口
 * 统一后台任务事实表（backstage schema）的受限创建与状态条件更新接口
 * （主 PRD §9.1，T4-2 Outbox + Worker）。
 */

export {
  TASK_TYPE_ACCOUNT_LIFECYCLE,
  TASK_TYPE_SCHEDULED_BACKUP,
  TASK_TYPE_IMMEDIATE_BACKUP,
  TASK_TYPE_RESTORE_DELIVERY,
  TASK_TYPE_UNASSOCIATED_IMAGE_CLEANUP,
  TASK_TYPE_APPROVAL_TIMEOUT_SCAN,
  TASK_TYPES,
  TASK_QUEUE_NAME,
  BULLMQ_RETENTION,
  TASK_ENQUEUE_LEASE_SECONDS,
  TASK_RUNNING_LEASE_SECONDS,
  TASK_MAX_ATTEMPTS,
  TASK_ENQUEUE_BACKOFF_BASE_SECONDS,
  TASK_ENQUEUE_BATCH_SIZE,
  OUTBOX_SCHEDULER_INTERVAL_MS,
  QUEUE_MAINTENANCE_INTERVAL_MS,
  SAFELY_REPLAYABLE_TASK_TYPES,
  type TaskType,
} from './constants';

export type {
  TaskStatus,
  TaskInitiatorType,
  AccountLifecycleTaskRef,
  ScheduledBackupTaskRef,
  ImmediateBackupTaskRef,
  RestoreDeliveryTaskRef,
  UnassociatedImageCleanupTaskRef,
  ApprovalTimeoutScanTaskRef,
  TaskRefByType,
  TaskRef,
  CreatePendingTaskInput,
  BackgroundTaskRow,
  TaskWriter,
} from './types';

export { stableTaskUuid } from './stable-task-uuid';

export type { SqlClient } from './sql-client';

export { prismaTaskWriter, createPendingTask } from './task-writer';

export {
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
  computeEnqueueBackoffSeconds,
  loadTaskByUuid,
  markQueued,
  claimRunning,
  markSucceeded,
  markFailed,
  markCancelled,
  releaseEnqueueLease,
} from './status-transitions';

export { claimOutboxBatch, insertPendingTaskSql, type OutboxClaimRow } from './outbox';

export {
  PLATFORM_TIMEZONE,
  beijingDateString,
  beijingHour,
  isPastScheduledBackupBoundary,
} from './beijing-time';
