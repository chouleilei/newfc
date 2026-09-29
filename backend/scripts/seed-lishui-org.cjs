/**
 * 澧水集团预算组织树初始化(完整适配第一步)
 *
 * 流程:
 *  1. 在线备份数据库(SQLite backup API,服务运行中可安全执行)
 *  2. 校验备份完整性
 *  3. 事务清理演示数据(组织/科目/版本/实际数/指标/快照/日志,外键延迟检查)
 *  4. 调用本机 API 登录并按序创建 26 个预算组织
 *  5. 校验树结构与结构检查接口
 *
 * 用法: 先导出 NEWFC_SEED_USER/NEWFC_SEED_PASSWORD，再在 backend 目录运行本脚本。
 * 幂等性: 若目标编码已存在则中止,不重复创建。
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const BASE = 'http://127.0.0.1:3748';
const DATA_DIR = process.env.NEWFC_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'newfc.sqlite');

/* 组织编码:层级式数字码,每级 2 位;sort_order 取码的数值,天然保序 */
const ORG_TREE = [
  { code: '01', name: '澧水集团', parent: null },
  { code: '0101', name: '澧水本级', parent: '01' },
  { code: '010101', name: '公司总部', parent: '0101' },
  { code: '010102', name: '江垭电站', parent: '0101' },
  { code: '010103', name: '皂市电站', parent: '0101' },
  { code: '0102', name: '索溪分公司', parent: '01' },
  { code: '0103', name: '彩石公司', parent: '01' },
  { code: '0104', name: '澧能公司', parent: '01' },
  { code: '010401', name: '澧能总部', parent: '0104' },
  { code: '010402', name: '新化大熊山', parent: '0104' },
  { code: '010403', name: '双牌湘澧', parent: '0104' },
  { code: '010404', name: '全州优能', parent: '0104' },
  { code: '01040401', name: '六字界风电场', parent: '010404' },
  { code: '01040402', name: '白竹风电场', parent: '010404' },
  { code: '01040403', name: '磨子岭风电场', parent: '010404' },
  { code: '01040404', name: '全州优能本部', parent: '010404' },
  { code: '0105', name: '项目公司', parent: '01' },
  { code: '0106', name: '泽通公司', parent: '01' },
  { code: '010601', name: '泽通总部', parent: '0106' },
  { code: '010602', name: '物业公司', parent: '0106' },
  { code: '010603', name: '江垭温泉', parent: '0106' },
  { code: '0107', name: '机电公司', parent: '01' },
  { code: '010701', name: '银腾光伏项目', parent: '0107' },
  { code: '010702', name: '长沙基地光伏项目', parent: '0107' },
  { code: '010703', name: '国检光伏项目', parent: '0107' },
  { code: '010704', name: '机电本部(非电业务)', parent: '0107' },
];

const DEMO_TABLES = [
  'budget_entry', 'budget_version',
  'actual_snapshot_entry', 'actual_snapshot_batch', 'actual_year_state', 'actual_current',
  'report_metric_term', 'report_metric',
  'tree_snapshot', 'org', 'account', 'operation_log',
];

function fail(msg) { console.error('FATAL: ' + msg); process.exit(1); }

/* 登录:会话在 HttpOnly Cookie 中,写请求须附带 X-CSRF-Token;凭据只读取进程环境。 */
async function apiLogin() {
  const cfg = { username: process.env.NEWFC_SEED_USER, password: process.env.NEWFC_SEED_PASSWORD };
  if (!cfg.username || !cfg.password) fail('请先设置 NEWFC_SEED_USER 和 NEWFC_SEED_PASSWORD(具备主数据维护权限的账号)');
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg),
  });
  if (!loginRes.ok) return { ok: false, detail: 'HTTP ' + loginRes.status + ': ' + await loginRes.text() };
  const { csrfToken } = await loginRes.json();
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  return { ok: true, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken } };
}

