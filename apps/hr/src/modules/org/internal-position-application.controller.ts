import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  InternalPositionApplicationQueryDto,
  InternalPositionApplicationSubmitDto,
  InternalUserOrgQueryDto,
} from '@wbme/contracts';
import { AllowedCallers, InternalAuthGuard, Public } from '@wbme/server';
import { UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { loadUserName } from '../../shared/cross-schema-auth';
import { loadHrOperationLogOperator } from '../../shared/hr-operation-log.util';
import { PositionApplicationService } from './position-application.service';

/**
 * 岗位申请内部接口（base PRD §6 个人中心 P4/P5 承接，T6-6）：
 * 调用方 platform-core（内部令牌 + 白名单）——个人中心代传会话用户的操作。
 * 业务校验（多部门不可申请/目标条件）在 hr 侧执行，4xx 业务码原样返回。
 */
@Public()
@UseGuards(InternalAuthGuard)
@Controller('internal/v1')
export class InternalPositionApplicationController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly applications: PositionApplicationService,
  ) {}

  /** P4 提交岗位变更申请（携带实际操作者 userId；幂等键透传） */
  @Post('position-applications')
  @AllowedCallers('platform-core')
  async submit(@Body() dto: InternalPositionApplicationSubmitDto): Promise<{ requestId: number; applicationNo: string }> {
    const operator = await loadHrOperationLogOperator(this.prisma.client, dto.userId);
    return this.applications.submit(operator, dto.targetDepartmentId, dto.targetPositionId, dto.idempotencyKey);
  }

  /** P5 我的岗位申请记录（分页；用户不存在返回空分页） */
  @Get('position-applications')
  @AllowedCallers('platform-core')
  async list(@Query() query: InternalPositionApplicationQueryDto): Promise<unknown> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = { applicantId: query.userId };
    const [total, rows] = await Promise.all([
      this.prisma.client.hrApprovalRequest.count({ where }),
      this.prisma.client.hrApprovalRequest.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { positionChangeRequest: true },
      }),
    ]);
    return {
      data: rows.map((row) => ({
        requestId: row.id,
        applicationNo: row.applicationNo,
        status: row.status,
        targetDepartmentName: row.positionChangeRequest?.targetDepartmentName ?? null,
        targetPositionName: row.positionChangeRequest?.targetPositionName ?? null,
        submittedAt: row.submittedAt,
        processedAt: row.processedAt,
        opinion: row.opinion,
      })),
      pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /** P2 用户组织身份（部门/岗位/可否自助申请；用户不存在返回空结构供前端降级） */
  @Get('users/:userId/org')
  @AllowedCallers('platform-core')
  async getOrg(@Param('userId', ParseIntPipe) userId: number, @Query() _query: InternalUserOrgQueryDto): Promise<unknown> {
    const [name, rows] = await Promise.all([
      loadUserName(this.prisma.client, userId),
      this.prisma.client.$queryRaw<
        Array<{ department_id: number; department_name: string; position_id: number | null; position_name: string | null }>
      >`
        SELECT department_id, department_name, position_id, position_name
        FROM hr.user_org
        WHERE user_id = ${userId}
      `,
    ]);
    if (!name) {
      return {
        departmentIds: [],
        departmentNames: [],
        positionId: null,
        positionName: null,
        canApplyPositionChange: false,
      };
    }
    const departmentIds = rows.map((row) => row.department_id);
    const departmentNames = rows.map((row) => row.department_name);
    const positionId = rows[0]?.position_id ?? null;
    const positionName = rows[0]?.position_name ?? null;
    return {
      departmentIds,
      departmentNames,
      positionId,
      positionName,
      canApplyPositionChange: departmentIds.length <= 1,
    };
  }
}
