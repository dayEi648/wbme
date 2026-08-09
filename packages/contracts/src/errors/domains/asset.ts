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
  /** 调度时部门与责任人任一项均未变化，不允许提交（asset PRD §4） */
  ASSET_TRANSFER_NO_CHANGE: {
    code: 'ASSET_TRANSFER_NO_CHANGE',
    type: 'BUSINESS',
    domain: 'ASSET',
    httpStatus: 422,
    message: '部门与责任人均未变化，无需调度',
  },
  /** 分类仍被资产/品种引用或已停用，不允许删除（asset PRD §3） */
  CATEGORY_REFERENCED: {
    code: 'CATEGORY_REFERENCED',
    type: 'BUSINESS',
    domain: 'ASSET',
    httpStatus: 422,
    message: '分类仍被业务数据引用，不允许删除',
  },
  /** 字典项仍被业务数据或历史记录引用，不允许删除（asset PRD §12） */
  DICT_REFERENCED: {
    code: 'DICT_REFERENCED',
    type: 'BUSINESS',
    domain: 'ASSET',
    httpStatus: 422,
    message: '字典项仍被业务数据引用，不允许删除',
  },
  /** 资产主图对象标识非法或不属于当前业务（asset PRD §4） */
  ASSET_IMAGE_INVALID: {
    code: 'ASSET_IMAGE_INVALID',
    type: 'VALIDATION',
    domain: 'ASSET',
    httpStatus: 400,
    message: '主图对象标识无效',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
