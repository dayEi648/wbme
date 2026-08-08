import type { ErrorEntry } from '../types';

/** ASSET 域错误目录：固定资产台账与维修（asset PRD §4） */
export const assetErrors = {
  /** 资产当前状态不允许该操作（状态机规则） */
  ASSET_STATUS_INVALID: {
    code: 'ASSET_STATUS_INVALID',
    type: 'BUSINESS',
    domain: 'ASSET',
    httpStatus: 422,
    message: '资产当前状态不允许该操作',
  },
  /** 同一资产同一时刻最多一张进行中维修单（asset PRD §4 条件唯一索引） */
  MAINTENANCE_ACTIVE_EXISTS: {
    code: 'MAINTENANCE_ACTIVE_EXISTS',
    type: 'CONFLICT',
    domain: 'ASSET',
    httpStatus: 409,
    message: '同一资产存在进行中的维修单',
  },
  /** 仍在使用或有业务关联的资产不允许删除（asset PRD §4） */
  ASSET_REFERENCED: {
    code: 'ASSET_REFERENCED',
    type: 'BUSINESS',
    domain: 'ASSET',
    httpStatus: 422,
    message: '资产仍在使用或有业务关联，不允许删除',
  },
  /** 调度目标责任人必须属于目标部门（asset PRD §4） */
  ASSIGNEE_DEPARTMENT_MISMATCH: {
    code: 'ASSIGNEE_DEPARTMENT_MISMATCH',
    type: 'BUSINESS',
    domain: 'ASSET',
    httpStatus: 422,
    message: '责任人必须属于目标所属部门',
  },
  /** 二维码无效、停用或作废（asset PRD §11） */
  QR_INVALID: {
    code: 'QR_INVALID',
    type: 'BUSINESS',
    domain: 'ASSET',
    httpStatus: 404,
    message: '二维码无效或已停用',
  },
  /** 二维码已作废不可恢复（asset PRD §11） */
  QR_REVOKED: {
    code: 'QR_REVOKED',
    type: 'BUSINESS',
    domain: 'ASSET',
    httpStatus: 422,
    message: '二维码已作废，无法恢复',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
