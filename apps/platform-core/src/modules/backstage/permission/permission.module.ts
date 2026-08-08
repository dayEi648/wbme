import { Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { FunctionPermissionGuard } from './function-permission.guard';
import { GrantService } from './grant.service';
import { PermissionGroupService } from './permission-group.service';
import { PermissionController } from './permission.controller';
import { PermissionGroupController } from './permission-group.controller';

/**
 * 权限管理模块（backstage，实现规划 T3-2/T3-3）。
 *
 * 员工授权 CRUD（GrantService）与权限组维护（PermissionGroupService）；
 * AuthorizationService / FunctionPermissionGuard 为全站授权校验基础
 *（T3-4 推广为全站守卫与数据范围；T3-5 用户管理等接口复用），故导出。
 */
@Module({
  controllers: [PermissionController, PermissionGroupController],
  providers: [AuthorizationService, FunctionPermissionGuard, GrantService, PermissionGroupService],
  exports: [AuthorizationService, FunctionPermissionGuard],
})
export class PermissionModule {}
