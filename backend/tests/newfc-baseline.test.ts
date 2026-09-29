/**
 * T-0 基线:AC-F02(存活/就绪)、AC-X01(运行隔离)、AC-X08(显式迁移)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../src/server';
import { openDatabase } from '../src/db/connection';
import { applyMigrations, MIGRATIONS } from '../src/db/migrations';

const REPO_ROOT = path.join(__dirname, '..', '..');

async function withServer<T>(dbPath: string, fn: (base: string, holder: { getDb(): import('../src/db/connection').DB }) => Promise<T>, extra: Record<string, unknown> = {}) {
  const { app, holder } = await createApp({ dbPath, ...extra });
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, holder);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { holder.getDb().close(); } catch { /* already closed */ }
  }
}

describe('AC-F02 存活与就绪', () => {
  it('无需登录即可探活;新库就绪且 schema 为最新', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-health-'));
    await withServer(path.join(dir, 'newfc.sqlite'), async (base) => {
      const live = await fetch(`${base}/api/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ ok: true, status: 'live' });
      const ready = await fetch(`${base}/api/health/ready`);
      expect(ready.status).toBe(200);
      const body = await ready.json() as { checks: Record<string, { ok: boolean; detail?: string }> };
      const latest = Math.max(...MIGRATIONS.map((m) => m.version));
      expect(body.checks.schema).toEqual({ ok: true, detail: `V${latest}` });
      // 就绪响应不含业务数据;受保护的 /api/health 仍需登录
      expect((await fetch(`${base}/api/health`)).status).toBe(401);
    });
  });

  it('数据库不可用时就绪失败(503)而存活仍成功', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-health-'));
    await withServer(path.join(dir, 'newfc.sqlite'), async (base, holder) => {
      holder.getDb().close();
      const ready = await fetch(`${base}/api/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ ok: false, checks: { database: { ok: false } } });
      expect((await fetch(`${base}/api/health/live`)).status).toBe(200);
    });
  });

  it('未配置模型不影响就绪', async () => {
    expect(process.env.AI_BASE_URL).toBe('');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-health-'));
    await withServer(path.join(dir, 'newfc.sqlite'), async (base) => {
      expect((await fetch(`${base}/api/health/ready`)).status).toBe(200);
    });
  });
});

describe('AC-X08 显式迁移', () => {
  it('已初始化且有待执行迁移时,生产入口(autoMigrate=false)拒绝启动且不改库', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-migrate-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    const latest = Math.max(...MIGRATIONS.map((m) => m.version));
    db.prepare('DELETE FROM schema_migration WHERE version = ?').run(latest);
    db.close();
    await expect(createApp({ dbPath, autoMigrate: false })).rejects.toThrow(/待执行迁移/);
    const check = openDatabase(dbPath);
    const row = check.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number };
    check.close();
    expect(row.v).toBeLessThan(latest);
  });
});

describe('AC-X01 仓库与运行隔离', () => {
  const runtimeFiles = [
    'backend/src/index.ts', 'backend/src/server.ts', 'backend/src/db/migrate-cli.ts', 'backend/src/env.ts',
    'deploy/newfc.service', 'scripts/deploy.sh', '.env.example', 'frontend/vite.config.ts', 'frontend/playwright.config.ts',
  ];

  it('运行配置与脚本不引用原项目目录、服务名或端口', () => {
    for (const rel of runtimeFiles) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const offending = text.split('\n').filter((line) =>
        /\/data\/newbd|\/root\/newbd|lishui-finance-ai|newbd-budget\.service|:3748\b|PORT=3748/.test(line)
        // deploy.sh 显式拒绝原项目目录,允许出现在 case 拒绝分支中
        && !/拒绝|case|\|\/root/.test(line));
      expect(offending, rel).toEqual([]);
    }
  });

  it('包名、默认端口与数据库文件名均为 newfc 自有', () => {
    const backendPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'backend/package.json'), 'utf8'));
    const frontendPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'frontend/package.json'), 'utf8'));
    expect(backendPkg.name).toBe('newfc-backend');
    expect(frontendPkg.name).toBe('newfc-frontend');
    const index = fs.readFileSync(path.join(REPO_ROOT, 'backend/src/index.ts'), 'utf8');
    expect(index).toMatch(/NEWFC_PORT \|\| 3760/);
    expect(index).toMatch(/newfc\.sqlite/);
    expect(fs.readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8').trim()).toBe(process.versions.node);
  });

  it('独立 Git:仓库拥有自己的 .git 目录且未配置指向原项目的 remote', () => {
    const gitDir = path.join(REPO_ROOT, '.git');
    expect(fs.statSync(gitDir).isDirectory()).toBe(true);
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    expect(config).not.toMatch(/newbd|lishui/);
  });
});