async function main() {
  /* 登录必须先于任何备份/清理操作；凭据只读取进程环境，不猜测启动脚本文本。 */
  const login = await apiLogin();
  if (!login.ok) fail('登录失败，未执行任何清理: ' + login.detail);
  const headers = login.headers;
  console.log('[0] API 登录验证通过');

  /* ---------- 0. 若 org 已为空(此前已清理过),跳过备份与清理,直接建树 ---------- */
  const preDb = new Database(DB_PATH, { readonly: true });
  const preOrg = preDb.prepare('SELECT COUNT(*) c FROM org').get().c;
  preDb.close();
  if (preOrg === 0) {
    console.log('[0] 检测到 org 表已为空,跳过备份与清理,直接进入建树');
  } else {

  /* ---------- 1. 在线备份 ---------- */
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupPath = path.join(DATA_DIR, `manual-backup-pre-lishui-org-${stamp}.sqlite`);
  const src = new Database(DB_PATH, { readonly: true });
  await src.backup(backupPath);
  src.close();
  console.log('[1] 备份完成:', backupPath, `(${fs.statSync(backupPath).size} bytes)`);

  /* ---------- 2. 校验备份 ---------- */
  const vdb = new Database(backupPath, { readonly: true });
  const integ = vdb.prepare('PRAGMA integrity_check').get();
  const vOrg = vdb.prepare('SELECT COUNT(*) c FROM org').get();
  const vEntry = vdb.prepare('SELECT COUNT(*) c FROM budget_entry').get();
  vdb.close();
  if (integ.integrity_check !== 'ok') fail('备份完整性检查未通过,已中止(未做任何修改)');
  console.log(`[2] 备份校验通过: integrity=ok, 演示数据 org=${vOrg.c}, budget_entry=${vEntry.c}(应均为非零)`);

  /* ---------- 3. 事务清理演示数据 ---------- */
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
  const before = {};
  for (const t of DEMO_TABLES) before[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    for (const t of DEMO_TABLES) db.prepare(`DELETE FROM ${t}`).run();
  })();
  const afterOrg = db.prepare('SELECT COUNT(*) c FROM org').get().c;
  const schemaOk = db.prepare("SELECT COUNT(*) c FROM schema_migration").get().c;
  db.close();
  if (afterOrg !== 0) fail('清理后 org 表非空,异常中止');
  console.log('[3] 演示数据已清理:', DEMO_TABLES.map(t => `${t}=${before[t]}`).join(', '));
  console.log(`    schema_migration 保留(${schemaOk} 条迁移记录)`);

  } /* end preOrg !== 0 */

  /* ---------- 4. 创建组织 ---------- */
  const existing = await (await fetch(`${BASE}/api/org/tree`, { headers })).json();
  const existingCodes = new Set(existing.rows.map(r => r.code));
  const clash = ORG_TREE.filter(o => existingCodes.has(o.code));
  if (existingCodes.size > 0) {
    if (clash.length || existingCodes.size) fail(`org 表非空(已有 ${[...existingCodes].join(',')}),为避免重复/冲突已中止`);
  }

  const idByCode = new Map();
  for (const o of ORG_TREE) {
    const parentId = o.parent == null ? null : idByCode.get(o.parent);
    if (o.parent != null && parentId == null) fail(`父组织 ${o.parent} 尚未创建(顺序错误)`);
    const res = await fetch(`${BASE}/api/org`, {
      method: 'POST', headers,
      body: JSON.stringify({ parentId, code: o.code, name: o.name, sortOrder: parseInt(o.code, 10) }),
    });
    if (!res.ok) fail(`创建 ${o.code} ${o.name} 失败: HTTP ${res.status} ${await res.text()}`);
    const created = await res.json();
    idByCode.set(o.code, created.id);
    console.log(`    + ${o.code}  ${o.name}  (id=${created.id})`);
  }
  console.log(`[4] 已创建 ${idByCode.size} 个组织`);

  /* ---------- 5. 校验 ---------- */
  const tree = await (await fetch(`${BASE}/api/org/tree`, { headers })).json();
  const check = await (await fetch(`${BASE}/api/org/check`, { headers })).json();
  const print = (nodes, depth) => {
    for (const n of nodes) {
      console.log('    ' + '  '.repeat(depth) + `${n.code}  ${n.name}${n.children?.length ? '  [汇总]' : '  [叶子]'}`);
      if (n.children?.length) print(n.children, depth + 1);
    }
  };
  console.log(`[5] 组织树(叶子 ${tree.leafIds.length} 个),结构检查: ${check.ok ? '通过' : '存在问题 ' + JSON.stringify(check.problems)}`);
  print(tree.tree, 0);
  if (!check.ok || tree.leafIds.length !== 20 || tree.rows.length !== 26) fail('最终校验未通过');
  console.log('DONE: 澧水集团预算组织树初始化完成(26 组织 / 20 叶子)');
}

/* 组织树定义对外可复用(E2E 夹具构建脚本按同一份主数据建库),
   但整套「备份 → 清理 → 调 API 建树」的运维流程只在直接执行本脚本时才跑。 */
module.exports = { ORG_TREE };

if (require.main === module) main().catch(e => fail(e.stack || String(e)));
