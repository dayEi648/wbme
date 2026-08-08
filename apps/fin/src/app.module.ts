import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { HealthModule, MIGRATION_READINESS, MigrationReadinessService, RedisModule } from '@wbme/server';
import type { Redis } from '@wbme/server';

/** fin 根模块（业务模块 T8 阶段落地） */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
})
export class AppModule {
  static register(options: { redis: Redis }): DynamicModule {
    return {
      module: AppModule,
      imports: [RedisModule.forRoot(options.redis), HealthModule],
      providers: [
        // 迁移版本就绪检查（主 PRD §9.9）：本单元迁移元数据表与目录漂移对照
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
