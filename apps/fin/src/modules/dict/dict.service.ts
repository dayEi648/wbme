import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessException,
  FINANCE_CONFIG_FUNCTION_CODE,
  financeErrors,
  frameworkErrors,
  type FinDictItemCreateDto,
  type FinDictItemQueryDto,
  type FinDictItemUpdateDto,
} from '@wbme/contracts';
import { buildTablePrismaQuery, collectTableFilterFields, normalizeTableFilters } from '@wbme/server';
import { Prisma, type FinanceDictItem } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { executeIdempotentOperation, fingerprintPayload, type FinOperationLogOperator } from '../../shared/fin-operation-log.util';
import { isUnclassifiedReservedName } from '../../shared/name-normalize';
import { countProjectRefs } from '../project/project.service';

/**
 * 财务业务字典服务（fin PRD §6；F-6）。
 *
 * 类型：项目进度（PROGRESS，每个选项必须带金额语义 TENTATIVE/AUDITED，被引用后不可修改）、
 * 资料齐全度（COMPLETENESS）、业务分类（BIZ_CATEGORY，不得与系统虚拟分组“未分类”重名）、
 * 地区（REGION，跨系统地区选项统一在财务系统维护）。
 * 选项可新增/编辑/排序/启停；批量硬删除按主 PRD §2.6 确认式删除：删除预览逐目标返回
 * 被工程合同的引用数，引用不阻断删除，确认后物理删除（历史项目按删除前名称快照展示）。
 */
