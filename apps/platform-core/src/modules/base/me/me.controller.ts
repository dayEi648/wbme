import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Inject, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import {
  BusinessException,
  frameworkErrors,
  IdempotentDto,
  maskPhone,
  PaginationQueryDto,
  PositionApplicationSubmitDto,
} from '@wbme/contracts';
import { CurrentUser, EXPORT_TIMEOUT_MS, RateLimit, RateLimitGuard, RequestTimeout } from '@wbme/server';
import type { Response } from 'express';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../../prisma.service';
import { ProfileChangeService } from '../approval-proxy/profile-change.service';
import { OperationLogService } from '../../backstage/operation-log/operation-log.service';
import { HrOrgClient } from './hr-org.client';

/** P3 资料修改（至少一项；超管直改，员工提交审批；幂等键防重复提交建单） */
class UpdateProfileDto extends IdempotentDto {
  @ApiProperty({
    description: '姓名（至少一项时必填其一）',
    required: false,
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @ApiProperty({
    description: '性别',
    required: false,
    enum: ['MALE', 'FEMALE'],
  })
  @IsOptional()
  @IsIn(['MALE', 'FEMALE'])
  gender?: 'MALE' | 'FEMALE';
}

/**
 * 个人中心（base PRD §6）：
 * P2 当前身份（部门/岗位经 hr 内部接口）、P3 资料修改（超管直改/员工审批）、
 * P4 岗位变更申请（hr 侧校验）、P5 我的岗位申请记录、P6 我的操作日志。
 */
@ApiTags('个人中心')
@Controller('me')
export class MeController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly profileChange: ProfileChangeService,
    private readonly operationLog: OperationLogService,
    private readonly hrOrg: HrOrgClient,
  ) {}

  /** P2 当前身份信息（部门/岗位由 hr 提供；hr 不可用时降级为空结构，手机号只读） */
  @Get()
  async me(@CurrentUser() userId: number): Promise<unknown> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, gender: true, phone: true, status: true, isSuperAdmin: true, createdAt: true },
    });
    if (!user) {
      throw new BusinessException(frameworkErrors.SESSION_EXPIRED);
    }
    const [pendingProfileChange, org] = await Promise.all([
      this.prisma.client.approvalRequest.findFirst({
        where: { applicantId: userId, requestType: 'PROFILE_CHANGE', status: 'PENDING' },
        select: { id: true },
      }),
      this.hrOrg.getMyOrg(userId),
    ]);
    return {
      user: {
        id: user.id,
        name: user.name,
        gender: user.gender,
        phoneMasked: maskPhone(user.phone),
        status: user.status,
        isSuperAdmin: user.isSuperAdmin,
        createdAt: user.createdAt,
      },
      departments: org.departmentNames.map((name, index) => ({ id: org.departmentIds[index] ?? null, name })),
      positions: org.positionName ? [{ id: org.positionId, name: org.positionName }] : [],
      canApplyPositionChange: org.canApplyPositionChange,
      pendingProfileChange: pendingProfileChange !== null,
    };
  }

  /** P3 资料修改（超管直改生效；员工创建审批单） */
  @Put('profile')
  async updateProfile(@CurrentUser() userId: number, @Body() dto: UpdateProfileDto): Promise<unknown> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true },
    });
    const result = await this.profileChange.submitProfileChange(userId, user?.isSuperAdmin ?? false, dto, dto.idempotencyKey);
    return { applied: result.applied, requestId: result.requestId };
  }

  /** P4 岗位变更申请（hr 侧校验：多部门不可申请/目标部门岗位条件；hr 不可用 → 503） */
  @Post('position-applications')
  async createPositionApplication(
    @CurrentUser() userId: number,
    @Body() dto: PositionApplicationSubmitDto,
  ): Promise<{ requestId: number; applicationNo: string }> {
    return this.hrOrg.submitPositionApplication(userId, {
      targetDepartmentId: dto.targetDepartmentId,
      targetPositionId: dto.targetPositionId,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** P5 我的岗位申请记录（经 hr 内部接口；hr 不可用返回空分页） */
  @Get('position-applications')
  async listPositionApplications(
    @CurrentUser() userId: number,
    @Query() query: PaginationQueryDto,
  ): Promise<unknown> {
    return this.hrOrg.listPositionApplications(userId, query.page ?? 1, query.pageSize ?? 20);
  }

  /** P6 我的操作日志（全员可用，仅本人记录） */
  @Get('operation-logs')
  async listMyOperationLogs(
    @CurrentUser() userId: number,
    @Query() query: PaginationQueryDto,
  ): Promise<unknown> {
    return this.operationLog.listMine(userId, { page: query.page, pageSize: query.pageSize, filters: query.filters, sorts: query.sorts });
  }

  /** P6 我的操作日志导出（仅当前用户记录；结构化筛选与列表一致；M2 补限流）。 */
  @Get('operation-logs/export')
  @RequestTimeout(EXPORT_TIMEOUT_MS)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'me-operation-log-export', keyType: 'user', limit: 20, windowSeconds: 3600, envPrefix: 'ME_EXPORT' })
  async exportMyOperationLogs(
    @CurrentUser() userId: number,
    @Query() query: PaginationQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.operationLog.export(userId, { operatorId: userId, filters: query.filters, sorts: query.sorts }, res);
  }
}
