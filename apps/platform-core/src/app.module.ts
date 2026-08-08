import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, RedisModule } from '@wbme/server';
import type { Redis } from '@wbme/server';

/**
 * platform-core 根模块。
 * base 与 backstage 的模块边界与领域拆分在 T1（Prisma schema）与 T2/T3 阶段落地，
 * 本期承载全局配置、Redis 与健康探针。
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
})
export class AppModule {
  /** 注册含已探测 Redis 客户端的根模块（Redis 实例由启动入口创建并探测） */
  static register(options: { redis: Redis }): DynamicModule {
    return {
      module: AppModule,
      imports: [RedisModule.forRoot(options.redis), HealthModule],
    };
  }
}
