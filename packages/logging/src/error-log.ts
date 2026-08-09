import { createHash } from 'node:crypto';
import type { RawSqlClient } from './raw-sql-client';

/** 错误日志写入超时（毫秒）：超时则放弃写入，由调用方 stderr 兜底 */
export const ERROR_LOG_WRITE_TIMEOUT_MS = 2_000;

/** 异常样本最大长度（字符） */
export const ERROR_LOG_SAMPLE_MAX_LENGTH = 4_096;

/** 五分钟聚合时间桶宽度（分钟） */
export const ERROR_LOG_BUCKET_MINUTES = 5;

/** 脱敏时需剥离的敏感模式（密码、令牌、密钥等） */
const SECRET_PATTERNS: readonly RegExp[] = [
  /password\s*[:=]\s*\S+/gi,
  /passwd\s*[:=]\s*\S+/gi,
  /token\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /secret\s*[:=]\s*\S+/gi,
  /authorization\s*:\s*\S+/gi,
  /bearer\s+\S+/gi,
  /\+86\d{11}/g,
];

/** 错误指纹输入（backstage PRD §8：不含高基数/敏感值） */
export interface ErrorFingerprintInput {
  /** 所属服务（部署单元标识） */
  service: string;
  /** 部署 Git commit */
  deployCommit: string;
  /** 错误分类（如 SYSTEM / DEPENDENCY / 业务域） */
  errorCategory: string;
  /** 稳定执行入口（HTTP 路由模板或 BACKGROUND_TASK:<类型>） */
  entryPoint: string;
  /** 稳定堆栈位置（文件:行 或模块标识，不含动态参数） */
  stackLocation: string;
}

/** 错误日志聚合写入输入 */
export interface UpsertErrorLogInput {
  level: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  service: string;
  source: string;
  errorCategory: string;
  deployCommit: string;
  fingerprint: string;
  bucketStart: Date;
  occurredAt: Date;
  requestId: string | null;
  /** 原始异常样本（写入前自动脱敏截断） */
  sample: string;
}

/**
 * 计算异常指纹 SHA-256 十六进制（backstage PRD §8）。
 *
 * @param input 服务、部署 commit、错误分类、稳定入口与堆栈位置
 * @returns 64 位十六进制指纹
 */
export function computeErrorFingerprint(input: ErrorFingerprintInput): string {
  const canonical = [
    input.service,
    input.deployCommit,
    input.errorCategory,
    input.entryPoint,
    input.stackLocation,
  ].join('\0');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * 将时间向下取整到 UTC 五分钟时间桶起点。
 *
 * @param date 异常发生时间
 * @returns 时间桶起点（UTC）
 */
export function bucketStart(date: Date): Date {
  const ms = date.getTime();
  const bucketMs = ERROR_LOG_BUCKET_MINUTES * 60 * 1_000;
  return new Date(Math.floor(ms / bucketMs) * bucketMs);
}

/**
 * 脱敏并截断异常样本（backstage PRD §8）。
 *
 * @param raw 原始异常文本
 * @returns 脱敏后的样本
 */
export function desensitizeErrorSample(raw: string): string {
  let text = raw;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]');
  }
  if (text.length > ERROR_LOG_SAMPLE_MAX_LENGTH) {
    return `${text.slice(0, ERROR_LOG_SAMPLE_MAX_LENGTH)}…[truncated]`;
  }
  return text;
}

const UPSERT_ERROR_LOG_SQL = `
INSERT INTO backstage.error_logs (
  level, service, source, error_category, deploy_commit, fingerprint, bucket_start,
  first_seen_at, last_seen_at, occurrence_count, first_request_id, last_request_id, sample, status
) VALUES (
  $1::backstage."LogLevel", $2, $3, $4, $5, $6, $7,
  $8, $8, 1, $9, $9, $10, 'PENDING'::backstage."ErrorStatus"
)
ON CONFLICT (fingerprint, bucket_start) WHERE status = 'PENDING'
DO UPDATE SET
  occurrence_count = backstage.error_logs.occurrence_count + 1,
  last_seen_at = EXCLUDED.last_seen_at,
  last_request_id = EXCLUDED.last_request_id,
  updated_at = NOW()
`;

/**
 * 原子 UPSERT 集中错误日志（backstage PRD §8 五分钟聚合）。
 *
 * - 待处理状态下同一指纹+时间桶：递增 occurrence_count 并更新 last_seen_at/last_request_id；
 * - 已关闭记录不参与冲突：同桶再次发生时 INSERT 新待处理行。
 * - 写入失败或超时返回 false，不抛错（调用方 stderr 兜底）。
 *
 * @param client 原始 SQL 客户端
 * @param input 聚合写入参数
 * @returns 是否写入成功
 */
export async function upsertErrorLog(client: RawSqlClient, input: UpsertErrorLogInput): Promise<boolean> {
  const sample = desensitizeErrorSample(input.sample);
  const values = [
    input.level,
    input.service,
    input.source,
    input.errorCategory,
    input.deployCommit,
    input.fingerprint,
    input.bucketStart,
    input.occurredAt,
    input.requestId,
    sample,
  ];
  try {
    await Promise.race([
      client.$executeRawUnsafe(UPSERT_ERROR_LOG_SQL, ...values),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('error log write timeout')), ERROR_LOG_WRITE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}
