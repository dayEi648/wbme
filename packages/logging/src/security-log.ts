import type { RawSqlClient } from './raw-sql-client';

/** 安全日志写入超时（毫秒） */
export const SECURITY_LOG_WRITE_TIMEOUT_MS = 2_000;

/**
 * 安全事件类型（与 backstage.security_event_type 枚举对齐）。
 * 各部署单元引用生成类型或本联合类型均可。
 */
export type SecurityEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'LOGOUT'
  | 'ACCOUNT_LOCK'
  | 'ACCOUNT_UNLOCK'
  | 'IP_LOCK'
  | 'IP_UNLOCK'
  | 'ACCOUNT_ACTIVATED'
  | 'INVITATION_ISSUED'
  | 'INVITATION_USED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET_ISSUED'
  | 'PASSWORD_RESET_COMPLETED'
  | 'DINGTALK_BOUND'
  | 'PHONE_SYNCED'
  | 'PHONE_SYNC_CONFLICT'
  | 'INTERNAL_TOKEN_FAILED';

/** 安全日志写入输入 */
export interface InsertSecurityLogInput {
  eventType: SecurityEventType;
  result: 'SUCCESS' | 'FAILURE';
  actorId?: number | null;
  targetUserId?: number | null;
  reason?: string | null;
  sourceIp?: string | null;
  context?: Record<string, unknown> | null;
  requestId?: string | null;
}

const INSERT_SECURITY_LOG_SQL = `
INSERT INTO backstage.security_logs (
  event_type, actor_id, target_user_id, result, reason, source_ip, context, request_id
) VALUES (
  $1::backstage."SecurityEventType", $2, $3, $4::backstage."SecurityResult", $5, $6, $7::jsonb, $8
)
`;

/**
 * 追加一条安全日志（backstage PRD §8；只追加，不聚合）。
 *
 * 写入失败或超时返回 false，不抛错（调用方 stderr 兜底）。
 *
 * @param client 原始 SQL 客户端
 * @param input 事件参数（调用方负责脱敏）
 * @returns 是否写入成功
 */
export async function insertSecurityLog(client: RawSqlClient, input: InsertSecurityLogInput): Promise<boolean> {
  const contextJson = input.context ? JSON.stringify(input.context) : null;
  const values = [
    input.eventType,
    input.actorId ?? null,
    input.targetUserId ?? null,
    input.result,
    input.reason ?? null,
    input.sourceIp ?? null,
    contextJson,
    input.requestId ?? null,
  ];
  try {
    await Promise.race([
      client.$executeRawUnsafe(INSERT_SECURITY_LOG_SQL, ...values),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('security log write timeout')), SECURITY_LOG_WRITE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}
