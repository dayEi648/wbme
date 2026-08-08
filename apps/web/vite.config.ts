import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 前端工程配置（主 PRD §10.1）。
 * 开发环境将 /api/v1 代理到 platform-core（3001）；生产由 Nginx 统一入口转发。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 业务接口代理到 platform-core（生产由 Nginx 承担，见 T10-1）
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
