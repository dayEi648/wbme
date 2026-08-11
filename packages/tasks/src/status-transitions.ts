import {
  TASK_ENQUEUE_BACKOFF_BASE_SECONDS,
  TASK_RUNNING_LEASE_SECONDS,
} from './constants';
import type { SqlClient } from './sql-client';
import type { BackgroundTaskRow, TaskStatus } from './types';

/** 终态任务状态 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/**
 * 判断任务是否处于终态。
 *
 * @param status 任务状态
 * @returns 是否终态
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/**
 * 计算投递失败退避秒数（有上限指数退避）。
 *
 * @param attempts 已尝试次数
 * @returns 退避秒数
 */
export function computeEnqueueBackoffSeconds(attempts: number): number {
  const capped = Math.min(attempts, 8);
  return TASK_ENQUEUE_BACKOFF_BASE_SECONDS * 2 ** capped;
}

/**
 * 按 task_uuid 加载任务行。
 *
 * @param client SQL 客户端
 * @param taskUuid 任务 UUID
 * @returns 任务行或 null
 */
export async function loadTaskByUuid(client: SqlClient, taskUuid: string): Promise<BackgroundTaskRow | null> {
  const rows = await client.queryRows<BackgroundTaskRow>(
    `
    SELECT
      task_uuid AS "taskUuid",
      task_type AS "taskType",
      module,
      initiator_id AS "initiatorId",
      initiator_type AS "initiatorType",
      ref,
      status::text AS status,
      progress,
      attempts
    FROM backstage.background_tasks
    WHERE task_uuid = $1::uuid
    `,
    [taskUuid],
  );
  return rows[0] ?? null;
}

/**
 * 投递成功后条件更新为 QUEUED。
 *
 * 覆盖两类来源（批次8复核修复）：
 * - PENDING_ENQUEUE 首投：常规流转；
 * - 租约重领/卡死重投（QUEUED/RUNNING 残留行被 claimOutboxBatch 重领）：归队并清空
 *   调度器投递租约——旧执行者租约已过期才可能被重领，保留投递租约会挡住 Worker 的
 *   claimRunning（需等投递租约自然过期），重投链路空转直至 timeout_at 误标 FAILED。
 *
 * @param client SQL 客户端
 * @param taskUuid 任务 UUID
 * @param leaseOwner 投递租约持有者
 * @returns 是否更新成功
 */
