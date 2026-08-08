import type { ErrorEntry } from '../types';

/** APPROVAL 域错误目录：统一审批契约（主 PRD §3.2） */
export const approvalErrors = {
  /** 审批状态/版本并发冲突（"当前状态 + 版本号"条件更新仅一个成功） */
  STATUS_CONFLICT: {
    code: 'STATUS_CONFLICT',
    type: 'CONFLICT',
    domain: 'APPROVAL',
    httpStatus: 409,
    message: '审批状态已变化，请刷新后重试',
  },
  /** 审批人数据范围未覆盖批次全部申请对象（主 PRD §3.2） */
  SCOPE_NOT_COVERED: {
    code: 'SCOPE_NOT_COVERED',
    type: 'BUSINESS',
    domain: 'APPROVAL',
    httpStatus: 422,
    message: '当前数据范围未覆盖该申请的全部对象',
  },
  /** 同一业务键同时最多一条待审批（主 PRD §3.2 条件唯一索引兜底） */
  PENDING_LIMIT_REACHED: {
    code: 'PENDING_LIMIT_REACHED',
    type: 'CONFLICT',
    domain: 'APPROVAL',
    httpStatus: 409,
    message: '存在待审批申请，请先处理后再提交',
  },
  /** 当前状态不允许该操作（如终态不可撤回） */
  STATUS_NOT_ALLOWED: {
    code: 'STATUS_NOT_ALLOWED',
    type: 'BUSINESS',
    domain: 'APPROVAL',
    httpStatus: 422,
    message: '当前状态不允许该操作',
  },
  /** 驳回必须填写原因（主 PRD §3.2） */
  REJECT_REASON_REQUIRED: {
    code: 'REJECT_REASON_REQUIRED',
    type: 'VALIDATION',
    domain: 'APPROVAL',
    httpStatus: 400,
    message: '驳回必须填写原因',
  },
  /** 目标账号已注销，申请将自动取消（backstage PRD §3） */
  APPLICANT_DEACTIVATED: {
    code: 'APPLICANT_DEACTIVATED',
    type: 'BUSINESS',
    domain: 'APPROVAL',
    httpStatus: 422,
    message: '账号已注销，申请将自动取消',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
