import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

/**
 * fin Prisma 客户端（主 PRD §9.9）。
 *
 * fin schema 独立 Prisma Client；跨 schema（base/backstage/hr）只读查询走 `$queryRaw`
 * （只读视图），不建立跨 schema 外键。迁移元数据经 prisma.config.ts 的 `?schema=fin` 落位。
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly prisma: PrismaClient;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL 未配置（fin 启动前置检查）');
    }
    const adapter = new PrismaPg({ connectionString });
    this.prisma = new PrismaClient({ adapter });
  }

  /** 业务代码统一通过该客户端访问 fin schema（及跨 schema 原始 SQL） */
  get client(): PrismaClient {
    return this.prisma;
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
