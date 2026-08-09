import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 前端工程配置（主 PRD §10.1）。
 * 开发环境经与生产一致的同源网关路径路由至四项服务；生产由 Nginx 按同一契约转发。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 独立业务服务：去除公开服务前缀后保留后端既有 /api/v1 契约。
      '/api/asset/v1': {
        target: process.env.ASSET_URL ?? 'http://localhost:3002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/asset\/v1/, '/api/v1'),
      },
      '/api/hr/v1': {
        target: process.env.HR_URL ?? 'http://localhost:3003',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hr\/v1/, '/api/v1'),
      },
      '/api/fin/v1': {
        target: process.env.FIN_URL ?? 'http://localhost:3004',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/fin\/v1/, '/api/v1'),
      },
      // 平台核心公开 API（生产由 Nginx 承担，见 T10-1）。
      '/api/v1': {
        target: process.env.PLATFORM_CORE_URL ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
