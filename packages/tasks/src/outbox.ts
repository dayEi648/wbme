import {
  TASK_ENQUEUE_BATCH_SIZE,
  TASK_ENQUEUE_LEASE_SECONDS,
  type TaskType,
} from './constants';
import type { SqlClient } from './sql-client';
import type { CreatePendingTaskInput } from './types';

/** Outbox 领取行 */
export interface OutboxClaimRow {
  taskUuid: string;
  taskType: TaskType;
  status: string;
}

/**
 * 已入队（QUEUED）但从未领取的超时兜底阈值（分钟）。
 * markQueued 清空租约；若 BullMQ 作业因 Redis 数据丢失/Worker 崩溃消失，
 * 任务会永久卡 QUEUED——超过该阈值后调度器按可重放类型重新投递
 * （主 PRD §9.1：Redis 数据丢失时调度器按 PostgreSQL 状态恢复）。
 */
export const STALLED_QUEUED_REQUEUE_MINUTES = 10;

/**
 * 领取待投递 Outbox 批次（SELECT FOR UPDATE SKIP LOCKED + 投递租约）。
 *
 * @param client SQL 客户端
 * @param leaseOwner 调度器实例标识
 * @param replayableTypes 可安全重放的任务类型
 * @param now 当前时间
 * @param batchSize 批次大小
 * @returns 已领取行
 */
export async function claimOutboxBatch(
  client: SqlClient,
  leaseOwner: string,
  replayableTypes: readonly TaskType[],
  now: Date = new Date(),
  batchSize: number = TASK_ENQUEUE_BATCH_SIZE,
): Promise<OutboxClaimRow[]> {
  return client.queryRows<OutboxClaimRow>(
    `
    WITH candidates AS (
      SELECT task_uuid, task_type, status
      FROM backstage.background_tasks
      WHERE (
        status = 'PENDING_ENQUEUE'::backstage."TaskStatus"
        AND (next_retry_at IS NULL OR next_retry_at <= $1::timestamptz)
        AND (lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz)
      )
      OR (
        status IN (
          'QUEUED'::backstage."TaskStatus",
          'RUNNING'::backstage."TaskStatus"
        )
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= $1::timestamptz
        AND task_type = ANY($2::text[])
      )
      OR (
        status = 'QUEUED'::backstage."TaskStatus"
        AND lease_expires_at IS NULL
        AND created_at <= $1::timestamptz - (${STALLED_QUEUED_REQUEUE_MINUTES} * interval '1 minute')
        AND task_type = ANY($2::text[])
      )
      ORDER BY created_at
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
      UPDATE backstage.background_tasks AS t
      SET
        lease_owner = $4,
        lease_expires_at = $1::timestamptz + ($5::int * interval '1 second')
      FROM candidates AS c
      WHERE t.task_uuid = c.task_uuid
      RETURNING t.task_uuid AS "taskUuid", t.task_type AS "taskType", t.status::text AS status
    )
    SELECT * FROM claimed
    `,
    [now, replayableTypes, batchSize, leaseOwner, TASK_ENQUEUE_LEASE_SECONDS],
  );
}

/**
 * 通过 SQL 插入 PENDING_ENQUEUE 行（Worker 定时备份等无 Prisma 场景）。
 *
 * @param client SQL 客户端
 * @param input 创建参数
 * @param now 下次投递时间
 * @returns taskUuid 与是否新建
 */
export async function insertPendingTaskSql(
  client: SqlClient,
  input: CreatePendingTaskInput,
  now: Date = new Date(),
): Promise<{ taskUuid: string; created: boolean }> {
  const rows = await client.queryRows<{ taskUuid: string }>(
    `
    INSERT INTO backstage.background_tasks (
      task_uuid, task_type, module, initiator_id, initiator_type, ref,
      status, next_retry_at
    ) VALUES (
      $1::uuid, $2, $3, $4, $5::backstage."TaskInitiatorType", $6::jsonb,
      'PENDING_ENQUEUE'::backstage."TaskStatus", $7::timestamptz
    )
    ON CONFLICT (task_uuid) DO NOTHING
    RETURNING task_uuid AS "taskUuid"
    `,
    [
      input.taskUuid,
      input.taskType,
      input.module,
      input.initiatorId ?? null,
      input.initiatorType,
      input.ref ? JSON.stringify(input.ref) : null,
      now,
    ],
  );
  return { taskUuid: input.taskUuid, created: rows.length > 0 };
}
