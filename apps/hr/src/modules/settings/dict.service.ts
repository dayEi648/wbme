import { Inject, Injectable } from '@nestjs/common';
import { BusinessException, HR_CONFIG_FUNCTION_CODE, HrDictQueryDto, frameworkErrors } from '@wbme/contracts';
import { buildTablePrismaQuery } from '@wbme/server';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  executeIdempotentOperation,
  fingerprintPayload,
  type HrOperationLogOperator,
} from '../../shared/hr-operation-log.util';

/**
 * 人事字典服务（hr PRD §9）：字典项随业务引入；表单只能使用启用选项；
 * 选项可新增、编辑、排序、停用，并按主 PRD §2.6 批量硬删除未被引用的字典项。
 * MVP 无业务字典引用表——引用校验点保留（referencedIds 恒为空数组），
 * 业务引入字典类型时在此接入引用计数，任一目标被引用则整批拒绝。
 */
@Injectable()
export class DictService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 字典列表（分页；可按类型/状态筛选）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async list(query: HrDictQueryDto): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.HrDictWhereInput = {};
    if (query.dictType) {
      where.dictType = query.dictType as Prisma.HrDictWhereInput['dictType'];
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
    const effectiveWhere: Prisma.HrDictWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.HrDictWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.hrDict.count({ where: effectiveWhere }),
      this.prisma.client.hrDict.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.HrDictOrderByWithRelationInput[] | undefined) ?? [{ sort: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
  }

  /**
   * 创建字典项（幂等）。
   *
   * @param operator 操作人
   * @param input 字典项
   * @returns 字典项 id
   * @throws VALIDATION_FAILED 同类型同名已存在
   */
  async create(
    operator: HrOperationLogOperator,
    input: { dictType: string; name: string; sort?: number; idempotencyKey?: string },
  ): Promise<{ id: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: HR_CONFIG_FUNCTION_CODE,
      scope: 'hr.dict.create',
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        try {
          const row = await tx.hrDict.create({
            data: {
              dictType: input.dictType as Prisma.HrDictCreateInput['dictType'],
              name: input.name,
              sort: input.sort ?? 0,
              createdBy: operator.id,
            },
          });
          return {
            result: { id: row.id },
            actionType: 'CREATE' as const,
            summary: `在人事配置中新增了字典项：${input.name}（${input.dictType}）`,
          };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '同类型字典项已存在' });
          }
          throw error;
        }
      },
    });
  }

  /**
   * 更新字典项（名称/排序/启停；停用不影响历史数据展示）。
   *
   * @param operator 操作人
   * @param id 字典项 id
   * @param input 更新内容
   */
  async update(
    operator: HrOperationLogOperator,
    id: number,
    input: { name?: string; sort?: number; status?: 'ACTIVE' | 'DISABLED'; idempotencyKey?: string },
  ): Promise<{ ok: true }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: HR_CONFIG_FUNCTION_CODE,
      scope: 'hr.dict.update',
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprintPayload(input),
      run: async (tx) => {
        const existing = await tx.hrDict.findUnique({ where: { id } });
        if (!existing) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        try {
          await tx.hrDict.update({
            where: { id },
            data: {
              name: input.name ?? existing.name,
              sort: input.sort ?? existing.sort,
              status: input.status ?? existing.status,
              updatedBy: operator.id,
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '同类型字典项已存在' });
          }
          throw error;
        }
        return { result: { ok: true }, actionType: 'UPDATE' as const, summary: `更新了字典项：${existing.name}` };
      },
    });
  }

  /**
   * 批量硬删除字典项（主 PRD §2.6 配置类规则）：任一目标被业务或历史记录引用时整批拒绝。
   * MVP 无引用表，引用检查点保留（恒通过）。
   *
   * @param operator 操作人
   * @param ids 目标 id 列表（1~100）
   * @returns 逐项结果（全部成功）
   * @throws RESOURCE_NOT_FOUND 任一目标不存在（整批不变更）
   */
  async deleteBatch(operator: HrOperationLogOperator, ids: number[], idempotencyKey?: string): Promise<{ deleted: number }> {
    return executeIdempotentOperation(this.prisma.client, {
      operator,
      feature: HR_CONFIG_FUNCTION_CODE,
      scope: 'hr.dict.delete',
      idempotencyKey,
      fingerprint: fingerprintPayload({ ids }),
      run: async (tx) => {
        const existing = await tx.hrDict.findMany({ where: { id: { in: ids } } });
        if (existing.length !== ids.length) {
          throw new BusinessException(frameworkErrors.RESOURCE_NOT_FOUND);
        }
        // 引用校验点：业务引入字典类型后在此查询引用（任一被引用 → 整批拒绝）
        const referencedIds: number[] = [];
        if (referencedIds.length > 0) {
          throw new BusinessException(frameworkErrors.VALIDATION_FAILED, { reason: '字典项已被业务引用，不可删除' });
        }
        await tx.hrDict.deleteMany({ where: { id: { in: ids } } });
        return {
          result: { deleted: ids.length },
          actionType: 'DELETE' as const,
          summary: `删除了 ${ids.length} 个字典项`,
        };
      },
    });
  }
}
