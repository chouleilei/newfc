import type { DB } from './connection';
import { NEWFC_MIGRATIONS } from './migrations-newfc';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** raw=true:事务外执行(可 PRAGMA foreign_keys=OFF 后重建表;表重建场景延迟外键在 COMMIT 仍会报错) */
  raw?: boolean;
  /**
   * rebuild=true:整表重建(扩展 CHECK 枚举等)。外键关闭后在单事务内执行 SQL、foreign_key_check 与版本记录,
   * 任一步失败整体回滚,不留半重建状态。
   */
  rebuild?: boolean;
}

/**
 * 迁移 V1:初始 schema,13 张表(方案四)。
 * 后续结构变更追加新 Migration,迁移前由 backup 模块自动备份。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE org (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES org(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES account(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','cost','expense')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tree_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_type TEXT NOT NULL CHECK (tree_type IN ('org','account')),
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tree_type, content_hash)
);

CREATE TABLE budget_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 9999),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked','archived')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  org_tree_snapshot_id INTEGER NOT NULL REFERENCES tree_snapshot(id),
  account_tree_snapshot_id INTEGER NOT NULL REFERENCES tree_snapshot(id),
  source_version_id INTEGER REFERENCES budget_version(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  locked_at TEXT,
  UNIQUE (year, name)
);

CREATE INDEX idx_budget_version_year ON budget_version(year);

CREATE TABLE budget_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES budget_version(id),
  org_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (version_id, org_id, account_id)
);

CREATE INDEX idx_budget_entry_version ON budget_entry(version_id);

CREATE TABLE actual_year_state (
  year INTEGER PRIMARY KEY CHECK (year BETWEEN 1900 AND 9999),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','frozen')),
  current_batch_id INTEGER,
  final_batch_id INTEGER,
  frozen_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE actual_current (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 9999),
  org_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  cumulative_amount_cents INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','excel_import')),
  memo TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (year, org_id, account_id)
);

CREATE INDEX idx_actual_current_year ON actual_current(year);

CREATE TABLE actual_snapshot_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 9999),
  snapshot_date TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  source TEXT NOT NULL CHECK (source IN ('manual','excel_import','history_import')),
  org_tree_snapshot_id INTEGER NOT NULL REFERENCES tree_snapshot(id),
  account_tree_snapshot_id INTEGER NOT NULL REFERENCES tree_snapshot(id),
  updates_current INTEGER NOT NULL DEFAULT 1 CHECK (updates_current IN (0,1)),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_snapshot_batch_year_date ON actual_snapshot_batch(year, snapshot_date);
CREATE INDEX idx_snapshot_batch_status ON actual_snapshot_batch(year, status);

CREATE TABLE actual_snapshot_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES actual_snapshot_batch(id),
  org_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  cumulative_amount_cents INTEGER NOT NULL,
  UNIQUE (batch_id, org_id, account_id)
);

CREATE INDEX idx_snapshot_entry_batch ON actual_snapshot_entry(batch_id);

CREATE TABLE report_metric (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE report_metric_term (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id INTEGER NOT NULL REFERENCES report_metric(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('account','metric')),
  source_account_id INTEGER REFERENCES account(id),
  source_metric_id INTEGER REFERENCES report_metric(id),
  coefficient INTEGER NOT NULL CHECK (coefficient IN (1,-1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((source_type = 'account' AND source_account_id IS NOT NULL AND source_metric_id IS NULL)
      OR (source_type = 'metric' AND source_metric_id IS NOT NULL AND source_account_id IS NULL))
);

CREATE INDEX idx_metric_term_metric ON report_metric_term(metric_id);

CREATE TABLE operation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_operation_log_time ON operation_log(created_at);
`,
  },
  {
    version: 2,
    name: 'quantity_accounts',
    raw: true,
    sql: `
PRAGMA foreign_keys = OFF;

CREATE TABLE account_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES account(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','cost','expense','quantity')),
  unit TEXT NOT NULL DEFAULT '',
  quantity_agg TEXT NOT NULL DEFAULT 'sum' CHECK (quantity_agg IN ('sum','none')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO account_v2 (id, parent_id, code, name, type, unit, quantity_agg, sort_order, status, created_at, updated_at)
SELECT id, parent_id, code, name, type, '', 'sum', sort_order, status, created_at, updated_at FROM account;

DROP TABLE account;
ALTER TABLE account_v2 RENAME TO account;

ALTER TABLE budget_entry ADD COLUMN quantity INTEGER;
ALTER TABLE actual_current ADD COLUMN quantity INTEGER;
ALTER TABLE actual_snapshot_entry ADD COLUMN quantity INTEGER;
`,
  },
  {
    version: 3,
    name: 'preset_sheets',
    sql: `
CREATE TABLE preset_sheet (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  root_codes TEXT NOT NULL DEFAULT '[]',
  collapsed_codes TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO preset_sheet (code, name, root_codes, collapsed_codes, sort_order, status, created_at, updated_at) VALUES
('master', '收入成本表', '["I1","I2","I3","C1","C2","C3","C4","C5","C6","E1","E2","E3"]', '["I12","C12","E2"]', 1, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
('power', '发电收入', '["I11","Q1","Q2","Q3"]', '[]', 2, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
('nonpower_income', '非电收入', '["I12"]', '[]', 3, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
('nonpower_cost', '非电营业成本', '["C12"]', '[]', 4, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
('admin_expense', '管理费用', '["E2"]', '[]', 5, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
('labor_cost', '人工成本表', '["E201"]', '[]', 6, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
`,
  },
  {
    version: 4,
    name: 'master_sheet_collapse_power',
    sql: `
/* 套表原则:下级有专属明细表(发电收入表 -> I11)则上级表只留汇总行 */
UPDATE preset_sheet
SET collapsed_codes = '["I11","I12","C12","E2"]', updated_at = '2026-08-22T00:00:00.000Z'
WHERE code = 'master';
`,
  },
  {
    version: 5,
    name: 'master_sheet_template_order',
    sql: `
/* 收入成本表根科目顺序对齐模板:期间费用(销售/管理/财务)在税金及附加之后,
   信用减值/营业外支出其后,所得税在利润总额计算行之后(计算行由前端按锚点插入) */
UPDATE preset_sheet
SET root_codes = '["I1","I2","I3","C1","C2","C3","E1","E2","E3","C4","C5","C6"]', updated_at = '2026-08-22T00:00:00.000Z'
WHERE code = 'master';
`,
  },
  {
    version: 6,
    name: 'add_two_rules_award_account',
    sql: `
/* 水力发电辅助服务补偿:在 I11 发电产业收入 下增加 I1103 两项细则奖励(调峰/调频/黑启动补偿) */
INSERT INTO account (code, name, type, parent_id, sort_order, status, created_at, updated_at)
SELECT 'I1103', '两项细则奖励', 'income', id, 3, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
FROM account WHERE code = 'I11'
ON CONFLICT(code) DO NOTHING;
`,
  },
  {
    version: 7,
    name: 'mgmt_expense_to_manufacturing_cost_and_capitalized_labor',
    sql: `
/* 1. 预设表更名:管理费用 -> 管理类费用表(代码保持 admin_expense) */
UPDATE preset_sheet SET name = '管理类费用表', updated_at = '2026-08-22T00:00:00.000Z' WHERE code = 'admin_expense';

/* 2. 人工成本表增设 E20199 在建工程资本化人工成本(不在预算损益体现,自动在管理类费用和损益表扣除) */
INSERT INTO account (code, name, type, parent_id, sort_order, status, created_at, updated_at)
SELECT 'E20199', '其中：在建工程/资本化人工成本(不进损益)', 'expense', id, 99, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
FROM account WHERE code = 'E201'
ON CONFLICT(code) DO NOTHING;
`,
  },
  {
    version: 8,
    name: 'budget_entry_formula_and_note',
    sql: `
/* 预算分录增加公式与附注/测算依据字段 */
ALTER TABLE budget_entry ADD COLUMN formula TEXT NOT NULL DEFAULT '';
ALTER TABLE budget_entry ADD COLUMN note TEXT NOT NULL DEFAULT '';
`,
  },
  {
    version: 9,
    name: 'power_income_refactor_and_account_cleanup',
    sql: `
/* 1. 删除已停用科目: 直供电量收入(I1102)、直供电量(Q102) 及其相关分录与快照数据 */
/* 先清理引用这些科目的指标公式项(source_account_id 为 NO ACTION 外键,不清理会导致迁移失败、阻塞启动) */
DELETE FROM report_metric_term WHERE source_account_id IN (SELECT id FROM account WHERE code IN ('I1102', 'Q102'));

/* 失去公式项的指标及其引用链一并删除:先以递归 CTE 找出全部受影响指标(含引用了待删指标的其他指标),
   再统一清理其公式项与本体——直接 DELETE 指标会被 source_metric_id 外键(NO ACTION)阻塞 */
CREATE TEMP TABLE _v9_doomed_metric AS
WITH RECURSIVE doomed(mid) AS (
  SELECT id FROM report_metric WHERE NOT EXISTS (SELECT 1 FROM report_metric_term t WHERE t.metric_id = report_metric.id)
  UNION
  SELECT t.metric_id FROM report_metric_term t JOIN doomed d ON t.source_metric_id = d.mid
)
SELECT mid FROM doomed;