export async function markQueued(client: SqlClient, taskUuid: string, leaseOwner: string): Promise<boolean> {
  const result = await client.query(
    `
    UPDATE backstage.background_tasks
    SET
      status = 'QUEUED'::backstage."TaskStatus",
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = NULL,
      last_error = NULL
    WHERE task_uuid = $1::uuid
      AND status IN (
        'PENDING_ENQUEUE'::backstage."TaskStatus",
        'QUEUED'::backstage."TaskStatus",
        'RUNNING'::backstage."TaskStatus"
      )
      AND lease_owner = $2
    `,
    [taskUuid, leaseOwner],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Worker 领取 RUNNING 执行租约。
 *
 * @param client SQL 客户端
 * @param taskUuid 任务 UUID
 * @param leaseOwner 租约持有者
 * @param now 当前时间
 * @returns 是否领取成功
 */
export async function claimRunning(
  client: SqlClient,
  taskUuid: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const leaseExpiresAt = new Date(now.getTime() + TASK_RUNNING_LEASE_SECONDS * 1_000);
  const timeoutAt = new Date(now.getTime() + TASK_RUNNING_LEASE_SECONDS * 2 * 1_000);
  const result = await client.query(
    `
    UPDATE backstage.background_tasks
    SET
      status = 'RUNNING'::backstage."TaskStatus",
      lease_owner = $2,
      lease_expires_at = $3::timestamptz,
      started_at = COALESCE(started_at, $4::timestamptz),
      attempts = CASE WHEN status = 'QUEUED'::backstage."TaskStatus" THEN attempts + 1 ELSE attempts END,
      timeout_at = $5::timestamptz
    WHERE task_uuid = $1::uuid
      AND status IN (
        'QUEUED'::backstage."TaskStatus",
        'RUNNING'::backstage."TaskStatus"
      )
      AND (
        status = 'QUEUED'::backstage."TaskStatus"
        OR lease_expires_at IS NULL
        OR lease_expires_at <= $4::timestamptz
        OR lease_owner = $2
      )
    `,
    [taskUuid, leaseOwner, leaseExpiresAt, now, timeoutAt],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 续期 RUNNING 任务执行租约（长任务心跳，问题13 修复）。
 *
 * 长任务（如大库备份 >10 分钟）执行期间定期续期 lease_expires_at，防止租约过期
 * 被 claimOutboxBatch 重领导致同一任务被重复执行（pg_dump/上传第二次）。
 * 同时重置 timeout_at（问题12 修复）：任务仍在续期 = 仍在执行，不触发超时终态化；
 * 超时只针对不再续期的卡死任务。
 *
 * @param client SQL 客户端
 * @param taskUuid 任务 UUID
 * @param leaseOwner 租约持有者
 * @param now 当前时间
 * @returns 是否续期成功（任务已不在本租约下时返回 false）
 */
export async function renewRunningLease(
  client: SqlClient,
  taskUuid: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const leaseExpiresAt = new Date(now.getTime() + TASK_RUNNING_LEASE_SECONDS * 1_000);
  const timeoutAt = new Date(now.getTime() + TASK_RUNNING_LEASE_SECONDS * 2 * 1_000);
  const result = await client.query(
    `
    UPDATE backstage.background_tasks
    SET lease_expires_at = $3::timestamptz,
        timeout_at = $4::timestamptz
    WHERE task_uuid = $1::uuid
      AND status = 'RUNNING'::backstage."TaskStatus"
      AND lease_owner = $2
    `,
    [taskUuid, leaseOwner, leaseExpiresAt, timeoutAt],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 超时终态化（主 PRD §9.1 第 250 行「支持超时控制、卡死任务发现」，问题12 修复）。
 *
 * RUNNING 且 timeout_at 已过期的任务判定为卡死/超时，终态化为 FAILED（不再重领、
 * 不再重试），由人工核查；活着的任务经 renewRunningLease 持续重置 timeout_at 不触发。
 *
 * @param client SQL 客户端
 * @param now 当前时间
 * @returns 被终态化的任务数
 */
export async function failTimedOutTasks(client: SqlClient, now: Date = new Date()): Promise<number> {
  const result = await client.query(
    `
    UPDATE backstage.background_tasks
    SET
      status = 'FAILED'::backstage."TaskStatus",
      finished_at = $1::timestamptz,
      last_error = '任务执行超时（timeout_at）',
      lease_owner = NULL,
      lease_expires_at = NULL
    WHERE status = 'RUNNING'::backstage."TaskStatus"
      AND timeout_at IS NOT NULL
      AND timeout_at <= $1::timestamptz
    `,
    [now],
  );
  return result.rowCount ?? 0;
}

/**
 * 标记任务成功终态。
 *
 * @param client SQL 客户端
 * @param taskUuid 任务 UUID
 * @param leaseOwner 租约持有者
 * @param now 完成时间
 * @returns 是否更新成功
 */
export async function markSucceeded(
  client: SqlClient,
  taskUuid: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await client.query(
    `
    UPDATE backstage.background_tasks
    SET
      status = 'SUCCEEDED'::backstage."TaskStatus",
      finished_at = $3::timestamptz,
      progress = 100,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = NULL
    WHERE task_uuid = $1::uuid
      AND status = 'RUNNING'::backstage."TaskStatus"
      AND lease_owner = $2
    `,
    [taskUuid, leaseOwner, now],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 标记任务失败终态。
 *
 * @param client SQL 客户端
 * @param taskUuid 任务 UUID
 * @param leaseOwner 租约持有者
 * @param lastError 脱敏错误摘要
 * @param now 完成时间
 * @returns 是否更新成功
 */
export async function markFailed(
  client: SqlClient,
  taskUuid: string,
  leaseOwner: string,
  lastError: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await client.query(
    `
    UPDATE backstage.background_tasks
    SET
      status = 'FAILED'::backstage."TaskStatus",
      finished_at = $3::timestamptz,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = $4
    WHERE task_uuid = $1::uuid
      AND status = 'RUNNING'::backstage."TaskStatus"
      AND lease_owner = $2
    `,
    [taskUuid, leaseOwner, now, lastError.slice(0, 2_000)],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 标记任务已取消。
 *
 * @param client SQL 客户端
 * @param taskUuid 任务 UUID
 * @param leaseOwner 租约持有者（可选）
 * @param now 取消时间
 * @returns 是否更新成功
 */
export async function markCancelled(
  client: SqlClient,
  taskUuid: string,
  leaseOwner?: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await client.query(
    `
    UPDATE backstage.background_tasks
    SET
      status = 'CANCELLED'::backstage."TaskStatus",
      finished_at = $3::timestamptz,
      lease_owner = NULL,
      lease_expires_at = NULL
    WHERE task_uuid = $1::uuid
      AND status NOT IN (
        'SUCCEEDED'::backstage."TaskStatus",
        'FAILED'::backstage."TaskStatus",
        'CANCELLED'::backstage."TaskStatus"
      )
      AND ($2::text IS NULL OR lease_owner = $2)
    `,
    [taskUuid, leaseOwner ?? null, now],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 释放投递租约并设置下次重试时间（投递失败）。
 *
 * @param client SQL 客户端
 * @param taskUuid 任务 UUID
 * @param leaseOwner 租约持有者
 * @param attempts 当前尝试次数
 * @param lastError 错误摘要
 * @param now 当前时间
 * @returns 是否更新成功
 */
export async function releaseEnqueueLease(
  client: SqlClient,
  taskUuid: string,
  leaseOwner: string,
  attempts: number,
  lastError: string,
  now: Date = new Date(),
): Promise<boolean> {
  const backoffSeconds = computeEnqueueBackoffSeconds(attempts);
  const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1_000);
  const result = await client.query(
    `
    UPDATE backstage.background_tasks
    SET
      lease_owner = NULL,
      lease_expires_at = NULL,
      attempts = attempts + 1,
      next_retry_at = $3::timestamptz,
      last_error = $4
    WHERE task_uuid = $1::uuid
      AND status = 'PENDING_ENQUEUE'::backstage."TaskStatus"
      AND lease_owner = $2
    `,
    [taskUuid, leaseOwner, nextRetryAt, lastError.slice(0, 2_000)],
  );
  return (result.rowCount ?? 0) > 0;
}
