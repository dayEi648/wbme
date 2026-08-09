import { scanAndAutoCancelOverdue } from '@wbme/approval';
import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';

/** 系统设置键：审批超时自动取消天数（默认 30） */
const SETTING_KEY_APPROVAL_TIMEOUT_DAYS = 'approval.timeout.cancel.days';

/** 默认超时天数 */
const DEFAULT_APPROVAL_TIMEOUT_DAYS = 30;

/**
 * 待审批超时自动取消扫描（主 PRD §3.2 / T5-1）。
 *
 * 读取系统设置 `approval.timeout.cancel.days`，扫描 backstage/hr/asset 三 schema
 * 中已超时的 PENDING 审批头，条件更新为 CANCELLED（cancel_source=OVERDUE）并写入
 * AUTO_CANCEL 动作流水。业务占用释放 hook：asset 借还占用释放随 T7-8 接入
 * （占用转换原子、超时取消释放占用；本阶段仅状态迁移）。
 *
 * @param task 任务行
 * @param ctx 处理器上下文
 */
export async function processApprovalTimeoutScan(task: BackgroundTaskRow, ctx: ProcessorContext): Promise<void> {
  const timeoutDays = await readTimeoutDays(ctx);
  const counts = await scanAndAutoCancelOverdue(ctx.sql, timeoutDays, new Date());
  console.log(
    `[processor] APPROVAL_TIMEOUT_SCAN 完成 taskUuid=${task.taskUuid} days=${timeoutDays}` +
      ` backstage=${counts.backstage} hr=${counts.hr} asset=${counts.asset}`,
  );
}

/**
 * 读取审批超时天数；缺省或非法回退 30。
 *
 * @param ctx 处理器上下文
 * @returns 超时天数
 */
async function readTimeoutDays(ctx: ProcessorContext): Promise<number> {
  const rows = await ctx.sql.queryRows<{ value: string }>(
    `SELECT value FROM backstage.system_settings WHERE key = $1 LIMIT 1`,
    [SETTING_KEY_APPROVAL_TIMEOUT_DAYS],
  );
  const parsed = Number(rows[0]?.value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 365 ? Math.floor(parsed) : DEFAULT_APPROVAL_TIMEOUT_DAYS;
}
