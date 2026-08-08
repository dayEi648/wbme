import { Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { FunctionPermissionGuard } from './function-permission.guard';
import { GrantService } from './grant.service';
import { PermissionController } from './permission.controller';

/**
 * 权限管理模块（backstage，实现规划 T3-2）。
 *
 * AuthorizationService / FunctionPermissionGuard 为全站授权校验基础
 *（T3-4 推广为全站守卫与数据范围；T3-5 用户管理等接口复用），故导出。
 */
@Module({
  controllers: [PermissionController],
  providers: [AuthorizationService, FunctionPermissionGuard, GrantService],
  exports: [AuthorizationService, FunctionPermissionGuard],
})
export class PermissionModule {}
