import { type ProjectQueryDto } from '@wbme/contracts';
import { buildTablePrismaQuery } from '@wbme/server';

/**
 * 编译工程合同与利润分析共用的结构化查询字段。
 *
 * 金额 numeric 不注册为 number，避免以 JavaScript 浮点数解释人民币筛选值；金额展示与
 * 计算仍全部由 Prisma Decimal/十进制字符串处理。
 *
 * @param query 项目列表查询 DTO
 * @returns Prisma 条件和排序片段
 */
export function buildProjectTableQuery(query: ProjectQueryDto) {
  return buildTablePrismaQuery(query, {
    id: { prismaField: 'id', type: 'number' },
    name: { prismaField: 'name', type: 'text' },
    year: { prismaField: 'year', type: 'number' },
    partyA: { prismaField: 'partyA', type: 'text' },
    regionId: { prismaField: 'regionId', type: 'number' },
    progressId: { prismaField: 'progressId', type: 'number' },
    bizCategoryId: { prismaField: 'bizCategoryId', type: 'number' },
    contractStartDate: { prismaField: 'contractStartDate', type: 'date' },
    contractEndDate: { prismaField: 'contractEndDate', type: 'date' },
    updatedAt: { prismaField: 'updatedAt', type: 'date' },
  });
}
