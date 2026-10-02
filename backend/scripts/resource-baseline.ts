/**
 * OPEN-04 / AC-X09 资源基线(T-2 首个闭环)。
 *
 *   npm run build && npm run resource:baseline -- [--port 3763] [--out 结果.json] [--dist 编译产物/index.js] [--keep 目录]
 * --keep:结束后把一次性数据目录移到指定(不存在的)目录保留,供恢复演练测 RTO;默认删除。
 *
 * 在系统临时目录新建一次性数据目录(绝不指向运行库),种入固定规模主数据后,
 * 以子进程启动编译产物 dist/index.js,按 specs/operations.md「资源」一节的工作负载测量:
 * 冷启动、稳定空闲、典型预算查询、代表性/最大支持导入、超限导入、报告导出、
 * 助手降级(无模型)、一次重任务 + 普通查询。RSS 取 /proc/<pid>/status 的 VmRSS/VmHWM。
 * T-6(AC-X09 收口)增加:报告发布渲染、预测重算(样本与超时上限)、敏感性分析、跨域检索,
 * 以及“敏感性分析(重任务)+ 普通查询/检索 p95”。
 *
 * 规模:1 集团 + 5 大区 + 100 公司;4 类科目共 200 个末级科目。
 *   代表性导入 = 10 公司 × 200 科目 = 2,000 行;最大支持导入 = 100 × 200 = 20,000 行(MAX_IMPORT_ROWS);
 *   超限 = 20,001 行。
 * 口令为运行时随机生成,仅用于本次一次性库。
 */
