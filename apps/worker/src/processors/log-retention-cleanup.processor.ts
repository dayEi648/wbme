import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';

/**
 * 日志保留策略清理处理器（主 PRD §9.1 新增 LOG_RETENTION_CLEANUP）。
 *
 * 按系统设置中的保留天数，分批物理删除已过期的：
 * - 各 schema 的 operation_logs（按 actionType 单独配置，0=永不清理，-1=继承默认）
 * - backstage.error_logs（按 first_seen_at）
 * - backstage.security_logs（按 created_at）
 *
 * 操作日志同时承担幂等记录职责：为避免旧幂等键失效导致重复执行业务，
 * 清理时保留 `idempotency_key IS NOT NULL` 的行（普通日志正常清理）。
 */

const SETTING_KEYS = {
  OPERATION_LOG_DEFAULT_DAYS: 'log.cleanup.operation_log.default.days',
  OPERATION_LOG_CREATE_DAYS: 'log.cleanup.operation_log.create.days',
  OPERATION_LOG_UPDATE_DAYS: 'log.cleanup.operation_log.update.days',
  OPERATION_LOG_DELETE_DAYS: 'log.cleanup.operation_log.delete.days',
  OPERATION_LOG_EXPORT_DAYS: 'log.cleanup.operation_log.export.days',
  OPERATION_LOG_QUERY_DAYS: 'log.cleanup.operation_log.query.days',
  ERROR_LOG_DAYS: 'log.cleanup.error_log.days',
  SECURITY_LOG_DAYS: 'log.cleanup.security_log.days',
} as const;

const OPERATION_LOG_ACTION_TYPES = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'EXPORT',
  'QUERY',
] as const;

const OPERATION_LOG_SCHEMAS = ['base', 'backstage', 'asset', 'hr', 'fin'] as const;

/** 单批删除上限：控制锁粒度，避免长事务。 */
const BATCH_SIZE = 5_000;

/** 解析设置值：空/非法回退默认值；-1 表示操作日志单项继承统一设置。 */
function parseSetting(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 计算保留天数：0 表示永不清理；-1 表示继承统一设置。 */
function resolveOperationLogDays(
  actionSetting: number,
  defaultSetting: number,
): number | null {
  if (actionSetting === 0) {
    return null;
  }
  const effective = actionSetting > 0 ? actionSetting : defaultSetting;
  return effective > 0 ? effective : null;
}

/** 按批次删除过期操作日志，返回删除行数。 */
async function deleteExpiredOperationLogs(
  ctx: ProcessorContext,
  schema: string,
  actionType: string,
  cutoff: Date,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await ctx.sql.query(
      `DELETE FROM "${schema}"."operation_logs"
       WHERE id IN (
         SELECT id FROM "${schema}"."operation_logs"
         WHERE action_type::text = $1
           AND created_at < $2::timestamptz
           AND idempotency_key IS NULL
         ORDER BY id
         LIMIT $3
       )`,
      [actionType, cutoff, BATCH_SIZE],
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < BATCH_SIZE) {
      break;
    }
  }
  return total;
}

/** 按批次删除普通日志表（error_logs / security_logs）。 */
async function deleteExpiredLogs(
  ctx: ProcessorContext,
  table: 'error_logs' | 'security_logs',
  timeColumn: 'first_seen_at' | 'created_at',
  cutoff: Date,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await ctx.sql.query(
      `DELETE FROM backstage."${table}"
       WHERE id IN (
         SELECT id FROM backstage."${table}"
         WHERE "${timeColumn}" < $1::timestamptz
         ORDER BY id
         LIMIT $2
       )`,
      [cutoff, BATCH_SIZE],
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < BATCH_SIZE) {
      break;
    }
  }
  return total;
}

/**
 * 执行日志保留清理。
 *
 * @param task 任务行（ref 仅用于追踪）
 * @param ctx 处理器上下文
 */
export async function processLogRetentionCleanup(
  task: BackgroundTaskRow,
  ctx: ProcessorContext,
): Promise<void> {
  const keys = Object.values(SETTING_KEYS);
  const rows = (await ctx.sql.queryRows<{ key: string; value: string }>(
    `SELECT key, value FROM backstage.system_settings WHERE key = ANY($1::text[])`,
    [keys],
  )) ?? [];
  const settingMap = new Map(rows.map((row) => [row.key, row.value]));

  const defaultOperationLogDays = parseSetting(
    settingMap.get(SETTING_KEYS.OPERATION_LOG_DEFAULT_DAYS),
    365,
  );
  const now = new Date();
  const summary: string[] = [];

  for (const schema of OPERATION_LOG_SCHEMAS) {
    for (const actionType of OPERATION_LOG_ACTION_TYPES) {
      const actionKey = actionTypeToSettingKey(actionType);
      const actionSetting = parseSetting(settingMap.get(actionKey), -1);
      const retentionDays = resolveOperationLogDays(actionSetting, defaultOperationLogDays);
      if (retentionDays === null) {
        continue;
      }
      const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
      const deleted = await deleteExpiredOperationLogs(ctx, schema, actionType, cutoff);
      if (deleted > 0) {
        summary.push(`${schema}.operation_logs(${actionType})=${deleted}`);
      }
    }
  }

  const errorLogDays = parseSetting(settingMap.get(SETTING_KEYS.ERROR_LOG_DAYS), 180);
  if (errorLogDays > 0) {
    const cutoff = new Date(now.getTime() - errorLogDays * 24 * 60 * 60 * 1000);
    const deleted = await deleteExpiredLogs(ctx, 'error_logs', 'first_seen_at', cutoff);
    if (deleted > 0) {
      summary.push(`backstage.error_logs=${deleted}`);
    }
  }

  const securityLogDays = parseSetting(settingMap.get(SETTING_KEYS.SECURITY_LOG_DAYS), 365);
  if (securityLogDays > 0) {
    const cutoff = new Date(now.getTime() - securityLogDays * 24 * 60 * 60 * 1000);
    const deleted = await deleteExpiredLogs(ctx, 'security_logs', 'created_at', cutoff);
    if (deleted > 0) {
      summary.push(`backstage.security_logs=${deleted}`);
    }
  }

  console.log(
    `[log-retention-cleanup] 完成 taskUuid=${task.taskUuid} 删除${summary.length > 0 ? `：${summary.join('、')}` : ' 0 条过期记录'}`,
  );
}

function actionTypeToSettingKey(actionType: string): string {
  switch (actionType) {
    case 'CREATE':
      return SETTING_KEYS.OPERATION_LOG_CREATE_DAYS;
    case 'UPDATE':
      return SETTING_KEYS.OPERATION_LOG_UPDATE_DAYS;
    case 'DELETE':
      return SETTING_KEYS.OPERATION_LOG_DELETE_DAYS;
    case 'EXPORT':
      return SETTING_KEYS.OPERATION_LOG_EXPORT_DAYS;
    case 'QUERY':
      return SETTING_KEYS.OPERATION_LOG_QUERY_DAYS;
    default:
      throw new Error(`未知操作日志动作类型：${actionType}`);
  }
}
