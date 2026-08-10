import type { ErrorEntry } from '../types';

/**
 * 框架级通用错误（无业务域）：认证/授权/校验/冲突/限流/超时/依赖/系统。
 * 与具体业务域无关的错误码在此注册，业务域错误在各域目录文件注册。
 */
export const frameworkErrors = {
  /** 未登录或会话失效（主 PRD §9.5：401） */
  UNAUTHORIZED: {
    code: 'UNAUTHORIZED',
    type: 'AUTHENTICATION',
    httpStatus: 401,
    message: '请先登录',
  },
  /** 登录状态已失效（会话过期），前端应引导重新登录 */
  SESSION_EXPIRED: {
    code: 'SESSION_EXPIRED',
    type: 'AUTHENTICATION',
    httpStatus: 401,
    message: '登录状态已失效，请重新登录',
  },
  /** 已登录但不允许操作（主 PRD §9.5：403） */
  FORBIDDEN: {
    code: 'FORBIDDEN',
    type: 'AUTHORIZATION',
    httpStatus: 403,
    message: '没有权限执行该操作',
  },
  /** 资源不存在或超出数据范围：统一 404，不泄露资源存在性（主 PRD §9.5） */
  RESOURCE_NOT_FOUND: {
    code: 'RESOURCE_NOT_FOUND',
    type: 'AUTHORIZATION',
    httpStatus: 404,
    message: '资源不存在',
  },
  /** 请求格式错误 / 字段校验失败（主 PRD §9.5：400） */
  VALIDATION_FAILED: {
    code: 'VALIDATION_FAILED',
    type: 'VALIDATION',
    httpStatus: 400,
    message: '请求参数不合法',
    detailsFields: ['fields'],
  },
  /** 上传请求体超过端点固定上限（主 PRD §9.5：413） */
  PAYLOAD_TOO_LARGE: {
    code: 'PAYLOAD_TOO_LARGE',
    type: 'VALIDATION',
    httpStatus: 413,
    message: '上传内容超过允许的大小',
  },
  /** 版本/状态/唯一性冲突（主 PRD §9.5：409） */
  CONFLICT: {
    code: 'CONFLICT',
    type: 'CONFLICT',
    httpStatus: 409,
    message: '数据已被更新，请刷新后重试',
  },
  /** 同一幂等键复用且请求指纹不同（主 PRD §3.3：409 IDEMPOTENCY_KEY_REUSED） */
  IDEMPOTENCY_KEY_REUSED: {
    code: 'IDEMPOTENCY_KEY_REUSED',
    type: 'CONFLICT',
    httpStatus: 409,
    message: '幂等键已被其他请求使用',
  },
  /** 超出频率或同用户并发额度（主 PRD §9.5：429） */
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    type: 'RATE_LIMIT',
    httpStatus: 429,
    message: '操作过于频繁，请稍后重试',
  },
  /** 本服务操作超过预定义处理时限（主 PRD §9.5：503 TIMEOUT） */
  REQUEST_TIMEOUT: {
    code: 'REQUEST_TIMEOUT',
    type: 'TIMEOUT',
    httpStatus: 503,
    message: '操作超时，请稍后重试',
  },
  /** 目标系统/依赖当前不可用（主 PRD §9.4：DEPENDENCY + 目标系统名称） */
  DEPENDENCY_UNAVAILABLE: {
    code: 'DEPENDENCY_UNAVAILABLE',
    type: 'DEPENDENCY',
    httpStatus: 503,
    message: '目标系统当前不可用，本次操作未提交',
    detailsFields: ['target'],
  },
  /** 维护状态下拒绝业务请求（backstage PRD §10：503 SYSTEM_MAINTENANCE） */
  SYSTEM_MAINTENANCE: {
    code: 'SYSTEM_MAINTENANCE',
    type: 'DEPENDENCY',
    httpStatus: 503,
    message: '系统维护中，请稍后再试',
  },
  /**
   * 磁盘使用率达严重阈值：停止接受新的文件上传、Excel 导入及备份任务
   * （主 PRD §9.13；不暴露主机路径，仅提示空间不足）
   */
  DISK_SPACE_CRITICAL: {
    code: 'DISK_SPACE_CRITICAL',
    type: 'DEPENDENCY',
    httpStatus: 503,
    message: '磁盘空间不足，暂不可执行此操作',
  },
  /** 目标系统未开放（product_status ≠ OPEN）：入口可见不等于可进入（主 PRD §9.6 系统可用性校验、base PRD §5） */
  SYSTEM_NOT_OPEN: {
    code: 'SYSTEM_NOT_OPEN',
    type: 'DEPENDENCY',
    httpStatus: 503,
    message: '系统尚未开放，暂不可进入',
    detailsFields: ['system'],
  },
  /** 无法可靠分类的异常（主 PRD §9.5：SYSTEM 500 通用安全文案） */
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    type: 'SYSTEM',
    httpStatus: 500,
    message: '系统处理失败，请稍后重试',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
