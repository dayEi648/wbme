import { Prisma } from '../generated/prisma/client';

/**
 * 组织版本递增（H-1 org_meta 单行，docs/database-design/hr.md）。
 *
 * - user_org_version：用户组织关系事务递增（员工部门/岗位编排、岗位申请批准生效）；
 * - org_tree_version：部门树结构事务递增（父节点/停用/删除等改变部门范围闭包的变更）。
 * base PRD §3 的守卫缓存版本校验（pv/ov/otv/dv）以两者为组织维度事实来源；
 * 当前无授权缓存（无失效窗口），仍须在对应事务内递增，供缓存接入后立即生效。
 */

/** org_meta 单行主键（H-1：CHECK id = 1 由迁移 SQL 保证） */
const ORG_META_ID = 1;

/**
 * 递增用户组织版本（单行 UPSERT）。
 *
 * @param tx 事务客户端（与业务写入同事务）
 */
export async function bumpUserOrgVersion(tx: Prisma.TransactionClient): Promise<void> {
  await tx.orgMeta.upsert({
    where: { id: ORG_META_ID },
    create: { id: ORG_META_ID, userOrgVersion: 1 },
    update: { userOrgVersion: { increment: 1 } },
  });
}

/**
 * 递增组织树版本（单行 UPSERT）。
 *
 * @param tx 事务客户端（与业务写入同事务）
 */
export async function bumpOrgTreeVersion(tx: Prisma.TransactionClient): Promise<void> {
  await tx.orgMeta.upsert({
    where: { id: ORG_META_ID },
    create: { id: ORG_META_ID, orgTreeVersion: 1 },
    update: { orgTreeVersion: { increment: 1 } },
  });
}