import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { openDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { runWithContext, systemContext } from '../src/core/request-context';
import { bootstrapAdmin } from '../src/modules/security/security.service';
import * as org from '../src/modules/org/org.service';
import * as account from '../src/modules/account/account.service';
import * as budget from '../src/modules/budget/budget.service';
import * as master from '../src/modules/master/master.service';
import { getSetting } from '../src/modules/settings/business-settings';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', '3763'));
const OUT = arg('out');
const REGIONS = 5;
const COMPANIES = 100;
const LEAVES_PER_TYPE = 50;
const TYPES = [['I', 'income', '收入'], ['C', 'cost', '成本'], ['E', 'expense', '费用'], ['Q', 'quantity', '数量']] as const;

const base = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-resource-'));
const dbPath = path.join(dataDir, 'newfc.sqlite');
const password = crypto.randomBytes(18).toString('base64url');

function seed() {
  const db = openDatabase(dbPath);
  applyMigrations(db);
  const ids = runWithContext(systemContext('cli'), () => {
    bootstrapAdmin(db, 'resource-admin', password);
    const root = org.createOrg(db, { parentId: null, code: 'G', name: '集团' }).id;
    const companies: string[] = [];
    const companyIds: number[] = [];
    for (let r = 1; r <= REGIONS; r++) {
      const region = org.createOrg(db, { parentId: root, code: `R${r}`, name: `大区${r}` }).id;
      for (let c = 1; c <= COMPANIES / REGIONS; c++) {
        const code = `C${r}${String(c).padStart(2, '0')}`;
        companyIds.push(org.createOrg(db, { parentId: region, code, name: `公司${code}` }).id);
        companies.push(code);
      }
    }
    const accounts: { code: string; quantity: boolean }[] = [];
    for (const [prefix, type, name] of TYPES) {
      const parent = account.createAccount(db, { parentId: null, code: prefix, name, type, ...(type === 'quantity' ? { unit: '件' } : {}) }).id;
      for (let i = 1; i <= LEAVES_PER_TYPE; i++) {
        const code = `${prefix}${String(i).padStart(3, '0')}`;
        account.createAccount(db, { parentId: parent, code, name: `${name}${i}`, type, ...(type === 'quantity' ? { unit: '件' } : {}) });
        accounts.push({ code, quantity: type === 'quantity' });
      }
    }
    // 检索负载:500 个项目、200 个供应商(编码/名称可被关键词命中)
    for (let i = 1; i <= 500; i++) {
      master.createProject(db, { code: `P${String(i).padStart(4, '0')}`, name: `水利工程项目${i}`, orgId: companyIds[i % companyIds.length] });
    }
    for (let i = 1; i <= 200; i++) master.createSupplier(db, { code: `S${String(i).padStart(4, '0')}`, name: `供应商${i}建设有限公司` });
    const typical = budget.createVersion(db, { year: 2026, name: '典型查询' }).id;
    const representative = budget.createVersion(db, { year: 2026, name: '代表性导入' }).id;
    const max = budget.createVersion(db, { year: 2026, name: '最大导入' }).id;
    return { root, companies, accounts, versions: { typical, representative, max } };
  });
  db.close();
  return ids;
}

async function workbook(companies: string[], accounts: { code: string; quantity: boolean }[], extraRows = 0): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('预算导入');
  ws.addRow(['组织编码', '科目编码', '金额(元)', '数量', '备注']);
  let n = 0;
  for (const c of companies) {
    for (const a of accounts) {
      n++;
      ws.addRow(a.quantity ? [c, a.code, '', String((n % 97) + 0.5), ''] : [c, a.code, `${(n * 1234.56 % 1_000_000).toFixed(2)}`, '', '']);
    }
  }
  for (let i = 0; i < extraRows; i++) ws.addRow([companies[0], accounts[0].code, '1.00', '', `超限${i}`]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function procStatus(pid: number): { rssMiB: number; hwmMiB: number } {
  const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (key: string) => Number(new RegExp(`${key}:\\s+(\\d+) kB`).exec(text)?.[1] ?? 0);
  return { rssMiB: +(kb('VmRSS') / 1024).toFixed(1), hwmMiB: +(kb('VmHWM') / 1024).toFixed(1) };
}

function cpuSeconds(pid: number): number {
  const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const ticks = Number(fields[11]) + Number(fields[12]);
  return ticks / 100;
}

class Sampler {
  peak = 0;
  private timer?: NodeJS.Timeout;
  constructor(private pid: number) {}
  start() { this.peak = procStatus(this.pid).rssMiB; this.timer = setInterval(() => { this.peak = Math.max(this.peak, procStatus(this.pid).rssMiB); }, 50); }
  stop() { clearInterval(this.timer); return this.peak; }
}

let session = { cookie: '', csrf: '' };
async function call(method: string, url: string, body?: unknown, form?: FormData): Promise<{ status: number; ms: number; json: any }> {
  const t = performance.now();
  const headers: Record<string, string> = { cookie: session.cookie };
  if (method !== 'GET') headers['x-csrf-token'] = session.csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${url}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const buf = await res.arrayBuffer();
  const ms = performance.now() - t;
  let json: any = null;
  try { json = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { json = { bytes: buf.byteLength }; }
  return { status: res.status, ms, json };
}

const pct = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(1);
};

/** 前置步骤失败时立即报错,避免后续测量拿到无意义的 id。 */
async function must(step: string, p: Promise<{ status: number; json: any }>): Promise<any> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${step} 失败 HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}

async function waitJob(jobId: number): Promise<{ status: string; ms: number }> {
  const t = performance.now();
  for (;;) {
    const r = await call('GET', `/api/jobs/${jobId}`);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.json?.status)) return { status: r.json.status, ms: performance.now() - t };
    if (performance.now() - t > 300_000) return { status: 'timeout', ms: performance.now() - t };
    await new Promise((res) => setTimeout(res, 50));
  }
}