/* 破坏性清理必须留痕(锁定版本明细/历史快照被删,违反不可变约定,仅凭 pre-migrate 备份可恢复):
   先记数量与被删指标编码,再执行删除 */
INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at)
SELECT 'migration.data_cleanup', 'migration', 'V9', json_object(
  'reason', '删除停用科目 I1102/Q102 及关联数据',
  'deleted_metrics', (SELECT COALESCE(group_concat(code), '') FROM report_metric WHERE id IN (SELECT mid FROM _v9_doomed_metric)),
  'deleted_metric_terms', (SELECT COUNT(*) FROM report_metric_term WHERE metric_id IN (SELECT mid FROM _v9_doomed_metric) OR source_metric_id IN (SELECT mid FROM _v9_doomed_metric)),
  'deleted_budget_entries', (SELECT COUNT(*) FROM budget_entry WHERE account_id IN (SELECT id FROM account WHERE code IN ('I1102','Q102'))),
  'deleted_locked_version_entries', (SELECT COUNT(*) FROM budget_entry e JOIN budget_version v ON v.id = e.version_id
                                     WHERE e.account_id IN (SELECT id FROM account WHERE code IN ('I1102','Q102')) AND v.status IN ('locked','archived')),
  'deleted_actual_current', (SELECT COUNT(*) FROM actual_current WHERE account_id IN (SELECT id FROM account WHERE code IN ('I1102','Q102'))),
  'deleted_snapshot_entries', (SELECT COUNT(*) FROM actual_snapshot_entry WHERE account_id IN (SELECT id FROM account WHERE code IN ('I1102','Q102')))
), '2026-08-22T00:00:00.000Z';

DELETE FROM report_metric_term WHERE metric_id IN (SELECT mid FROM _v9_doomed_metric) OR source_metric_id IN (SELECT mid FROM _v9_doomed_metric);
DELETE FROM report_metric WHERE id IN (SELECT mid FROM _v9_doomed_metric);
DROP TABLE _v9_doomed_metric;

DELETE FROM budget_entry WHERE account_id IN (SELECT id FROM account WHERE code IN ('I1102', 'Q102'));
DELETE FROM actual_current WHERE account_id IN (SELECT id FROM account WHERE code IN ('I1102', 'Q102'));
DELETE FROM actual_snapshot_entry WHERE account_id IN (SELECT id FROM account WHERE code IN ('I1102', 'Q102'));
DELETE FROM account WHERE code IN ('I1102', 'Q102');

/* 2. 规范数量科目名称,去除名称自带的重复括号单位 */
UPDATE account SET name = '上网电量', updated_at = '2026-08-22T00:00:00.000Z' WHERE code = 'Q101';
UPDATE account SET name = '发电量', updated_at = '2026-08-22T00:00:00.000Z' WHERE code = 'Q103';
`,
  },
  {
    version: 10,
    name: 'expand_power_stations_org_tree',
    sql: `
/* 1. 全州优能(010404)下增设 3 个风电场末级电站 */
INSERT INTO org (code, name, parent_id, sort_order, status, created_at, updated_at)
SELECT '01040401', '六字界风电场', id, 1, 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
FROM org WHERE code = '010404'
ON CONFLICT(code) DO NOTHING;

INSERT INTO org (code, name, parent_id, sort_order, status, created_at, updated_at)
SELECT '01040402', '白竹风电场', id, 2, 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
FROM org WHERE code = '010404'
ON CONFLICT(code) DO NOTHING;

INSERT INTO org (code, name, parent_id, sort_order, status, created_at, updated_at)
SELECT '01040403', '磨子岭风电场', id, 3, 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
FROM org WHERE code = '010404'
ON CONFLICT(code) DO NOTHING;

/* 010404 增设子节点后由叶子变为汇总,新增本部叶子承接其存量直接录入数据 */
INSERT INTO org (code, name, parent_id, sort_order, status, created_at, updated_at)
SELECT '01040404', '全州优能本部', id, 4, 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
FROM org WHERE code = '010404'
ON CONFLICT(code) DO NOTHING;

/* 2. 机电公司(0107)下增设 3 个光伏发电项目与 1 个机电非电业务/本部节点 */
INSERT INTO org (code, name, parent_id, sort_order, status, created_at, updated_at)
SELECT '010701', '银腾光伏项目', id, 1, 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
FROM org WHERE code = '0107'
ON CONFLICT(code) DO NOTHING;

INSERT INTO org (code, name, parent_id, sort_order, status, created_at, updated_at)
SELECT '010702', '长沙基地光伏项目', id, 2, 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
FROM org WHERE code = '0107'
ON CONFLICT(code) DO NOTHING;

INSERT INTO org (code, name, parent_id, sort_order, status, created_at, updated_at)
SELECT '010703', '国检光伏项目', id, 3, 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
FROM org WHERE code = '0107'
ON CONFLICT(code) DO NOTHING;

INSERT INTO org (code, name, parent_id, sort_order, status, created_at, updated_at)
SELECT '010704', '机电本部(非电业务)', id, 4, 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
FROM org WHERE code = '0107'
ON CONFLICT(code) DO NOTHING;

/* 3. 仅迁移当前累计实际(actual_current)到新叶子:它始终跟随当前组织树,0107/010404 已非叶子,
   保留会导致保存整包被"非叶子组织"校验拒绝、且不参与叶子口径汇总。
   预算明细与历史快照条目必须保持原组织 ID——它们绑定的树快照仍以 0107/010404 为叶子,
   改写会使按快照汇总(rollup 对快照外组织按零处理)丢失这些数据、破坏历史批次。
   注:迁移后至该年度下一次保存前,一致性检查会提示当前实际与最新快照的组织差异,属预期过渡态。
   目标叶子若已存在同年同科目数据(UNIQUE(year, org_id, account_id)),保留在原组织并写日志告警,避免迁移失败阻塞启动 */
UPDATE actual_current
SET org_id = (SELECT id FROM org WHERE code = '010704')
WHERE org_id = (SELECT id FROM org WHERE code = '0107')
  AND NOT EXISTS (
    SELECT 1 FROM actual_current t
    WHERE t.year = actual_current.year AND t.account_id = actual_current.account_id
      AND t.org_id = (SELECT id FROM org WHERE code = '010704')
  );
/* changes() 反映紧邻的上一条 UPDATE,两条日志必须紧跟各自的 UPDATE 之后 */
INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at)
SELECT 'migration.data_cleanup', 'migration', 'V10', json_object('moved_actual_current', changes(), 'from_org', '0107', 'to_org', '010704'), '2026-08-23T00:00:00.000Z';

UPDATE actual_current
SET org_id = (SELECT id FROM org WHERE code = '01040404')
WHERE org_id = (SELECT id FROM org WHERE code = '010404')
  AND NOT EXISTS (
    SELECT 1 FROM actual_current t
    WHERE t.year = actual_current.year AND t.account_id = actual_current.account_id
      AND t.org_id = (SELECT id FROM org WHERE code = '01040404')
  );
INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at)
SELECT 'migration.data_cleanup', 'migration', 'V10', json_object('moved_actual_current', changes(), 'from_org', '010404', 'to_org', '01040404'), '2026-08-23T00:00:00.000Z';

/* 冲突行告警统一在两条 UPDATE 之后统计(此时仍留在原组织的即冲突行) */
INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at)
SELECT 'migration.data_cleanup_warning', 'migration', 'V10',
  json_object('conflict_rows_kept', COUNT(*), 'from_org', '0107', 'to_org', '010704',
              'reason', '目标组织同年同科目已有数据,冲突行保留在原组织待人工合并'),
  '2026-08-23T00:00:00.000Z'
FROM actual_current WHERE org_id = (SELECT id FROM org WHERE code = '0107') HAVING COUNT(*) > 0;
INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at)
SELECT 'migration.data_cleanup_warning', 'migration', 'V10',
  json_object('conflict_rows_kept', COUNT(*), 'from_org', '010404', 'to_org', '01040404',
              'reason', '目标组织同年同科目已有数据,冲突行保留在原组织待人工合并'),
  '2026-08-23T00:00:00.000Z'
FROM actual_current WHERE org_id = (SELECT id FROM org WHERE code = '010404') HAVING COUNT(*) > 0;
`,
  },
  {
    version: 11,
    name: 'add_quanzhou_benbu_leaf',
    sql: `
/* 补充迁移:全州优能本部(01040404)。
   修复早期 V10 版本未创建该节点的问题——已按旧 V10 升级的库缺此叶子,010404 存量当前实际无处迁移;
   全新库 V10 已建节点,本迁移为幂等空操作 */
INSERT INTO org (code, name, parent_id, sort_order, status, created_at, updated_at)
SELECT '01040404', '全州优能本部', id, 4, 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
FROM org WHERE code = '010404'
ON CONFLICT(code) DO NOTHING;

/* 与 V10 相同的 UNIQUE 冲突防护与留痕 */
UPDATE actual_current
SET org_id = (SELECT id FROM org WHERE code = '01040404')
WHERE org_id = (SELECT id FROM org WHERE code = '010404')
  AND NOT EXISTS (
    SELECT 1 FROM actual_current t
    WHERE t.year = actual_current.year AND t.account_id = actual_current.account_id
      AND t.org_id = (SELECT id FROM org WHERE code = '01040404')
  );
INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at)
SELECT 'migration.data_cleanup', 'migration', 'V11', json_object('moved_actual_current', changes(), 'from_org', '010404', 'to_org', '01040404'), '2026-08-23T00:00:00.000Z';
INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at)
SELECT 'migration.data_cleanup_warning', 'migration', 'V11',
  json_object('conflict_rows_kept', COUNT(*), 'from_org', '010404', 'to_org', '01040404',
              'reason', '目标组织同年同科目已有数据,冲突行保留在原组织待人工合并'),
  '2026-08-23T00:00:00.000Z'
FROM actual_current WHERE org_id = (SELECT id FROM org WHERE code = '010404') HAVING COUNT(*) > 0;
`,
  },
  {
    version: 12,
    name: 'budget_compilation_checkpoints',
    sql: `
/* 编制记录点:草稿自动保存不留业务日志;用户主动记录或定稿时固化当时快照与相对上次记录的差异 */
CREATE TABLE budget_compilation_checkpoint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES budget_version(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  change_count INTEGER NOT NULL CHECK (change_count > 0),
  auto_created INTEGER NOT NULL DEFAULT 0 CHECK (auto_created IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (version_id, sequence_no)
);

CREATE INDEX idx_budget_checkpoint_version ON budget_compilation_checkpoint(version_id, sequence_no DESC);
`,
  },
  {
    version: 13,
    name: 'lightweight_planning_extensions',
    sql: `
/* 预算与预测复用同一版本/明细生命周期；每类版本可各有一个当前生效版本。 */
ALTER TABLE budget_version ADD COLUMN kind TEXT NOT NULL DEFAULT 'budget'
  CHECK (kind IN ('budget','forecast'));
ALTER TABLE budget_version ADD COLUMN generation_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_budget_version_year_kind ON budget_version(year, kind);

/* 轻量填报要求随科目树快照固化，不引入通用规则语言。 */
ALTER TABLE account ADD COLUMN budget_required INTEGER NOT NULL DEFAULT 0
  CHECK (budget_required IN (0,1));
ALTER TABLE account ADD COLUMN basis_required INTEGER NOT NULL DEFAULT 0
  CHECK (basis_required IN (0,1));

/* 只支持少量后端内置模板类型；config_json 保存科目编码映射，不执行用户代码。 */
CREATE TABLE budget_calculation_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('quantity_price_net_tax','multiply')),
  sheet_code TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO budget_calculation_rule
  (code, name, rule_type, sheet_code, config_json, status, sort_order, created_at, updated_at)
VALUES
  ('POWER_GRID_REVENUE', '上网电费测算', 'quantity_price_net_tax', 'power',
   '{"quantityAccountCode":"Q101","priceAccountCode":"Q2","taxAccountCode":"Q3","outputAccountCode":"I1101","defaultTaxRate":"13"}',
   'active', 1, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z');

/* 导入预览本身成为可审计批次：保存原件、哈希、解析结果、影响前后值与撤销状态。 */
CREATE TABLE import_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('budget','actual')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','rolled_back','cancelled')),
  target_version_id INTEGER REFERENCES budget_version(id),
  history INTEGER NOT NULL DEFAULT 0 CHECK (history IN (0,1)),
  original_name TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  file_blob BLOB NOT NULL,
  payload_json TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  before_json TEXT NOT NULL DEFAULT '[]',
  after_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  committed_at TEXT,
  rolled_back_at TEXT
);

CREATE INDEX idx_import_batch_created ON import_batch(created_at DESC);
CREATE INDEX idx_import_batch_status ON import_batch(status, kind);

ALTER TABLE actual_snapshot_batch ADD COLUMN import_batch_id INTEGER REFERENCES import_batch(id);
`,
  },
  {
    version: 14,
    name: 'management_total_income_cost_metrics',
    sql: `
/* 管理口径（金额均为利润方向符号）:
 * 总收入 P07 = 营业总收入 P01 + 投资收益 I2 + 营业外收入 I3;
 * 总成本 P06 = 营业总成本 P02 + 营业外支出 C5 + 所得税费用 C6，不含增值税 C2;
 * 净利润 P05 = 总收入 P07 + 总成本 P06（成本为负数）;
 * 利润总额 P04 = 净利润 P05 - 所得税费用 C6。
 */
INSERT INTO report_metric (code, name, display_order, status, created_at, updated_at)
SELECT 'P07', '总收入', 6, 'active', datetime('now'), datetime('now')
WHERE EXISTS (SELECT 1 FROM report_metric WHERE code = 'P01')
  AND EXISTS (SELECT 1 FROM account WHERE code IN ('I2','I3') GROUP BY 1 HAVING COUNT(*) = 2)
  AND NOT EXISTS (SELECT 1 FROM report_metric WHERE code = 'P07');

UPDATE report_metric SET name = '总收入', display_order = 6, status = 'active', updated_at = datetime('now') WHERE code = 'P07';
UPDATE report_metric SET name = '总成本', display_order = 7, status = 'active', updated_at = datetime('now') WHERE code = 'P06';

DELETE FROM report_metric_term WHERE metric_id IN (SELECT id FROM report_metric WHERE code IN ('P04','P05','P06','P07'));

INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'metric', NULL, source.id, 1, 1 FROM report_metric target, report_metric source WHERE target.code = 'P07' AND source.code = 'P01';
INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'account', account.id, NULL, 1, 2 FROM report_metric target, account WHERE target.code = 'P07' AND account.code = 'I2';
INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'account', account.id, NULL, 1, 3 FROM report_metric target, account WHERE target.code = 'P07' AND account.code = 'I3';

INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'metric', NULL, source.id, 1, 1 FROM report_metric target, report_metric source WHERE target.code = 'P06' AND source.code = 'P02';
INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'account', account.id, NULL, 1, 2 FROM report_metric target, account WHERE target.code = 'P06' AND account.code = 'C5';
INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'account', account.id, NULL, 1, 3 FROM report_metric target, account WHERE target.code = 'P06' AND account.code = 'C6';

INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'metric', NULL, source.id, 1, 1 FROM report_metric target, report_metric source WHERE target.code = 'P05' AND source.code = 'P07';
INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'metric', NULL, source.id, 1, 2 FROM report_metric target, report_metric source WHERE target.code = 'P05' AND source.code = 'P06';

INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'metric', NULL, source.id, 1, 1 FROM report_metric target, report_metric source WHERE target.code = 'P04' AND source.code = 'P05';
INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
SELECT target.id, 'account', account.id, NULL, -1, 2 FROM report_metric target, account WHERE target.code = 'P04' AND account.code = 'C6';
`,
  },
  {
    version: 15,
    name: 'finance_actual_conversion_pipeline',
    sql: `
/* 财务实际数转换: 原件、确定性映射版本、校验报告与下游导入批次全链路留痕。 */
CREATE TABLE finance_source_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  adapter_type TEXT NOT NULL CHECK (adapter_type IN ('fixed_finance_system_v1')),
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE finance_mapping_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_profile_id INTEGER NOT NULL REFERENCES finance_source_profile(id),
  version_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked','retired')),
  org_tree_snapshot_id INTEGER NOT NULL REFERENCES tree_snapshot(id),
  account_tree_snapshot_id INTEGER NOT NULL REFERENCES tree_snapshot(id),
  parent_version_id INTEGER REFERENCES finance_mapping_version(id),
  created_by TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  locked_at TEXT,
  UNIQUE (source_profile_id, version_no)
);
CREATE INDEX idx_finance_mapping_profile ON finance_mapping_version(source_profile_id, version_no DESC);

CREATE TABLE finance_org_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_version_id INTEGER NOT NULL REFERENCES finance_mapping_version(id) ON DELETE CASCADE,
  source_book_code TEXT NOT NULL DEFAULT '',
  source_org_code TEXT NOT NULL DEFAULT '',
  source_org_name TEXT NOT NULL DEFAULT '',
  source_aux_json TEXT NOT NULL DEFAULT '{}',
  target_org_id INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_finance_org_mapping_version ON finance_org_mapping(mapping_version_id);

CREATE TABLE finance_account_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_version_id INTEGER NOT NULL REFERENCES finance_mapping_version(id) ON DELETE CASCADE,
  source_account_code TEXT NOT NULL,
  source_account_name TEXT NOT NULL DEFAULT '',
  source_aux_json TEXT NOT NULL DEFAULT '{}',
  target_account_id INTEGER NOT NULL,
  amount_rule TEXT NOT NULL CHECK (amount_rule IN ('credit','debit','credit_minus_debit','debit_minus_credit')),
  allocation_method TEXT NOT NULL DEFAULT 'direct' CHECK (allocation_method IN ('direct','fixed_ratio')),
  allocation_weight INTEGER NOT NULL DEFAULT 1000000 CHECK (allocation_weight > 0 AND allocation_weight <= 1000000),
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_finance_account_mapping_version ON finance_account_mapping(mapping_version_id);

CREATE TABLE finance_reconciliation_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_version_id INTEGER NOT NULL REFERENCES finance_mapping_version(id) ON DELETE CASCADE,
  source_line_alias TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('account','metric')),
  target_code TEXT NOT NULL,
  org_scope_json TEXT NOT NULL DEFAULT '[]',
  comparison TEXT NOT NULL DEFAULT 'equal' CHECK (comparison IN ('equal')),
  tolerance_cents INTEGER NOT NULL DEFAULT 0 CHECK (tolerance_cents >= 0),
  tolerance_reason TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1))
);
CREATE INDEX idx_finance_recon_version ON finance_reconciliation_rule(mapping_version_id);

