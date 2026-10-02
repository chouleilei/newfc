import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    maxWorkers: 2,
    // 测试隔离：屏蔽本机 .env 里的模型配置(见 tests/setup.ts 的说明)。
    setupFiles: ['./tests/setup.ts'],
  },
});
