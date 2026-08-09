import { Controller, Get, Inject } from '@nestjs/common';
import { CurrentUser } from '@wbme/server';
import { PrismaService } from '../../prisma.service';

/**
 * 个人中心自助申请所需的可选目标。
 *
 * 此接口仅公开仍可提交的部门、岗位及其适用关系；提交和审批时仍由业务服务在事务中重新校验，
 * 不把前端筛选结果当作授权或有效性依据。
 */
@Controller('self-service')
export class SelfServiceController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 返回岗位变更申请的活跃部门与允许自助申请的岗位。 */
  @Get('position-application-options')
  async positionApplicationOptions(@CurrentUser() _userId: number): Promise<{
    departments: Array<{ id: number; name: string }>;
    positions: Array<{ id: number; name: string; departmentIds: number[] }>;
  }> {
    const [departments, positions] = await Promise.all([
      this.prisma.client.department.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true },
      }),
      this.prisma.client.position.findMany({
        where: { status: 'ACTIVE', allowSelfApply: true },
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, positionDepartments: { select: { departmentId: true } } },
      }),
    ]);
    return {
      departments,
      positions: positions.map((position) => ({
        id: position.id,
        name: position.name,
        departmentIds: position.positionDepartments.map((item) => item.departmentId),
      })),
    };
  }
}
