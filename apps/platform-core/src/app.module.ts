import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import {
  CsrfGuard,
  HealthModule,
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

/**
 * platform-core 根模块。
 * base 与 backstage 的模块边界与领域拆分在 T2/T3 阶段落地，
 * 本期承载全局配置、Redis、健康探针与认证会话基础设施（全局会话守卫 + CSRF 守卫）。
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
      ],
    };
  }
}
