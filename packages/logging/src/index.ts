/**
 * @wbme/logging 包入口
 * 操作日志摘要模板、集中错误日志五分钟聚合、安全日志预定义受限语句接口
 * （主 PRD §3.3/§9.3、backstage PRD §8，T4-1/T4-3/T4-4 实现）。
 */

export type { RawSqlClient } from './raw-sql-client';

export {
  ERROR_LOG_WRITE_TIMEOUT_MS,
  ERROR_LOG_SAMPLE_MAX_LENGTH,
  ERROR_LOG_BUCKET_MINUTES,
  computeErrorFingerprint,
  bucketStart,
  desensitizeErrorSample,
  upsertErrorLog,
  type ErrorFingerprintInput,
  type UpsertErrorLogInput,
} from './error-log';

export {
  SECURITY_LOG_WRITE_TIMEOUT_MS,
  insertSecurityLog,
  type SecurityEventType,
  type InsertSecurityLogInput,
} from './security-log';

export {
  formatOperationSummary,
  type OperationActionType,
  type OperationSummaryInput,
} from './operation-log';

export { canonicalize, fingerprintPayload } from './fingerprint';
