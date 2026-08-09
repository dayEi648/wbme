import type { CreatePendingTaskInput, TaskWriter } from './types';

/** Prisma Client 唯一约束冲突码 */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * 判断是否为 Prisma 唯一约束冲突。
 *
 * @param error 捕获的异常
 * @returns 是否唯一冲突
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code: string }).code === PRISMA_UNIQUE_VIOLATION
  );
}

/**
 * 将 Prisma TransactionClient 适配为 {@link TaskWriter}。
 *
 * @param tx 含 backgroundTask.create 的事务客户端
 * @returns TaskWriter 实现
 */
export function prismaTaskWriter(tx: unknown): TaskWriter {
  const client = tx as {
    backgroundTask: {
      create: (args: { data: Record<string, unknown> }) => Promise<{ taskUuid: string }>;
    };
  };
  return {
    async createPending(input: CreatePendingTaskInput): Promise<{ taskUuid: string; created: boolean }> {
      try {
        const row = await client.backgroundTask.create({
          data: {
            taskUuid: input.taskUuid,
            taskType: input.taskType,
            module: input.module,
            initiatorId: input.initiatorId ?? null,
            initiatorType: input.initiatorType,
            ref: input.ref ?? null,
            status: 'PENDING_ENQUEUE',
            nextRetryAt: new Date(),
          },
        });
        return { taskUuid: row.taskUuid, created: true };
      } catch (error) {
        // 稳定 taskUuid 冲突：同业务事实已写入，视为幂等命中（主 PRD §9.1）
        if (isUniqueViolation(error)) {
          return { taskUuid: input.taskUuid, created: false };
        }
        throw error;
      }
    },
  };
}

/**
 * 在事务内创建 PENDING_ENQUEUE 任务（platform-core 等调用方入口）。
 *
 * @param writer TaskWriter（通常为 prismaTaskWriter(tx)）
 * @param input 创建参数
 * @returns taskUuid 与是否新建
 */
export async function createPendingTask(
  writer: TaskWriter,
  input: CreatePendingTaskInput,
): Promise<{ taskUuid: string; created: boolean }> {
  return writer.createPending(input);
}
