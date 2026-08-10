import { PrismaClient } from '../generated/prisma/client';

/**
 * 为历史列表行补"申请人/用户已注销"标记（主 PRD §2.6：既有业务记录须返回并展示
 * 原 ID/姓名快照及"已注销"标记）。经 backstage.user_accounts 只读视图（含软删用户）
 * 批量关联 deleted_at，避免逐行查询。
 *
 * @param prisma asset Prisma 客户端（跨 schema 只读查询）
 * @param items 历史列表行（就地补标记，不改变行数与顺序）
 * @param idKey 行中用户 id 字段名（审批申请系 applicantId；借还系 userId）
 * @param flagKey 输出标记字段名（如 applicantDeactivated / userDeactivated）
 * @returns 无（就地修改 items）
 */
export async function attachDeactivatedFlags(
  prisma: PrismaClient,
  items: Array<Record<string, unknown>>,
  idKey: 'applicantId' | 'userId',
  flagKey: string,
): Promise<void> {
  const ids = [
    ...new Set(
      items
        .map((row) => row[idKey])
        .filter((value): value is number => typeof value === 'number'),
    ),
  ];
  if (ids.length === 0) {
    return;
  }
  const rows = await prisma.$queryRaw<Array<{ user_id: number; deleted_at: Date | null }>>`
    SELECT user_id, deleted_at
    FROM backstage.user_accounts
    WHERE user_id = ANY(${ids}::int[])
  `;
  const deactivated = new Set(
    rows.filter((row) => row.deleted_at !== null).map((row) => row.user_id),
  );
  for (const item of items) {
    const userId = item[idKey];
    if (typeof userId === 'number') {
      item[flagKey] = deactivated.has(userId);
    }
  }
}
