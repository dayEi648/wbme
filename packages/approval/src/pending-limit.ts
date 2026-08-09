import { BusinessException, approvalErrors } from '@wbme/contracts';

/**
 * 判断错误是否为 Prisma 唯一约束冲突（P2002）。
 *
 * @param error 捕获的异常
 * @returns 是否唯一冲突
 */
export function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * 将条件唯一索引冲突映射为 PENDING_LIMIT_REACHED（主 PRD §3.2）。
 * 非唯一冲突原样抛出。
 *
 * @param error 捕获的异常
 * @throws PENDING_LIMIT_REACHED 或原错误
 */
export function mapPendingLimitError(error: unknown): never {
  if (error instanceof BusinessException) {
    throw error;
  }
  if (isPrismaUniqueViolation(error)) {
    throw new BusinessException(approvalErrors.PENDING_LIMIT_REACHED);
  }
  throw error;
}

/**
 * 包装异步提交：唯一冲突 → PENDING_LIMIT_REACHED。
 *
 * @param run 提交事务
 * @returns 提交结果
 */
export async function withPendingLimitMapping<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    mapPendingLimitError(error);
  }
}
