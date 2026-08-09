import { buildTablePrismaQuery, type TableQueryInput } from '@wbme/server';

/**
 * 编译 asset 审批头共有的结构化查询字段。
 *
 * @param query 各申请历史 DTO 继承的分页查询字段
 * @returns 仅包含已登记审批头标量字段的 Prisma 条件与排序片段
 */
export function buildAssetApprovalRequestTableQuery(query: TableQueryInput) {
  return buildTablePrismaQuery(query, {
    id: { prismaField: 'id', type: 'number' },
    applicationNo: { prismaField: 'applicationNo', type: 'text' },
    requestType: { prismaField: 'requestType', type: 'enum' },
    applicantId: { prismaField: 'applicantId', type: 'number' },
    applicantName: { prismaField: 'applicantName', type: 'text' },
    proxyId: { prismaField: 'proxyId', type: 'number' },
    proxyName: { prismaField: 'proxyName', type: 'text' },
    status: { prismaField: 'status', type: 'enum' },
    submittedAt: { prismaField: 'submittedAt', type: 'date' },
    processorId: { prismaField: 'processorId', type: 'number' },
    processorName: { prismaField: 'processorName', type: 'text' },
    processedAt: { prismaField: 'processedAt', type: 'date' },
  });
}
