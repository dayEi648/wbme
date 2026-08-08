import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { USER_MANAGE_FUNCTION_CODE } from '@wbme/contracts';
import { CurrentUser } from '@wbme/server';
import { FunctionPermissionGuard, RequireFunction } from '../permission/function-permission.guard';
import { UserAdminService } from './user-admin.service';
import { CreateUserDto, ListUsersDto, UpdateUserDto } from './user-admin.dto';

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
  constructor(private readonly users: UserAdminService) {}

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
}
