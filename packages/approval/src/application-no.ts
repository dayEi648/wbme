import { randomInt } from 'node:crypto';

/**
 * 生成申请编号（主 PRD §3.2：每条审批至少保留申请编号）。
 * 格式：`{prefix}{yyyyMMddHHmmss}{3位随机}`，前缀由业务类型声明（如 PC/OT/POS）。
 *
 * @param prefix 类型前缀（字母数字，建议 2～4 字符）
 * @param now 时间点（可注入便于测试）
 * @returns 申请编号
 */
export function generateApplicationNo(prefix: string, now: Date = new Date()): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  const hh = now.getUTCHours().toString().padStart(2, '0');
  const mm = now.getUTCMinutes().toString().padStart(2, '0');
  const ss = now.getUTCSeconds().toString().padStart(2, '0');
  const suffix = randomInt(100, 1000).toString();
  return `${prefix}${y}${m}${d}${hh}${mm}${ss}${suffix}`;
}

/** 资料修改申请编号前缀 */
export const APPLICATION_NO_PREFIX_PROFILE_CHANGE = 'PC';

/** 加班申请编号前缀 */
export const APPLICATION_NO_PREFIX_OVERTIME = 'OT';

/** 岗位变更申请编号前缀 */
export const APPLICATION_NO_PREFIX_POSITION_CHANGE = 'POS';

/** 资产申请编号前缀（按类型） */
export const APPLICATION_NO_PREFIX_ASSET: Readonly<Record<string, string>> = {
  STOCK_IN: 'SI',
  STOCK_CHANGE: 'SC',
  CONSUMABLE_REQUEST: 'CR',
  AGENT_REQUEST: 'AR',
  RETURN: 'RT',
  WRITE_OFF: 'WO',
  AGENT_SETTLEMENT: 'AS',
};
