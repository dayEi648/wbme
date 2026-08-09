import type { RestoreDeliveryTaskRef } from '@wbme/tasks';
import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';

/**
 * 恢复投递处理器：将 RESTORE_DELIVERY 可靠交给 recovery-executor（backstage PRD §10）。
 *
 * @param task 任务行
 * @param _ctx 处理器上下文
 * @throws 投递失败（由 Worker 重试/终态失败）
 */
export async function processRestoreDelivery(task: BackgroundTaskRow, _ctx: ProcessorContext): Promise<void> {
  const ref = task.ref as RestoreDeliveryTaskRef | null;
  if (!ref?.restoreUuid || !ref.backupId) {
    throw new Error('恢复投递任务 ref 无效');
  }
  const token = process.env.INTERNAL_SERVICE_TOKEN?.trim();
  if (!token) {
    throw new Error('INTERNAL_SERVICE_TOKEN 未配置，无法投递恢复请求');
  }
  const baseUrl = (process.env.RECOVERY_EXECUTOR_URL ?? 'http://127.0.0.1:3010').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/recovery/delivery`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-wbme-caller': 'worker',
    },
    body: JSON.stringify(ref),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`恢复执行器投递失败 HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
}
