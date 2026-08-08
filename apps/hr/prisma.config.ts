import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';

// 加载仓库根 .env（开发环境本地变量；CI/生产由部署环境注入，缺失时跳过）
try {
  loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // .env 不存在时使用进程环境变量（CI / 部署注入场景）
}

/**
 * hr Prisma 配置（Prisma 7；主 PRD §9.9）。
 *
 * - schema 指向 prisma/ 目录（multi-file：schema.prisma + hr.prisma）；
 * - 连接串在 datasource.url，URL 附加 ?schema=hr：迁移元数据表 `_prisma_migrations`
 *   落位于 hr schema（hr 独立部署单元、独立迁移序列）；
 * - 运行时连接由应用代码通过 @prisma/adapter-pg 注入同一 URL。
 */
export default defineConfig({
  schema: 'prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: `${env('DATABASE_URL')}?schema=hr`,
  },
});
