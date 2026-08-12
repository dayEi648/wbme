import type { AccountLifecycleTaskRef } from '@wbme/tasks';
import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';

/**
 * 账号生命周期处理器：注销任务消费——调用 hr 内部接口
 * 幂等取消"注销前已提交且仍待审批"的岗位申请（cancelSource=ACCOUNT_DEACTIVATED）。
 *
 * - hr 暂时下线不阻塞整批注销（任务留存，恢复服务后继续处理）；
 * - hr 侧状态过滤天然幂等：重复投递/恢复兜底取消后到达的任务仅幂等确认；
 * - 失败抛错由 Worker 按任务重试策略处理。
 *
 * @param task 任务行
 * @param _ctx 处理器上下文
 */
export async function processAccountLifecycle(task: BackgroundTaskRow, _ctx: ProcessorContext): Promise<void> {
  const ref = task.ref as AccountLifecycleTaskRef | null;
  if (!ref || ref.event !== 'DEACTIVATED') {
    throw new Error('账号生命周期任务 ref 无效');
  }
  const token = process.env.INTERNAL_SERVICE_TOKEN?.trim();
  if (!token) {
    throw new Error('INTERNAL_SERVICE_TOKEN 未配置，无法调用 hr 取消岗位申请');
  }
  const baseUrl = (process.env.HR_INTERNAL_BASE_URL ?? 'http://localhost:43003').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/internal/v1/lifecycle/cancel-position-applications`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-wbme-caller': 'worker',
    },
    body: JSON.stringify({ userId: ref.userId, deactivatedAt: ref.deactivatedAt }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`hr 取消岗位申请失败 HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
}
