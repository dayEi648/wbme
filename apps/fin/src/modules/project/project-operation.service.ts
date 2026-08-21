import { Inject, Injectable } from '@nestjs/common';
import { type ProjectOperationQueryDto } from '@wbme/contracts';
import { collectTableFilterFields, normalizeTableFilters } from '@wbme/server';
import { Prisma, type ProjectOperation } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { buildProjectOperationTableQuery } from '../../shared/project-operation-table-query';

/**
 * 项目操作记录服务（fin PRD §5；F-5）。
 *
 * 只读列表与详情；记录只追加、不能修改或删除，项目删除后操作记录仍保留。
 * 写入由业务服务在业务事务内调用 writeProjectChange 完成（与业务变更同一数据库事务）。
 */
@Injectable()
export class ProjectOperationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 操作记录列表（按时间倒序；可按项目过滤；携带项目名称，fin PRD §5）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async list(query: ProjectOperationQueryDto): Promise<{ items: unknown[]; total: number }> {
    const structuredFields = query.filters
      ? collectTableFilterFields(normalizeTableFilters(query.filters))
      : new Set<string>();
    const where: Prisma.ProjectOperationWhereInput = {};
    // filters 树中出现 projectId 时以树为准，具名参数让位
    if (query.projectId !== undefined && !structuredFields.has('projectId')) {
      where.projectId = query.projectId;
    }
    const tableQuery = buildProjectOperationTableQuery(query);
    const effectiveWhere: Prisma.ProjectOperationWhereInput = tableQuery.where
      ? { AND: [where, tableQuery.where as Prisma.ProjectOperationWhereInput] }
      : where;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.projectOperation.count({ where: effectiveWhere }),
      this.prisma.client.projectOperation.findMany({
        where: effectiveWhere,
        orderBy: (tableQuery.orderBy as Prisma.ProjectOperationOrderByWithRelationInput[] | undefined) ?? [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        // 项目列：join 项目名（含已软删项目——操作记录展示删除前名称）
        include: { project: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      items: rows.map((row: ProjectOperation & { project?: { name: string } | null }) => ({
        ...row,
        projectName: row.project?.name ?? null,
        project: undefined,
      })),
    };
  }

  /**
   * 操作记录详情（按字段展示变更前后内容）。
   *
   * @param id 记录 id
   * @returns 操作记录
   */
  async getDetail(id: number): Promise<unknown> {
    return this.prisma.client.projectOperation.findUnique({ where: { id } });
  }
}
