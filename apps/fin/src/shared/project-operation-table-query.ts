import { type ProjectOperationQueryDto } from '@wbme/contracts';
import { buildTablePrismaQuery } from '@wbme/server';

/**
 * 编译项目操作记录结构化查询字段。
 *
 * 白名单只包含 ProjectOperation 标量列；projectName 来自 project relation，
 * 标准编译器不支持嵌套字段，故不注册。
 *
 * @param query 项目操作记录列表查询 DTO
 * @returns Prisma 条件和排序片段
 */
export function buildProjectOperationTableQuery(query: ProjectOperationQueryDto) {
  return buildTablePrismaQuery(query, {
    id: { prismaField: 'id', type: 'number' },
    projectId: { prismaField: 'projectId', type: 'number' },
    action: { prismaField: 'action', type: 'enum' },
    operatorName: { prismaField: 'operatorName', type: 'text' },
    createdAt: { prismaField: 'createdAt', type: 'date' },
  });
}
