import { Inject, Injectable } from '@nestjs/common';
import {
  ASSET_CONFIG_FUNCTION_CODE,
  BusinessException,
  frameworkErrors,
} from '@wbme/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';

/** 系统内置顶级分类（asset PRD §3；"车辆"顶级分类本期不提供） */
export const TOP_LEVEL_CATEGORIES = ['固定资产', '消耗品'] as const;

/** 分类行（对外输出） */
export interface CategoryItem {
  id: number;
  parentId: number | null;
  name: string;
  sort: number;
  status: string;
}

/**
 * 资产分类服务（asset PRD §3、§12；A-1）。
 *
 * 分类体系：系统内置「固定资产 / 消耗品」两个顶级分类（不可增删改）；业务人员
 * 只维护其下的一级子分类（不能继续建立下级分类）；子分类名称在同一顶级分类下唯一；
 * 分类按主 PRD §2.6 批量硬删除——资产与品种只保存分类名称快照，删除前校验引用，
 * 任一项被引用则整批拒绝；仍可随时停用。
 */
@Injectable()
export class CategoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 初始化内置顶级分类（幂等：已存在同名顶级分类则跳过；应用启动调用）。
   */
  async ensureDefaults(): Promise<void> {
    for (const [index, name] of TOP_LEVEL_CATEGORIES.entries()) {
      const existing = await this.prisma.client.assetCategory.findFirst({ where: { parentId: null, name } });
      if (!existing) {
        await this.prisma.client.assetCategory.create({
          data: { parentId: null, name, sort: index, createdBy: null },
        });
      }
    }
  }

  /**
   * 分类全量列表（顶级 + 一级子分类平铺；前端按 parentId 组装）。
   *
   * @returns 分类列表（按排序、id）
   */
  async list(): Promise<{ items: CategoryItem[] }> {
    await this.ensureDefaults();
    const rows = await this.prisma.client.assetCategory.findMany({
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
    return { items: rows };
  }

  /**
   * 创建一级子分类（幂等；顶级分类只能系统内置，不能继续建立下级分类）。
   *
   * @param operator 操作人
   * @param input 分类输入
   * @returns 分类 id
   * @throws VALIDATION_FAILED 父级非法/同顶级分类下重名
   */
  async create(
    operator: AssetOperationLogOperator,
    input: { parentId?: number; name: string; sort?: number; idempotencyKey?: string },
  ): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.category.create',
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        const parent = await this.assertValidParent(tx, input.parentId);
        try {
          const row = await tx.assetCategory.create({
            data: {
              parentId: parent?.id ?? null,
              name: input.name,
              sort: input.sort ?? 0,
              createdBy: operator.id,
            },
          });
          return {
            result: { id: row.id },
            actionType: 'CREATE' as const,
            summary: `在资产配置中新增了分类：${input.name}`,
          };
        } catch (error) {
          // 同一顶级分类下名称唯一（A-1 部分唯一索引）
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '同一顶级分类下已存在同名分类' });
          }
          throw error;
        }
      },
    });
  }

  /**
   * 编辑分类（名称/排序/状态；停用不影响历史引用）。
   *
   * @param operator 操作人
   * @param id 分类 id
   * @param input 分类输入
   * @throws RESOURCE_NOT_FOUND 分类不存在；VALIDATION_FAILED 重名
   */
  async update(
    operator: AssetOperationLogOperator,
    id: number,
    input: { name: string; sort: number; status: 'ACTIVE' | 'DISABLED' },
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.category.update',
      idempotencyKey,
      fingerprint: fingerprintPayload({ ...input, id }),
      run: async (tx) => {
        const existing = await tx.assetCategory.findUnique({ where: { id } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (existing.parentId === null) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '顶级分类为系统内置，不允许编辑' });
        }
        try {
          await tx.assetCategory.update({
            where: { id },
            data: { name: input.name, sort: input.sort, status: input.status, updatedBy: operator.id },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '同一顶级分类下已存在同名分类' });
          }
          throw error;
        }
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `更新了分类：${existing.name} → ${input.name}`,
        };
      },
    });
  }

  /**
   * 分类批量删除前引用预览（asset PRD §3/§12；主 PRD §2.6）：
   * 返回每个目标仍被引用的情况（现存资产数/品种数），引用本身不阻断删除；
   * 前端展示并要求确认后调用 batchDelete 物理删除。
   *
   * @param ids 分类 id 列表
   * @returns 逐分类引用统计
   * @throws RESOURCE_NOT_FOUND 任一目标不存在
   */
  async deletePreview(ids: readonly number[]): Promise<{ items: Array<{ id: number; assetCount: number; consumableCount: number }> }> {
    const rows = await this.prisma.client.assetCategory.findMany({ where: { id: { in: [...ids] } } });
    if (rows.length !== ids.length) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const counts = await this.prisma.client.$queryRaw<Array<{ id: number; asset_count: bigint; consumable_count: bigint }>>`
      SELECT c.id,
        (SELECT COUNT(*) FROM asset.assets a WHERE a.category_id = c.id AND a.deleted_at IS NULL) AS asset_count,
        (SELECT COUNT(*) FROM asset.consumables co WHERE co.category_id = c.id) AS consumable_count
      FROM asset.asset_categories c
      WHERE c.id = ANY(${ids as number[]})
    `;
    const byId = new Map(counts.map((row) => [Number(row.id), row]));
    return {
      items: ids.map((id) => {
        const row = byId.get(id);
        return { id, assetCount: Number(row?.asset_count ?? 0), consumableCount: Number(row?.consumable_count ?? 0) };
      }),
    };
  }

  /**
   * 分类批量硬删除（主 PRD §2.6 确认式删除：引用预览后确认执行；
   * 资产与品种只保存分类名称快照，删除不阻断也不追溯改写历史）。
   *
   * @param operator 操作人
   * @param ids 分类 id 列表
   * @returns 删除结果
   * @throws VALIDATION_FAILED 目标含顶级分类
   */
  async batchDelete(operator: AssetOperationLogOperator, ids: readonly number[], idempotencyKey?: string): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.category.delete',
      idempotencyKey,
      fingerprint: fingerprintPayload({ ids }),
      run: async (tx) => {
        const rows = await tx.assetCategory.findMany({ where: { id: { in: [...ids] } } });
        if (rows.length !== ids.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        if (rows.some((row) => row.parentId === null)) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '顶级分类为系统内置，不允许删除' });
        }
        const result = await tx.assetCategory.deleteMany({ where: { id: { in: [...ids] } } });
        return {
          result: { deleted: result.count },
          actionType: 'DELETE' as const,
          summary: `删除了 ${result.count} 个分类`,
        };
      },
    });
  }

  /**
   * 校验父分类合法：顶级（null）或指向一个顶级分类；不允许再建立下级分类。
   *
   * @param tx 事务客户端
   * @param parentId 目标父分类 id
   * @returns 父分类行（null = 顶级）
   * @throws VALIDATION_FAILED 父级不存在或不是顶级分类
   */
  private async assertValidParent(
    tx: Prisma.TransactionClient,
    parentId?: number,
  ): Promise<{ id: number } | null> {
    if (parentId === undefined || parentId === null) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
        reason: '顶级分类为系统内置（固定资产 / 消耗品），业务只能在其下维护一级子分类',
      });
    }
    const parent = await tx.assetCategory.findUnique({ where: { id: parentId } });
    if (!parent || parent.parentId !== null) {
      throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '父分类不存在或不是顶级分类' });
    }
    return parent;
  }

}
