import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    // 集成测试共享同一个数据库：spec 之间存在全局态读写（如"最后一名可用超管"保护
    // 会批量选中当前全部可用超管），并行执行会互相注销对方规格的操作人账号。
    // 串行执行消除这类交叉干扰；全量约 6s，可接受。
    fileParallelism: false,
  },
});
