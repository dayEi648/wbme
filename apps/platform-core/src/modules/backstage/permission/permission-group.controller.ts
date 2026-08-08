import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PaginationQueryDto, PERMISSION_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { FunctionPermissionGuard, RequireFunction } from './function-permission.guard';
import { PermissionGroupService } from './permission-group.service';
import { BatchDeleteGroupsDto, CreatePermissionGroupDto, UpdatePermissionGroupDto } from './permission-group.dto';

/**
 * 权限组维护（backstage PRD §4、主 PRD §3.1；实现规划 T3-3）。
 *
 * 权限组是命名的授权预设（可跨系统）：授予员工时展开为员工功能授权快照，
 * 之后修改/删除组不影响已授权员工。全部路由要求持有"权限管理"功能授权或超级管理员。
 */
@ApiTags('权限组')
@Controller('permission/groups')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(PERMISSION_MANAGE_FUNCTION_CODE)
export class PermissionGroupController {
  constructor(private readonly groups: PermissionGroupService) {}

  /** 权限组列表（分页；不含已软删除） */
  @Get()
  listGroups(@Query() dto: PaginationQueryDto): Promise<unknown> {
    return this.groups.listGroups(dto);
  }

  /** 查看组内权限（明细含目录有效性标记） */
  @Get(':id')
  getGroup(@Param('id', ParseIntPipe) groupId: number): Promise<unknown> {
    return this.groups.getGroup(groupId);
  }

  /** 创建权限组（命名 + 描述 + 明细；名称唯一冲突 409） */
  @Post()
  createGroup(@CurrentUser() operatorId: number, @Body() dto: CreatePermissionGroupDto): Promise<unknown> {
    return this.groups.createGroup(operatorId, dto);
  }

  /** 编辑权限组（名称/描述 + 明细事务内全量替换） */
  @Put(':id')
  updateGroup(
    @Param('id', ParseIntPipe) groupId: number,
    @CurrentUser() operatorId: number,
    @Body() dto: UpdatePermissionGroupDto,
  ): Promise<unknown> {
    return this.groups.updateGroup(operatorId, groupId, dto);
  }

  /** 批量删除权限组（软删除；全有或全无） */
  @Post('batch-delete')
  batchDeleteGroups(@CurrentUser() operatorId: number, @Body() dto: BatchDeleteGroupsDto): Promise<unknown> {
    return this.groups.batchDeleteGroups(operatorId, dto);
  }
}
