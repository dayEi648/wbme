import type { BackgroundTaskRow } from '@wbme/tasks';
import type { SqlClient } from '@wbme/tasks';

/** 任务处理器上下文 */
export interface ProcessorContext {
  sql: SqlClient;
  leaseOwner: string;
  deployCommit: string;
}

/** 任务处理器 */
export type TaskProcessor = (task: BackgroundTaskRow, ctx: ProcessorContext) => Promise<void>;
