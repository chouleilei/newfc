import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@contracts': fileURLToPath(new URL('../backend/src/contracts', import.meta.url)) } },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
