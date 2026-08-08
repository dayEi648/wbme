import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { IdempotentDto, USER_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { FunctionPermissionGuard, RequireFunction } from '../../backstage/permission/function-permission.guard';
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
 * 审批权：持有"用户管理"功能者（T3-4 函数权限守卫：超管豁免 + 目录存在性过滤）。
 */
@ApiTags('审批')
@Controller('approval-requests')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(USER_MANAGE_FUNCTION_CODE)
export class ApprovalController {
  constructor(private readonly profileChange: ProfileChangeService) {}

  /** X1 处理资料修改审批（APPROVE 生效 / REJECT 不改正式资料） */
  @Post(':id/process')
  async process(
    @Param('id', ParseIntPipe) requestId: number,
    @CurrentUser() processorId: number,
    @Body() dto: ProcessApprovalDto,
  ): Promise<{ ok: true }> {
    await this.profileChange.processProfileChange(requestId, dto.action, processorId, dto.opinion);
    return { ok: true };
  }
}
