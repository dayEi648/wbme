import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IdempotentDto, USER_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { SuperAdminService } from './super-admin.service';
import { UserAdminService } from './user-admin.service';
import { UserLifecycleService } from './user-lifecycle.service';
import { BatchDeactivateDto, CreateUserDto, ListUsersDto, RestoreConfirmDto, RestorePreviewDto, UpdateUserDto } from './user-admin.dto';

/**
 * 用户管理（backstage PRD §3；实现规划 T3-5）。
 *
 * 全部路由要求持有"用户管理"功能授权或超级管理员（类级守卫 + 功能声明）。
 * 激活邀请（M1）/管理员发起密码重置（M2）/解锁账号（M4）见 base 认证模块的
 * admin-auth.controller（同一 /users 命名空间，同一功能守卫）。
 */
@Controller('users')
@UseGuards(FunctionPermissionGuard)
@RequireFunction(USER_MANAGE_FUNCTION_CODE)
export class UserAdminController {
  constructor(
    private readonly users: UserAdminService,
    private readonly lifecycle: UserLifecycleService,
    private readonly superAdmins: SuperAdminService,
  ) {}

  /** 创建用户（待激活基础账号；手机号在待激活与正常账号间唯一） */
  @Post()
  createUser(@CurrentUser() operatorId: number, @Body() dto: CreateUserDto): Promise<unknown> {
    return this.users.createUser(operatorId, dto);
  }

  /** 用户列表（状态筛选 + 姓名/手机号模糊 + 分页；含激活与钉钉绑定状态） */
  @Get()
  listUsers(@Query() dto: ListUsersDto): Promise<unknown> {
    return this.users.listUsers(dto);
  }

  /** 用户详情（含已注销账号） */
  @Get(':id')
  getUserDetail(@Param('id', ParseIntPipe) targetUserId: number): Promise<unknown> {
    return this.users.getUserDetail(targetUserId);
  }

  /** 编辑基本资料（仅姓名和性别；手机号只读） */
  @Put(':id')
  updateUser(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() dto: UpdateUserDto,
  ): Promise<unknown> {
    return this.users.updateUser(operatorId, targetUserId, dto);
  }

  /** 批量注销（整批全有或全无；同事务：账号注销 + 待审批资料修改取消 + 生命周期任务） */
  @Post('deactivations/batch')
  batchDeactivate(@CurrentUser() operatorId: number, @Body() dto: BatchDeactivateDto): Promise<unknown> {
    return this.lifecycle.batchDeactivate(operatorId, dto);
  }

  /** 恢复预览（实际调用 hr 内部接口；hr 不可用则 503 HR_SERVICE_UNAVAILABLE） */
  @Post('restorations/preview')
  previewRestore(@CurrentUser() operatorId: number, @Body() dto: RestorePreviewDto): Promise<unknown> {
    return this.lifecycle.previewRestore(operatorId, dto);
  }

  /** 恢复确认（稳定恢复请求 ID + 生命周期版本；hr 整批应用成功后本地事务完成恢复） */
  @Post('restorations/confirm')
  confirmRestore(@CurrentUser() operatorId: number, @Body() dto: RestoreConfirmDto): Promise<unknown> {
    return this.lifecycle.confirmRestore(operatorId, dto);
  }

  /** 任命普通员工为超级管理员（仅超管可操作；事务内复核角色与最后超管约束；任命后目标会话提权旋转） */
  @Post(':id/super-admin')
  appointSuperAdmin(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() dto: IdempotentDto,
  ): Promise<unknown> {
    return this.superAdmins.appoint(operatorId, targetUserId, dto);
  }

  /** 超级管理员降级为普通员工（仅超管可操作；最后一名可用超管不可降级） */
  @Delete(':id/super-admin')
  demoteSuperAdmin(
    @Param('id', ParseIntPipe) targetUserId: number,
    @CurrentUser() operatorId: number,
    @Body() dto: IdempotentDto,
  ): Promise<unknown> {
    return this.superAdmins.demote(operatorId, targetUserId, dto);
  }
}
