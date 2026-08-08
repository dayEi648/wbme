import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { HrLifecycleClient } from './hr-lifecycle.client';
import { UserAdminController } from './user-admin.controller';
import { UserAdminService } from './user-admin.service';
import { UserLifecycleService } from './user-lifecycle.service';

/**
 * 用户管理模块（backstage，实现规划 T3-5）。
 *
 * 创建/列表/详情/编辑 + 批量注销/恢复（账号生命周期编排，UserLifecycleService；
 * HrLifecycleClient 按契约调用 hr：hr 未就绪时恢复类操作返回 HR_SERVICE_UNAVAILABLE）。
 */
@Module({
  imports: [PermissionModule],
  controllers: [UserAdminController],
  providers: [
    UserAdminService,
    UserLifecycleService,
    // 工厂装配：InternalHttpClient 非 Nest provider，避免构造参数被按类型解析
    { provide: HrLifecycleClient, useFactory: () => HrLifecycleClient.fromEnv() },
  ],
  exports: [UserAdminService, UserLifecycleService, HrLifecycleClient],
})
export class UserAdminModule {}