@Injectable()
export class DictService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 字典列表（分页；类型/状态筛选）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async list(query: FinDictItemQueryDto): Promise<{ items: FinanceDictItem[]; total: number }> {
    const structuredFields = query.filters
      ? collectTableFilterFields(normalizeTableFilters(query.filters))
      : new Set<string>();
    const where: Prisma.FinanceDictItemWhereInput = {};
    // filters 树中出现 dictType/status 时以树为准，具名参数让位
    if (query.dictType && !structuredFields.has('dictType')) {
      where.dictType = query.dictType;
    }
    if (query.status && !structuredFields.has('status')) {
      where.status = query.status;
    }
    const tableQuery = buildTablePrismaQuery(query, {
      id: { prismaField: 'id', type: 'number' },
      dictType: { prismaField: 'dictType', type: 'enum' },
      name: { prismaField: 'name', type: 'text' },
      semantic: { prismaField: 'semantic', type: 'enum' },
      status: { prismaField: 'status', type: 'enum' },
      sort: { prismaField: 'sort', type: 'number' },
    });
    const effectiveWhere: Prisma.FinanceDictItemWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.FinanceDictItemWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.financeDictItem.count({ where: effectiveWhere }),
      this.prisma.client.financeDictItem.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.FinanceDictItemOrderByWithRelationInput[] | undefined) ?? [{ sort: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /**
   * 创建字典项（幂等；同类型同名唯一；PROGRESS 必填语义；业务分类不得叫“未分类”）。
   *
   * @param operator 操作人
   * @param dto 字典项输入
   * @returns 字典项 id
   */
  async create(operator: FinOperationLogOperator, dto: FinDictItemCreateDto): Promise<{ id: number }> {
    return this.runDictWrite(operator, dto.idempotencyKey, 'fin.dict.create', dto, async (tx) => {
      if (dto.dictType === 'PROGRESS' && !dto.semantic) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
          fields: [{ field: 'semantic', reason: '项目进度必须声明金额语义' }],
        });
      }
      if (dto.dictType === 'BIZ_CATEGORY' && isUnclassifiedReservedName(dto.name)) {
        throw new BusinessException(financeErrors.UNCLASSIFIED_NAME_CONFLICT);
      }
      try {
        const row = await tx.financeDictItem.create({
          data: {
            dictType: dto.dictType,
            name: dto.name,
            semantic: dto.semantic ?? null,
            sort: dto.sort ?? 0,
            createdBy: operator.id,
          },
        });
        return {
          result: { id: row.id },
          actionType: 'CREATE' as const,
          summary: `在财务配置中新增了字典项：${dto.name}（${dictTypeName(dto.dictType)}）`,
        };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
            fields: [{ field: 'name', reason: '同类型下已存在同名字典项' }],
          });
        }
        throw error;
      }
    });
  }

  /**
   * 编辑字典项（名称/排序/状态；PROGRESS 语义已被项目引用后不可修改）。
   *
   * @param operator 操作人
   * @param id 字典项 id
   * @param dto 字典项输入
   * @returns 编辑结果
   */
  async update(operator: FinOperationLogOperator, id: number, dto: FinDictItemUpdateDto): Promise<{ ok: true }> {
    return this.runDictWrite(operator, dto.idempotencyKey, 'fin.dict.update', dto, async (tx) => {
      const existing = await tx.financeDictItem.findUnique({ where: { id } });
      if (!existing) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      if (existing.dictType === 'PROGRESS' && dto.semantic === undefined && !existing.semantic) {
        throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
          fields: [{ field: 'semantic', reason: '项目进度必须声明金额语义' }],
        });
      }
      if (existing.dictType === 'BIZ_CATEGORY' && isUnclassifiedReservedName(dto.name)) {
        throw new BusinessException(financeErrors.UNCLASSIFIED_NAME_CONFLICT);
      }
      // PROGRESS 语义被引用后不可修改（fin PRD §6：避免历史项目含义被全局改写）
      if (existing.dictType === 'PROGRESS' && dto.semantic !== undefined && dto.semantic !== existing.semantic) {
        const refs = await countProjectRefs(tx, [id]);
        if (refs.progress > 0) {
          throw new BusinessException(financeErrors.DICT_SEMANTIC_LOCKED);
        }
      }
      try {
        await tx.financeDictItem.update({
          where: { id },
          data: {
            name: dto.name,
            semantic: existing.dictType === 'PROGRESS' ? (dto.semantic ?? existing.semantic) : null,
            sort: dto.sort,
            status: dto.status,
            updatedBy: operator.id,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, {
            fields: [{ field: 'name', reason: '同类型下已存在同名字典项' }],
          });
        }
        throw error;
      }
      return {
        result: { ok: true as const },
        actionType: 'UPDATE' as const,
        summary: `在财务配置中更新了字典项：${existing.name} → ${dto.name}（${dictTypeName(existing.dictType)}）`,
      };
    });
  }

  /**
   * 字典项批量删除前引用预览（主 PRD §2.6）：逐目标返回被工程合同的引用数
   * （地区/进度/业务分类按 id 列统计，资料齐全度按 completeness_docs JSONB 数组元素统计，
   * 字典项 id 全局唯一，四项求和即该 id 的全部引用）；引用不阻断删除，
   * 前端展示明细并要求确认后调用 batchDelete 物理删除。
   *
   * @param ids 字典项 id 列表
   * @returns 逐字典项引用统计（按入参顺序）
   * @throws RESOURCE_NOT_FOUND 任一目标不存在
   */
  async deletePreview(ids: readonly number[]): Promise<{ items: Array<{ id: number; dictType: FinanceDictItem['dictType']; referencedCount: number }> }> {
    const rows = await this.prisma.client.financeDictItem.findMany({ where: { id: { in: [...ids] } } });
    if (rows.length !== ids.length) {
      throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
    }
    const counts = await this.prisma.client.$queryRaw<Array<{ id: number; referenced: bigint }>>`
      SELECT d.id,
        ((SELECT COUNT(*) FROM fin.projects p WHERE p.region_id = d.id)
         + (SELECT COUNT(*) FROM fin.projects p WHERE p.progress_id = d.id)
         + (SELECT COUNT(*) FROM fin.projects p WHERE p.biz_category_id = d.id)
         + (SELECT COUNT(*) FROM fin.projects p WHERE p.completeness_docs @> jsonb_build_array(jsonb_build_object('id', d.id)))) AS referenced
      FROM fin.finance_dict_items d
      WHERE d.id = ANY(${ids as number[]})
    `;
    const referencedById = new Map(counts.map((row) => [Number(row.id), Number(row.referenced)]));
    const typeById = new Map(rows.map((row) => [row.id, row.dictType]));
    return {
      items: ids.map((id) => ({
        id,
        dictType: typeById.get(id) as FinanceDictItem['dictType'],
        referencedCount: referencedById.get(id) ?? 0,
      })),
    };
  }

  /**
   * 字典项批量硬删除（主 PRD §2.6 确认式删除：删除预览展示逐目标引用明细、前端确认后执行；
   * 引用不阻断删除，历史项目按删除前名称快照展示，删除不追溯改写；幂等）。
   *
   * @param operator 操作人
   * @param ids 目标 id 列表
   * @param idempotencyKey 幂等键（同键重试返回原结果）
   * @returns 删除结果
   */
  async batchDelete(operator: FinOperationLogOperator, ids: readonly number[], idempotencyKey?: string): Promise<{ deleted: number }> {
    return this.runDictWrite(operator, idempotencyKey, 'fin.dict.delete', { ids }, async (tx) => {
      const rows = await tx.financeDictItem.findMany({ where: { id: { in: [...ids] } } });
      if (rows.length !== ids.length) {
        throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
      }
      const result = await tx.financeDictItem.deleteMany({ where: { id: { in: [...ids] } } });
      return {
        result: { deleted: result.count },
        actionType: 'DELETE' as const,
        summary: `在财务配置中删除了 ${result.count} 个字典项`,
      };
    });
  }

  /** 字典写操作统一事务封装（幂等 + 操作日志） */
  private async runDictWrite<T>(
    operator: FinOperationLogOperator,
    idempotencyKey: string | undefined,
    scope: string,
    fingerprintInput: object,
    run: (tx: Prisma.TransactionClient) => Promise<{ result: T; actionType: 'CREATE' | 'UPDATE' | 'DELETE'; summary: string }>,
  ): Promise<T> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: FINANCE_CONFIG_FUNCTION_CODE,
      scope,
      idempotencyKey,
      fingerprint: fingerprintPayload(fingerprintInput),
      run,
    });
  }
}

/** 字典类型展示名 */
function dictTypeName(dictType: 'PROGRESS' | 'COMPLETENESS' | 'BIZ_CATEGORY' | 'REGION'): string {
  switch (dictType) {
    case 'PROGRESS':
      return '项目进度';
    case 'COMPLETENESS':
      return '资料齐全度';
    case 'BIZ_CATEGORY':
      return '业务分类';
    case 'REGION':
      return '地区';
  }
}
