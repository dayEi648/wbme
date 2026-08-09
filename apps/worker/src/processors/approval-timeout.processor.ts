import { scanAndAutoCancelOverdue } from '@wbme/approval';
import type { BackgroundTaskRow } from '@wbme/tasks';
import { createAssetAutoCancelHook } from './approval-timeout.asset-release';
import type { ProcessorContext } from './types';

/** 系统设置键：审批超时自动取消天数（默认 30） */
const SETTING_KEY_APPROVAL_TIMEOUT_DAYS = 'approval.timeout.cancel.days';

/** 默认超时天数 */
const DEFAULT_APPROVAL_TIMEOUT_DAYS = 30;

/**
 * 待审批超时自动取消扫描（主 PRD §3.2，含 asset 占用释放）。
 *
 * 读取系统设置 `approval.timeout.cancel.days`，扫描 backstage/hr/asset 三 schema
 * 中已超时的 PENDING 审批头，条件更新为 CANCELLED（cancel_source=OVERDUE）并写入
 * AUTO_CANCEL 动作流水。asset 业务占用释放经 hook 与状态迁移同一事务执行
 * （崩溃整体回滚、头保持 PENDING、下轮扫描重试）：
 * 申领/库存变更释放库存占用与额度占用；借还与结清为派生占用无需回写。
 *
 * @param task 任务行
 * @param ctx 处理器上下文
 */
export async function processApprovalTimeoutScan(task: BackgroundTaskRow, ctx: ProcessorContext): Promise<void> {
  const timeoutDays = await readTimeoutDays(ctx);
  const assetHook = createAssetAutoCancelHook();
  const counts = await scanAndAutoCancelOverdue(ctx.sql, timeoutDays, new Date(), { asset: assetHook });
  console.log(
    `[processor] APPROVAL_TIMEOUT_SCAN 完成 taskUuid=${task.taskUuid} days=${timeoutDays}` +
      ` backstage=${counts.backstage} hr=${counts.hr} asset=${counts.asset}` +
      ` (asset 释放：库存条目 ${assetHook.stats.inventoryItems}、额度占用 ${assetHook.stats.quotaOccupations}、派生占用跳过 ${assetHook.stats.skipped})`,
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
