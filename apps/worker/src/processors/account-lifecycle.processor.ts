import type { AccountLifecycleTaskRef } from '@wbme/tasks';
import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';

/**
 * 账号生命周期处理器（T6-8 接入 hr 内部接口；当前为可测占位成功）。
 *
 * @param task 任务行
 * @param _ctx 处理器上下文
 */
export async function processAccountLifecycle(task: BackgroundTaskRow, _ctx: ProcessorContext): Promise<void> {
  const ref = task.ref as AccountLifecycleTaskRef | null;
  if (!ref || ref.event !== 'DEACTIVATED') {
    throw new Error('账号生命周期任务 ref 无效');
  }
  // TODO(T6-8): 调用 hr 内部接口幂等取消注销前待审批岗位申请
  console.log(`[processor] ACCOUNT_LIFECYCLE 占位成功 userId=${ref.userId} version=${ref.lifecycleVersion}`);
}
