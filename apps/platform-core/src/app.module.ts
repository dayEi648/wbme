import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { MaintenanceInterceptor } from './shared/maintenance/maintenance.interceptor';
import {
  CsrfGuard,
  HealthModule,
  MIGRATION_READINESS,
  MigrationReadinessService,
  RedisModule,
  SessionGuard,
  SessionModule,
  SESSION_IDLE_TIMEOUT_PROVIDER,
  SESSION_USER_LOADER,
  type Redis,
  type IdleTimeoutProvider,
} from '@wbme/server';
import { SharedModule } from './shared.module';
import { SessionIntegrityLoader } from './modules/base/session/session-integrity.loader';
import { SettingsModule } from './modules/base/settings/settings.module';
import { SETTING_KEYS, SettingsService } from './modules/base/settings/settings.service';
import { SecurityLogModule } from './modules/base/security-log/security-log.module';
import { AuthModule } from './modules/base/auth/auth.module';
import { DingtalkModule } from './modules/base/dingtalk/dingtalk.module';
import { PortalModule } from './modules/base/portal/portal.module';
import { PermissionCatalogModule } from './modules/backstage/permission-catalog/permission-catalog.module';
import { PermissionModule } from './modules/backstage/permission/permission.module';
import { UserAdminModule } from './modules/backstage/user-admin/user-admin.module';
import { SystemStructureModule } from './modules/backstage/system-structure/system-structure.module';
import { SystemSettingsModule } from './modules/backstage/system-settings/system-settings.module';
import { OperationLogModule } from './modules/backstage/operation-log/operation-log.module';
import { SystemLogModule } from './modules/backstage/system-log/system-log.module';
import { ContentModule } from './modules/backstage/content/content.module';
import { BackupModule } from './modules/backstage/backup/backup.module';
import { HealthStatusModule } from './modules/backstage/health-status/health-status.module';
import { TablePrefsModule } from './modules/base/table-prefs/table-prefs.module';
import { FilesModule } from './modules/files/files.module';

/**
 * platform-core 根模块。
 * base 与 backstage 的模块边界与领域拆分在 T2/T3 阶段落地，
 * 本期承载全局配置、Redis、健康探针、认证会话基础设施（全局会话守卫 + CSRF 守卫）、
 * backstage 权限目录启动对账（T3-1）与员工授权管理（T3-2）。
 */

/** 空闲超时提供者：按"记住我"读取系统设置（base PRD §3 双时限） */
function idleTimeoutProviderFactory(settings: SettingsService): IdleTimeoutProvider {
  return async (rememberMe) => {
    const key = rememberMe ? SETTING_KEYS.SESSION_IDLE_REMEMBER : SETTING_KEYS.SESSION_IDLE_TIMEOUT;
    return (await settings.getNumber(key)) * 1000;
  };
}

@Module({})
export class AppModule {
  /** 注册含已探测 Redis 客户端的根模块（Redis 实例由启动入口创建并探测） */
  static register(options: { redis: Redis }): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        RedisModule.forRoot(options.redis),
        HealthModule,
        SessionModule.forRoot(),
        SharedModule,
        SettingsModule,
        SecurityLogModule,
        AuthModule,
        DingtalkModule,
        PortalModule,
        PermissionCatalogModule,
        PermissionModule,
        UserAdminModule,
        SystemStructureModule,
        SystemSettingsModule,
        OperationLogModule,
        SystemLogModule,
        ContentModule,
        BackupModule,
        HealthStatusModule,
        TablePrefsModule,
        FilesModule,
      ],
      providers: [
        SessionIntegrityLoader,
        SettingsService,
        { provide: SESSION_USER_LOADER, useClass: SessionIntegrityLoader },
        {
          provide: SESSION_IDLE_TIMEOUT_PROVIDER,
          useFactory: idleTimeoutProviderFactory,
          inject: [SettingsService],
        },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        // 恢复维护状态写拦截（backstage PRD §10）：维护标记存在时写请求 503
        { provide: APP_INTERCEPTOR, useClass: MaintenanceInterceptor },
        // 迁移版本就绪检查（主 PRD §9.9）：base 元数据表代表 base+backstage 合并迁移序列
        {
          provide: MIGRATION_READINESS,
          useFactory: () =>
            new MigrationReadinessService({
              connectionString: process.env.DATABASE_URL,
              metadataSchema: 'base',
              migrationsDir: resolve(__dirname, '../prisma/migrations'),
            }),
        },
      ],
    };
  }
}
