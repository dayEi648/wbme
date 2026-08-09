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
import { TablePrefsModule } from './modules/base/table-prefs/table-prefs.module';
import { DictModule } from './modules/dict/dict.module';
import { ExcelModule } from './modules/excel/excel.module';
import { ProfitModule } from './modules/profit/profit.module';
import { ProjectModule } from './modules/project/project.module';
import { SettingsModule } from './modules/settings/settings.module';
import { CrossSchemaSessionLoader } from './shared/cross-schema-auth';
import { SharedModule } from './shared.module';

/** fin 固定空闲超时（毫秒） */
const FIN_IDLE_TIMEOUT_MS = 86_400_000;

/** fin 根模块（业务模块全部挂载） */
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
        ProjectModule,
        ProfitModule,
        DictModule,
        SettingsModule,
        ExcelModule,
        TablePrefsModule,
      ],
      providers: [
        CrossSchemaSessionLoader,
        { provide: SESSION_USER_LOADER, useExisting: CrossSchemaSessionLoader },
        {
          provide: SESSION_IDLE_TIMEOUT_PROVIDER,
          useValue: async () => FIN_IDLE_TIMEOUT_MS,
        },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        {
          provide: MIGRATION_READINESS,
          useFactory: () =>
            new MigrationReadinessService({
              connectionString: process.env.DATABASE_URL,
              metadataSchema: 'fin',
              migrationsDir: resolve(__dirname, '../prisma/migrations'),
            }),
        },
      ],
    };
  }
}
