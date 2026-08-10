import { Global, Module } from '@nestjs/common';
import { RateLimitGuard } from '@wbme/server';
import { PrismaService } from './prisma.service';

/**
 * platform-core 全局共享模块：单一 PrismaService 实例与连接池
 * （base/backstage 共享该容器连接池，不重复各建一池，主 PRD §9.9），
 * 以及全局 RateLimitGuard（M2 复核修复：此前仅 @UseGuards 声明、从未注册为 provider，
 * Nest 静默跳过守卫——登录/批量/导出限流全部未生效；REDIS_CLIENT 由全局
 * RedisModule.forRoot 提供，此处注册后各模块 controller 的 @UseGuards(RateLimitGuard) 可解析）。
 */
@Global()
@Module({
  providers: [PrismaService, RateLimitGuard],
  exports: [PrismaService, RateLimitGuard],
})
export class SharedModule {}
