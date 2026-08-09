/**
 * 统一后台任务类型与写入契约（主 PRD §9.1）。
 */

import type { TaskType } from './constants';

export type TaskStatus =
  | 'PENDING_ENQUEUE'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export type TaskInitiatorType = 'USER' | 'SCHEDULER';

/** 账号生命周期任务 ref 负载 */
export interface AccountLifecycleTaskRef {
  event: 'DEACTIVATED';
  userId: number;
  deactivatedAt: string;
  lifecycleVersion: number;
}

/** 定时备份任务 ref */
export interface ScheduledBackupTaskRef {
  /** 北京时间周期日 YYYY-MM-DD */
  cycleDate: string;
}

/** 立即备份任务 ref */
export interface ImmediateBackupTaskRef {
  /** 触发来源（如 migration-runner / user-admin） */
  trigger?: string;
  /** 关联备份记录 id */
  backupId?: number;
}

/** 恢复投递任务 ref */
export interface RestoreDeliveryTaskRef {
  /** 恢复业务 UUID */
  restoreUuid: string;
  /** 关联备份 id */
  backupId: number;
  /** 关联 restores 表 id（可选） */
  restoreId?: number;
  /** 稳定恢复请求 ID（可选） */
  restoreRequestId?: string;
}

/** 未关联图片清理任务 ref */
export interface UnassociatedImageCleanupTaskRef {
  /** 可选扫描批次标识 */
  batchId?: string;
}

/** 审批超时扫描任务 ref */
export interface ApprovalTimeoutScanTaskRef {
  /** 扫描窗口起点（ISO 8601） */
  scanFrom?: string;
}

/** 各任务类型 ref 映射 */
export interface TaskRefByType {
  ACCOUNT_LIFECYCLE: AccountLifecycleTaskRef;
  SCHEDULED_BACKUP: ScheduledBackupTaskRef;
  IMMEDIATE_BACKUP: ImmediateBackupTaskRef;
  RESTORE_DELIVERY: RestoreDeliveryTaskRef;
  UNASSOCIATED_IMAGE_CLEANUP: UnassociatedImageCleanupTaskRef;
  APPROVAL_TIMEOUT_SCAN: ApprovalTimeoutScanTaskRef;
}

export type TaskRef = TaskRefByType[keyof TaskRefByType];

/** 创建 PENDING_ENQUEUE 任务输入 */
export interface CreatePendingTaskInput {
  taskUuid: string;
  taskType: TaskType;
  module: string;
  initiatorId?: number | null;
  initiatorType: TaskInitiatorType;
  ref?: TaskRef | null;
}

/** 任务表行只读视图（Worker 消费） */
export interface BackgroundTaskRow {
  taskUuid: string;
  taskType: TaskType;
  module: string;
  initiatorId: number | null;
  initiatorType: TaskInitiatorType;
  ref: TaskRef | null;
  status: TaskStatus;
  progress: number;
  attempts: number;
}

/** 受限创建接口：各部署单元在事务内注入 Prisma 或等价实现 */
export interface TaskWriter {
  /**
   * 写入 PENDING_ENQUEUE 行（稳定 task_uuid 去重）。
   *
   * @param input 任务创建参数
   * @returns taskUuid 与是否新建
   */
  createPending(input: CreatePendingTaskInput): Promise<{ taskUuid: string; created: boolean }>;
}
