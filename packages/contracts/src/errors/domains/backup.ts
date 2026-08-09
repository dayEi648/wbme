import type { ErrorEntry } from '../types';

/** BACKUP 域错误目录：数据备份与恢复（backstage PRD §10） */
export const backupErrors = {
  /** 备份/恢复互斥：同一时刻仅允许一个备份恢复锁占用 */
  BACKUP_LOCK_BUSY: {
    code: 'BACKUP_LOCK_BUSY',
    type: 'CONFLICT',
    domain: 'BACKUP',
    httpStatus: 409,
    message: '已有备份或恢复任务执行中，请稍后再试',
  },
  /** 存在未完成恢复清单时拒绝新的备份请求 */
  RESTORE_IN_PROGRESS: {
    code: 'RESTORE_IN_PROGRESS',
    type: 'CONFLICT',
    domain: 'BACKUP',
    httpStatus: 409,
    message: '恢复流程处理中，已拒绝新的备份请求',
  },
  /** 整库恢复仅超级管理员可执行（backstage PRD §10） */
  RESTORE_SUPER_ADMIN_ONLY: {
    code: 'RESTORE_SUPER_ADMIN_ONLY',
    type: 'AUTHORIZATION',
    domain: 'BACKUP',
    httpStatus: 403,
    message: '整库恢复仅超级管理员可执行',
  },
  /** 备份文件校验失败（校验和/格式/版本兼容性） */
  BACKUP_UNVERIFIED: {
    code: 'BACKUP_UNVERIFIED',
    type: 'BUSINESS',
    domain: 'BACKUP',
    httpStatus: 422,
    message: '备份文件校验失败，不允许使用',
  },
  /** 恢复前紧急备份失败：须向操作人明确风险并经人工确认后方可继续（backstage PRD §10） */
  EMERGENCY_BACKUP_FAILED: {
    code: 'EMERGENCY_BACKUP_FAILED',
    type: 'BUSINESS',
    domain: 'BACKUP',
    httpStatus: 422,
    message: '恢复前紧急备份失败，继续恢复将没有回退副本，请确认风险后重试',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
