import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PERMISSION_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { FunctionPermissionGuard, RequireFunction } from './function-permission.guard';
import { GrantService } from './grant.service';
import { BatchGrantDto, BatchRevokeDto, SaveEmployeeGrantsDto, SearchEmployeesDto } from './permission.dto';

/**
 * 统一人员权限管理（backstage PRD §4）。
 *
 * 全部路由要求持有"权限管理"功能授权或超级管理员（类级守卫 + 功能声明）；
 * 委派规则（自我修改禁止、"权限管理"功能仅超管可授收、超管目标保护）由服务层强制。
 */
@ApiTags('权限管理')
@Controller('permission')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(PERMISSION_MANAGE_FUNCTION_CODE)
export class PermissionController {
  constructor(private readonly grants: GrantService) {}

  /** 员工检索：姓名/手机号模糊 + 分页；返回授权摘要（含数据范围标注） */
  @Get('employees')
  searchEmployees(@Query() dto: SearchEmployeesDto): Promise<unknown> {
    return this.grants.searchEmployees(dto);
  }

  /** 查看目标员工当前授权 + 授权版本（"修改权限"打开时调用） */
  @Get('employees/:id/grants')
  getEmployeeGrants(@Param('id', ParseIntPipe) targetUserId: number): Promise<unknown> {
    return this.grants.getEmployeeGrants(targetUserId);
  }

  /** 保存单人权限：完整状态 + 授权版本（乐观并发控制）；幂等键重放返回原结果 */
  @Put('employees/:id/grants')
  saveEmployeeGrants(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() dto: SaveEmployeeGrantsDto,
  ): Promise<unknown> {
    return this.grants.saveEmployeeGrants(operatorId, targetUserId, dto);
  }

  /** 批量授权（增量）：整批校验，任一目标失败整批回滚并逐人返回原因；幂等键重放不重复 */
  @Post('grants/batch')
  batchGrant(@CurrentUser() operatorId: number, @Body() dto: BatchGrantDto): Promise<unknown> {
    return this.grants.batchGrant(operatorId, dto);
  }

  /** 批量撤销：撤销所选员工在操作人可管理范围内的全部功能授权；同样的整批语义 */
  @Post('revocations/batch')
  batchRevoke(@CurrentUser() operatorId: number, @Body() dto: BatchRevokeDto): Promise<unknown> {
    return this.grants.batchRevoke(operatorId, dto);
  }
}
