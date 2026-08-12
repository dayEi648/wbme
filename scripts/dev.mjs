#!/usr/bin/env node
/**
 * 开发环境一键启动（主 PRD §9.9、dev-workflow §5）。
 *
 * 开发环境不使用 Docker（容器化仅用于生产部署），依赖本机 PostgreSQL 与 Redis：
 *   1. 检查本地 PostgreSQL 与 Redis 可达（不可达给出明确安装提示并退出）；
 *   2. 构建共享包（@wbme/packages，供各应用运行时消费）；
 *   3. 执行 Migration Runner（按部署单元顺序增量迁移，失败即停）；
 *   4. 执行幂等种子（权限目录 + 首个超管账号，全新库初始化）；
 *   5. 并行启动 platform-core / asset / hr / fin / worker（构建产物）。
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

/**
 * 服务端口定义（开发默认端口，43xxx/45xxx 少见端口段，避免与常见服务冲突）。
 * 端口被占用时由 resolvePorts 统一 +1 顺延，并把最终端口经环境变量注入全部子进程，
 * 保证 Vite 代理、服务间内部调用、钉钉回调等"依赖固定端口"的位置同步跟随。
 */
const DEFAULT_PORTS = {
  'platform-core': 43001,
  asset: 43002,
  hr: 43003,
  fin: 43004,
  worker: 43105,
  web: 45173,
};

/** 端口顺延尝试上限（超出后按占用报错退出，避免无界抢占） */
const PORT_TRY_LIMIT = 20;

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

/**
 * 预检并分配各服务实际端口：首选端口被占用时 +1 顺延（上限 PORT_TRY_LIMIT）。
 * 返回 { service: 实际端口 } 映射，供环境变量注入与端口表打印。
 */
async function resolvePorts() {
  const resolved = {};
  for (const [name, preferred] of Object.entries(DEFAULT_PORTS)) {
    let port = preferred;
    let used = false;
    for (let i = 0; i < PORT_TRY_LIMIT; i++) {
      // 同一端口已分配给其它服务也视为占用，避免两服务抢同一端口
      if (!Object.values(resolved).includes(port) && !(await tcpProbe('127.0.0.1', port))) {
        resolved[name] = port;
        used = true;
        break;
      }
      port += 1;
    }
    if (!used) {
      console.error(`[dev] ${name} 端口（起始 ${preferred}）连续 ${PORT_TRY_LIMIT} 个均被占用，请释放端口后重试`);
      process.exit(1);
    }
  }
  return resolved;
}

/**
 * 基于分配后的端口生成子进程环境变量：
 * 各服务 *_PORT、Vite 代理目标（*_URL）、服务间内部 base URL、公开 origin/钉钉回调。
 * 覆盖 .env 中的旧端口值（如 PUBLIC_ORIGIN），保证顺延后全链路一致。
 */
function buildServiceEnv(ports) {
  const env = { ...process.env };
  env.PLATFORM_CORE_PORT = String(ports['platform-core']);
  env.ASSET_PORT = String(ports.asset);
  env.HR_PORT = String(ports.hr);
  env.FIN_PORT = String(ports.fin);
  env.WORKER_HEALTH_PORT = String(ports.worker);
  env.WEB_PORT = String(ports.web);
  // Vite 代理目标（apps/web/vite.config.ts 读取；口径与生产 nginx 契约一致）
  env.PLATFORM_CORE_URL = `http://localhost:${ports['platform-core']}`;
  env.ASSET_URL = `http://localhost:${ports.asset}`;
  env.HR_URL = `http://localhost:${ports.hr}`;
  env.FIN_URL = `http://localhost:${ports.fin}`;
  // 服务间内部 base URL（docker-compose 内网口径的本地等价：http://host:port）
  env.PLATFORM_CORE_INTERNAL_BASE_URL = `http://localhost:${ports['platform-core']}`;
  env.ASSET_INTERNAL_BASE_URL = `http://localhost:${ports.asset}/internal/v1`;
  env.HR_INTERNAL_BASE_URL = `http://localhost:${ports.hr}/internal/v1`;
  // 公开 origin 与钉钉回调（激活/重置链接、OAuth 回调与 Vite 端口保持一致）
  env.PUBLIC_ORIGIN = `http://localhost:${ports.web}`;
  env.DINGTALK_REDIRECT_URI = `http://localhost:${ports.web}/api/v1/auth/dingtalk/callback`;
  return env;
}

/** 打印端口映射表（顺延发生时便于定位实际端口） */
function printPortTable(ports) {
  const rows = Object.entries(ports).map(([name, port]) => `  ${name.padEnd(14)} ${port}`);
  console.log(`[dev] 端口映射：\n${rows.join('\n')}`);
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

/** 生成 Prisma Client（src 下 generated 目录不提交，全新 clone 无产物；generate 幂等，重复执行安全） */
function generatePrisma() {
  const result = spawnSync('pnpm', ['prisma:generate'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('[dev] Prisma Client 生成失败，停止启动');
    process.exit(1);
  }
  console.log('[dev] Prisma Client 生成完成');
}

/** 全新环境（clone 后未构建）下各服务 dist 不存在：先构建缺失的服务，保证 `pnpm dev` 一条命令起全套 */
function buildMissingServices() {
  const missing = SERVICES.filter(
    (s) => s.cmd[0] === 'node' && !existsSync(resolve(root, 'apps', s.name, 'dist', 'main.js')),
  );
  // Migration Runner 的 start 直接运行 dist/index.js，同样可能未构建
  if (!existsSync(resolve(root, 'apps', 'migration-runner', 'dist', 'index.js'))) {
    missing.push({ name: 'migration-runner' });
  }
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

function runMigrationRunner(env) {
  const result = spawnSync('pnpm', ['--filter', '@wbme/migration-runner', 'start'], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  if (result.status !== 0) {
    console.error('[dev] Migration Runner 执行失败（迁移未完成），停止启动');
    process.exit(1);
  }
  console.log('[dev] Migration Runner 执行完成');
}

/**
 * 种子与初始化数据（权限目录 + 首个超管账号，幂等：upsert / 已存在即跳过）。
 * `prisma migrate deploy` 不触发 seed（Prisma 设计），开发启动需显式执行；
 * 每次启动重复执行安全，全新库首次执行即完成初始化（主 PRD §3.1）。
 */
function runSeed(env) {
  const result = spawnSync('pnpm', ['--filter', '@wbme/platform-core', 'exec', 'prisma', 'db', 'seed'], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  if (result.status !== 0) {
    console.error('[dev] 种子初始化失败（权限目录/超管账号），停止启动');
    process.exit(1);
  }
  console.log('[dev] 种子初始化完成（幂等）');
}

function startServices(env) {
  const children = [];
  for (const service of SERVICES) {
    const child = spawn(service.cmd[0], service.cmd.slice(1), {
      cwd: resolve(root, 'apps', service.name),
      stdio: 'inherit',
      env,
    });
    child.on('exit', (code) => {
      // Worker 为常驻进程（消费队列任务）；code 0 退出属异常（调度器/消费者不应主动退出）
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
// 端口预检分配：被占用自动 +1 顺延，最终端口注入全部子进程
const ports = await resolvePorts();
const serviceEnv = buildServiceEnv(ports);
printPortTable(ports);
generatePrisma();
buildPackages();
buildMissingServices();
runMigrationRunner(serviceEnv);
runSeed(serviceEnv);
startServices(serviceEnv);
