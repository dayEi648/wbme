import type { Prisma } from '../../generated/prisma/client';

/**
 * 用户行锁共享工具（backstage 域批量写事务）。
 *
 * 按 id 升序 SELECT ... FOR UPDATE：串行化并发授权/注销/恢复写入并防死锁
 * （与单人保存的版本条件更新互斥：后者在锁释放后因版本不符返回 CONFLICT）。
 *
 * @param tx 事务客户端
 * @param userIds 目标用户标识（去重由调用方 DTO 保证）
 */
export async function lockUserRowsForUpdate(tx: Prisma.TransactionClient, userIds: readonly number[]): Promise<void> {
  await tx.$queryRaw`SELECT id FROM base.users WHERE id = ANY(${[...userIds]}::int[]) ORDER BY id FOR UPDATE`;
}
