import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

/**
 * E2E 测试配置（主 PRD 前端 + 核心业务链路）。
 *
 * - 前置：后端四服务已在本地运行（`pnpm dev`）或由 webServer 自动启动；
 *   测试库已执行迁移且 `node scripts/e2e-seed.mjs` 已创建 ACTIVE 测试用户
 *   （激活流程依赖钉钉外部服务，无法走真实激活）；
 * - worker 无 HTTP 端口、E2E 用例不消费队列任务，不作为 webServer 前置；
 * - reuseExistingServer：本地已起服务时直接复用，CI 由 webServer 拉起。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const platformCorePort = process.env.E2E_PLATFORM_CORE_PORT ?? process.env.PLATFORM_CORE_PORT ?? '43001';
const assetPort = process.env.E2E_ASSET_PORT ?? process.env.ASSET_PORT ?? '43002';
const hrPort = process.env.E2E_HR_PORT ?? process.env.HR_PORT ?? '43003';
const finPort = process.env.E2E_FIN_PORT ?? process.env.FIN_PORT ?? '43004';
const webPort = process.env.E2E_WEB_PORT ?? process.env.WEB_PORT ?? '45173';

// 加载仓库根 .env（本地开发：服务启动所需机密与连接串；CI 由环境变量注入）
try {
  loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  // .env 不存在时使用进程环境变量（CI / 部署注入场景）
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://127.0.0.1:${webPort}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    // 本地已运行（pnpm dev）时复用；CI 无进程时自动启动（cwd = 仓库根）
    {
      command: 'node apps/platform-core/dist/main.js',
      url: `http://127.0.0.1:${platformCorePort}/healthz`,
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { PLATFORM_CORE_PORT: platformCorePort },
    },
    {
      command: 'node apps/asset/dist/main.js',
      url: `http://127.0.0.1:${assetPort}/healthz`,
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { ASSET_PORT: assetPort },
    },
    {
      command: 'node apps/hr/dist/main.js',
      url: `http://127.0.0.1:${hrPort}/healthz`,
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { HR_PORT: hrPort },
    },
    {
      command: 'node apps/fin/dist/main.js',
      url: `http://127.0.0.1:${finPort}/healthz`,
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { FIN_PORT: finPort },
    },
    {
      command: 'pnpm --filter @wbme/web dev --host 127.0.0.1',
      url: `http://127.0.0.1:${webPort}`,
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { WEB_PORT: webPort },
    },
  ],
  outputDir: 'e2e-results',
});
