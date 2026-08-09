import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';

/**
 * 审批超时扫描占位（T5-1 @wbme/approval 接入）。
 *
 * @param task 任务行
 * @param _ctx 处理器上下文
 */
export async function processApprovalTimeoutScan(task: BackgroundTaskRow, _ctx: ProcessorContext): Promise<void> {
  console.log(`[processor] APPROVAL_TIMEOUT_SCAN 占位成功 taskUuid=${task.taskUuid}`);
}
