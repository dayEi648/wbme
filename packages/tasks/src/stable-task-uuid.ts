import { createHash } from 'node:crypto';

/**
 * 由稳定业务键派生确定性任务 UUID（v5 形态，主 PRD §9.1 稳定 jobId 语义）。
 *
 * @param businessKey 稳定业务键（如 `ACCOUNT_LIFECYCLE:DEACTIVATED:{userId}:{lifecycleVersion}`）
 * @returns UUID 字符串（SHA-256 截断，version=5/variant=10 位型）
 */
export function stableTaskUuid(businessKey: string): string {
  const hex = createHash('sha256').update(businessKey).digest('hex');
  const variantNibble = (parseInt(hex.charAt(16), 16) & 0x3) | 0x8;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variantNibble.toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
