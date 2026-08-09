import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * hr 全局共享模块：单一 PrismaService 实例与连接池（主 PRD §9.9）。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class SharedModule {}
