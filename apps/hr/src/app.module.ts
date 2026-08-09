import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
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
} from '@wbme/server';
import { ApprovalModule } from './modules/approval/approval.module';
import { HolidayModule } from './modules/holiday/holiday.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { OrgModule } from './modules/org/org.module';
import { OvertimeModule } from './modules/overtime/overtime.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TablePrefsModule } from './modules/base/table-prefs/table-prefs.module';
import { TitleModule } from './modules/title/title.module';
import { CrossSchemaSessionLoader } from './shared/cross-schema-auth';
import { SharedModule } from './shared.module';

/** 固定空闲超时（毫秒） */
const T5_IDLE_TIMEOUT_MS = 86_400_000;

/** hr 根模块（接入会话守卫与审批头） */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
})
export class AppModule {
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
        HolidayModule,
        OrgModule,
        TitleModule,
        OvertimeModule,
        LifecycleModule,
        TablePrefsModule,
        ApprovalModule,
      ],
      providers: [
        CrossSchemaSessionLoader,
        { provide: SESSION_USER_LOADER, useExisting: CrossSchemaSessionLoader },
        {
          provide: SESSION_IDLE_TIMEOUT_PROVIDER,
          useValue: async () => T5_IDLE_TIMEOUT_MS,
        },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        {
          provide: MIGRATION_READINESS,
          useFactory: () =>
            new MigrationReadinessService({
              connectionString: process.env.DATABASE_URL,
              metadataSchema: 'hr',
              migrationsDir: resolve(__dirname, '../prisma/migrations'),
            }),
        },
      ],
    };
  }
}
