import { Inject, Injectable } from '@nestjs/common';
import { type ProjectOperationQueryDto } from '@wbme/contracts';
import { PrismaService } from '../../prisma.service';

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
   * 操作记录列表（按时间倒序；可按项目过滤）。
   *
   * @param query 查询参数
   * @returns items + total
   */
  async list(query: ProjectOperationQueryDto): Promise<{ items: unknown[]; total: number }> {
    const where = query.projectId !== undefined ? { projectId: query.projectId } : {};
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await Promise.all([
      this.prisma.client.projectOperation.count({ where }),
      this.prisma.client.projectOperation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, items: rows };
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