async function forecastWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const p = wb.addWorksheet('参数');
  p.getCell('A1').value = '增长率';
  p.getCell('B1').value = 0.05;
  const f = wb.addWorksheet('预测');
  // 10 年 × 200 行的递推公式,代表一份中等规模的预测模型
  for (let r = 1; r <= 200; r++) {
    f.getCell(r, 1).value = `项目${r}`;
    f.getCell(r, 2).value = 1000 + r;
    for (let c = 3; c <= 12; c++) {
      const prev = f.getCell(r, c - 1).address;
      f.getCell(r, c).value = { formula: `${prev}*(1+参数!$B$1)`, result: 0 };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 重任务期间持续发普通请求,返回延迟分布。 */
function lightLoad(urls: string[]) {
  let stop = false;
  const light: { ms: number; status: number }[] = [];
  const loop = (async () => {
    let i = 0;
    while (!stop) {
      const r = await call('GET', urls[i++ % urls.length]);
      light.push({ ms: r.ms, status: r.status });
    }
  })();
  return async () => {
    stop = true;
    await loop;
    const ms = light.map((l) => l.ms);
    return { requests: light.length, errors: light.filter((l) => l.status >= 400).length, p50Ms: pct(ms, 50), p95Ms: pct(ms, 95), maxMs: pct(ms, 100) };
  };
}

async function importFile(versionId: number, file: Buffer) {
  const form = new FormData();
  form.append('versionId', String(versionId));
  form.append('file', new Blob([new Uint8Array(file)]), 'baseline.xlsx');
  const preview = await call('POST', '/api/io/budget/import', undefined, form);
  if (preview.status !== 200) return { preview, confirm: null };
  const confirm = await call('POST', `/api/io/import-batches/${preview.json.importBatchId}/confirm`, {});
  return { preview, confirm };
}

async function main() {
  const started = Date.now();
  const ids = seed();
  const dist = path.resolve(arg('dist', path.join(__dirname, '..', 'dist', 'index.js'))!);
  if (!fs.existsSync(dist)) throw new Error('缺少 dist/index.js,请先 npm run build');

  const t0 = performance.now();
  const child: ChildProcess = spawn(process.execPath, [dist], {
    env: { ...process.env, NEWFC_DATA_DIR: dataDir, NEWFC_PORT: String(PORT), NEWFC_HOST: '127.0.0.1', AI_BASE_URL: '', OPENAI_BASE_URL: '', NODE_ENV: 'production' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  const pid = child.pid!;
  const result: Record<string, unknown> = {
    environment: { node: process.version, platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, memMiB: Math.round(os.totalmem() / 1048576) },
    scale: { orgs: 1 + REGIONS + COMPANIES, leafAccounts: TYPES.length * LEAVES_PER_TYPE },
  };
  try {
    for (;;) {
      try { if ((await fetch(`${base}/api/health/ready`)).ok) break; } catch { /* 未就绪 */ }
      if (performance.now() - t0 > 30_000) throw new Error(`30s 内未就绪:${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    result.coldStart = { readyMs: Math.round(performance.now() - t0), ...procStatus(pid) };

    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'resource-admin', password }) });
    const token = /newfc_session=([a-f0-9]{64})/.exec(login.headers.get('set-cookie') ?? '')?.[1];
    session = { cookie: `newfc_session=${token}`, csrf: ((await login.json()) as { csrfToken: string }).csrfToken };

    await new Promise((r) => setTimeout(r, 5_000));
    result.steadyIdle = procStatus(pid);

    // 代表性导入(2,000 行)
    const repFile = await workbook(ids.companies.slice(0, 10), ids.accounts);
    let sampler = new Sampler(pid); sampler.start();
    const rep = await importFile(ids.versions.representative, repFile);
    result.representativeImport = { rows: 10 * ids.accounts.length, fileKiB: Math.round(repFile.length / 1024), previewMs: Math.round(rep.preview.ms), confirmMs: Math.round(rep.confirm?.ms ?? -1), status: [rep.preview.status, rep.confirm?.status], peakRssMiB: sampler.stop() };

    // 典型预算查询:在代表性数据上 20 次执行报表
    await importFile(ids.versions.typical, repFile);
    const queryMs: number[] = [];
    for (let i = 0; i < 20; i++) queryMs.push((await call('GET', `/api/report/completion?versionId=${ids.versions.typical}`)).ms);
    result.typicalQuery = { requests: 20, p50Ms: pct(queryMs, 50), p95Ms: pct(queryMs, 95), maxMs: pct(queryMs, 100) };

    // 最大支持导入(20,000 行)+ 同时的普通查询/任务进度/登录态(一次重任务 + 普通查询)
    const maxFile = await workbook(ids.companies, ids.accounts);
    const cpu0 = cpuSeconds(pid);
    sampler = new Sampler(pid); sampler.start();
    let stop = false;
    const light: { url: string; ms: number; status: number }[] = [];
    const lightLoop = (async () => {
      const urls = ['/api/health/ready', '/api/jobs', '/api/me', `/api/report/completion?versionId=${ids.versions.typical}&orgScopeId=2`];
      let i = 0;
      while (!stop) {
        const url = urls[i++ % urls.length];
        const r = await call('GET', url);
        light.push({ url, ms: r.ms, status: r.status });
      }
    })();
    const maxT = performance.now();
    const max = await importFile(ids.versions.max, maxFile);
    const maxTotal = performance.now() - maxT;
    stop = true;
    await lightLoop;
    const lightMs = light.map((l) => l.ms);
    result.maxImport = {
      rows: COMPANIES * ids.accounts.length, fileKiB: Math.round(maxFile.length / 1024),
      previewMs: Math.round(max.preview.ms), confirmMs: Math.round(max.confirm?.ms ?? -1), totalMs: Math.round(maxTotal),
      status: [max.preview.status, max.confirm?.status], peakRssMiB: sampler.stop(), cpuSeconds: +(cpuSeconds(pid) - cpu0).toFixed(2),
    };
    result.concurrentLightRequests = {
      requests: light.length, errors: light.filter((l) => l.status >= 400).length,
      p50Ms: pct(lightMs, 50), p95Ms: pct(lightMs, 95), maxMs: pct(lightMs, 100),
    };

    // 超限:20,001 行明确拒绝,不 OOM
    const overFile = await workbook(ids.companies, ids.accounts, 1);
    sampler = new Sampler(pid); sampler.start();
    const over = await importFile(ids.versions.max, overFile);
    result.overLimitImport = { rows: COMPANIES * ids.accounts.length + 1, status: over.preview.status, code: over.preview.json?.code, message: String(over.preview.json?.message ?? '').slice(0, 80), ms: Math.round(over.preview.ms), peakRssMiB: sampler.stop() };

    // 报告导出(最大版本的执行报表 xlsx)
    sampler = new Sampler(pid); sampler.start();
    const exp = await call('GET', `/api/io/export/completion/${ids.versions.max}`);
    result.reportExport = { status: exp.status, ms: Math.round(exp.ms), bytes: exp.json?.bytes, peakRssMiB: sampler.stop() };

    // 助手降级(未配置模型):规则路由回答
    const chatMs: number[] = [];
    let routing = '';
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/assistant/chat', { message: '2026年预算执行情况', pageContext: { schemaVersion: 2, snapshotId: 'resource-chat', routeInstanceId: 'resource-route', contextVersion: 1, pageKey: 'assistant', scope: { year: 2026, budgetVersionId: ids.versions.max } } });
      chatMs.push(r.ms);
      routing = r.json?.routing ?? `HTTP ${r.status}`;
    }
    result.assistantDegraded = { requests: 5, routing, p50Ms: pct(chatMs, 50), maxMs: pct(chatMs, 100) };

    // T-6:跨域检索(20 次,关键词命中 100 家公司)
    const searchMs: number[] = [];
    let searchCount = 0;
    for (let i = 0; i < 20; i++) {
      const r = await call('GET', `/api/search?q=${encodeURIComponent(['P00', '水利工程', '供应商1', 'P0123'][i % 4])}`);
      searchMs.push(r.ms);
      searchCount = r.json?.items?.length ?? -1;
    }
    result.crossSearch = { requests: 20, seeded: { projects: 500, suppliers: 200 }, lastItems: searchCount, p50Ms: pct(searchMs, 50), p95Ms: pct(searchMs, 95), maxMs: pct(searchMs, 100) };

    // T-6:报告发布渲染(创建 → 提交 → 自审例外 → 发布任务)
    sampler = new Sampler(pid); sampler.start();
    let rep1 = await must('创建报告', call('POST', '/api/analysis-reports', { kind: 'risk_investment', year: 2026 }));
    rep1 = await must('提交报告', call('POST', `/api/analysis-reports/${rep1.id}/submit`, { expectedVersion: rep1.version }));
    rep1 = await must('审批报告', call('POST', `/api/analysis-reports/${rep1.id}/approve`, { expectedVersion: rep1.version, exceptionReason: '资源基线单人' }));
    const pubT = performance.now();
    const pub = await call('POST', `/api/analysis-reports/${rep1.id}/publish`, { expectedVersion: rep1.version });
    const pubJob = pub.status === 202 ? await waitJob(pub.json.jobId) : { status: `HTTP ${pub.status}`, ms: 0 };
    result.reportPublish = { status: pubJob.status, totalMs: Math.round(performance.now() - pubT), peakRssMiB: sampler.stop() };

    // T-6:预测重算(10 年 × 200 行公式样本;超时上限取业务设置)
    const FF = '/api/forecast';
    const model = await must('创建预测模型', call('POST', `${FF}/models`, { name: '资源基线预测', orgId: ids.root, baseYear: 2026, horizonYears: 10 }));
    const ffForm = new FormData();
    ffForm.append('file', new Blob([new Uint8Array(await forecastWorkbook())]), '预测.xlsx');
    let fv = await must('导入预测工作簿', call('POST', `${FF}/models/${model.id}/imports`, undefined, ffForm));
    fv = await must('配置预测参数', call('PATCH', `${FF}/versions/${fv.id}`, { expectedVersion: fv.version, params: [{ key: 'g', name: '增长率', cell: '参数!B1' }], outputs: Array.from({ length: 10 }, (_, i) => ({ key: `r${i + 1}`, name: `项目${i * 20 + 1}`, ref: `预测!B${i * 20 + 1}:L${i * 20 + 1}` })) }));
    fv = await must('冻结预测版本', call('POST', `${FF}/versions/${fv.id}/freeze`, { expectedVersion: fv.version }));
    sampler = new Sampler(pid); sampler.start();
    const ffT = performance.now();
    const ffRun = await call('POST', `${FF}/versions/${fv.id}/runs`, { kind: 'baseline', params: {} });
    const ffJob = ffRun.status === 202 ? await waitJob(ffRun.json.jobId) : { status: `HTTP ${ffRun.status}: ${JSON.stringify(ffRun.json).slice(0, 120)}`, ms: 0 };
    const settingsDb = openDatabase(dbPath);
    const timeoutSeconds = getSetting<number>(settingsDb, 'forecast.timeout_seconds');
    settingsDb.close();
    result.forecastRecalc = { cells: 200 * 10, status: ffJob.status, totalMs: Math.round(performance.now() - ffT), peakRssMiB: sampler.stop(), timeoutSeconds };

    // T-6:敏感性分析(重任务)+ 同时的普通查询/检索
    const FEAS = '/api/investment/feasibility';
    const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'investment_feasibility_yichongqiao.json'), 'utf8'));
    const fp = await must('创建可研项目', call('POST', `${FEAS}/projects`, { code: 'RB-1', name: '资源基线测算', orgId: ids.root, constructionStartYear: 2026, operationStartYear: 2028, horizonYears: 30 }));
    const sc = await must('创建方案', call('POST', `${FEAS}/projects/${fp.id}/scenarios`, { code: 'BASE', name: '基准', assumptions: sample.assumptions }));
    const cpu1 = cpuSeconds(pid);
    sampler = new Sampler(pid); sampler.start();
    const stopLight = lightLoad(['/api/health/ready', '/api/jobs', '/api/me', '/api/search?q=C1', `/api/report/completion?versionId=${ids.versions.typical}&orgScopeId=2`]);
    const sensT = performance.now();
    const sens = await call('POST', `${FEAS}/scenarios/${sc.id}/sensitivity`, { expectedVersion: sc.version });
    const sensJob = sens.status === 202 ? await waitJob(sens.json.jobId) : { status: `HTTP ${sens.status}`, ms: 0 };
    const sensTotal = performance.now() - sensT;
    result.sensitivity = { status: sensJob.status, totalMs: Math.round(sensTotal), peakRssMiB: sampler.stop(), cpuSeconds: +(cpuSeconds(pid) - cpu1).toFixed(2) };
    result.sensitivityConcurrentLight = await stopLight();

    result.final = { ...procStatus(pid), dbMiB: +(fs.statSync(dbPath).size / 1048576).toFixed(1), walMiB: fs.existsSync(`${dbPath}-wal`) ? +(fs.statSync(`${dbPath}-wal`).size / 1048576).toFixed(1) : 0 };
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const keep = arg('keep');
    if (keep) fs.cpSync(dataDir, path.resolve(keep), { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  result.durationS = Math.round((Date.now() - started) / 1000);
  const text = JSON.stringify(result, null, 2);
  if (OUT) fs.writeFileSync(OUT, text);
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
