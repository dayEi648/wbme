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

/** T5 固定空闲超时（毫秒）；后续可改为读系统设置 */
const T5_IDLE_TIMEOUT_MS = 86_400_000;

/** asset 根模块（T5-3 接入会话守卫与审批头） */
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
          useValue: async () => T5_IDLE_TIMEOUT_MS,
        },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
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
