import { Body, Controller, Inject, Param, ParseIntPipe, Post } from '@nestjs/common';
import { BusinessException, frameworkErrors, IdempotentDto } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../../prisma.service';
import { ProfileChangeService } from './profile-change.service';

/** X1 审批处理入参 */
class ProcessApprovalDto extends IdempotentDto {
  @IsIn(['APPROVE', 'REJECT'])
  action!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  opinion?: string;
}

/**
 * 资料修改审批处理（X1，backstage PRD §3/§5；T5 统一审批内核接管完整规则）。
 * 审批权：持有"用户管理"功能者（本期最小校验：超管或 user_manage 授权）。
 */
@Controller('approval-requests')
export class ApprovalController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly profileChange: ProfileChangeService,
  ) {}

  /** X1 处理资料修改审批（APPROVE 生效 / REJECT 不改正式资料） */
  @Post(':id/process')
  async process(
    @Param('id', ParseIntPipe) requestId: number,
    @CurrentUser() processorId: number,
    @Body() dto: ProcessApprovalDto,
  ): Promise<{ ok: true }> {
    await this.assertUserManage(processorId);
    await this.profileChange.processProfileChange(requestId, dto.action, processorId, dto.opinion);
    return { ok: true };
  }

  /** 最小"用户管理"授权校验（T3-5 完整权限守卫接管） */
  private async assertUserManage(operatorId: number): Promise<void> {
    const operator = await this.prisma.client.user.findUnique({
      where: { id: operatorId },
      select: { isSuperAdmin: true },
    });
    if (!operator) {
      throw new BusinessException(frameworkErrors.UNAUTHORIZED);
    }
    if (operator.isSuperAdmin) {
      return;
    }
    const grant = await this.prisma.client.employeeGrant.findFirst({
      where: { userId: operatorId, functionCode: 'user_manage' },
      select: { id: true },
    });
    if (!grant) {
      throw new BusinessException(frameworkErrors.FORBIDDEN);
    }
  }
}
