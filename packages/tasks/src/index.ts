/**
 * @wbme/tasks 包入口
 * 统一后台任务事实表（backstage schema）的受限创建与状态条件更新接口
 * （主 PRD §9.1，T4-2 实现完整调度/投递/消费；本包当前提供任务类型常量、
 * 稳定业务键 UUID 与任务 ref 负载契约——受限创建的承载语句仍由各部署单元
 * 在自己的事务内写入 background_tasks，T4-2 统一为受限接口）。
 */

import { createHash } from 'node:crypto';

/**
 * 任务类型：账号生命周期处理（backstage PRD §3；主 PRD §9.1 本期任务清单）。
 * 注销时由 platform-core 逐用户写入（PENDING_ENQUEUE），hr 消费：
 * 幂等取消注销发生前已提交且仍待审批的岗位申请；恢复时若任务尚未消费，
 * hr 在恢复应用事务中先行幂等处理（之后到达的原任务只作幂等确认）。
 */
export const TASK_TYPE_ACCOUNT_LIFECYCLE = 'ACCOUNT_LIFECYCLE';

/** 账号生命周期任务 ref 负载（background_tasks.ref；稳定业务键的组成部分） */
export interface AccountLifecycleTaskRef {
  /** 生命周期事件（本期仅注销；恢复不产生任务） */
  event: 'DEACTIVATED';
  /** 目标用户 id */
  userId: number;
  /** 注销时间（ISO 8601） */
  deactivatedAt: string;
  /** 注销后的账号生命周期版本（users.lifecycle_version；恢复确认携带校验，幂等键组成部分） */
  lifecycleVersion: number;
}

/**
 * 由稳定业务键派生确定性任务 UUID（v5 形态，主 PRD §9.1 稳定 jobId 语义）：
 * 同一业务事实重复写入得到同一 UUID，配合 background_tasks.task_uuid 唯一约束去重。
 *
 * @param businessKey 稳定业务键（如 `ACCOUNT_LIFECYCLE:DEACTIVATED:{userId}:{lifecycleVersion}`）
 * @returns UUID 字符串（SHA-256 截断，version=5/variant=10 位型）
 */
export function stableTaskUuid(businessKey: string): string {
  const hex = createHash('sha256').update(businessKey).digest('hex');
  const variantNibble = (parseInt(hex.charAt(16), 16) & 0x3) | 0x8;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variantNibble.toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
