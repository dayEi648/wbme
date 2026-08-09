import type { BackgroundTaskRow } from '@wbme/tasks';
import type { SqlClient } from '@wbme/tasks';
import type { FileStorageService } from '@wbme/files';

/** 任务处理器上下文 */
export interface ProcessorContext {
  sql: SqlClient;
  leaseOwner: string;
  deployCommit: string;
  /** 文件存储实例（缺省按环境创建；测试可注入替身） */
  storage?: FileStorageService;
}

/** 任务处理器 */
export type TaskProcessor = (task: BackgroundTaskRow, ctx: ProcessorContext) => Promise<void>;
