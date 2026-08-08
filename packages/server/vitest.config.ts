import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 测试期共享包直连 src，避免依赖 dist 产物（与根 tsconfig paths 保持一致）
    alias: {
      '@wbme/contracts': fileURLToPath(new URL('../contracts/src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.ts'],
  },
});
