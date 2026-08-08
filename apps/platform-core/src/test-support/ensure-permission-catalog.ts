import { reconcilePermissionCatalog } from '../modules/backstage/permission-catalog/permission-catalog.reconcile';
import type { PrismaService } from '../prisma.service';

/**
 * 集成测试前置：确保权限目录已在测试库注册（实现规划 T3-1）。
 *
 * 背景：CI 的 PostgreSQL 只执行迁移（不跑 seed、不启动应用钩子），`systems`/
 * `business_sections`/`functions` 为空；本地 dev 库则已被 seed/对账写入。
 * 依赖目录的 spec 若不自备注册，会在 CI 因 FUNCTION_NOT_REGISTERED 偶发失败
 * （是否失败取决于并行 spec 的执行顺序）。
 *
 * `reconcilePermissionCatalog` 幂等且内部有单行锁 + ON CONFLICT，
 * 多个 spec 进程并发调用安全；无变化时零写入。
 *
 * @param prisma 集成测试使用的 PrismaService
 */
export async function ensurePermissionCatalog(prisma: PrismaService): Promise<void> {
  await reconcilePermissionCatalog(prisma.client);
}
