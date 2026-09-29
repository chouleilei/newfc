import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* @contracts/* 只允许 `import type`(编译期擦除,构建产物不含 zod);别名保证误写成值导入时也能解析并在评审中暴露。 */
const contracts = fileURLToPath(new URL('../backend/src/contracts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@contracts': contracts } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3760', changeOrigin: false },
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
