import type { ErrorEntry } from '../types';

/** INTEGRATION 域错误目录：外部依赖（钉钉/OSS/节假日/内部服务，主 PRD §9.4/§9.2） */
export const integrationErrors = {
  /** 钉钉接口超时或不可用（base PRD §2） */
  DINGTALK_UNAVAILABLE: {
    code: 'DINGTALK_UNAVAILABLE',
    type: 'DEPENDENCY',
    domain: 'INTEGRATION',
    httpStatus: 503,
    message: '钉钉服务当前不可用，请稍后重试',
  },
  /** 目标内部服务不可用（主 PRD §9.4） */
  SERVICE_UNAVAILABLE: {
    code: 'SERVICE_UNAVAILABLE',
    type: 'DEPENDENCY',
    domain: 'INTEGRATION',
    httpStatus: 503,
    message: '目标系统当前不可用，本次操作未提交',
    detailsFields: ['target'],
  },
  /** 人事系统未就绪：用户恢复不可用（backstage PRD §3） */
  HR_SERVICE_UNAVAILABLE: {
    code: 'HR_SERVICE_UNAVAILABLE',
    type: 'DEPENDENCY',
    domain: 'INTEGRATION',
    httpStatus: 503,
    message: '人事系统当前不可用，无法恢复用户',
  },
  /** 节假日 API 依赖失败（hr PRD §3） */
  HOLIDAY_API_UNAVAILABLE: {
    code: 'HOLIDAY_API_UNAVAILABLE',
    type: 'DEPENDENCY',
    domain: 'INTEGRATION',
    httpStatus: 503,
    message: '节假日服务当前不可用，请稍后重试',
  },
  /** OSS 不可用（主 PRD §9.2） */
  OSS_UNAVAILABLE: {
    code: 'OSS_UNAVAILABLE',
    type: 'DEPENDENCY',
    domain: 'INTEGRATION',
    httpStatus: 503,
    message: '文件存储服务当前不可用，请稍后重试',
  },
  /** Redis 失联降级：受保护接口统一 503（主 PRD §9.8） */
  REDIS_UNAVAILABLE: {
    code: 'REDIS_UNAVAILABLE',
    type: 'DEPENDENCY',
    domain: 'INTEGRATION',
    httpStatus: 503,
    message: '平台暂时不可用，请稍后重试',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
