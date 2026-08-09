import { Inject, Injectable } from '@nestjs/common';
import {
  ASSET_CONFIG_FUNCTION_CODE,
  BusinessException,
  AssetDictItemQueryDto,
  assetErrors,
  frameworkErrors,
} from '@wbme/contracts';
import { buildTablePrismaQuery } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type AssetOperationLogOperator,
} from '../../shared/asset-operation-log.util';

/**
 * 资产业务字典服务（asset PRD §12；A-2）。
 *
 * 字典类型：单位 / 库存变更类型（仅表示意外扣减原因）/ 供应商 / 品牌 / 规格 /
 * 资产规格 / 资产型号。受控选项只能使用已启用值；停用值不能自动恢复；历史数据引用
 * 停用选项时保留原值展示。按主 PRD §2.6 提供批量硬删除，仅未被业务或历史记录引用的
 * 项可删除，任一项不可删除则整批回滚。
 */
/** 库存变更类型初始字典项（asset PRD §6「MVP 至少提供其他意外扣减」） */
const DEFAULT_CHANGE_TYPES = ['其他意外扣减'];

@Injectable()
export class DictService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 初始化内置字典项（幂等：同类型同名已存在则跳过；读路径惰性调用）。
   */
  async ensureDefaults(): Promise<void> {
    for (const [index, name] of DEFAULT_CHANGE_TYPES.entries()) {
      const existing = await this.prisma.client.assetDictItem.findFirst({
        where: { dictType: 'CHANGE_TYPE', name },
      });
      if (!existing) {
        await this.prisma.client.assetDictItem.create({
          data: { dictType: 'CHANGE_TYPE', name, sort: index, createdBy: null },
        });
      }
    }
  }

  /**
   * 字典列表（分页；可按类型/状态筛选）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async list(query: AssetDictItemQueryDto): Promise<{ items: unknown[]; total: number }> {
    await this.ensureDefaults();
    const where: Prisma.AssetDictItemWhereInput = {};
    if (query.dictType) {
      where.dictType = query.dictType as Prisma.AssetDictItemWhereInput['dictType'];
    }
    if (query.status) {
      where.status = query.status;
    }
    const tableQuery = buildTablePrismaQuery(query, {
      id: { prismaField: 'id', type: 'number' },
      dictType: { prismaField: 'dictType', type: 'enum' },
      name: { prismaField: 'name', type: 'text' },
      status: { prismaField: 'status', type: 'enum' },
      sort: { prismaField: 'sort', type: 'number' },
      createdAt: { prismaField: 'createdAt', type: 'date' },
      updatedAt: { prismaField: 'updatedAt', type: 'date' },
    });
    const effectiveWhere: Prisma.AssetDictItemWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.AssetDictItemWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.assetDictItem.count({ where: effectiveWhere }),
      this.prisma.client.assetDictItem.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.AssetDictItemOrderByWithRelationInput[] | undefined) ?? [{ sort: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /**
   * 创建字典项（幂等；同类型同名唯一）。
   *
   * @param operator 操作人
   * @param input 字典项输入
   * @returns 字典项 id
   * @throws VALIDATION_FAILED 同类型同名已存在
   */
  async create(
    operator: AssetOperationLogOperator,
    input: { dictType: string; name: string; sort?: number; idempotencyKey?: string },
  ): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.dict.create',
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        try {
          const row = await tx.assetDictItem.create({
            data: {
              dictType: input.dictType as Prisma.AssetDictItemCreateInput['dictType'],
              name: input.name,
              sort: input.sort ?? 0,
              createdBy: operator.id,
            },
          });
          return {
            result: { id: row.id },
            actionType: 'CREATE' as const,
            summary: `在资产配置中新增了字典项：${input.name}（${input.dictType}）`,
          };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '同类型下已存在同名字典项' });
          }
          throw error;
        }
      },
    });
  }

  /**
   * 编辑字典项（名称/排序/状态）。
   *
   * @param operator 操作人
   * @param id 字典项 id
   * @param input 字典项输入
   * @throws RESOURCE_NOT_FOUND 字典项不存在；VALIDATION_FAILED 重名
   */
  async update(
    operator: AssetOperationLogOperator,
    id: number,
    input: { name: string; sort: number; status: 'ACTIVE' | 'DISABLED' },
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.dict.update',
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        const existing = await tx.assetDictItem.findUnique({ where: { id } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        try {
          await tx.assetDictItem.update({
            where: { id },
            data: { name: input.name, sort: input.sort, status: input.status, updatedBy: operator.id },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '同类型下已存在同名字典项' });
          }
          throw error;
        }
        return {
          result: { ok: true },
          actionType: 'UPDATE' as const,
          summary: `更新了字典项：${existing.name} → ${input.name}（${existing.dictType}）`,
        };
      },
    });
  }

  /**
   * 字典项批量硬删除（引用检查：任一项被业务或历史记录引用则整批回滚）。
   *
   * @param operator 操作人
   * @param ids 字典项 id 列表
   * @returns 删除结果
   * @throws DICT_REFERENCED 任一字典项被引用
   */
  async batchDelete(operator: AssetOperationLogOperator, ids: readonly number[]): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: ASSET_CONFIG_FUNCTION_CODE,
      scope: 'asset.dict.delete',
      idempotencyKey: undefined,
      fingerprint: fingerprintPayload({ ids }),
      run: async (tx) => {
        const rows = await tx.assetDictItem.findMany({ where: { id: { in: [...ids] } } });
        if (rows.length !== ids.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        const referenced = await this.countReferenced(tx, ids);
        if (referenced > 0) {
          throw new BusinessException(assetErrors.DICT_REFERENCED, { referenced });
        }
        const result = await tx.assetDictItem.deleteMany({ where: { id: { in: [...ids] } } });
        return {
          result: { deleted: result.count },
          actionType: 'DELETE' as const,
          summary: `删除了 ${result.count} 个字典项`,
        };
      },
    });
  }

  /**
   * 统计字典项引用数（按类型落到对应业务表；规格/资产规格/资产型号为文字快照无 id 引用）。
   *
   * @param tx 事务客户端
   * @param ids 字典项 id 集合
   * @returns 引用总数
   */
  private async countReferenced(tx: Prisma.TransactionClient, ids: readonly number[]): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ total: bigint }>>`
      SELECT (
        (SELECT COUNT(*) FROM asset.consumables WHERE unit_id = ANY(${ids as number[]})) +
        (SELECT COUNT(*) FROM asset.batches WHERE supplier_id = ANY(${ids as number[]})) +
        (SELECT COUNT(*) FROM asset.batches WHERE brand_id = ANY(${ids as number[]})) +
        (SELECT COUNT(*) FROM asset.stock_in_items WHERE supplier_id = ANY(${ids as number[]})) +
        (SELECT COUNT(*) FROM asset.stock_in_items WHERE brand_id = ANY(${ids as number[]})) +
        (SELECT COUNT(*) FROM asset.stock_change_items WHERE change_type_id = ANY(${ids as number[]}))
      ) AS total
    `;
    return Number(rows[0]?.total ?? 0);
  }
}
