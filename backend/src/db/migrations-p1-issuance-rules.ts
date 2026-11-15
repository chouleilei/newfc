/**
 * T-14 / P1 综合计划合一下达、多部门会签、招采与 52 条监管预警迁移 (V74, 只追加)。
 * 使用 Migration.rebuild = true 在 PRAGMA foreign_keys = OFF + 单事务内完成表新建与重建，
 * 并通过 PRAGMA foreign_key_check 强校验，完整保留 V1~V73 既有列、索引与触发器。
 */

export const P1_ISSUANCE_RULES_V74_SQL = `
/* 1. 年度综合计划与预算合一下达及 6 类调整闭环（4 张核心表） */
CREATE TABLE plan_issuance_cycle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  cycle_code TEXT NOT NULL UNIQUE,
  issuance_stage TEXT NOT NULL CHECK (issuance_stage IN ('pre_arrangement','formal_draft','official','adjusted')),
  source_plan_batch_id INTEGER REFERENCES plan_batch(id),
  source_budget_version_id INTEGER REFERENCES budget_version(id),
  decision_doc_meta TEXT NOT NULL DEFAULT '{}',
  frozen_snapshot_json TEXT NOT NULL DEFAULT '{}',
  snapshot_sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_plan_issuance_cycle_year ON plan_issuance_cycle(year, status);

CREATE TABLE plan_issuance_unit_pack (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES plan_issuance_cycle(id),
  unit_org_id INTEGER NOT NULL REFERENCES org(id),
  doc_no TEXT NOT NULL DEFAULT '',
  issued_date TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  has_responsibility_letter INTEGER NOT NULL DEFAULT 0 CHECK (has_responsibility_letter IN (0,1)),
  responsibility_letter_no TEXT NOT NULL DEFAULT '',
  pack_summary_json TEXT NOT NULL DEFAULT '{}',
  budget_version_id INTEGER REFERENCES budget_version(id),
  sign_off_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (sign_off_status IN ('draft','issued','acknowledged','adjust_requested')),
  ack_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  ack_at TEXT,
  ack_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (cycle_id, unit_org_id)
);
CREATE INDEX idx_issuance_pack_unit ON plan_issuance_unit_pack(unit_org_id, sign_off_status);

CREATE TABLE plan_adjustment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES plan_issuance_cycle(id),
  unit_pack_id INTEGER NOT NULL REFERENCES plan_issuance_unit_pack(id),
  adjust_type TEXT NOT NULL CHECK (adjust_type IN (
    'within_total_realloc',
    'overall_target_change',
    'unplanned_hq_or_station',
    'unplanned_subsidiary_within_cap',
    'unplanned_subsidiary_over_cap',
    'emergency_retroactive'
  )),
  approval_body TEXT NOT NULL CHECK (approval_body IN (
    'gm_office',
    'board_of_directors',
    'joint_review_company',
    'subsidiary_self_decision',
    'company_approval'
  )),
  decision_doc_no TEXT NOT NULL DEFAULT '',
  decision_attachment_id INTEGER REFERENCES file_object(id),
  emergency_start_date TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  new_cycle_id INTEGER REFERENCES plan_issuance_cycle(id),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1))
);
CREATE INDEX idx_plan_adj_cycle ON plan_adjustment(cycle_id, status);

CREATE TABLE plan_adjustment_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adjustment_id INTEGER NOT NULL REFERENCES plan_adjustment(id) ON DELETE CASCADE,
  plan_item_id INTEGER REFERENCES plan_item(id),
  stable_item_uid TEXT NOT NULL DEFAULT '',
  target_sheet_code TEXT NOT NULL,
  target_item_name TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'amount_cents'
    CHECK (value_type IN ('amount_cents','scaled_int','rate_bp','text')),
  scale INTEGER NOT NULL DEFAULT 2,
  unit TEXT NOT NULL DEFAULT '元',
  before_val TEXT NOT NULL DEFAULT '0',
  after_val TEXT NOT NULL DEFAULT '0',
  delta_val TEXT NOT NULL DEFAULT '0',
  before_cents INTEGER NOT NULL DEFAULT 0,
  after_cents INTEGER NOT NULL DEFAULT 0,
  delta_cents INTEGER NOT NULL DEFAULT 0,
  budget_account_id INTEGER REFERENCES account(id),
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_plan_adj_line_adj ON plan_adjustment_line(adjustment_id);

/* 2. 重建 std_report: 新增 plan_issuance_summary 标准冻结报表类型，完整保留冻结与单次复核触发器 */
CREATE TABLE std_report_v74 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL CHECK (report_type IN (
    'budget_execution','statement_summary','eas_recon','contract_payment_ledger',
    'risk_rectification_ledger','contract_monthly_pack','plan_issuance_summary'
  )),
  title TEXT NOT NULL,
  org_id INTEGER REFERENCES org(id),
  period TEXT NOT NULL,
  params_json TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','reviewed')),
  generated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  generated_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1))
);
INSERT INTO std_report_v74 (
  id, report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json,
  sources_json, content_sha256, status, generated_by_user_id, generated_at,
  reviewed_by_user_id, reviewed_at, review_comment, exception_reason, self_review
)
SELECT
  id, report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json,
  sources_json, content_sha256, status, generated_by_user_id, generated_at,
  reviewed_by_user_id, reviewed_at, review_comment, exception_reason, self_review
FROM std_report;
DROP TABLE std_report;
ALTER TABLE std_report_v74 RENAME TO std_report;
CREATE INDEX idx_std_report_org ON std_report(org_id);
CREATE INDEX idx_std_report_type ON std_report(report_type, period);
CREATE TRIGGER trg_std_report_d BEFORE DELETE ON std_report BEGIN SELECT RAISE(ABORT, '标准报表不可删除'); END;
CREATE TRIGGER trg_std_report_frozen_u BEFORE UPDATE OF report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json,
  sources_json, content_sha256, generated_by_user_id, generated_at ON std_report
BEGIN SELECT RAISE(ABORT, '标准报表冻结内容不可修改'); END;
CREATE TRIGGER trg_std_report_review_once BEFORE UPDATE OF status ON std_report
WHEN NOT (OLD.status = 'generated' AND NEW.status = 'reviewed')
BEGIN SELECT RAISE(ABORT, '标准报表只能复核一次'); END;

/* 3. 多部门结构化会签 ct_countersign 与合同包干池/当年计划分配列 */
CREATE TABLE ct_countersign (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  round_no INTEGER NOT NULL DEFAULT 1,
  doc_fingerprint TEXT NOT NULL DEFAULT '',
  dept_code TEXT NOT NULL,
  dept_name TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  assigned_reviewer_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewer_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewer_name TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','returned','waived','superseded')),
  opinion TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (contract_id, round_no, dept_code)
);
CREATE INDEX idx_ct_countersign_contract ON ct_countersign(contract_id, status);

ALTER TABLE ct_contract ADD COLUMN annual_plan_alloc_cents INTEGER CHECK (annual_plan_alloc_cents IS NULL OR annual_plan_alloc_cents >= 0);
ALTER TABLE ct_contract ADD COLUMN budget_pool_account_id INTEGER REFERENCES account(id);
ALTER TABLE ct_contract ADD COLUMN budget_pool_cap_cents INTEGER CHECK (budget_pool_cap_cents IS NULL OR budget_pool_cap_cents >= 0);

/* 4. 招采评委明细、共享招采修订日志、月报 OA 报送日志与不利变更上报日期 */
CREATE TABLE ct_procurement_reviewer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  procurement_record_id INTEGER NOT NULL REFERENCES ct_procurement_record(id) ON DELETE CASCADE,
  reviewer_name TEXT NOT NULL,
  identity TEXT NOT NULL CHECK (identity IN ('owner','staff','external')),
  title_level TEXT NOT NULL DEFAULT '',
  mid_title_years INTEGER,
  has_reg_qualification INTEGER NOT NULL DEFAULT 0 CHECK (has_reg_qualification IN (0,1)),
  is_qualified INTEGER NOT NULL DEFAULT 0 CHECK (is_qualified IN (0,1))
);
CREATE INDEX idx_ct_proc_reviewer_rec ON ct_procurement_reviewer(procurement_record_id);

CREATE TABLE ct_procurement_revision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  procurement_record_id INTEGER NOT NULL REFERENCES ct_procurement_record(id) ON DELETE CASCADE,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  affected_contract_ids_json TEXT NOT NULL DEFAULT '[]',
  actor_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ct_proc_rev_rec ON ct_procurement_revision_log(procurement_record_id, id DESC);

CREATE TABLE ct_monthly_report_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES org(id),
  report_month TEXT NOT NULL,
  exported_at TEXT,
  submitted_at TEXT,
  oa_ref_no TEXT NOT NULL DEFAULT '',
  receipt_attachment_id INTEGER REFERENCES file_object(id),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  UNIQUE (org_id, report_month)
);
CREATE INDEX idx_ct_monthly_report_month ON ct_monthly_report_log(report_month, org_id);

ALTER TABLE ct_change ADD COLUMN adverse_occurred_at TEXT;
ALTER TABLE ct_change ADD COLUMN adverse_reported_at TEXT;

/* 5. 重建 ct_document: 新增受控草稿附件一次性逻辑撤回列，严禁修改任何实质内容或物理删除 */
CREATE TABLE ct_document_v74 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('procurement','contract_text','signed','performance','acceptance','invoice','change','settlement','authorization','qualification','guarantee','dispute','other')),
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  name TEXT NOT NULL,
  uploaded_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL,
  evidence_kind TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN (
    'procurement_scheme_approval','bid_award_approval','award_notice','evaluation_report','company_approval','client_written_offer','legal_opinion','triple_major_decision','tech_spec','safety_protocol',
    'supplier_qualification','our_signatory_auth','counterparty_signatory_auth','change_decision','change_agreement','guarantor_consent','termination_agreement','warranty_release_visa','payment_approval_form','out_of_plan_approval','tech_special_audit','funding_feasibility',
    'boq_quantity_settlement','boq_price_settlement','other'
  )),
  change_id INTEGER REFERENCES ct_change(id),
  withdrawn_at TEXT,
  withdrawn_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  withdraw_reason TEXT NOT NULL DEFAULT ''
);
INSERT INTO ct_document_v74 (id, contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at, evidence_kind, change_id)
SELECT id, contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at, evidence_kind, change_id FROM ct_document;
DROP TABLE ct_document;
ALTER TABLE ct_document_v74 RENAME TO ct_document;
CREATE INDEX idx_ct_document_change ON ct_document(change_id) WHERE change_id IS NOT NULL;
CREATE INDEX idx_ct_document_contract ON ct_document(contract_id, doc_type);
CREATE TRIGGER trg_ct_document_d BEFORE DELETE ON ct_document BEGIN SELECT RAISE(ABORT, '合同文档不可删除'); END;
CREATE TRIGGER trg_ct_document_u BEFORE UPDATE ON ct_document
WHEN NOT (
  OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
  AND OLD.contract_id = NEW.contract_id
  AND OLD.doc_type = NEW.doc_type
  AND OLD.file_object_id = NEW.file_object_id
  AND OLD.name = NEW.name
  AND OLD.uploaded_by_user_id IS NEW.uploaded_by_user_id
  AND OLD.uploaded_at = NEW.uploaded_at
  AND OLD.evidence_kind IS NEW.evidence_kind
  AND OLD.change_id IS NEW.change_id
)
BEGIN SELECT RAISE(ABORT, '合同文档不可修改'); END;

/* 6. 前置 ex_claim 采购比价最小列（支撑 P1 PW-13 / PW-14 真实联测） */
ALTER TABLE ex_claim ADD COLUMN contract_id INTEGER REFERENCES ct_contract(id);
ALTER TABLE ex_claim ADD COLUMN is_procurement_expense INTEGER NOT NULL DEFAULT 0 CHECK (is_procurement_expense IN (0,1));
ALTER TABLE ex_claim ADD COLUMN price_compare_doc_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_ex_claim_contract ON ex_claim(contract_id) WHERE contract_id IS NOT NULL;

/* 7. 幂等补齐 AI 功能绑定 contract_legal_review（当已有非环境变量导入渠道或已配置7项绑定时默认关联首条启用渠道） */
INSERT OR IGNORE INTO ai_feature_binding (feature, primary_channel_id, fallback_channel_id, updated_at)
SELECT 'contract_legal_review', id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM ai_channel
WHERE enabled = 1
  AND (
    EXISTS (SELECT 1 FROM ai_feature_binding WHERE feature = 'expense_audit')
    OR name != '环境变量默认'
  )
ORDER BY id LIMIT 1;

/* 8. 重建 risk_rule 与 risk_event，补齐 52 条制度规则底座（33 净版 + 1 合并 + 18 内部扩展内控） */
CREATE TABLE risk_rule_v74 (
  code TEXT PRIMARY KEY CHECK (length(code) BETWEEN 3 AND 48),
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('project_budget','plan','contract','investment_control','feasibility','eas','expense')),
  detector TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 1 CHECK (builtin IN (0,1)),
  org_id INTEGER REFERENCES org(id),
  level TEXT NOT NULL CHECK (level IN ('high','medium','low')),
  threshold TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  suggestion TEXT NOT NULL DEFAULT '',
  rule_scope TEXT NOT NULL DEFAULT 'domain_general'
    CHECK (rule_scope IN ('supervision_net_33','internal_control_18','domain_general')),
  policy_ref_code TEXT NOT NULL DEFAULT '',
  effective_from TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT,
  updated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at TEXT,
  CHECK (builtin = 0 OR org_id IS NULL)
);
INSERT INTO risk_rule_v74 (
  code, name, source, detector, builtin, org_id, level, threshold, enabled, suggestion,
  version, created_by_user_id, created_at, updated_by_user_id, updated_at
)
SELECT
  code, name, source, detector, builtin, org_id, level, threshold, enabled, suggestion,
  version, created_by_user_id, created_at, updated_by_user_id, updated_at
FROM risk_rule;
DROP TABLE risk_rule;
ALTER TABLE risk_rule_v74 RENAME TO risk_rule;

CREATE TABLE risk_event_v74 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  rule_code TEXT NOT NULL REFERENCES risk_rule(code),
  source TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('high','medium','low')),
  org_id INTEGER NOT NULL REFERENCES org(id),
  project_id INTEGER REFERENCES md_project(id),
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER,
  metric TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  evidence_status TEXT NOT NULL DEFAULT 'confirmed_hit'
    CHECK (evidence_status IN ('confirmed_hit','insufficient_evidence','suspected_clue')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','rectifying','rectified','closed','false_positive')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  last_scan_id INTEGER REFERENCES risk_scan(id),
  last_scan_hit INTEGER NOT NULL DEFAULT 1 CHECK (last_scan_hit IN (0,1)),
  handler_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  deadline TEXT,
  rectify_note TEXT,
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  closed_at TEXT,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO risk_event_v74 (
  id, event_key, rule_code, source, level, org_id, project_id, subject_type, subject_id,
  title, description, amount_cents, metric, evidence_json, status, occurrence_count,
  first_detected_at, last_detected_at, last_scan_id, last_scan_hit, handler_user_id, deadline,
  rectify_note, submitted_by_user_id, reviewed_by_user_id, closed_at, reopened_count, version,
  created_at, updated_at
)
SELECT
  id, event_key, rule_code, source, level, org_id, project_id, subject_type, subject_id,
  title, description, amount_cents, metric, evidence_json, status, occurrence_count,
  first_detected_at, last_detected_at, last_scan_id, last_scan_hit, handler_user_id, deadline,
  rectify_note, submitted_by_user_id, reviewed_by_user_id, closed_at, reopened_count, version,
  created_at, updated_at
FROM risk_event;
DROP TRIGGER IF EXISTS trg_ct_risk_insert;
DROP TRIGGER IF EXISTS trg_ct_risk_update;
DROP TRIGGER IF EXISTS trg_ct_risk_delete;
DROP TABLE risk_event;
ALTER TABLE risk_event_v74 RENAME TO risk_event;
CREATE INDEX idx_risk_event_org ON risk_event(org_id, status);
CREATE INDEX idx_risk_event_rule ON risk_event(rule_code, status);
CREATE TRIGGER trg_ct_risk_insert AFTER INSERT ON risk_event WHEN NEW.source = 'contract' AND NEW.subject_type IN ('contract','project')
BEGIN UPDATE ct_contract SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (NEW.subject_type = 'contract' AND id = NEW.subject_id) OR (NEW.subject_type = 'project' AND project_id = NEW.subject_id AND org_id = NEW.org_id); END;
CREATE TRIGGER trg_ct_risk_update AFTER UPDATE ON risk_event WHEN NEW.source = 'contract' AND NEW.subject_type IN ('contract','project')
BEGIN UPDATE ct_contract SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (NEW.subject_type = 'contract' AND id = NEW.subject_id) OR (NEW.subject_type = 'project' AND project_id = NEW.subject_id AND org_id = NEW.org_id); END;
CREATE TRIGGER trg_ct_risk_delete AFTER DELETE ON risk_event WHEN OLD.source = 'contract' AND OLD.subject_type IN ('contract','project')
BEGIN UPDATE ct_contract SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (OLD.subject_type = 'contract' AND id = OLD.subject_id) OR (OLD.subject_type = 'project' AND project_id = OLD.subject_id AND org_id = OLD.org_id); END;

/* 9. 写入 52 条制度预警规则（PW_01~PW_20 共 20 条 + CW_01~CW_32 合并 CW-03 后 31 条 = 51 行，精确覆盖 52 条原始制度条目） */
INSERT OR IGNORE INTO risk_rule (code, name, source, detector, builtin, level, threshold, enabled, suggestion, rule_scope, policy_ref_code, effective_from) VALUES
  ('PW_01', '采购等级自动判定不符', 'contract', 'PW_01', 1, 'high', NULL, 1, '按采购类别、估算金额及是否招标重算采购等级（招标项目一律按一级管理），修正招采与合同等级记录。', 'supervision_net_33', 'PW-01', '2026-06-25'),
  ('PW_02', '承办人变更后未指定新承办人', 'contract', 'PW_02', 1, 'medium', NULL, 1, '承办人岗位调整或调离超过15个工作日须及时重新指定采购项目与合同承办人并留存交接记录。', 'internal_control_18', 'PW-02', '2026-06-25'),
  ('PW_03', '一级采购方案未经经营层审批', 'contract', 'PW_03', 1, 'high', NULL, 1, '一级采购（含所有招标项目）采购方案须报集团经营层审批并留存批复依据。', 'supervision_net_33', 'PW-03', '2026-06-25'),
  ('PW_04', '二级采购方案未经分管归口副总审批', 'contract', 'PW_04', 1, 'high', NULL, 1, '二级采购项目采购方案须报分管归口副总经理审批并补充批复记录。', 'supervision_net_33', 'PW-04', '2026-06-25'),
  ('PW_05', '三级采购（职能部门承办）方案未经归口部门审批', 'contract', 'PW_05', 1, 'medium', NULL, 1, '本部职能部门或中心承办的三级采购方案须经采购归口管理部门审批。', 'supervision_net_33', 'PW-05', '2026-06-25'),
  ('PW_06', '招标项目未按一级采购管理', 'contract', 'PW_06', 1, 'high', NULL, 1, '公开招标或邀请招标项目无论金额大小均须提级按一级采购管理。', 'internal_control_18', 'PW-06', '2026-06-25'),
  ('PW_07', '一级采购未公开招标且无经营层决策', 'contract', 'PW_07', 1, 'high', NULL, 1, '一级采购未采用公开招标方式时，须核实非依法必招属性并补齐集团经营层决策纪要。', 'supervision_net_33', 'PW-07', '2026-06-25'),
  ('PW_08', '邀请招标邀请数量不足', 'contract', 'PW_08', 1, 'high', NULL, 1, '邀请招标拟邀请及实际响应有效投标单位不得少于3家，不足3家须重新组织或履行变更审批。', 'supervision_net_33', 'PW-08', '2026-06-25'),
  ('PW_09', '谈判采购供应商不足2家', 'contract', 'PW_09', 1, 'high', NULL, 1, '竞争性谈判或商务谈判参与供应商不得少于2家。', 'supervision_net_33', 'PW-09', '2026-06-25'),
  ('PW_10', '询比采购供应商不足4家（制度门槛不足3家）', 'contract', 'PW_10', 1, 'high', NULL, 1, '询比采购参与有效报价供应商不得少于3家（制度 §8.1.4 法定最低3家）。', 'supervision_net_33', 'PW-10', '2026-06-25'),
  ('PW_11', '竞价采购供应商不足4家（制度门槛不足3家）', 'contract', 'PW_11', 1, 'high', NULL, 1, '竞价采购参与有效报价供应商不得少于3家（制度 §8.1.5 法定最低3家）。', 'supervision_net_33', 'PW-11', '2026-06-25'),
  ('PW_12', '直接采购缺合法情形或审批', 'contract', 'PW_12', 1, 'high', NULL, 1, '直接采购须匹配采购管理办法 §8.1.6 八种法定情形之一并附对应层级审批记录（情形6须附经营层决策文号）。', 'supervision_net_33', 'PW-12', '2026-06-25'),
  ('PW_13', '3万以内发票报账无比价报告', 'contract', 'PW_13', 1, 'medium', NULL, 1, '30,000.00元（含）以内采购类直接报账须进行市场比价并上传书面比价报告作为报账依据。', 'internal_control_18', 'PW-13', '2026-06-25'),
  ('PW_14', '3万以下经常性项目违规走发票报账', 'contract', 'PW_14', 1, 'high', NULL, 1, '同组织30日内同类别高频小额采购累计达30,000.00元疑似拆单或经常性项目，须按规定集中采购并签订合同。', 'internal_control_18', 'PW-14', '2026-06-25'),
  ('PW_15', '一、二级非招标评审人数不足', 'contract', 'PW_15', 1, 'high', NULL, 1, '一、二级非招标采购评审小组人数须为5人及以上单数。', 'supervision_net_33', 'PW-15', '2026-06-25'),
  ('PW_16', '三级采购评审人数不足', 'contract', 'PW_16', 1, 'medium', NULL, 1, '三级采购评审小组人数须为3人及以上单数。', 'supervision_net_33', 'PW-16', '2026-06-25'),
  ('PW_17', '业主评委职称不达标', 'contract', 'PW_17', 1, 'medium', NULL, 1, '招标项目派出的业主评委须具备高级及以上专业技术职称。', 'internal_control_18', 'PW-17', '2026-06-25'),
  ('PW_18', '一、二级非招标评委资格不达标', 'contract', 'PW_18', 1, 'high', NULL, 1, '一、二级非招标采购内部员工评委须满足高级职称、中级职称满5年或相应注册执业资格。', 'supervision_net_33', 'PW-18', '2026-06-25'),
  ('PW_19', '三级采购评委资格不达标', 'contract', 'PW_19', 1, 'medium', NULL, 1, '三级采购内部职工评委须满足中级职称满5年及以上或具备相应执业资格。', 'supervision_net_33', 'PW-19', '2026-06-25'),
  ('PW_20', '非招标项目未用库内供应商', 'contract', 'PW_20', 1, 'medium', NULL, 1, '非招标采购原则上须选用合格供应商库内主体；紧急例外须补充说明并事后完成入库核验。', 'supervision_net_33', 'PW-20', '2026-06-25'),
  ('CW_01', '合同编号不符合编号规则', 'contract', 'CW_01', 1, 'medium', NULL, 1, '核对合同编号单位简码映射、业务分类码（JG/SG/SJ/CW/TH/XF/QT）与年度流水号唯一性（合并原 CW-01/CW-03）。', 'supervision_net_33', 'CW-01/CW-03', '2026-06-25'),
  ('CW_02', '合同关联采购等级自动判定不符', 'contract', 'PW_01', 1, 'high', NULL, 1, '与 PW-01 同源重算合同采购等级（含招标提级一级），核对并修正合同采购等级。', 'supervision_net_33', 'CW-02', '2026-06-25'),
  ('CW_04', '重要合同谈判无法律顾问参与或法律意见', 'contract', 'CW_04', 1, 'high', NULL, 1, '重要合同签署前须邀请法律顾问参与谈判并上传正式法律意见书证据。', 'supervision_net_33', 'CW-04', '2026-06-25'),
  ('CW_05', '合同签订依据缺失', 'contract', 'CW_05', 1, 'high', NULL, 1, '采购合同须齐备招采审批记录，非采购合同须附集团批准文件，产品销售服务进项合同须附相对方书面邀约。', 'supervision_net_33', 'CW-05', '2026-06-25'),
  ('CW_06', '重要合同未经三重一大审批', 'contract', 'CW_06', 1, 'high', NULL, 1, '股权投资、资产置换、融资担保、合资合作等重要合同签署前须完成三重一大集体决策并上传决议。', 'supervision_net_33', 'CW-06', '2026-06-25'),
  ('CW_07', '承办人未指定或未及时交接', 'contract', 'CW_07', 1, 'medium', NULL, 1, '在途合同须明确承办人，承办人调离超过15个工作日须完成书面交接登记。', 'internal_control_18', 'CW-07', '2026-06-25'),
  ('CW_08', '合同生效前实质履行', 'contract', 'CW_08', 1, 'high', NULL, 1, '非应急合同严禁履约开始日或收付款早于合同签署生效日期。', 'supervision_net_33', 'CW-08', '2026-06-25'),
  ('CW_09', '应急项目超期补办合同', 'contract', 'CW_09', 1, 'high', NULL, 1, '应急项目开工后须在5个工作日内补办计划立项、15个工作日内完成正式合同审批签署。', 'internal_control_18', 'CW-09', '2026-06-25'),
  ('CW_10', '限额以上变更未经对应层级审批', 'contract', 'CW_10', 1, 'high', NULL, 1, '单次变更增加额超过 min(2%合同额, 200,000.00元) 时，须严格按制度附件5分级履行审批。', 'supervision_net_33', 'CW-10', '2026-06-25'),
  ('CW_11', '累计变更达门槛后未报经营层', 'contract', 'CW_11', 1, 'high', NULL, 1, '累计变更或索赔达到5,000,000.00元或原合同额10%后，后续每笔变更均须报集团经营层审批。', 'supervision_net_33', 'CW-11', '2026-06-25'),
  ('CW_12', '重大变更缺专项审核', 'contract', 'CW_12', 1, 'high', NULL, 1, '变更估算金额超过中标合同金额10%的重大变更，须上传技术归口部门专项审核意见。', 'internal_control_18', 'CW-12', '2026-06-25'),
  ('CW_13', '技术方案审查超时', 'contract', 'CW_13', 1, 'medium', NULL, 1, '技术归口部门收到变更技术方案审查申请后须在10个日历日内反馈意见。', 'internal_control_18', 'CW-13', '2026-06-25'),
  ('CW_14', '反索赔审查超时', 'contract', 'CW_14', 1, 'medium', NULL, 1, '反索赔方案报送技术归口部门后须在10个日历日内反馈审查结果。', 'internal_control_18', 'CW-14', '2026-06-25'),
  ('CW_15', '未审批变更进入结算', 'contract', 'CW_15', 1, 'high', NULL, 1, '含变更项目的合同结算须先完成对应变更审批并签署补充协议或合法确认文件。', 'internal_control_18', 'CW-15', '2026-06-25'),
  ('CW_16', '变更超计划未办计划外审批', 'contract', 'CW_16', 1, 'high', NULL, 1, '原合同加变更占用突破年度综合计划额度时，须先办理计划外审批并上传批复。', 'internal_control_18', 'CW-16', '2026-06-25'),
  ('CW_17', '涉支付增加未向纪审部备案', 'contract', 'CW_17', 1, 'medium', NULL, 1, '涉及集团支付金额增加的合同变更或索赔批准后须报纪审部门备案。', 'internal_control_18', 'CW-17', '2026-06-25'),
  ('CW_18', '变更后应签补充协议未签', 'contract', 'CW_18', 1, 'medium', NULL, 1, '已批准增额或实质变更须及时签订补充协议或上传其他法律法规认可的确认文件。', 'supervision_net_33', 'CW-18', '2026-06-25'),
  ('CW_19', '商务条款/工商信息变更未报分管领导审批', 'contract', 'CW_19', 1, 'medium', NULL, 1, '一、二级采购合同涉及对方工商主体、实质商务条款或付款方式变更时，须报承办单位分管领导审批。', 'supervision_net_33', 'CW-19', '2026-06-25'),
  ('CW_20', '生产经营总额包干项目突破包干总额', 'contract', 'CW_20', 1, 'high', NULL, 1, '总额包干项目同组织同科目跨合同年度占用累计不得突破年度包干总池额度。', 'internal_control_18', 'CW-20', '2026-06-25'),
  ('CW_21', '违规以变更规避采购', 'contract', 'CW_21', 1, 'high', NULL, 1, '与原合同范围无关、具备独立委托条件或超批准范围的事项严禁走合同变更，须重新履行采购程序。', 'supervision_net_33', 'CW-21', '2026-06-25'),
  ('CW_22', '合同解除未经总经理批准', 'contract', 'CW_22', 1, 'high', NULL, 1, '合同解除须经总经理或更高集体决策层级批准并上传解除协议证据。', 'supervision_net_33', 'CW-22', '2026-06-25'),
  ('CW_23', '担保合同变更/解除无担保单位书面同意', 'contract', 'CW_23', 1, 'high', NULL, 1, '附有效担保条款的合同办理变更、中止或解除时，须取得担保人书面同意文件。', 'internal_control_18', 'CW-23', '2026-06-25'),
  ('CW_24', '纠纷案结后未备案', 'contract', 'CW_24', 1, 'medium', NULL, 1, '合同纠纷结案后须及时报合同归口管理部门和纪审部门备案登记。', 'internal_control_18', 'CW-24', '2026-06-25'),
  ('CW_25', '无验收意见或档案不完整即结算', 'contract', 'CW_25', 1, 'high', NULL, 1, '办理最终竣工结算前须上传书面验收合格意见/鉴定书并完成合同档案核验。', 'supervision_net_33', 'CW-25', '2026-06-25'),
  ('CW_26', '单次支付审批层级不符', 'contract', 'CW_26', 1, 'high', NULL, 1, '核对单次付款审批层级与法人上年净资产1%及固定金额门槛的一致性，补齐合规付款审批表。', 'supervision_net_33', 'CW-26', '2026-06-25'),
  ('CW_27', '超结超付', 'contract', 'CW_27', 1, 'high', NULL, 1, '累计结算与累计支付严禁超过现行有效合同总额（原合同额 + 已批准变更额）或估算上限。', 'supervision_net_33', 'CW-27', '2026-06-25'),
  ('CW_28', '月度合同信息未按时报送', 'contract', 'CW_28', 1, 'medium', NULL, 1, '各单位须在每月28日前通过 OA 正式报送月度合同5表并登记 OA 流程单号（仅下载导出不消警）。', 'supervision_net_33', 'CW-28', '2026-06-25'),
  ('CW_29', '异常情形超期报告', 'contract', 'CW_29', 1, 'high', NULL, 1, '不利变更、对方索赔或合同纠纷发生后须在2个工作日内书面报告合同归口管理部门。', 'internal_control_18', 'CW-29', '2026-06-25'),
  ('CW_30', '验收后超期未归档', 'contract', 'CW_30', 1, 'low', '30', 1, '合同档案验收通过后超过配置移交时限仍未移交档案室的，须尽快办理集中归档移交。', 'internal_control_18', 'CW-30', '2026-06-25'),
  ('CW_31', '直属电站资金进项合同未以集团公司名义签订', 'contract', 'CW_31', 1, 'high', NULL, 1, '制度认定的直属水电站（is_direct_station=1）资金进项合同须以集团母公司名义对外签订。', 'supervision_net_33', 'CW-31', '2026-06-25'),
  ('CW_32', '分/子公司资金进项合同超期未报备', 'contract', 'CW_32', 1, 'medium', NULL, 1, '分、子公司（不含直属电站及集团内部单位间关联协议）资金进项合同签署后10个工作日内须报归口部门与财务结算中心备案。', 'supervision_net_33', 'CW-32', '2026-06-25');
`;
