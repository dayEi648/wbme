import { Module } from '@nestjs/common';
import { PermissionModule } from '../permission/permission.module';
import { AuthModule } from '../../base/auth/auth.module';
import { DingtalkModule } from '../../base/dingtalk/dingtalk.module';
import { DingtalkImportService } from './dingtalk-import.service';
import { HrLifecycleClient } from './hr-lifecycle.client';
import { UserAdminController } from './user-admin.controller';
import { UserAdminService } from './user-admin.service';
import { UserLifecycleService } from './user-lifecycle.service';
import { SuperAdminService } from './super-admin.service';

/**
 * 用户管理模块（backstage）。
 *
 * 创建/列表/详情/编辑 + 批量注销/恢复（账号生命周期编排，UserLifecycleService；
 * HrLifecycleClient 按契约调用 hr：hr 未就绪时恢复类操作返回 HR_SERVICE_UNAVAILABLE）。
 */
@Module({
  imports: [PermissionModule, AuthModule, DingtalkModule],
  controllers: [UserAdminController],
  providers: [
    UserAdminService,
    UserLifecycleService,
    SuperAdminService,
    DingtalkImportService,
    // 工厂装配：InternalHttpClient 非 Nest provider，避免构造参数被按类型解析
    { provide: HrLifecycleClient, useFactory: () => HrLifecycleClient.fromEnv() },
  ],
  exports: [UserAdminService, UserLifecycleService, SuperAdminService, HrLifecycleClient],
})
export class UserAdminModule {}
