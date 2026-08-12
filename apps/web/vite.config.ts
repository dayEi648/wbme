import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * 前端工程配置（主 PRD §10.1）。
 * 开发环境经与生产一致的同源网关路径路由至四项服务；生产由 Nginx 按同一契约转发。
 * 开发端口默认 45173（少见端口段），可由 WEB_PORT 覆盖；Vite 自带端口被占用自动顺延。
 */
const DEV_PORT = Number(process.env.WEB_PORT ?? 45173);

export default defineConfig({
  plugins: [react()],
  server: {
    port: DEV_PORT,
    host: true,
    fs: {
      allow: [path.resolve(webRoot, '../..')],
    },
    proxy: {
      // 独立业务服务：去除公开服务前缀后保留后端既有 /api/v1 契约。
      '/api/asset/v1': {
        target: process.env.ASSET_URL ?? 'http://localhost:43002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/asset\/v1/, '/api/v1'),
      },
      '/api/hr/v1': {
        target: process.env.HR_URL ?? 'http://localhost:43003',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hr\/v1/, '/api/v1'),
      },
      '/api/fin/v1': {
        target: process.env.FIN_URL ?? 'http://localhost:43004',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/fin\/v1/, '/api/v1'),
      },
      // 平台核心公开 API（生产由 Nginx 承担）。
      '/api/v1': {
        target: process.env.PLATFORM_CORE_URL ?? 'http://localhost:43001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
