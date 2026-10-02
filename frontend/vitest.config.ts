import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@contracts': fileURLToPath(new URL('../backend/src/contracts', import.meta.url)) } },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // 组件挂载包含 Ant Design 浮层，限制并发以适应单机与 CI 的 CPU/内存。
    maxWorkers: 2,
    testTimeout: 15_000,
  },
});
