import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { BackgroundTaskRow, SqlClient } from '@wbme/tasks';
import { processApprovalTimeoutScan } from './approval-timeout.processor';
import type { ProcessorContext } from './types';

try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  // CI / 外部注入
}

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * 审批超时扫描集成测试（主 PRD §3.2）：
 * 构造一条过期 PENDING 资料修改审批头，扫描后应变为 CANCELLED + OVERDUE。
 */
describe.skipIf(!DATABASE_URL)('processApprovalTimeoutScan', () => {
  let client: Client;
  let sql: SqlClient;
  let createdRequestId: number | null = null;
  let createdUserId: number | null = null;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    sql = {
      query: async (text: string, values?: readonly unknown[]) => {
        const result = await client.query(text, values as unknown[] | undefined);
        return { rowCount: result.rowCount };
      },
      queryRows: async <T>(text: string, values?: readonly unknown[]): Promise<T[]> => {
        const result = await client.query(text, values as unknown[] | undefined);
        return result.rows as T[];
      },
    };
  });

  afterAll(async () => {
    if (createdRequestId !== null) {
      await client.query(`DELETE FROM backstage.approval_actions WHERE request_id = $1`, [createdRequestId]);
      await client.query(`DELETE FROM backstage.profile_change_requests WHERE request_id = $1`, [createdRequestId]);
      await client.query(`DELETE FROM backstage.approval_requests WHERE id = $1`, [createdRequestId]);
    }
    if (createdUserId !== null) {
      await client.query(`DELETE FROM base.users WHERE id = $1`, [createdUserId]);
    }
    await client.end();
  });

  it('超时 PENDING 被 AUTO_CANCEL 且 cancel_source=OVERDUE', async () => {
    const phone = `+86139${String(Date.now()).slice(-8)}`;
    const userRes = await client.query<{ id: number }>(
      `INSERT INTO base.users (name, gender, phone, status, is_super_admin, password_hash, created_at, updated_at)
       VALUES ('超时扫描测', 'MALE', $1, 'ACTIVE', false, 'x', NOW(), NOW())
       RETURNING id`,
      [phone],
    );
    createdUserId = userRes.rows[0]!.id;

    const oldSubmitted = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const appNo = `PC_TIMEOUT_${Date.now()}`;
    const reqRes = await client.query<{ id: number }>(
      `INSERT INTO backstage.approval_requests (
         application_no, request_type, applicant_id, applicant_name, status, version, submitted_at, created_at, updated_at
       ) VALUES ($1, 'PROFILE_CHANGE', $2, '超时扫描测', 'PENDING', 1, $3, NOW(), NOW())
       RETURNING id`,
      [appNo, createdUserId, oldSubmitted.toISOString()],
    );
    createdRequestId = reqRes.rows[0]!.id;
    await client.query(
      `INSERT INTO backstage.profile_change_requests (
         request_id, user_id, user_name, old_name, new_name, old_gender, new_gender
       ) VALUES ($1, $2, '超时扫描测', '超时扫描测', '新名', 'MALE', 'FEMALE')`,
      [createdRequestId, createdUserId],
    );

    await client.query(
      `INSERT INTO backstage.system_settings (key, value, value_type, "group", label, sensitive, created_at, updated_at)
       VALUES ('approval.timeout.cancel.days', '30', 'NUMBER', 'PLATFORM', '审批超时天数', false, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET value = '30'`,
    );

    const ctx: ProcessorContext = {
      sql,
      leaseOwner: 'test',
      deployCommit: 'test',
    };
    const task: BackgroundTaskRow = {
      taskUuid: '00000000-0000-4000-8000-000000000001',
      taskType: 'APPROVAL_TIMEOUT_SCAN',
      module: 'backstage',
      initiatorId: null,
      initiatorType: 'SCHEDULER',
      ref: {},
      status: 'RUNNING',
      progress: 0,
      attempts: 1,
    };
    await processApprovalTimeoutScan(task, ctx);

    const status = await client.query<{ status: string; cancel_source: string | null }>(
      `SELECT status::text AS status, cancel_source::text AS cancel_source
       FROM backstage.approval_requests WHERE id = $1`,
      [createdRequestId],
    );
    expect(status.rows[0]?.status).toBe('CANCELLED');
    expect(status.rows[0]?.cancel_source).toBe('OVERDUE');

    const actions = await client.query<{ action: string }>(
      `SELECT action::text AS action FROM backstage.approval_actions WHERE request_id = $1`,
      [createdRequestId],
    );
    expect(actions.rows.some((row) => row.action === 'AUTO_CANCEL')).toBe(true);
  });
});
