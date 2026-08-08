import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, RedisModule } from '@wbme/server';
import type { Redis } from '@wbme/server';

/** asset 根模块（业务模块 T7 阶段落地） */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
})
export class AppModule {
  static register(options: { redis: Redis }): DynamicModule {
    return {
      module: AppModule,
      imports: [RedisModule.forRoot(options.redis), HealthModule],
    };
  }
}
