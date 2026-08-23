import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import {
  CsrfGuard,
  HealthModule,
  MIGRATION_READINESS,
  MaintenanceInterceptor,
  MigrationReadinessService,
  RedisModule,
  SessionGuard,
  SessionModule,
  createPlatformSessionIdleTimeoutProvider,
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
import { PrismaService } from './prisma.service';

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
          useFactory: (prisma: PrismaService) => createPlatformSessionIdleTimeoutProvider(async (key) => {
            const rows = await prisma.client.$queryRaw<Array<{ value: string }>>`
              SELECT value FROM backstage.platform_settings WHERE key = ${key} LIMIT 1
            `;
            return rows[0]?.value ?? null;
          }),
          inject: [PrismaService],
        },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_INTERCEPTOR, useClass: MaintenanceInterceptor },
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
