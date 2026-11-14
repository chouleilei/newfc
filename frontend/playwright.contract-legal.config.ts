import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
const dataDir = process.env.NEWFC_T9_E2E_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t9-e2e-'));
if(!/^\/tmp\/newfc-t9-e2e-[^/]+$/.test(dataDir))throw new Error('法审 E2E 只能使用临时测试目录');
// Teardown is local to this configuration; production data and compiled dist are never touched.
process.env.NEWFC_T9_E2E_DIR = dataDir;
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /(contract-lifecycle|contract-legal|project-contract)\.spec\.ts$/,
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    baseURL: 'http://127.0.0.1:3764',
    viewport: { width: 1440, height: 1000 },
    headless: true,
    trace: 'retain-on-failure',
    actionTimeout: 15000,
  },
  reporter: [['list']],
  globalTeardown: './tests/e2e/contract-legal-teardown.ts',
  webServer: {
    command:
      'cd ../backend && node -r ts-node/register/transpile-only scripts/seed-contract-legal-e2e.ts && node .t9-dist/index.js',
    url: 'http://127.0.0.1:3764/api/health/ready',
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      NEWFC_DATA_DIR: dataDir,
      NEWFC_PORT: '3764',
      NEWFC_FRONTEND_DIST: '/tmp/newfc-t9-frontend',
      AI_BASE_URL: '',
      AI_API_KEY: '',
      AI_MODEL: '',
      OPENAI_BASE_URL: '',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: '',
    },
  },
});
