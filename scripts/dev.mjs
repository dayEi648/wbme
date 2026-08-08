#!/usr/bin/env node
/**
 * 开发环境一键启动（主 PRD §9.9、dev-workflow §5）。
 *
 * 开发环境不使用 Docker（容器化仅用于生产部署），依赖本机 PostgreSQL 与 Redis：
 *   1. 检查本地 PostgreSQL 与 Redis 可达（不可达给出明确安装提示并退出）；
 *   2. 构建共享包（@wbme/packages，供各应用运行时消费）；
 *   3. 执行 Migration Runner（按部署单元顺序迁移，失败即停）；
 *   4. 并行启动 platform-core / asset / hr / fin / worker（构建产物）。
 *
 * 退出方式：Ctrl+C 或 SIGTERM 时依次终止全部子进程。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

// 加载仓库根 .env（本地开发变量；生产/CI 由部署环境注入，缺失时跳过）
try {
  loadEnvFile(resolve(root, '.env'));
} catch {
  // .env 不存在时使用进程环境变量
}
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wbme';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

const SERVICES = [
  { name: 'platform-core', cmd: ['node', 'dist/main.js'] },
  { name: 'asset', cmd: ['node', 'dist/main.js'] },
  { name: 'hr', cmd: ['node', 'dist/main.js'] },
  { name: 'fin', cmd: ['node', 'dist/main.js'] },
  { name: 'worker', cmd: ['node', 'dist/main.js'] },
  // 前端使用 Vite dev server（HMR），命令为 pnpm dev
  { name: 'web', cmd: ['pnpm', 'dev'] },
];

/** 尝试建立 TCP 连接（用于探活本地服务端口） */
function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
  });
}

/** 解析 URL 的 host/port（redis:// 与 postgresql:// 均适用） */
function parseHostPort(url) {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: Number(parsed.port || (parsed.protocol === 'redis:' ? 6379 : 5432)) };
  } catch {
    return null;
  }
}

async function checkDependencies() {
  const pg = parseHostPort(databaseUrl);
  const redis = parseHostPort(redisUrl);

  const pgOk = pg ? await tcpProbe(pg.host, pg.port) : false;
  if (!pgOk) {
    console.error(`[dev] PostgreSQL 不可达（${databaseUrl}）。开发环境使用本机 PostgreSQL：brew install postgresql@18`);
    process.exit(1);
  }
  const redisOk = redis ? await tcpProbe(redis.host, redis.port) : false;
  if (!redisOk) {
    console.error(`[dev] Redis 不可达（${redisUrl}）。开发环境使用本机 Redis：brew install redis`);
    process.exit(1);
  }
  console.log(`[dev] 依赖检查通过：PostgreSQL（${pg.host}:${pg.port}）、Redis（${redis.host}:${redis.port}）`);
}

function buildPackages() {
  const result = spawnSync('pnpm', ['build:packages'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('[dev] 共享包构建失败，停止启动');
    process.exit(1);
  }
  console.log('[dev] 共享包构建完成');
}

/** 全新环境（clone 后未构建）下各服务 dist 不存在：先构建缺失的服务，保证 `pnpm dev` 一条命令起全套 */
function buildMissingServices() {
  const missing = SERVICES.filter(
    (s) => s.cmd[0] === 'node' && !existsSync(resolve(root, 'apps', s.name, 'dist', 'main.js')),
  );
  if (missing.length === 0) {
    return;
  }
  console.log(`[dev] 检测到未构建的服务（${missing.map((s) => s.name).join(' / ')}），先执行构建...`);
  for (const service of missing) {
    const result = spawnSync('pnpm', ['--filter', `@wbme/${service.name}`, 'build'], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) {
      console.error(`[dev] ${service.name} 构建失败，停止启动`);
      process.exit(1);
    }
    console.log(`[dev] ${service.name} 构建完成`);
  }
}

function runMigrationRunner() {
  const result = spawnSync('pnpm', ['--filter', '@wbme/migration-runner', 'start'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error('[dev] Migration Runner 执行失败（迁移未完成），停止启动');
    process.exit(1);
  }
  console.log('[dev] Migration Runner 执行完成');
}

function startServices() {
  const children = [];
  for (const service of SERVICES) {
    const child = spawn(service.cmd[0], service.cmd.slice(1), {
      cwd: resolve(root, 'apps', service.name),
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (service.name === 'worker' && code === 0) {
        // Worker 当前为空实现（T4-2 接入 BullMQ 消费者后常驻），启动即退出属正常
        console.log('[dev] worker 空实现已启动即退出（正常，T4-2 接入任务消费者后常驻）');
        return;
      }
      console.error(`[dev] ${service.name} 退出（code=${code}）`);
    });
    children.push({ name: service.name, child });
  }
  console.log(`[dev] 已启动 ${children.map((c) => c.name).join(' / ')}，Ctrl+C 停止全部`);

  const shutdown = () => {
    console.log('\n[dev] 正在停止全部服务...');
    for (const { name, child } of children) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        console.log(`[dev] ${name} 已发送 SIGTERM`);
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await checkDependencies();
buildPackages();
buildMissingServices();
runMigrationRunner();
startServices();
