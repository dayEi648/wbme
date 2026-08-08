import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { Client } from 'pg';

// 加载仓库根 .env（开发环境本地变量；生产/CI 由部署环境注入，缺失时跳过）
try {
  loadEnvFile(resolve(__dirname, '../../..', '.env'));
} catch {
  // .env 不存在时使用进程环境变量
}

/**
 * Migration Runner（主 PRD §9.9）。
 *
 * 按部署单元顺序执行 `prisma migrate deploy`：
 * - platform-core → asset → hr → fin（平台核心先行）；
 * - 各部署单元迁移元数据表（`_prisma_migrations`）落位于各自默认 schema，相互隔离；
 * - 任一单元迁移失败即停止本次启动，输出失败模块与原因；
 * - 无待执行迁移时直接成功退出；不存在 Prisma schema 的单元跳过。
 *
 * 执行完成即退出，不承载 HTTP 接口；由开发启动脚本与生产发布命令调用。
 */

interface DeploymentUnit {
  /** 应用目录名与包名后缀 */
  name: string;
  /** workspace 包名 */
  packageName: string;
  /** 迁移元数据默认 schema（platform-core 使用 base，代表 base+backstage 合并序列） */
  metadataSchema: string;
}

const DEPLOYMENT_UNITS: readonly DeploymentUnit[] = [
  { name: 'platform-core', packageName: '@wbme/platform-core', metadataSchema: 'base' },
  { name: 'asset', packageName: '@wbme/asset', metadataSchema: 'asset' },
  { name: 'hr', packageName: '@wbme/hr', metadataSchema: 'hr' },
  { name: 'fin', packageName: '@wbme/fin', metadataSchema: 'fin' },
];

/** 应用 Prisma 目录（schema 与迁移所在位置） */
function prismaDirOf(root: string, unit: DeploymentUnit): string {
  return resolve(root, 'apps', unit.name, 'prisma');
}

/** 单元是否已配置 Prisma schema（尚未建模的单元跳过迁移） */
function hasSchema(root: string, unit: DeploymentUnit): boolean {
  const dir = prismaDirOf(root, unit);
  return existsSync(dir) && readdirSync(dir).some((file) => file.endsWith('.prisma'));
}

/** 执行命令并等待结束 */
function run(cmd: string, args: string[]): Promise<{ ok: boolean; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    child.on('close', (code) => resolvePromise({ ok: code === 0, code }));
  });
}

/** 校验各部署单元迁移元数据表隔离：`_prisma_migrations` 位于各自声明 schema */
async function verifyMetadataIsolation(root: string, databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const unit of DEPLOYMENT_UNITS) {
      if (!hasSchema(root, unit)) {
        continue;
      }
      const result = await client.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = '_prisma_migrations'`,
        [unit.metadataSchema],
      );
      if (result.rowCount === 0) {
        throw new Error(
          `${unit.name} 的迁移元数据表未位于声明 schema "${unit.metadataSchema}"（主 PRD §9.9 迁移历史隔离）`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * 统一执行只读视图脚本（主 PRD §9.9）：全部部署单元迁移完成后执行 scripts/db-views/*.sql。
 * 视图脚本为幂等 CREATE OR REPLACE VIEW，可重复执行；按文件名顺序执行。
 */
async function applyViews(root: string, databaseUrl: string): Promise<void> {
  const viewsDir = resolve(root, 'scripts', 'db-views');
  if (!existsSync(viewsDir)) {
    console.log('[migration-runner] 无视图脚本目录，跳过');
    return;
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const files = readdirSync(viewsDir).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = readFileSync(resolve(viewsDir, file), 'utf8');
      await client.query(sql);
      console.log(`[migration-runner] 视图脚本已执行：${file}`);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  // dist/index.js → apps/migration-runner/dist → 仓库根
  const root = resolve(__dirname, '../../..');
  const databaseUrl = process.env.DATABASE_URL;

  for (const unit of DEPLOYMENT_UNITS) {
    if (!hasSchema(root, unit)) {
      console.log(`[migration-runner] ${unit.name}: 无 Prisma schema，跳过迁移`);
      continue;
    }
    console.log(`[migration-runner] ${unit.name}: 执行 prisma migrate deploy ...`);
    const { ok, code } = await run('pnpm', ['--filter', unit.packageName, 'exec', 'prisma', 'migrate', 'deploy']);
    if (!ok) {
      console.error(`[migration-runner] ${unit.name}: 迁移失败（退出码 ${code}），本次启动停止`);
      process.exit(1);
    }
    console.log(`[migration-runner] ${unit.name}: 迁移完成`);
  }

  if (!databaseUrl) {
    console.log('[migration-runner] 未配置 DATABASE_URL，跳过迁移元数据隔离校验与视图脚本');
  } else {
    await verifyMetadataIsolation(root, databaseUrl);
    console.log('[migration-runner] 各部署单元迁移元数据表隔离校验通过');
    await applyViews(root, databaseUrl);
  }
}

void main().catch((error: unknown) => {
  console.error('[migration-runner] 执行失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
