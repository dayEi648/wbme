import type { ApprovalSchema } from './types';
import { APPROVAL_SCHEMAS } from './types';
import type { SqlClient } from './sql-client';

/** 超时扫描单批上限（避免单次任务锁表过久） */
export const APPROVAL_TIMEOUT_BATCH_SIZE = 200;

/**
 * 计算超时截止点：submitted_at 早于此时间的 PENDING 应自动取消。
 *
 * @param now 当前时间
 * @param timeoutDays 审批超时自动取消天数（系统设置，默认 30）
 * @returns 截止时间
 */
export function overdueCutoff(now: Date, timeoutDays: number): Date {
  const days = Number.isFinite(timeoutDays) && timeoutDays >= 1 ? Math.floor(timeoutDays) : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** 待超时取消的审批头行 */
export interface OverdueApprovalRow {
  id: number;
  version: number;
  requestType: string;
}

/**
 * 超时自动取消业务 hook（T7-8：asset 占用释放等）。
 * 在取消同一事务内执行（客户端实现 transaction 时）；崩溃整体回滚、下轮扫描重试。
 */
export interface AutoCancelHook {
  /**
   * 单行取消后释放业务占用（事务内调用）。
   *
   * @param sql 事务客户端（或普通客户端——无事务回退路径）
   * @param schema 模块 schema
   * @param row 已取消的审批头行
   * @param now 取消时间
   */
  onAutoCancel(sql: SqlClient, schema: ApprovalSchema, row: OverdueApprovalRow, now: Date): Promise<void>;
}

/**
 * 列出某 schema 中已超时的 PENDING 审批头。
 *
 * @param client SQL 客户端
 * @param schema 模块 schema
 * @param cutoff 截止时间
 * @param limit 批次上限
 * @returns 待取消行
 */
export async function listOverduePending(
  client: SqlClient,
  schema: ApprovalSchema,
  cutoff: Date,
  limit: number = APPROVAL_TIMEOUT_BATCH_SIZE,
): Promise<OverdueApprovalRow[]> {
  if (!(APPROVAL_SCHEMAS as readonly string[]).includes(schema)) {
    throw new Error(`不支持的审批 schema: ${schema}`);
  }
  // schema 来自封闭常量，禁止外部拼接
  return client.queryRows<OverdueApprovalRow>(
    `
    SELECT id, version, request_type AS "requestType"
    FROM ${schema}.approval_requests
    WHERE status = 'PENDING'
      AND submitted_at IS NOT NULL
      AND submitted_at < $1::timestamptz
    ORDER BY submitted_at ASC
    LIMIT $2
    `,
    [cutoff.toISOString(), limit],
  );
}

/**
 * 条件取消一条超时审批（status+version；写入 AUTO_CANCEL 动作）。
 * 并发已被人工处理时 count=0，调用方跳过即可。
 *
 * 客户端实现 transaction 时，状态迁移、动作写入与业务 hook 在同一数据库事务内完成
 * （崩溃整体回滚、头保持 PENDING、下轮扫描重试）；否则保持原有两条独立语句行为。
 *
 * @param client SQL 客户端
 * @param schema 模块 schema
 * @param row 待取消行
 * @param now 当前时间
 * @param hook 业务占用释放 hook（可选；如 asset 超时取消释放库存/额度占用）
 * @returns 是否成功取消
 */
export async function autoCancelOverdueRow(
  client: SqlClient,
  schema: ApprovalSchema,
  row: OverdueApprovalRow,
  now: Date = new Date(),
  hook?: AutoCancelHook,
): Promise<boolean> {
  if (!(APPROVAL_SCHEMAS as readonly string[]).includes(schema)) {
    throw new Error(`不支持的审批 schema: ${schema}`);
  }
  const cancel = async (sql: SqlClient): Promise<boolean> => {
    const updated = await sql.query(
      `
      UPDATE ${schema}.approval_requests
      SET
        status = 'CANCELLED',
        version = version + 1,
        cancelled_at = $3::timestamptz,
        cancel_source = 'OVERDUE',
        updated_at = $3::timestamptz
      WHERE id = $1
        AND status = 'PENDING'
        AND version = $2
      `,
      [row.id, row.version, now.toISOString()],
    );
    if ((updated.rowCount ?? 0) === 0) {
      return false;
    }
    await sql.query(
      `
      INSERT INTO ${schema}.approval_actions (
        request_id, action, actor_id, actor_name, opinion, cancel_source, created_at
      ) VALUES (
        $1, 'AUTO_CANCEL', 0, 'system', NULL, 'OVERDUE', $2::timestamptz
      )
      `,
      [row.id, now.toISOString()],
    );
    if (hook) {
      await hook.onAutoCancel(sql, schema, row, now);
    }
    return true;
  };
  if (client.transaction) {
    return client.transaction((tx) => cancel(tx));
  }
  return cancel(client);
}

/**
 * 扫描并自动取消三 schema 超时待审批（主 PRD §3.2；业务占用释放经 hooks 接入）。
 *
 * @param client SQL 客户端
 * @param timeoutDays 超时天数
 * @param now 当前时间
 * @param hooks 各 schema 业务占用释放 hook（可选）
 * @returns 各 schema 成功取消条数
 */
export async function scanAndAutoCancelOverdue(
  client: SqlClient,
  timeoutDays: number,
  now: Date = new Date(),
  hooks?: Partial<Record<ApprovalSchema, AutoCancelHook>>,
): Promise<Record<ApprovalSchema, number>> {
  const cutoff = overdueCutoff(now, timeoutDays);
  const result: Record<ApprovalSchema, number> = { backstage: 0, hr: 0, asset: 0 };
  for (const schema of APPROVAL_SCHEMAS) {
    const rows = await listOverduePending(client, schema, cutoff);
    let cancelled = 0;
    for (const row of rows) {
      const ok = await autoCancelOverdueRow(client, schema, row, now, hooks?.[schema]);
      if (ok) {
        cancelled += 1;
      }
    }
    result[schema] = cancelled;
  }
  return result;
}
