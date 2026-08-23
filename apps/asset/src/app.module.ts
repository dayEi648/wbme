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
import { AssetModule } from './modules/asset/asset.module';
import { TablePrefsModule } from './modules/base/table-prefs/table-prefs.module';
import { BorrowModule } from './modules/borrow/borrow.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ClaimModule } from './modules/claim/claim.module';
import { ConsumableModule } from './modules/consumable/consumable.module';
import { DisposalModule } from './modules/disposal/disposal.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { QrModule } from './modules/qr/qr.module';
import { RepairModule } from './modules/repair/repair.module';
import { RequestModule } from './modules/request/request.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TransferModule } from './modules/transfer/transfer.module';
import { WarehouseModule } from './modules/warehouse/warehouse.module';
import { CrossSchemaSessionLoader } from './shared/cross-schema-auth';
import { SharedModule } from './shared.module';
import { PrismaService } from './prisma.service';

/** asset 根模块（接入会话守卫与审批头） */
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
        ApprovalModule,
        SettingsModule,
        CatalogModule,
        ConsumableModule,
        WarehouseModule,
        InventoryModule,
        RequestModule,
        TransferModule,
        ClaimModule,
        BorrowModule,
        DisposalModule,
        QrModule,
        AssetModule,
        RepairModule,
        TablePrefsModule,
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
              metadataSchema: 'asset',
              migrationsDir: resolve(__dirname, '../prisma/migrations'),
            }),
        },
      ],
    };
  }
}
