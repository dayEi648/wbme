import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

/**
 * platform-core Prisma 客户端（主 PRD §9.9）。
 *
 * base/backstage 共用一个覆盖两个 schema 的 Prisma Client 与连接池，
 * 保证跨 schema 的本地原子事务；迁移元数据表经 prisma.config.ts 的
 * `?schema=base` 参数落位于 base schema（运行时连接使用无参数 DATABASE_URL）。
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly prisma: PrismaClient;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL 未配置（platform-core 启动前置检查）');
    }
    const adapter = new PrismaPg({ connectionString });
    this.prisma = new PrismaClient({ adapter });
  }

  /** 业务代码统一通过该客户端访问 base/backstage schema */
  get client(): PrismaClient {
    return this.prisma;
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
