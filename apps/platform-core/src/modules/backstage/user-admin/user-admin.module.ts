import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { HrLifecycleClient } from './hr-lifecycle.client';
import { UserAdminController } from './user-admin.controller';
import { UserAdminService } from './user-admin.service';

/**
 * 用户管理模块（backstage，实现规划 T3-5）。
 *
 * 本期：创建/列表/详情/编辑 + 守卫切换；批量注销/恢复与账号生命周期编排随后续迭代落地
 * （HrLifecycleClient 已按契约就位：hr 未就绪时恢复类操作返回 HR_SERVICE_UNAVAILABLE）。
 */
@Module({
  imports: [PermissionModule],
  controllers: [UserAdminController],
  providers: [
    UserAdminService,
    // 工厂装配：InternalHttpClient 非 Nest provider，避免构造参数被按类型解析
    { provide: HrLifecycleClient, useFactory: () => HrLifecycleClient.fromEnv() },
  ],
  exports: [UserAdminService, HrLifecycleClient],
})
export class UserAdminModule {}
