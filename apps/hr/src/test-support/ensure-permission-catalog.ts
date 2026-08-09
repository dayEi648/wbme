import { PERMISSION_CATALOG } from '@wbme/contracts';
import type { PrismaService } from '../prisma.service';

/**
 * 集成测试前置：确保权限目录已在测试库注册（实现规划 T1-5 / T3-1）。
 *
 * 背景：CI 的 PostgreSQL 只执行迁移（不跑 seed、不启动应用钩子），`systems`/
 * `business_sections`/`functions` 为空；本地 dev 库则已被 seed/对账写入。
 * 依赖目录的 spec 若不自备注册，会在 CI 因 FUNCTION_NOT_REGISTERED 失败。
 *
 * 幂等：全部 ON CONFLICT DO NOTHING；只做首次注册（对账语义是 platform-core
 * T3-1 的职责，此处不覆盖已注册行）。
 *
 * @param prisma 集成测试使用的 PrismaService
 */
export async function ensurePermissionCatalog(prisma: PrismaService): Promise<void> {
  for (const system of PERMISSION_CATALOG) {
    await prisma.client.$executeRaw`
      INSERT INTO backstage.systems (code, name, product_status, sort, created_at, updated_at)
      VALUES (${system.code}, ${system.name}, ${system.productStatus}::backstage."ProductStatus", 0, NOW(), NOW())
      ON CONFLICT (code) DO NOTHING
    `;
    const systemRows = await prisma.client.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM backstage.systems WHERE code = ${system.code} LIMIT 1
    `;
    const systemId = systemRows[0]?.id;
    if (systemId === undefined) {
      throw new Error(`权限目录注册失败：系统 ${system.code} 未找到`);
    }
    for (const [sectionSort, section] of system.sections.entries()) {
      await prisma.client.$executeRaw`
        INSERT INTO backstage.business_sections (system_id, code, name, description, sort, created_at, updated_at)
        VALUES (${systemId}, ${section.code}, ${section.name}, ${section.description ?? null}, ${sectionSort}, NOW(), NOW())
        ON CONFLICT (system_id, code) DO NOTHING
      `;
      const sectionRows = await prisma.client.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM backstage.business_sections WHERE system_id = ${systemId} AND code = ${section.code} LIMIT 1
      `;
      const sectionId = sectionRows[0]?.id;
      if (sectionId === undefined) {
        throw new Error(`权限目录注册失败：板块 ${system.code}:${section.code} 未找到`);
      }
      for (const [functionSort, fn] of section.functions.entries()) {
        await prisma.client.$executeRaw`
          INSERT INTO backstage.functions
            (system_id, section_id, code, name, data_scope_options, sort, description, created_at, updated_at)
          VALUES (${systemId}, ${sectionId}, ${fn.code}, ${fn.name},
                  ${[...fn.dataScopeOptions]}, ${functionSort}, ${fn.description ?? null}, NOW(), NOW())
          ON CONFLICT (code) DO NOTHING
        `;
      }
    }
  }
}
