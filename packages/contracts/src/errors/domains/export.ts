import type { ErrorEntry } from '../types';

/** EXPORT 域错误目录：通用导出与利润分析导入/导出并发（主 PRD §10.3、fin PRD §4） */
export const exportErrors = {
  /** 导出数据行数超过配置上限，整次拒绝（主 PRD §10.3） */
  ROW_LIMIT_EXCEEDED: {
    code: 'ROW_LIMIT_EXCEEDED',
    type: 'BUSINESS',
    domain: 'EXPORT',
    httpStatus: 422,
    message: '导出数据超过行数上限，请缩小筛选范围',
    detailsFields: ['actualRows', 'limit'],
  },
  /** 单用户导出并发占用冲突（主 PRD §10.3：429） */
  EXPORT_ALREADY_RUNNING: {
    code: 'EXPORT_ALREADY_RUNNING',
    type: 'RATE_LIMIT',
    domain: 'EXPORT',
    httpStatus: 429,
    message: '已有导出任务正在执行，请等待其完成',
  },
  /** 导出超过 120 秒固定总时限（主 PRD §10.3：503） */
  EXPORT_TIMEOUT: {
    code: 'EXPORT_TIMEOUT',
    type: 'TIMEOUT',
    domain: 'EXPORT',
    httpStatus: 503,
    message: '导出超时，请缩小范围后重试',
  },
  /** 单用户导入并发占用冲突（fin PRD §4：429） */
  IMPORT_ALREADY_RUNNING: {
    code: 'IMPORT_ALREADY_RUNNING',
    type: 'RATE_LIMIT',
    domain: 'EXPORT',
    httpStatus: 429,
    message: '已有导入请求正在执行，请等待其完成',
  },
  /** 导入超过 120 秒固定总时限（fin PRD §4：503） */
  IMPORT_TIMEOUT: {
    code: 'IMPORT_TIMEOUT',
    type: 'TIMEOUT',
    domain: 'EXPORT',
    httpStatus: 503,
    message: '导入超时，请稍后重试',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
