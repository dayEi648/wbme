import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';

/**
 * 备份任务处理器占位（T4-7 完整实现见 runImmediateBackup；当前默认 no-op 成功以便 Worker 联调）。
 *
 * @param task 任务行
 * @param _ctx 处理器上下文
 */
export async function processBackupStub(task: BackgroundTaskRow, _ctx: ProcessorContext): Promise<void> {
  console.log(`[processor] ${task.taskType} 占位成功（T4-7 processor 待实现）`);
}