CREATE TABLE finance_conversion_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_profile_id INTEGER NOT NULL REFERENCES finance_source_profile(id),
  mapping_version_id INTEGER NOT NULL REFERENCES finance_mapping_version(id),
  year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 9999),
  snapshot_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'parsing' CHECK (status IN ('parsing','blocked','validated','imported','cancelled')),
  revision_of_id INTEGER REFERENCES finance_conversion_batch(id),
  balance_name TEXT NOT NULL,
  balance_sha256 TEXT NOT NULL CHECK (length(balance_sha256) = 64),
  balance_blob BLOB NOT NULL,
  profit_name TEXT NOT NULL,
  profit_sha256 TEXT NOT NULL CHECK (length(profit_sha256) = 64),
  profit_blob BLOB NOT NULL,
  profile_adapter_type TEXT NOT NULL,
  profile_config_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL DEFAULT '[]',
  validation_json TEXT NOT NULL DEFAULT '{}',
  output_sha256 TEXT,
  output_blob BLOB,
  import_batch_id INTEGER REFERENCES import_batch(id),
  created_at TEXT NOT NULL,
  validated_at TEXT,
  imported_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX idx_finance_conversion_period ON finance_conversion_batch(source_profile_id, year, snapshot_date);
CREATE INDEX idx_finance_conversion_hash ON finance_conversion_batch(balance_sha256, profit_sha256, mapping_version_id);
`,
  },
  {
    version: 16,
    name: 'finance_parallel_trial_evidence',
    sql: `
/* 真实数据并行试运行证据:保留原手工结果、逐组合差异、原因与复核结论。 */
CREATE TABLE finance_parallel_trial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversion_batch_id INTEGER NOT NULL REFERENCES finance_conversion_batch(id),
  status TEXT NOT NULL DEFAULT 'compared' CHECK (status IN ('compared','explained','passed')),
  manual_name TEXT NOT NULL,
  manual_sha256 TEXT NOT NULL CHECK (length(manual_sha256) = 64),
  manual_blob BLOB NOT NULL,
  comparison_json TEXT NOT NULL,
  explanations_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX idx_finance_parallel_conversion ON finance_parallel_trial(conversion_batch_id, id DESC);
`,
  },
  {
    version: 17,
    name: 'finance_balance_layout_and_journal_evidence',
    sql: `
/* 真实财务导出适配:可选序时簿原件与哈希随转换批次永久留痕。双层余额表布局由配置快照固化，无需改表。 */
ALTER TABLE finance_conversion_batch ADD COLUMN journal_name TEXT;
ALTER TABLE finance_conversion_batch ADD COLUMN journal_sha256 TEXT CHECK (journal_sha256 IS NULL OR length(journal_sha256) = 64);
ALTER TABLE finance_conversion_batch ADD COLUMN journal_blob BLOB;
`,
  },
  {
    version: 18,
    name: 'finance_locked_metric_snapshots',
    sql: `
/* 映射锁定口径:固化指标及公式；科目层级继续使用 mapping_version 绑定的 tree_snapshot。 */
CREATE TABLE finance_metric_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_version_id INTEGER NOT NULL REFERENCES finance_mapping_version(id) ON DELETE CASCADE,
  metric_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (mapping_version_id, metric_id),
  UNIQUE (mapping_version_id, code)
);

