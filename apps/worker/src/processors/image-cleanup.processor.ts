import type { BackgroundTaskRow } from '@wbme/tasks';
import type { ProcessorContext } from './types';

/**
 * 未关联图片清理占位（T4-10 @wbme/files 接入）。
 *
 * @param task 任务行
 * @param _ctx 处理器上下文
 */
export async function processImageCleanup(task: BackgroundTaskRow, _ctx: ProcessorContext): Promise<void> {
  console.log(`[processor] UNASSOCIATED_IMAGE_CLEANUP 占位成功 taskUuid=${task.taskUuid}`);
}
