import {
  TASK_TYPE_ACCOUNT_LIFECYCLE,
  TASK_TYPE_APPROVAL_TIMEOUT_SCAN,
  TASK_TYPE_EMERGENCY_BACKUP,
  TASK_TYPE_IMMEDIATE_BACKUP,
  TASK_TYPE_RESTORE_DELIVERY,
  TASK_TYPE_SCHEDULED_BACKUP,
  TASK_TYPE_UNASSOCIATED_IMAGE_CLEANUP,
  type TaskType,
} from '@wbme/tasks';
import { processAccountLifecycle } from './account-lifecycle.processor';
import { processApprovalTimeoutScan } from './approval-timeout.processor';
import { processBackupTask } from './backup-task.processor';
import { processImageCleanup } from './image-cleanup.processor';
import { processRestoreDelivery } from './restore-delivery.processor';
import type { TaskProcessor } from './types';

/** 任务类型 → 处理器映射 */
export const TASK_PROCESSORS: Record<TaskType, TaskProcessor> = {
  [TASK_TYPE_ACCOUNT_LIFECYCLE]: processAccountLifecycle,
  [TASK_TYPE_SCHEDULED_BACKUP]: processBackupTask,
  [TASK_TYPE_IMMEDIATE_BACKUP]: processBackupTask,
  [TASK_TYPE_RESTORE_DELIVERY]: processRestoreDelivery,
  [TASK_TYPE_EMERGENCY_BACKUP]: processBackupTask,
  [TASK_TYPE_UNASSOCIATED_IMAGE_CLEANUP]: processImageCleanup,
  [TASK_TYPE_APPROVAL_TIMEOUT_SCAN]: processApprovalTimeoutScan,
};

/**
 * 按任务类型分发处理器。
 *
 * @param taskType 任务类型
 * @returns 处理器函数
 * @throws 未知任务类型
 */
export function getTaskProcessor(taskType: TaskType): TaskProcessor {
  const processor = TASK_PROCESSORS[taskType];
  if (!processor) {
    throw new Error(`未知后台任务类型：${taskType}`);
  }
  return processor;
}
