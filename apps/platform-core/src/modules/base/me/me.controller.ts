import { Body, Controller, Get, Inject, Post, Put, Query } from '@nestjs/common';
import { BusinessException, accountErrors, frameworkErrors, IdempotentDto, maskPhone, PaginationQueryDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../../prisma.service';
import { ProfileChangeService } from '../approval-proxy/profile-change.service';

/** P3 资料修改（至少一项；超管直改，员工提交审批；幂等键防重复提交建单） */
class UpdateProfileDto extends IdempotentDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsIn(['MALE', 'FEMALE'])
  gender?: 'MALE' | 'FEMALE';
}

/**
 * 个人中心（base PRD §6，T2-7）：
 * P2 当前身份、P3 资料修改（超管直改/员工审批）、P4/P5 岗位申请契约、
 * P6 我的操作日志契约（T4-1 落地后接通）。
 */
@Controller('me')
export class MeController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly profileChange: ProfileChangeService,
  ) {}

  /** P2 当前身份信息（部门/岗位由 hr 提供，T6 填充；手机号只读） */
  @Get()
  async me(@CurrentUser() userId: number): Promise<unknown> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, gender: true, phone: true, status: true, isSuperAdmin: true, createdAt: true },
    });
    if (!user) {
      throw new BusinessException(frameworkErrors.SESSION_EXPIRED);
    }
    const pendingProfileChange = await this.prisma.client.approvalRequest.findFirst({
      where: { applicantId: userId, requestType: 'PROFILE_CHANGE', status: 'PENDING' },
      select: { id: true },
    });
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
      // 部门/岗位由 hr 服务提供（T6-6 接通；本期空）
      departments: [],
      positions: [],
      canApplyPositionChange: false, // 依赖 hr 组织数据（T6-6）
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
    const result = await this.profileChange.submitProfileChange(userId, user?.isSuperAdmin ?? false, dto);
    return { applied: result.applied, requestId: result.requestId };
  }

  /** P4 岗位变更申请（契约先行：hr 侧校验 T6-6 落地；本期返回不可用） */
  @Post('position-applications')
  async createPositionApplication(): Promise<never> {
    throw new BusinessException(accountErrors.POSITION_APPLICATION_INELIGIBLE);
  }

  /** P5 我的岗位申请记录（契约先行：本期空分页，T6-6 接通） */
  @Get('position-applications')
  async listPositionApplications(@Query() _query: PaginationQueryDto): Promise<unknown> {
    return { data: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } };
  }

  /** P6 我的操作日志（契约预留：T4-1 操作日志模块落地后接通；本期前端入口"即将开放"） */
  @Get('operation-logs')
  async listMyOperationLogs(@Query() _query: PaginationQueryDto): Promise<unknown> {
    return { data: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } };
  }
}
