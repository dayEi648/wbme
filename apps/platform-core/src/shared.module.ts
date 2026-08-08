import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * platform-core 全局共享模块：单一 PrismaService 实例与连接池
 * （base/backstage 共享该容器连接池，不重复各建一池，主 PRD §9.9）。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class SharedModule {}
