import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 前端工程配置（主 PRD §10.1）。
 * 主题与请求层完整实现见 T9-1；本期仅保证骨架可构建与启动。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
  },
});
