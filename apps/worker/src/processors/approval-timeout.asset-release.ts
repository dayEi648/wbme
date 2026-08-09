import type { ApprovalSchema, AutoCancelHook, OverdueApprovalRow } from '@wbme/approval';
import type { SqlClient } from '@wbme/tasks';

/** 释放统计（日志用） */
export interface AssetReleaseStats {
  inventoryItems: number;
  quotaOccupations: number;
  skipped: number;
}

/**
 * asset 超时自动取消的业务占用释放 hook（T7-8）。
 *
 * 审批超时取消时释放提交阶段的占用（与状态迁移同一事务，由
 * `scanAndAutoCancelOverdue` 的 transaction 化执行保证）：
 * - CONSUMABLE_REQUEST / AGENT_REQUEST：释放库存条目占用（reserved_qty −= 明细量）；
 * - CONSUMABLE_REQUEST：释放额度占用（quota_occupations RESERVED → RELEASED）；
 * - STOCK_CHANGE：释放库存条目占用（reserved_qty −= 明细量）；
 * - RETURN / WRITE_OFF / AGENT_SETTLEMENT：结构性 no-op——借还与结清占用为派生值
 *   （PENDING 头消失即释放），无需数据回写。
 *
 * @returns 释放 hook（含统计累计器）
 */
export function createAssetAutoCancelHook(): AutoCancelHook & { stats: AssetReleaseStats } {
  const stats: AssetReleaseStats = { inventoryItems: 0, quotaOccupations: 0, skipped: 0 };
  return {
    stats,
    async onAutoCancel(sql: SqlClient, _schema: ApprovalSchema, row: OverdueApprovalRow, _now: Date): Promise<void> {
      if (row.requestType === 'STOCK_CHANGE') {
        const updated = await sql.query(
          `
          UPDATE asset.inventory_items ii
          SET reserved_qty = reserved_qty - t.qty
          FROM (
            SELECT inventory_item_id, SUM(qty) AS qty
            FROM asset.stock_change_items
            WHERE request_id = $1
            GROUP BY inventory_item_id
          ) t
          WHERE ii.id = t.inventory_item_id
          `,
          [row.id],
        );
        stats.inventoryItems += updated.rowCount ?? 0;
        return;
      }
      if (row.requestType === 'CONSUMABLE_REQUEST' || row.requestType === 'AGENT_REQUEST') {
        const updated = await sql.query(
          `
          UPDATE asset.inventory_items ii
          SET reserved_qty = reserved_qty - t.qty
          FROM (
            SELECT inventory_item_id, SUM(qty) AS qty
            FROM asset.consumable_request_items
            WHERE request_id = $1
            GROUP BY inventory_item_id
          ) t
          WHERE ii.id = t.inventory_item_id
          `,
          [row.id],
        );
        stats.inventoryItems += updated.rowCount ?? 0;
        if (row.requestType === 'CONSUMABLE_REQUEST') {
          const quotaUpdated = await sql.query(
            `
            UPDATE asset.quota_occupations
            SET status = 'RELEASED'
            WHERE request_id = $1 AND status = 'RESERVED'
            `,
            [row.id],
          );
          stats.quotaOccupations += quotaUpdated.rowCount ?? 0;
        }
        return;
      }
      // RETURN / WRITE_OFF / AGENT_SETTLEMENT：派生占用随 PENDING 终态消失，无数据回写
      stats.skipped += 1;
    },
  };
}
