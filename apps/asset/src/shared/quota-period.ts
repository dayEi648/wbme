import { Prisma } from '../generated/prisma/client';
import type { QuotaCycle } from '../generated/prisma/enums';

/**
 * 申领额度周期工具（asset PRD §5/§12；T7 建立）。
 *
 * - 周期边界按北京时间（UTC+8，主 PRD §9.10）计算；
 * - 月/季/年上限分别在每个自然月 / 季度首月 / 每年 1 月的「申领上限重置日」重置；
 * - 周期键表达周期起点：如重置日 15 号时 2026-07-15 ~ 2026-08-14 归属 `2026-07`；
 *   重置日变更只影响之后开始的周期（新提交自然落入新键，旧键行不追溯改写）；
 * - 额度"事实"没有独立聚合表（使用量 = quota_occupations 中 CONSUMED 之和，
 *   占用 = RESERVED 之和），行不存在无法 FOR UPDATE，须用事务级咨询锁串行化
 *   同一 (员工, 品种, 周期) 键的并发提交。
 */

/** 北京时间偏移（毫秒） */
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 计算提交时间所属的额度周期键（北京时间）。
 *
 * @param now 提交时间
 * @param cycle 周期类型（MONTH / QUARTER / YEAR）
 * @param resetDay 申领上限重置日（1～28；asset_settings 全局参数）
 * @returns 周期键：`2026-08` / `2026-Q3` / `2026`
 */
export function computeCycleKey(now: Date, cycle: QuotaCycle, resetDay: number): string {
  const bj = new Date(now.getTime() + BJ_OFFSET_MS);
  const year = bj.getUTCFullYear();
  const month = bj.getUTCMonth() + 1;
  const day = bj.getUTCDate();
  if (cycle === 'YEAR') {
    // 1 月重置日之前 → 上一自然年；之后 → 本自然年
    return day < resetDay && month === 1 ? `${year - 1}` : `${year}`;
  }
  if (cycle === 'QUARTER') {
    const firstMonth = Math.floor((month - 1) / 3) * 3 + 1; // 1 / 4 / 7 / 10
    if (day < resetDay && month === firstMonth) {
      // 季度首月重置日之前 → 上一季度首月
      const prevFirst = firstMonth === 1 ? { y: year - 1, m: 10 } : { y: year, m: firstMonth - 3 };
      return `${prevFirst.y}-Q${Math.ceil(prevFirst.m / 3)}`;
    }
    return `${year}-Q${Math.ceil(firstMonth / 3)}`;
  }
  // MONTH：当月重置日之前 → 上一自然月
  if (day < resetDay) {
    const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
    return `${prev.y}-${String(prev.m).padStart(2, '0')}`;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * 按固定顺序（排序后）获取事务级咨询锁，串行化同键额度并发提交。
 *
 * @param tx 事务客户端
 * @param keys 咨询锁键（调用方按 `asset.quota.<userId>.<consumableId>.<cycleKey>` 构造）
 */
export async function acquireQuotaAdvisoryLocks(tx: Prisma.TransactionClient, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${key}))
    `;
  }
}