CREATE TABLE finance_metric_term_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_version_id INTEGER NOT NULL REFERENCES finance_mapping_version(id) ON DELETE CASCADE,
  metric_id INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('account','metric')),
  source_account_id INTEGER,
  source_metric_id INTEGER,
  coefficient INTEGER NOT NULL CHECK (coefficient IN (1,-1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((source_type = 'account' AND source_account_id IS NOT NULL AND source_metric_id IS NULL)
      OR (source_type = 'metric' AND source_metric_id IS NOT NULL AND source_account_id IS NULL))
);
CREATE INDEX idx_finance_metric_term_snapshot_version ON finance_metric_term_snapshot(mapping_version_id,metric_id,sort_order);

/* 已有锁定版本在升级时按升级前仍在使用的定义建立基线，升级后不再跟随主表变化。 */
INSERT INTO finance_metric_snapshot(mapping_version_id,metric_id,code,status)
SELECT v.id,m.id,m.code,m.status FROM finance_mapping_version v CROSS JOIN report_metric m WHERE v.status IN ('locked','retired');
INSERT INTO finance_metric_term_snapshot(mapping_version_id,metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order)
SELECT v.id,t.metric_id,t.source_type,t.source_account_id,t.source_metric_id,t.coefficient,t.sort_order
FROM finance_mapping_version v CROSS JOIN report_metric_term t WHERE v.status IN ('locked','retired');
`,
  },
  {
    version: 19,
    name: 'budget_locked_metric_snapshots',
    sql: `
/* 预算定稿口径:固化指标及公式，锁定/归档版本的汇总和历史报表不再跟随主表变化。 */
CREATE TABLE budget_metric_snapshot_state (
  version_id INTEGER PRIMARY KEY REFERENCES budget_version(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE budget_metric_snapshot (
  version_id INTEGER NOT NULL REFERENCES budget_version(id) ON DELETE CASCADE,
  metric_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (version_id, metric_id),
  UNIQUE (version_id, code)
);
CREATE TABLE budget_metric_term_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES budget_version(id) ON DELETE CASCADE,
  metric_id INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('account','metric')),
  source_account_id INTEGER,
  source_metric_id INTEGER,
  coefficient INTEGER NOT NULL CHECK (coefficient IN (1,-1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((source_type = 'account' AND source_account_id IS NOT NULL AND source_metric_id IS NULL)
      OR (source_type = 'metric' AND source_metric_id IS NOT NULL AND source_account_id IS NULL))
);
CREATE INDEX idx_budget_metric_term_snapshot_version ON budget_metric_term_snapshot(version_id,metric_id,sort_order);

/* 已有锁定/归档版本以升级前仍在使用的定义建立迁移基线。 */
INSERT INTO budget_metric_snapshot_state(version_id,created_at)
SELECT id,COALESCE(locked_at,updated_at) FROM budget_version WHERE status IN ('locked','archived');
INSERT INTO budget_metric_snapshot(version_id,metric_id,code,name,display_order,status,created_at,updated_at)
SELECT v.id,m.id,m.code,m.name,m.display_order,m.status,m.created_at,m.updated_at
FROM budget_version v CROSS JOIN report_metric m WHERE v.status IN ('locked','archived');
INSERT INTO budget_metric_term_snapshot(version_id,metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order)
SELECT v.id,t.metric_id,t.source_type,t.source_account_id,t.source_metric_id,t.coefficient,t.sort_order
FROM budget_version v CROSS JOIN report_metric_term t WHERE v.status IN ('locked','archived');
`,
  },
  {
    version: 20,
    name: 'ai_assistant_tables',
    sql: `
CREATE TABLE ai_conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ai_message (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES ai_conversation(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL, response_json TEXT NOT NULL DEFAULT '{}', model TEXT, created_at TEXT NOT NULL);
CREATE TABLE ai_action (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER REFERENCES ai_conversation(id) ON DELETE SET NULL, type TEXT NOT NULL, params_json TEXT NOT NULL, preview_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','confirmed','cancelled','expired')), idempotency_key TEXT UNIQUE, result_json TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ai_insight (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER REFERENCES ai_conversation(id) ON DELETE SET NULL, title TEXT NOT NULL, result_json TEXT NOT NULL, citations_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE INDEX idx_ai_message_conversation ON ai_message(conversation_id, id);
CREATE INDEX idx_ai_action_status ON ai_action(status, expires_at);
`,
  },
  {
    version: 21,
    name: 'ai_action_confirmation_token',
    sql: `ALTER TABLE ai_action ADD COLUMN confirmation_token TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 22,
    name: 'ai_action_token_backfill_and_indexes',
    sql: `
UPDATE ai_action SET confirmation_token = lower(hex(randomblob(32)))
WHERE status = 'pending' AND (confirmation_token IS NULL OR confirmation_token = '');
CREATE INDEX IF NOT EXISTS idx_ai_conversation_updated ON ai_conversation(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_action_conversation ON ai_action(conversation_id, id DESC);
`,
  },
  {
    version: 23,
    name: 'ratio_metrics',
    sql: `
/* 比率型指标(分子 ÷ 分母)。与线性指标共用 report_metric / report_metric_term,
 * 从而直接继承循环引用检测、被引用不可删除、停用科目标注和定稿固化快照四套现成机制。
 *
 * 口径(与线性指标的关键差异,不可混用):
 * - 线性指标值是「分」;比率值是按 10^6 缩放的定点数,两者存放在不同的结果映射里,
 *   报表层也分成 metrics(线性) 与 ratioMetrics(比率) 两个字段输出。
 * - 比率不可跨组织/跨层级加总,汇总行一律「先汇总分子分母再相除」,由后端统一重算。
 * - direction 显式声明有利方向:线性指标恒为利润方向(越大越有利),但费用率越低越好,
 *   因此比率必须自带方向字段,favorable 判断读它而不是沿用「差异为正即有利」。
 * - display_format / unit 由用户声明:百分比无单位;比率的自然单位是
 *   「元 ÷ 分母科目计量单位」,系统无法推断,只能显式登记。
 */
ALTER TABLE report_metric ADD COLUMN kind TEXT NOT NULL DEFAULT 'linear'
  CHECK (kind IN ('linear','ratio'));
ALTER TABLE report_metric ADD COLUMN direction TEXT NOT NULL DEFAULT 'higher_better'
  CHECK (direction IN ('higher_better','lower_better'));
ALTER TABLE report_metric ADD COLUMN display_format TEXT NOT NULL DEFAULT 'percent'
  CHECK (display_format IN ('percent','number'));
ALTER TABLE report_metric ADD COLUMN unit TEXT NOT NULL DEFAULT '';

/* role:线性指标全部为 term;比率指标恰好一个 numerator 与一个 denominator。
 * coefficient 在比率里承担符号归一(成本费用存的是负数,配 -1 让比率读正)。 */
ALTER TABLE report_metric_term ADD COLUMN role TEXT NOT NULL DEFAULT 'term'
  CHECK (role IN ('term','numerator','denominator'));

/* 定稿固化表同步扩列,否则锁定版本读快照时会丢掉比率定义。 */
ALTER TABLE budget_metric_snapshot ADD COLUMN kind TEXT NOT NULL DEFAULT 'linear';
ALTER TABLE budget_metric_snapshot ADD COLUMN direction TEXT NOT NULL DEFAULT 'higher_better';
ALTER TABLE budget_metric_snapshot ADD COLUMN display_format TEXT NOT NULL DEFAULT 'percent';
ALTER TABLE budget_metric_snapshot ADD COLUMN unit TEXT NOT NULL DEFAULT '';
ALTER TABLE budget_metric_term_snapshot ADD COLUMN role TEXT NOT NULL DEFAULT 'term';

/* ---- 示范比率(仅在依赖的科目/指标存在时创建,全部可在界面删除) ----
 * 覆盖四种组合:指标÷指标、科目÷科目、金额÷数量、越低越好。
 * 数量科目只允许 quantity_agg='sum';Q101 上网电量(万度)满足。 */

/* R01 营业利润率 = 营业利润 P03 ÷ 营业总收入 P01 */
INSERT INTO report_metric (code,name,display_order,status,kind,direction,display_format,unit,created_at,updated_at)
SELECT 'R01','营业利润率',101,'active','ratio','higher_better','percent','',datetime('now'),datetime('now')
WHERE EXISTS (SELECT 1 FROM report_metric WHERE code='P03')
  AND EXISTS (SELECT 1 FROM report_metric WHERE code='P01')
  AND NOT EXISTS (SELECT 1 FROM report_metric WHERE code='R01');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'metric',NULL,s.id,1,1,'numerator' FROM report_metric t, report_metric s
WHERE t.code='R01' AND s.code='P03'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='numerator');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'metric',NULL,s.id,1,2,'denominator' FROM report_metric t, report_metric s
WHERE t.code='R01' AND s.code='P01'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='denominator');

/* R02 净利率 = 净利润 P05 ÷ 总收入 P07 */
INSERT INTO report_metric (code,name,display_order,status,kind,direction,display_format,unit,created_at,updated_at)
SELECT 'R02','净利率',102,'active','ratio','higher_better','percent','',datetime('now'),datetime('now')
WHERE EXISTS (SELECT 1 FROM report_metric WHERE code='P05')
  AND EXISTS (SELECT 1 FROM report_metric WHERE code='P07')
  AND NOT EXISTS (SELECT 1 FROM report_metric WHERE code='R02');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'metric',NULL,s.id,1,1,'numerator' FROM report_metric t, report_metric s
WHERE t.code='R02' AND s.code='P05'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='numerator');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'metric',NULL,s.id,1,2,'denominator' FROM report_metric t, report_metric s
WHERE t.code='R02' AND s.code='P07'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='denominator');

/* R03 管理费用率 = 管理费用 E2 ÷ 营业收入 I1;E2 是费用(存负数),分子系数 -1 读正,越低越好 */
INSERT INTO report_metric (code,name,display_order,status,kind,direction,display_format,unit,created_at,updated_at)
SELECT 'R03','管理费用率',103,'active','ratio','lower_better','percent','',datetime('now'),datetime('now')
WHERE EXISTS (SELECT 1 FROM account WHERE code='E2')
  AND EXISTS (SELECT 1 FROM account WHERE code='I1')
  AND NOT EXISTS (SELECT 1 FROM report_metric WHERE code='R03');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'account',a.id,NULL,-1,1,'numerator' FROM report_metric t, account a
WHERE t.code='R03' AND a.code='E2'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='numerator');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'account',a.id,NULL,1,2,'denominator' FROM report_metric t, account a
WHERE t.code='R03' AND a.code='I1'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='denominator');

/* R04 平均上网电价 = 上网电量收入 I1101 ÷ 上网电量 Q101。
 * 自然单位 = 元 ÷ 万度;分母按科目自身计量单位取值,系统不做单位换算。 */
INSERT INTO report_metric (code,name,display_order,status,kind,direction,display_format,unit,created_at,updated_at)
SELECT 'R04','平均上网电价',104,'active','ratio','higher_better','number','元/万度',datetime('now'),datetime('now')
WHERE EXISTS (SELECT 1 FROM account WHERE code='I1101')
  AND EXISTS (SELECT 1 FROM account WHERE code='Q101' AND type='quantity' AND quantity_agg='sum')
  AND NOT EXISTS (SELECT 1 FROM report_metric WHERE code='R04');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'account',a.id,NULL,1,1,'numerator' FROM report_metric t, account a
WHERE t.code='R04' AND a.code='I1101'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='numerator');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'account',a.id,NULL,1,2,'denominator' FROM report_metric t, account a
WHERE t.code='R04' AND a.code='Q101'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='denominator');

/* R05 度电营业成本 = 营业成本 C1 ÷ 上网电量 Q101;C1 是成本(存负数),分子系数 -1,越低越好 */
INSERT INTO report_metric (code,name,display_order,status,kind,direction,display_format,unit,created_at,updated_at)
SELECT 'R05','度电营业成本',105,'active','ratio','lower_better','number','元/万度',datetime('now'),datetime('now')
WHERE EXISTS (SELECT 1 FROM account WHERE code='C1')
  AND EXISTS (SELECT 1 FROM account WHERE code='Q101' AND type='quantity' AND quantity_agg='sum')
  AND NOT EXISTS (SELECT 1 FROM report_metric WHERE code='R05');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'account',a.id,NULL,-1,1,'numerator' FROM report_metric t, account a
WHERE t.code='R05' AND a.code='C1'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='numerator');
INSERT INTO report_metric_term (metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT t.id,'account',a.id,NULL,1,2,'denominator' FROM report_metric t, account a
WHERE t.code='R05' AND a.code='Q101'
  AND NOT EXISTS (SELECT 1 FROM report_metric_term x WHERE x.metric_id=t.id AND x.role='denominator');
`,
  },
  {
    version: 24,
    name: 'backfill_ratio_metrics_into_locked_snapshots',
    sql: `
/* 把比率指标补进已定稿版本的固化指标快照。
 *
 * 为什么这不违反「定稿后不可变」(方案三.3、方案二.5):
 * 该约定的目的是「历史报表不被当前主数据重算」—— 保护的是金额、汇总与已有指标口径。
 * 本迁移只 INSERT 定稿时尚不存在的**新增比率指标**定义,不修改任何 budget_entry、
 * 实际快照、既有 budget_metric_snapshot 行或线性指标公式,所有历史金额与完成率逐分不变。
 * 比率是纯派生的分析视图,补录后才能做跨年度的毛利率/度电成本对比。
 *
 * 回填之后照常适用不可变规则:此后再改主表里的 R0x 公式,已定稿版本仍读这里固化的定义。
 * 若不希望某个定稿版本带比率,在界面上把该比率停用或删除即可。
 */
INSERT INTO budget_metric_snapshot(version_id,metric_id,code,name,display_order,status,kind,direction,display_format,unit,created_at,updated_at)
SELECT s.version_id,m.id,m.code,m.name,m.display_order,m.status,m.kind,m.direction,m.display_format,m.unit,m.created_at,m.updated_at
FROM budget_metric_snapshot_state s
CROSS JOIN report_metric m
WHERE m.kind='ratio'
  AND NOT EXISTS (
    SELECT 1 FROM budget_metric_snapshot x WHERE x.version_id=s.version_id AND x.metric_id=m.id
  );

INSERT INTO budget_metric_term_snapshot(version_id,metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
SELECT s.version_id,t.metric_id,t.source_type,t.source_account_id,t.source_metric_id,t.coefficient,t.sort_order,t.role
FROM budget_metric_snapshot_state s
JOIN report_metric_term t ON 1=1
JOIN report_metric m ON m.id=t.metric_id
WHERE m.kind='ratio'
  AND NOT EXISTS (
    SELECT 1 FROM budget_metric_term_snapshot x
    WHERE x.version_id=s.version_id AND x.metric_id=t.metric_id AND x.role=t.role
  );

/* 补录留痕:定稿版本的固化定义被追加过,必须可查 */
INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at)
SELECT 'migration.snapshot_backfill', 'migration', 'V24', json_object(
  'reason', '新增比率指标补进已定稿版本的固化指标快照(仅追加新指标定义,不改动金额与既有口径)',
  'ratio_metrics', (SELECT COALESCE(group_concat(code), '') FROM report_metric WHERE kind='ratio'),
  'versions_touched', (SELECT COUNT(*) FROM budget_metric_snapshot_state)
), datetime('now')
WHERE EXISTS (SELECT 1 FROM report_metric WHERE kind='ratio')
  AND EXISTS (SELECT 1 FROM budget_metric_snapshot_state);
`,
  },
  {
    version: 25,
    name: 'budget_revision_and_metric_display_sign',
    sql: `
/* 整包预算保存的跨客户端乐观并发基线。 */
ALTER TABLE budget_version ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);

/* 线性指标的业务展示方向：存储/差异仍保持利润方向，完成率两侧统一乘此符号。 */
ALTER TABLE report_metric ADD COLUMN display_sign INTEGER NOT NULL DEFAULT 1 CHECK (display_sign IN (-1,1));
ALTER TABLE budget_metric_snapshot ADD COLUMN display_sign INTEGER NOT NULL DEFAULT 1 CHECK (display_sign IN (-1,1));
UPDATE report_metric SET display_sign = -1 WHERE code IN ('P02','P06');
UPDATE budget_metric_snapshot SET display_sign = -1 WHERE code IN ('P02','P06');
`,
  },
  {
    version: 26,
    name: 'unique_metric_formula_sources',
    sql: `
/* 虚构数据中的历史重复项保留最早一条，再用数据库约束兜住服务层之外的写入。 */
DELETE FROM report_metric_term
WHERE id NOT IN (
  SELECT MIN(id) FROM report_metric_term
  GROUP BY metric_id, source_type, COALESCE(source_account_id, -1), COALESCE(source_metric_id, -1), role
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_metric_term_account_role
  ON report_metric_term(metric_id, source_account_id, role) WHERE source_type = 'account';
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_metric_term_metric_role
  ON report_metric_term(metric_id, source_metric_id, role) WHERE source_type = 'metric';

DELETE FROM budget_metric_term_snapshot
WHERE id NOT IN (
  SELECT MIN(id) FROM budget_metric_term_snapshot
  GROUP BY version_id, metric_id, source_type, COALESCE(source_account_id, -1), COALESCE(source_metric_id, -1), role
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_metric_term_snapshot_account_role
  ON budget_metric_term_snapshot(version_id, metric_id, source_account_id, role) WHERE source_type = 'account';
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_metric_term_snapshot_metric_role
  ON budget_metric_term_snapshot(version_id, metric_id, source_metric_id, role) WHERE source_type = 'metric';

/* 财务勾稽快照只固化线性指标，全部公式项都等价于 role=term。 */
DELETE FROM finance_metric_term_snapshot
WHERE id NOT IN (
  SELECT MIN(id) FROM finance_metric_term_snapshot
  GROUP BY mapping_version_id, metric_id, source_type, COALESCE(source_account_id, -1), COALESCE(source_metric_id, -1)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_metric_term_snapshot_account
  ON finance_metric_term_snapshot(mapping_version_id, metric_id, source_account_id) WHERE source_type = 'account';
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_metric_term_snapshot_metric
  ON finance_metric_term_snapshot(mapping_version_id, metric_id, source_metric_id) WHERE source_type = 'metric';
`,
  },
  {
    version: 27,
    name: 'cleaning_excel_import',
    sql: `
/* 非标准 Excel 清洗导入：批次固化计划，逐行预览只保留在 pending 生命周期。 */
ALTER TABLE import_batch ADD COLUMN cleaning_plan_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE import_cleaning_preview_row (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  sheet_name TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  source_org_text TEXT NOT NULL DEFAULT '',
  source_account_text TEXT NOT NULL DEFAULT '',
  source_value_text TEXT NOT NULL DEFAULT '',
  target_org_code TEXT NOT NULL DEFAULT '',
  target_account_code TEXT NOT NULL DEFAULT '',
  normalized_value TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('insert','overwrite','unchanged','clear','excluded')),
  warning TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_cleaning_preview_batch_row
  ON import_cleaning_preview_row(import_batch_id, id);
CREATE INDEX idx_cleaning_preview_batch_action
  ON import_cleaning_preview_row(import_batch_id, action, id);

CREATE TABLE import_mapping_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('budget','actual-current')),
  config_json TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE import_name_alias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('budget','actual-current')),
  mapping_kind TEXT NOT NULL CHECK (mapping_kind IN ('org','account')),
  source_text TEXT NOT NULL,
  target_code TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_kind, mapping_kind, source_text)
);
CREATE INDEX idx_import_alias_lookup
  ON import_name_alias(target_kind, mapping_kind, source_text);
`,
  },
  {
    version: 28,
    name: 'cleaning_preview_expected_value',
    sql: `
/* 金额清洗预览同时展示保存服务输入和预计最终利润方向值。 */
ALTER TABLE import_cleaning_preview_row
  ADD COLUMN expected_value_text TEXT NOT NULL DEFAULT '';
`,
  },
  {
    version: 29,
    name: 'finance_mapping_row_provenance',
    sql: `
/* 财务映射候选建议(AI 功能增强计划阶段二.3):映射行增加来源标记与未复核状态。
   存量行默认手工来源且已复核,不改变任何锁定与校验语义;
   采纳建议产生的行由服务层写入 deterministic/ai 与 reviewed=0。 */
ALTER TABLE finance_org_mapping
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','deterministic','ai'));
ALTER TABLE finance_org_mapping
  ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 1 CHECK (reviewed IN (0,1));
ALTER TABLE finance_account_mapping
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','deterministic','ai'));
ALTER TABLE finance_account_mapping
  ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 1 CHECK (reviewed IN (0,1));
`,
  },
  {
    version: 30,
    name: 'alias_target_kind_finance',
    raw: true,
    sql: `
/* 别名机制扩展到财务转换映射(AI 功能增强计划阶段二.5):
   import_name_alias.target_kind 枚举增加 'finance',用户确认的语义映射可沉淀复用。
   CHECK 约束不可修改,整表重建;raw 迁移自行关闭外键,结束后由迁移器恢复并强制 foreign_key_check。 */
PRAGMA foreign_keys = OFF;
CREATE TABLE import_name_alias_v30 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('budget','actual-current','finance')),
  mapping_kind TEXT NOT NULL CHECK (mapping_kind IN ('org','account')),
  source_text TEXT NOT NULL,
  target_code TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_kind, mapping_kind, source_text)
);
INSERT INTO import_name_alias_v30
  SELECT id, target_kind, mapping_kind, source_text, target_code, created_by, created_at, updated_at
  FROM import_name_alias;
DROP TABLE import_name_alias;
ALTER TABLE import_name_alias_v30 RENAME TO import_name_alias;
CREATE INDEX idx_import_alias_lookup
  ON import_name_alias(target_kind, mapping_kind, source_text);
`,
  },
  {
    version: 31,
    name: 'checkpoint_summary_provenance',
    sql: `
/* 编制记录点「本轮修改小结」(AI 功能增强计划 §四.阶段六.2):
   budget_compilation_checkpoint 增加小结列与 provenance 列。
   持久化散文 provenance 先例:本表是首个持久化模型散文点,字段为
   summary_source(template/model)、summary_model(模型名)、
   summary_prompt_version(prompt 版本)、summary_generated_at(生成时间)、
   summary_guard_ok(数字守卫结果,NULL=未经过守卫/1=通过/0=失败回退)。
   存量行全部为空(未生成),前端回退变化清单,语义不变。 */
ALTER TABLE budget_compilation_checkpoint
  ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE budget_compilation_checkpoint
  ADD COLUMN summary_source TEXT NOT NULL DEFAULT '' CHECK (summary_source IN ('','template','model'));
ALTER TABLE budget_compilation_checkpoint
  ADD COLUMN summary_model TEXT NOT NULL DEFAULT '';
ALTER TABLE budget_compilation_checkpoint
  ADD COLUMN summary_prompt_version TEXT NOT NULL DEFAULT '';
ALTER TABLE budget_compilation_checkpoint
  ADD COLUMN summary_generated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE budget_compilation_checkpoint
  ADD COLUMN summary_guard_ok INTEGER CHECK (summary_guard_ok IN (0,1));
`,
  },
  {
    version: 32,
    name: 'assistant_narrative_task',
    sql: `
/* 异步叙述生成任务表(AI 功能增强计划 §三.4,仅阶段六使用):
   一张任务表 + 轮询,不引入消息队列/异步框架。
   状态机 pending → running → done/failed;payload_json 为结果负载,
   source/model/prompt_version/guard_ok 为 provenance。
   当前唯一 kind 是 checkpoint_summary(编制记录点小结,ref_id = 记录点 id)。 */
CREATE TABLE assistant_narrative_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('checkpoint_summary')),
  ref_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  payload_json TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '' CHECK (source IN ('','template','model')),
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  guard_ok INTEGER CHECK (guard_ok IN (0,1)),
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_narrative_task_ref ON assistant_narrative_task(kind, ref_id, id);
`,
  },
  {
    version: 33,
    name: 'narrative_task_reliability',
    sql: `
/* 异步叙述任务的抢占与恢复(AI 功能增强计划 §三.4 可靠性补齐)。
   原实现读到任务就无条件置 running,并发调用同一任务会重复调用模型;
   崩溃遗留的 running 任务也无人回收。补三样东西:
   - attempts:已尝试次数,用于失败重试上限与 stale 回收判定;
   - started_at:本次 running 的开始时间,用于识别崩溃遗留的 stale 任务;
   - 活动任务唯一索引:同一 (kind, ref_id) 同时只允许一个 pending/running 任务,
     由数据库而不是应用层保证去重(partial index,failed/done 不占用)。
   claim 由 UPDATE ... WHERE status/started_at/attempts 条件原子完成,changes=1 才算抢到。 */
ALTER TABLE assistant_narrative_task
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assistant_narrative_task
  ADD COLUMN started_at TEXT NOT NULL DEFAULT '';
DELETE FROM assistant_narrative_task
  WHERE status IN ('pending','running')
    AND id NOT IN (
      SELECT MAX(id) FROM assistant_narrative_task
      WHERE status IN ('pending','running') GROUP BY kind, ref_id
    );
CREATE UNIQUE INDEX idx_narrative_task_active
  ON assistant_narrative_task(kind, ref_id)
  WHERE status IN ('pending','running');
`,
  },
  {
    version: 34,
    name: 'ai_channel_and_feature_binding',
    sql: `
/* LLM 渠道管理(侧栏导航扩展计划 §七):模型渠道从纯环境变量升级为库内可管理。
   ai_channel 存渠道(api_key 按用户决定明文存储,本地单用户应用,与 .env 同机同级暴露面);
   ai_feature_binding 把 6 个 AI 功能绑定到主/备渠道,主失败自动落备用由适配层完成。
   feature 枚举:chat / narrative(报告草稿、质量建议、趋势叙述共用管道) /
   checkpoint_summary / cleaning_suggest / mapping_candidates / master_data_semantic。
   纯 CREATE TABLE,无外键重建;一次性导入(env -> 首条渠道)在迁移函数内完成。 */
CREATE TABLE ai_channel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  timeout_ms INTEGER NOT NULL DEFAULT 15000,
  stream INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_test_status TEXT,
  last_test_latency_ms INTEGER,
  last_test_message TEXT,
  last_tested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE ai_feature_binding (
  feature TEXT PRIMARY KEY,
  primary_channel_id INTEGER REFERENCES ai_channel(id) ON DELETE SET NULL,
  fallback_channel_id INTEGER REFERENCES ai_channel(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 35,
    name: 'summary_cell_note',
    sql: `
/* 汇总格备注:非叶子组织列/非叶子科目行的批注(预算测算依据、实际数备注)。
   与 budget_entry.note / actual_current.memo 互补:明细表的键被校验为叶子×叶子,
   汇总格是运行时聚合值、没有明细行,批注只能独立成表。
   同一版本内两表键空间互斥(树快照不可变,叶子性固定),保存链路强制这一分工。
   汇总备注不带金额,不参与汇总/勾稽/快照,也不进导入导出。 */
CREATE TABLE budget_cell_note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES budget_version(id),
  org_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (version_id, org_id, account_id)
);
CREATE INDEX idx_budget_cell_note_version ON budget_cell_note(version_id);

CREATE TABLE actual_cell_note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (year, org_id, account_id)
);
`,
  },
  {
    version: 36,
    name: 'actual_save_receipt',
    sql: `
/* 实际保存持久回执(易用性方案 UX-11):请求编号由客户端生成,服务端只校验与去重。
   request_id 唯一;request_hash 是排除 requestId 后规范化请求内容的 SHA-256;
   回执与实际值/快照在同一事务写入,事务失败不残留成功回执;历史补录同样去重。
   回执长期保留以识别旧请求,不随缓存清理而允许同编号再次执行。 */
CREATE TABLE actual_save_receipt (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 9999),
  batch_id INTEGER NOT NULL REFERENCES actual_snapshot_batch(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_actual_save_receipt_year ON actual_save_receipt(year, created_at);
`,
  },
  {
    version: 37,
    name: 'import_preview_detail',
    sql: `
/* 统一导入预览明细(易用性方案 UX-14,§5.3):创建预览批次时与摘要同事务冻结,
   之后读取不随当前数据漂移。金额为利润方向整数分,数量为 10^4 缩放整数,
   不用万元显示值反推差异。group_year/group_date 对应实际导入的 年度×截止日 分组
   (文件可含多年度多截止日);预算导入为 NULL。
   source_sheet/source_row 可追溯时记录源位置,无法追溯(旧数据)留空由读取侧标注。
   old/new_text 承载备注(实际)或附注(预算);old/new_formula 仅预算导入使用。
   动作语义与确认提交一致:insert 新增 / overwrite 覆盖(含公式变化) /
   clear 清零或删除 / unchanged 不变 / note_change 仅备注变化 /
   excluded 清洗排除行 / skipped 保留位。
   生命周期:committed/rolled_back 批次明细保留供审计;pending 取消或过期时
   随现有清理政策删除明细,批次摘要与 operation_log 审计保留。 */
CREATE TABLE import_preview_detail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  group_year INTEGER,
  group_date TEXT,
  source_sheet TEXT NOT NULL DEFAULT '',
  source_row INTEGER,
  org_id INTEGER,
  org_code TEXT NOT NULL DEFAULT '',
  account_id INTEGER,
  account_code TEXT NOT NULL DEFAULT '',
  value_kind TEXT NOT NULL CHECK (value_kind IN ('amount','quantity','memo')),
  old_cents INTEGER,
  new_cents INTEGER,
  old_quantity INTEGER,
  new_quantity INTEGER,
  old_text TEXT NOT NULL DEFAULT '',
  new_text TEXT NOT NULL DEFAULT '',
  old_formula TEXT NOT NULL DEFAULT '',
  new_formula TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('insert','overwrite','clear','unchanged','note_change','excluded','skipped')),
  warning TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_import_preview_detail_batch ON import_preview_detail(import_batch_id, id);
CREATE INDEX idx_import_preview_detail_action ON import_preview_detail(import_batch_id, action, id);
CREATE INDEX idx_import_preview_detail_org ON import_preview_detail(import_batch_id, org_id, id);
`,
  },
  {
    version: 38,
    name: 'cleaning_reopen_session',
    sql: `
/* 清洗预览恢复会话(易用性方案 UX-16,§5.3):生成待确认预览后允许「修改导入配置」——
   服务端从原 pending 批次取回原件复制为新的临时上传,再取消旧批次并在此记录恢复计划。
   import_batch_id 唯一:同一批次只存在一份恢复会话,响应丢失后的重复请求幂等返回。
   upload_token 是新临时文件凭证,只出现在接口响应体,不进入 URL、日志或助手上下文;
   临时文件遵守 CleaningUploadStore 既有 TTL/容量限制,过期后被物理清除,
   本表行仍保留(计划/目标/原文件指纹即「必要的恢复摘要」),供要求重传时恢复配置。 */
CREATE TABLE cleaning_reopen_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL UNIQUE REFERENCES import_batch(id),
  upload_token TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  plan_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
];

// newfc 自有迁移(V39 起)按领域维护在 migrations-newfc.ts,保持只追加。
MIGRATIONS.push(...NEWFC_MIGRATIONS);

/**
 * V34 一次性导入:AI_BASE_URL 已配置且 ai_channel 为空时,把 env 配置落成名为
 * 「环境变量默认」的首条渠道,并把 6 个 feature 的 primary 都绑到它——升级后行为与升级前一致。
 * 在 V34 迁移事务内调用(见 applyMigrations)。
 *
 * 导入前必须过同款安全校验(env 路径的 aiConfigurationIssue 语义):升级前非法
 * AI_BASE_URL(如公网明文 http)会被拦下并回退模板模式,不发出任何请求;若不校验
 * 直接落库成 enabled 渠道,渠道路径没有 issue 检查,会让带 apiKey 的请求发往非法地址。
 */
function importEnvDefaultChannel(db: DB): void {
  const baseUrl = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || '').trim();
  if (!baseUrl) return;
  // 与 assistant/model.ts aiConfigurationIssue() 同款规则;该校验在 service 内重复实现,
  // 迁移文件不反向 import assistant 层,此处内联同口径判定(注释声明同源)。
  const apiKey = (process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const accessPassword = (process.env.NEWFC_ACCESS_PASSWORD || '').trim();
  if (apiKey && accessPassword && apiKey === accessPassword) return;
  const issue = envBaseUrlIssue(baseUrl);
  if (issue) return; // 非法配置不导入,保持无渠道状态,运行时回退 env→模板降级路径
  const existing = db.prepare('SELECT COUNT(*) AS c FROM ai_channel').get() as { c: number };
  if (existing.c > 0) return;
  const model = (process.env.AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const rawTimeout = Number(process.env.AI_TIMEOUT_MS || 15_000);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(120_000, Math.max(10, Math.trunc(rawTimeout))) : 15_000;
  const stream = (process.env.AI_STREAM ?? '1').trim() !== '0' ? 1 : 0;
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO ai_channel (name, base_url, api_key, model, timeout_ms, stream, enabled, created_at, updated_at)
     VALUES ('环境变量默认', ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(baseUrl, apiKey, model, timeoutMs, stream, now, now);
  const channelId = Number(result.lastInsertRowid);
  const features = ['chat', 'narrative', 'checkpoint_summary', 'cleaning_suggest', 'mapping_candidates', 'master_data_semantic'];
  const insert = db.prepare(
    'INSERT INTO ai_feature_binding (feature, primary_channel_id, fallback_channel_id, updated_at) VALUES (?, ?, NULL, ?)',
  );
  for (const feature of features) insert.run(feature, channelId, now);
}

/** AI_BASE_URL 合法性判定(与 aiConfigurationIssue/channelConfigurationIssue 同口径)。 */
function envBaseUrlIssue(baseUrl: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { return 'AI_BASE_URL 不是合法 URL'; }
  if (parsed.protocol === 'https:') return undefined;
  if (parsed.protocol !== 'http:') return 'AI_BASE_URL 只允许 https://,或本机 http:// 服务';
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  const explicitTrustedHttp = process.env.AI_ALLOW_INSECURE_HTTP === '1';
  const testOnlyHost = Boolean(process.env.VITEST) && host.endsWith('.test');
  if (!loopback && !explicitTrustedHttp && !testOnlyHost) {
    return '公网/远程 AI_BASE_URL 必须使用 https://;可信内网 HTTP 需显式设置 AI_ALLOW_INSECURE_HTTP=1';
  }
  return undefined;
}

function tableExists(db: DB, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function tableColumns(db: DB, name: 'account' | 'budget_entry' | 'actual_current' | 'actual_snapshot_entry'): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((row) => row.name));
}

/**
 * V30 是第二个事务外整表重建迁移(raw 迁移逐条 DDL 自动提交,版本号在全部完成后才写入)。
 * 进程若在 CREATE 之后、版本记录之前被杀,库里会同时留下 import_name_alias(旧枚举)与
 * import_name_alias_v30;下次启动重放 V30 会在 CREATE TABLE 处抛 "already exists",
 * 服务永久无法启动。这里按两表当前状态归一化续做:
 * - 两表并存:旧表是完整来源,弃掉未完成的暂存表重跑(数据未丢,重跑幂等);
 * - 仅 v30 暂存表:原迁移已在 DROP 旧表后中断,暂存表已持有全量数据,补改名即可。
 */
function applyImportAliasFinanceMigration(db: DB): void {
  db.pragma('foreign_keys = OFF');
  const hasOld = tableExists(db, 'import_name_alias');
  const hasStaging = tableExists(db, 'import_name_alias_v30');
  if (hasOld && hasStaging) {
    db.exec('DROP TABLE import_name_alias_v30');
    // 落回「旧表在、暂存表无」状态,与下方正常路径共用同一段重建 SQL
    db.exec(ALIAS_V30_SQL);
    return;
  }
  if (!hasOld && hasStaging) {
    db.exec('ALTER TABLE import_name_alias_v30 RENAME TO import_name_alias');
    db.exec('CREATE INDEX IF NOT EXISTS idx_import_alias_lookup ON import_name_alias(target_kind, mapping_kind, source_text)');
    return;
  }
  if (!hasOld) {
    // 理论上不可达(旧表与暂存表都不存在);为虚构数据恢复兜底,直接按目标结构字面量建表
    db.exec(`
CREATE TABLE import_name_alias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('budget','actual-current','finance')),
  mapping_kind TEXT NOT NULL CHECK (mapping_kind IN ('org','account')),
  source_text TEXT NOT NULL,
  target_code TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_kind, mapping_kind, source_text)
);
CREATE INDEX IF NOT EXISTS idx_import_alias_lookup ON import_name_alias(target_kind, mapping_kind, source_text);
`);
    return;
  }
  // 旧表在、暂存表无:正常首跑路径,直接执行原始 SQL
  db.exec(ALIAS_V30_SQL);
}

/** V30 的原始迁移 SQL(与迁移定义保持一致;运行器的续做逻辑按表状态选择执行段)。 */
const ALIAS_V30_SQL = `
CREATE TABLE import_name_alias_v30 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('budget','actual-current','finance')),
  mapping_kind TEXT NOT NULL CHECK (mapping_kind IN ('org','account')),
  source_text TEXT NOT NULL,
  target_code TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_kind, mapping_kind, source_text)
);
INSERT INTO import_name_alias_v30
  SELECT id, target_kind, mapping_kind, source_text, target_code, created_by, created_at, updated_at
  FROM import_name_alias;
DROP TABLE import_name_alias;
ALTER TABLE import_name_alias_v30 RENAME TO import_name_alias;
CREATE INDEX idx_import_alias_lookup
  ON import_name_alias(target_kind, mapping_kind, source_text);
`;

/**
 * V2 是旧版本唯一的事务外重建表迁移。恢复很早期备份时，进程可能曾在任意一条
 * DDL 后退出；这里按当前表/列状态续做，使 account_v2 残留和部分 quantity 列都可重放。
 */
function applyQuantityAccountsMigration(db: DB): void {
  db.pragma('foreign_keys = OFF');
  let hasAccount = tableExists(db, 'account');
  let hasStaging = tableExists(db, 'account_v2');

  if (hasAccount && hasStaging) {
    // account 仍在时它是完整来源；account_v2 只是未完成或重放时留下的暂存表。
    db.exec('DROP TABLE account_v2');
    hasStaging = false;
  }

  if (!hasAccount && hasStaging) {
    // 原迁移在 DROP account 后中断：暂存表已经拥有目标结构，直接完成改名。
    db.exec('ALTER TABLE account_v2 RENAME TO account');
    hasAccount = true;
    hasStaging = false;
  }

  if (!hasAccount) {
    // 理论上原迁移不会留下“两张表都没有”的状态；为虚构数据恢复提供空结构兜底。
    db.exec(`
CREATE TABLE account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES account(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','cost','expense','quantity')),
  unit TEXT NOT NULL DEFAULT '',
  quantity_agg TEXT NOT NULL DEFAULT 'sum' CHECK (quantity_agg IN ('sum','none')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);
    hasAccount = true;
  }

  const accountColumns = tableColumns(db, 'account');
  if (!accountColumns.has('unit') || !accountColumns.has('quantity_agg')) {
    const unitExpr = accountColumns.has('unit') ? 'unit' : "''";
    const quantityAggExpr = accountColumns.has('quantity_agg') ? 'quantity_agg' : "'sum'";
    db.exec(`
CREATE TABLE account_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES account_v2(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','cost','expense','quantity')),
  unit TEXT NOT NULL DEFAULT '',
  quantity_agg TEXT NOT NULL DEFAULT 'sum' CHECK (quantity_agg IN ('sum','none')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO account_v2 (id, parent_id, code, name, type, unit, quantity_agg, sort_order, status, created_at, updated_at)
SELECT id, parent_id, code, name, type, ${unitExpr}, ${quantityAggExpr}, sort_order, status, created_at, updated_at FROM account;
DROP TABLE account;
ALTER TABLE account_v2 RENAME TO account;
`);
  }

  const quantityTables = ['budget_entry', 'actual_current', 'actual_snapshot_entry'] as const;
  for (const table of quantityTables) {
    if (!tableColumns(db, table).has('quantity')) db.exec(`ALTER TABLE ${table} ADD COLUMN quantity INTEGER`);
  }
}

interface AppliedRow {
  version: number;
  name: string;
  applied_at: string;
}

/** 执行未应用的迁移(每个迁移一个事务;raw 迁移在事务外执行,自行管理外键开关)。返回本次应用的迁移列表。 */
export function applyMigrations(db: DB): Migration[] {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migration').all() as AppliedRow[]).map((r) => r.version)
  );
  const toApply = MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  for (const m of toApply) {
    if (m.rebuild) {
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(m.sql);
          const violations = db.pragma('foreign_key_check') as unknown[];
          if (violations.length > 0) {
            throw new Error(`迁移 V${m.version}(${m.name})重建后 foreign_key_check 发现 ${violations.length} 处违例,已回滚`);
          }
          db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    } else if (m.raw) {
      // raw 迁移在事务外自行管理外键开关;无论成败都必须恢复 foreign_keys,
      // 否则失败时当前连接会一直保持外键关闭,后续业务写入失去约束保护
      try {
        if (m.version === 2) applyQuantityAccountsMigration(db);
        else if (m.version === 30) applyImportAliasFinanceMigration(db);
        else db.exec(m.sql);
      } finally {
        db.pragma('foreign_keys = ON');
      }
      // 结构变更后强制外键体检:有违例则视为迁移失败,不写入迁移记录
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(`迁移 V${m.version}(${m.name})完成后 foreign_key_check 发现 ${violations.length} 处违例,已中止;请从备份恢复后排查`);
      }
      db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString()
      );
    } else {
      const tx = db.transaction(() => {
        db.exec(m.sql);
        if (m.version === 34) importEnvDefaultChannel(db);
        db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      });
      tx();
    }
  }
  return toApply;
}

export function appliedMigrations(db: DB): AppliedRow[] {
  return db.prepare('SELECT version, name, applied_at FROM schema_migration ORDER BY version').all() as AppliedRow[];
}

/** 库是否已初始化(存在 schema_migration 记录表)。全新库尚无任何业务表。 */
export function dbInitialized(db: DB): boolean {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'")
    .get();
  return Boolean(hasTable);
}

/** 待应用的迁移(首库返回全部;用于启动路径判断是否需要先做自动备份) */
export function pendingMigrations(db: DB): Migration[] {
  if (!dbInitialized(db)) return [...MIGRATIONS];
  const applied = new Set(appliedMigrations(db).map((r) => r.version));
  return MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
}
