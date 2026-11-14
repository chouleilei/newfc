/**
 * T-13 / P0 基础底座与历史容缺迁移 (V73, 只追加)。
 * 使用 Migration.rebuild = true 在 PRAGMA foreign_keys = OFF + 单事务内完成全部表扩展与重建，
 * 并通过 PRAGMA foreign_key_check 强校验，完整保留 V72 既有列、索引与触发器。
 */

export const P0_FOUNDATION_V73_SQL = `
/* 1. 扩展 org 组织主体 6 列（保持 status IN ('active','inactive') 兼容既有 30+ 表外键） */
ALTER TABLE org ADD COLUMN org_kind TEXT NOT NULL DEFAULT 'legal_entity'
  CHECK (org_kind IN ('legal_entity','hq_dept','direct_unit','closed_history'));
ALTER TABLE org ADD COLUMN credit_code TEXT NOT NULL DEFAULT '';
ALTER TABLE org ADD COLUMN plan_issuance_root_id INTEGER REFERENCES org(id);
ALTER TABLE org ADD COLUMN is_plan_excluded INTEGER NOT NULL DEFAULT 0 CHECK (is_plan_excluded IN (0,1));
ALTER TABLE org ADD COLUMN contract_prefix_code TEXT NOT NULL DEFAULT '';
ALTER TABLE org ADD COLUMN is_direct_station INTEGER NOT NULL DEFAULT 0 CHECK (is_direct_station IN (0,1));

/* 2. 扩展 md_supplier 合格供应商库标志（支撑冷启动主数据初始化基座） */
ALTER TABLE md_supplier ADD COLUMN is_in_pool INTEGER NOT NULL DEFAULT 0 CHECK (is_in_pool IN (0,1));
ALTER TABLE md_supplier ADD COLUMN pooled_at TEXT;

/* 3. 为内置系统管理员角色授予专有历史迁移权限 contract:migrate */
INSERT OR IGNORE INTO app_role_permission (role_id, permission)
SELECT id, 'contract:migrate' FROM app_role WHERE code = 'admin';

/* 4. 新建合同编号前缀映射字典 ct_prefix_org_map（六维法人归属与外部拦截单源） */
CREATE TABLE ct_prefix_org_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_prefix TEXT NOT NULL UNIQUE,
  canonical_prefix TEXT NOT NULL,
  legal_entity_org_id INTEGER REFERENCES org(id),
  signing_org_id INTEGER REFERENCES org(id),
  successor_org_id INTEGER REFERENCES org(id),
  effective_from TEXT,
  effective_to TEXT,
  parent_canonical_prefix TEXT NOT NULL DEFAULT '',
  entity_status TEXT NOT NULL CHECK (entity_status IN ('active_legal','direct_unit','inherited_child','closed_history','external','ignore')),
  allow_new_contract INTEGER NOT NULL DEFAULT 0 CHECK (allow_new_contract IN (0,1)),
  prefix_kind TEXT NOT NULL DEFAULT 'internal_prefix'
    CHECK (prefix_kind IN ('internal_prefix','typo_alias','role_prefix','external_counterparty','noise_header_filter')),
  sample_contract_no TEXT NOT NULL DEFAULT '',
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (entity_status IN ('external','ignore') OR legal_entity_org_id IS NOT NULL)
);
CREATE INDEX idx_ct_prefix_canonical ON ct_prefix_org_map(canonical_prefix);

/* 5. 前置新建核心招采过程主表 ct_procurement_record（1 采购项目 : N 合同，支撑月报 05_招标项目清查表） */
CREATE TABLE ct_procurement_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  procurement_code TEXT UNIQUE,
  procurement_title TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES md_project(id),
  org_id INTEGER NOT NULL REFERENCES org(id),
  procurement_target TEXT CHECK (procurement_target IS NULL OR procurement_target IN ('construction','goods','service')),
  procurement_method TEXT CHECK (procurement_method IS NULL OR procurement_method IN ('public_tender','invited_tender','negotiation','inquiry','bidding','direct','direct_reimburse')),
  procurement_tier TEXT CHECK (procurement_tier IS NULL OR procurement_tier IN ('tier_1','tier_2','tier_3','exempt_small')),
  estimated_cents INTEGER CHECK (estimated_cents IS NULL OR estimated_cents >= 0),
  is_tender INTEGER NOT NULL DEFAULT 0 CHECK (is_tender IN (0,1)),
  is_legally_mandatory_tender INTEGER NOT NULL DEFAULT 0 CHECK (is_legally_mandatory_tender IN (0,1)),
  undertaker_unit_type TEXT CHECK (undertaker_unit_type IS NULL OR undertaker_unit_type IN ('dept_center','secondary_unit')),
  approval_tier TEXT NOT NULL DEFAULT '',
  approver_name TEXT NOT NULL DEFAULT '',
  twice_tender_failed INTEGER NOT NULL DEFAULT 0 CHECK (twice_tender_failed IN (0,1)),
  is_invoice_reimburse INTEGER NOT NULL DEFAULT 0 CHECK (is_invoice_reimburse IN (0,1)),
  mgm_decision_doc TEXT NOT NULL DEFAULT '',
  tender_agency TEXT NOT NULL DEFAULT '',
  plan_submitted_at TEXT,
  announcement_date TEXT,
  prequal_sale_start TEXT,
  prequal_sale_end TEXT,
  doc_sale_start_date TEXT,
  clarification_site_date TEXT,
  bid_open_date TEXT,
  eval_report_submit_date TEXT,
  eval_report_receive_date TEXT,
  candidate_publicity_start TEXT,
  candidate_publicity_end TEXT,
  award_notice_date TEXT,
  invited_vendor_count INTEGER,
  committee_size INTEGER,
  committee_qualified_count INTEGER,
  supplier_in_pool INTEGER CHECK (supplier_in_pool IS NULL OR supplier_in_pool IN (0,1)),
  direct_procurement_grounds_json TEXT NOT NULL DEFAULT '[]',
  candidate_ranking_json TEXT NOT NULL DEFAULT '[]',
  comparison_quotes_json TEXT NOT NULL DEFAULT '[]',
  protest_flag INTEGER NOT NULL DEFAULT 0 CHECK (protest_flag IN (0,1)),
  protest_detail TEXT NOT NULL DEFAULT '',
  protest_resolved_at TEXT,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ct_proc_org ON ct_procurement_record(org_id, procurement_method);

/* 6. 重建 plan_item: 扩展 16 类 sheet_code、层级类型、跨修订 stable_item_uid、实际承办与四层金额列 */
CREATE TABLE plan_item_v73 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES plan_batch(id),
  sheet_code TEXT NOT NULL CHECK (sheet_code IN (
    'investment','investment_tech_renovation','investment_info','investment_other',
    'purchase','pre_work','capacity_add','tech_renovation_exp','maintenance','safety_input',
    'five_expenses','mgmt_fee','mfg_fee','annual_kpi','profit_budget','responsibility_kpi'
  )),
  row_no INTEGER NOT NULL,
  seq_no TEXT NOT NULL DEFAULT '',
  item_name TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'leaf' CHECK (item_type IN ('detail','category','subtotal','leaf','section_header','cross_ref_summary')),
  path TEXT NOT NULL DEFAULT '',
  item_key TEXT NOT NULL,
  project_id INTEGER REFERENCES md_project(id),
  org_id INTEGER REFERENCES org(id),
  stable_item_uid TEXT NOT NULL DEFAULT '',
  parent_item_key TEXT NOT NULL DEFAULT '',
  issuance_pack_id INTEGER,
  cost_nature TEXT NOT NULL DEFAULT '' CHECK (cost_nature IN ('','capitalized','expensed','recurrent','special')),
  funding_channel TEXT NOT NULL DEFAULT '' CHECK (funding_channel IN ('','equity_capital','debt_financing','self_owned','fiscal')),
  undertake_org_id INTEGER REFERENCES org(id),
  submitted_cents INTEGER,
  exact_calc_cents INTEGER,
  approved_cents INTEGER,
  rounding_rule TEXT NOT NULL DEFAULT 'exact_cents',
  diff_reason_code TEXT NOT NULL DEFAULT '',
  estimate_subitem TEXT NOT NULL DEFAULT '',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  CHECK (item_type <> 'detail' OR org_id IS NOT NULL),
  UNIQUE (batch_id, sheet_code, row_no)
);
INSERT INTO plan_item_v73 (
  id, batch_id, sheet_code, row_no, seq_no, item_name, item_type, path, item_key, project_id, org_id, stable_item_uid
)
SELECT
  id, batch_id, sheet_code, row_no, seq_no, item_name, item_type, path, item_key, project_id, org_id, item_key
FROM plan_item;
DROP TABLE plan_item;
ALTER TABLE plan_item_v73 RENAME TO plan_item;
CREATE INDEX idx_plan_item_batch_org ON plan_item(batch_id, org_id);
CREATE INDEX idx_plan_item_project ON plan_item(project_id);
CREATE INDEX idx_plan_item_stable_uid ON plan_item(stable_item_uid) WHERE stable_item_uid <> '';
CREATE TRIGGER trg_plan_item_u BEFORE UPDATE ON plan_item BEGIN SELECT RAISE(ABORT, '计划执行行不可修改'); END;
CREATE TRIGGER trg_plan_item_d BEFORE DELETE ON plan_item BEGIN SELECT RAISE(ABORT, '计划执行行不可删除'); END;

/* 7. 重建 ct_import: 扩展 legacy_batch_upsert 与 import_mode / 五维对账单持久化 */
CREATE TABLE ct_import_v73 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  errors_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','confirmed')),
  result_json TEXT,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  import_kind TEXT NOT NULL DEFAULT 'standard_ledger' CHECK (import_kind IN (
    'standard_ledger','monthly_ledger_wan','supervision_expense_base','supervision_expense_exec','supervision_expense_change',
    'supervision_income_base','supervision_income_exec','supervision_income_change','legacy_batch_upsert'
  )),
  import_mode TEXT NOT NULL DEFAULT 'standard' CHECK (import_mode IN ('standard','legacy_tolerant')),
  pipeline_version TEXT NOT NULL DEFAULT '',
  reconciliation_json TEXT
);
INSERT INTO ct_import_v73 (
  id, file_object_id, file_sha256, file_name, row_count, error_count, plan_hash, plan_json, errors_json,
  status, result_json, created_by_user_id, created_at, confirmed_at, import_kind
)
SELECT
  id, file_object_id, file_sha256, file_name, row_count, error_count, plan_hash, plan_json, errors_json,
  status, result_json, created_by_user_id, created_at, confirmed_at, import_kind
FROM ct_import;
DROP TABLE ct_import;
ALTER TABLE ct_import_v73 RENAME TO ct_import;
CREATE INDEX idx_ct_import_created ON ct_import(created_at DESC, id DESC);

/* 8. 重建 ct_contract: 保留 V68+V72 全部字段与触发器，扩展历史容缺、六维法人冻结、内部关联双视角与基线列 */
CREATE TABLE ct_contract_v73 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no TEXT NOT NULL,
  normalized_no TEXT NOT NULL,
  name TEXT NOT NULL,
  contract_type TEXT NOT NULL DEFAULT '',
  org_id INTEGER NOT NULL REFERENCES org(id),
  project_id INTEGER REFERENCES md_project(id),
  supplier_id INTEGER REFERENCES md_supplier(id),
  original_cents INTEGER NOT NULL DEFAULT 0,
  approved_change_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  payment_cap_ratio_scaled INTEGER CHECK (payment_cap_ratio_scaled IS NULL OR payment_cap_ratio_scaled BETWEEN 0 AND 1000000),
  stage TEXT NOT NULL DEFAULT 'initiation' CHECK (stage IN ('initiation','procurement','drafting','approval','performance','settlement','warranty','closed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed','terminated','voided')),
  status_reason TEXT,
  sign_date TEXT,
  effective_date TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  import_id INTEGER REFERENCES ct_import(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  legal_category TEXT NOT NULL DEFAULT 'other' CHECK (legal_category IN ('goods_procurement','small_construction','tech_service','general_service','construction','income_sales','important_special','other')),
  party_role TEXT NOT NULL DEFAULT 'buyer' CHECK (party_role IN ('buyer','seller','employer','contractor','client','provider','other')),
  signing_entity_level TEXT NOT NULL DEFAULT 'company' CHECK (signing_entity_level IN ('company','secondary_unit')),
  is_procurement INTEGER NOT NULL DEFAULT 1 CHECK (is_procurement IN (0,1)),
  procurement_target TEXT CHECK (procurement_target IS NULL OR procurement_target IN ('construction','goods','service')),
  procurement_method TEXT CHECK (procurement_method IS NULL OR procurement_method IN ('public_tender','invited_tender','negotiation','inquiry','bidding','direct','direct_reimburse')),
  procurement_tier TEXT CHECK (procurement_tier IS NULL OR procurement_tier IN ('tier_1','tier_2','tier_3','exempt_small','non_procurement')),
  is_important INTEGER NOT NULL DEFAULT 0 CHECK (is_important IN (0,1)),
  direction TEXT NOT NULL DEFAULT 'expense' CHECK (direction IN ('expense','income')),
  pricing_mode TEXT NOT NULL DEFAULT 'lump_sum' CHECK (pricing_mode IN ('lump_sum','unit_price')),
  unit_price_desc TEXT NOT NULL DEFAULT '',
  estimated_ceiling_cents INTEGER CHECK (estimated_ceiling_cents IS NULL OR estimated_ceiling_cents >= 0),
  currency TEXT NOT NULL DEFAULT '人民币',
  exchange_rate_scaled INTEGER CHECK (exchange_rate_scaled IS NULL OR exchange_rate_scaled > 0),
  report_category TEXT NOT NULL DEFAULT 'other' CHECK (report_category IN ('engineering','goods','service','other')),
  summary_text TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  plan_item_id INTEGER REFERENCES plan_item(id),
  budget_type TEXT NOT NULL DEFAULT 'single_listed' CHECK (budget_type IN ('single_listed','lump_sum_pool','emergency_unplanned')),
  is_emergency INTEGER NOT NULL DEFAULT 0 CHECK (is_emergency IN (0,1)),
  emergency_start_date TEXT,
  funding_source TEXT NOT NULL DEFAULT 'self_owned_other' CHECK (funding_source IN ('fiscal','income_contract','self_owned_other')),
  funding_source_detail TEXT NOT NULL DEFAULT '',
  source_income_contract_id INTEGER REFERENCES ct_contract_v73(id),
  parent_contract_id INTEGER REFERENCES ct_contract_v73(id),
  external_no_exempt INTEGER NOT NULL DEFAULT 0 CHECK (external_no_exempt IN (0,1)),
  counterparty_names TEXT NOT NULL DEFAULT '',
  undertaker_name TEXT NOT NULL DEFAULT '',
  undertaker_dept TEXT NOT NULL DEFAULT '',
  our_signatory_name TEXT NOT NULL DEFAULT '',
  our_signatory_title TEXT NOT NULL DEFAULT '',
  our_signatory_is_legal_rep INTEGER CHECK (our_signatory_is_legal_rep IN (0,1)),
  counterparty_signatory_name TEXT NOT NULL DEFAULT '',
  counterparty_signatory_title TEXT NOT NULL DEFAULT '',
  counterparty_signatory_is_legal_rep INTEGER CHECK (counterparty_signatory_is_legal_rep IN (0,1)),
  entrust_reason TEXT NOT NULL DEFAULT '',
  is_triple_major INTEGER NOT NULL DEFAULT 0 CHECK (is_triple_major IN (0,1)),
  decision_method TEXT CHECK (decision_method IS NULL OR decision_method IN ('meeting','approval','other')),
  decision_method_other TEXT NOT NULL DEFAULT '',
  meeting_type TEXT,
  meeting_type_other TEXT NOT NULL DEFAULT '',
  final_approver_name TEXT NOT NULL DEFAULT '',
  final_approver_title TEXT NOT NULL DEFAULT '',
  is_gov_procurement INTEGER NOT NULL DEFAULT 0 CHECK (is_gov_procurement IN (0,1)),
  procurement_method_other TEXT NOT NULL DEFAULT '',
  procurement_plan_text TEXT NOT NULL DEFAULT '',
  procurement_start_date TEXT,
  supplier_confirm_date TEXT,
  response_docs_complete INTEGER CHECK (response_docs_complete IN (0,1)),
  credit_checked INTEGER CHECK (credit_checked IN (0,1)),
  bid_award_cents INTEGER CHECK (bid_award_cents IS NULL OR bid_award_cents >= 0),
  acquisition_method TEXT CHECK (acquisition_method IS NULL OR acquisition_method IN ('tender','negotiation','other')),
  acquisition_method_other TEXT NOT NULL DEFAULT '',
  tender_body_type TEXT CHECK (tender_body_type IS NULL OR tender_body_type IN ('consortium','single')),
  consortium_members TEXT NOT NULL DEFAULT '',
  dept_reviewer_name TEXT NOT NULL DEFAULT '',
  related_mgmt_depts TEXT NOT NULL DEFAULT '',
  related_mgmt_reviewers TEXT NOT NULL DEFAULT '',
  unit_approver_name TEXT NOT NULL DEFAULT '',
  unit_approver_title TEXT NOT NULL DEFAULT '',
  farmer_wage_account TEXT NOT NULL DEFAULT '',
  term_type TEXT NOT NULL DEFAULT 'unspecified' CHECK (term_type IN ('fixed','conditional','unspecified')),
  term_start_date TEXT,
  term_end_date TEXT,
  term_condition_text TEXT NOT NULL DEFAULT '',
  deliverable_submitted INTEGER CHECK (deliverable_submitted IN (0,1)),
  final_accepted INTEGER NOT NULL DEFAULT 0 CHECK (final_accepted IN (0,1)),
  has_warranty INTEGER NOT NULL DEFAULT 0 CHECK (has_warranty IN (0,1)),
  warranty_months INTEGER CHECK (warranty_months IS NULL OR warranty_months >= 0),
  warranty_retention_ratio_scaled INTEGER CHECK (warranty_retention_ratio_scaled IS NULL OR warranty_retention_ratio_scaled BETWEEN 0 AND 1000000),
  settled_gross_cents INTEGER NOT NULL DEFAULT 0,
  settled_net_cents INTEGER NOT NULL DEFAULT 0,
  received_cents INTEGER NOT NULL DEFAULT 0,
  distribution_status TEXT NOT NULL DEFAULT 'pending' CHECK (distribution_status IN ('pending','completed')),
  distributed_at TEXT,
  company_filed_at TEXT,
  archive_status TEXT NOT NULL DEFAULT 'collecting' CHECK (archive_status IN ('collecting','checked','transferred')),
  archive_checked_at TEXT,
  archive_transferred_at TEXT,
  archive_transfer_no TEXT,
  archive_defer_note TEXT,
  completed_date TEXT,
  out_of_plan_approved_date TEXT,
  procurement_record_id INTEGER REFERENCES ct_procurement_record(id),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','standard_import','legacy_migration')),
  migration_mode TEXT NOT NULL DEFAULT 'normal' CHECK (migration_mode IN ('normal','legacy_tolerant')),
  duplicate_conflict_group TEXT NOT NULL DEFAULT '',
  amount_fact_source TEXT NOT NULL DEFAULT 'confirmed_contract'
    CHECK (amount_fact_source IN ('confirmed_contract','unit_price_open','voucher_debit_clue','unverified_forecast')),
  clue_voucher_debit_cents INTEGER,
  legacy_settled_baseline_cents INTEGER,
  legacy_invoiced_baseline_cents INTEGER,
  legacy_revenue_baseline_cents INTEGER,
  baseline_as_of_date TEXT,
  legacy_prefix_code TEXT NOT NULL DEFAULT '',
  raw_amount_text TEXT NOT NULL DEFAULT '',
  raw_sign_date_text TEXT NOT NULL DEFAULT '',
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  cross_ref_source TEXT NOT NULL DEFAULT '',
  is_reversal INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  synthetic_no_flag INTEGER NOT NULL DEFAULT 0 CHECK (synthetic_no_flag IN (0,1)),
  signing_org_id INTEGER REFERENCES org(id),
  signing_subject_org_id INTEGER REFERENCES org(id),
  legal_entity_org_id INTEGER REFERENCES org(id),
  historical_legal_entity_org_id INTEGER REFERENCES org(id),
  is_internal_group_tx INTEGER NOT NULL DEFAULT 0 CHECK (is_internal_group_tx IN (0,1)),
  internal_group_agreement_key TEXT NOT NULL DEFAULT '',
  counterparty_contract_id INTEGER REFERENCES ct_contract_v73(id),
  co_managed_org_id INTEGER REFERENCES org(id),
  currency_struct_status TEXT NOT NULL DEFAULT 'single'
    CHECK (currency_struct_status IN ('single','structured_multi','partial_unstructured')),
  legacy_raw_no TEXT NOT NULL DEFAULT '',
  no_exempt_reason TEXT NOT NULL DEFAULT '',
  foreign_amount_text TEXT NOT NULL DEFAULT '',
  CHECK (
    (origin != 'legacy_migration' AND migration_mode = 'normal' AND is_reversal = 0
      AND original_cents >= 0 AND settled_gross_cents >= 0 AND settled_net_cents >= 0 AND paid_cents >= 0 AND received_cents >= 0
      AND (pricing_mode = 'unit_price' OR (original_cents + approved_change_cents >= 0 AND paid_cents <= original_cents + approved_change_cents AND received_cents <= original_cents + approved_change_cents))
      AND (pricing_mode <> 'unit_price' OR (estimated_ceiling_cents IS NULL OR (paid_cents <= estimated_ceiling_cents AND received_cents <= estimated_ceiling_cents))))
    OR (origin = 'legacy_migration' AND migration_mode = 'legacy_tolerant' AND (is_reversal = 1 OR original_cents >= 0))
  )
);

INSERT INTO ct_contract_v73 (
  id, contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id,
  original_cents, approved_change_cents, paid_cents, payment_cap_ratio_scaled,
  stage, status, status_reason, sign_date, effective_date, source, import_id, version,
  created_by_user_id, created_at, updated_at,
  legal_category, party_role, signing_entity_level, is_procurement, procurement_target, procurement_method, procurement_tier, is_important,
  direction, pricing_mode, unit_price_desc, estimated_ceiling_cents, currency, exchange_rate_scaled,
  report_category, summary_text, remark, plan_item_id, budget_type, is_emergency, emergency_start_date,
  funding_source, funding_source_detail, source_income_contract_id, parent_contract_id, external_no_exempt,
  counterparty_names, undertaker_name, undertaker_dept,
  our_signatory_name, our_signatory_title, our_signatory_is_legal_rep,
  counterparty_signatory_name, counterparty_signatory_title, counterparty_signatory_is_legal_rep,
  entrust_reason, is_triple_major, decision_method, decision_method_other, meeting_type, meeting_type_other,
  final_approver_name, final_approver_title, is_gov_procurement, procurement_method_other, procurement_plan_text,
  procurement_start_date, supplier_confirm_date, response_docs_complete, credit_checked, bid_award_cents,
  acquisition_method, acquisition_method_other, tender_body_type, consortium_members,
  dept_reviewer_name, related_mgmt_depts, related_mgmt_reviewers, unit_approver_name, unit_approver_title,
  farmer_wage_account, term_type, term_start_date, term_end_date, term_condition_text,
  deliverable_submitted, final_accepted, has_warranty, warranty_months, warranty_retention_ratio_scaled,
  settled_gross_cents, settled_net_cents, received_cents,
  distribution_status, distributed_at, company_filed_at,
  archive_status, archive_checked_at, archive_transferred_at, archive_transfer_no, archive_defer_note,
  completed_date, out_of_plan_approved_date,
  origin, migration_mode, signing_org_id, signing_subject_org_id, legal_entity_org_id
)
SELECT
  id, contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id,
  original_cents, approved_change_cents, paid_cents, payment_cap_ratio_scaled,
  stage, status, status_reason, sign_date, effective_date, source, import_id, version,
  created_by_user_id, created_at, updated_at,
  legal_category, party_role, signing_entity_level, is_procurement, procurement_target, procurement_method, procurement_tier, is_important,
  direction, pricing_mode, unit_price_desc, estimated_ceiling_cents, currency, exchange_rate_scaled,
  report_category, summary_text, remark, plan_item_id, budget_type, is_emergency, emergency_start_date,
  funding_source, funding_source_detail, source_income_contract_id, parent_contract_id, external_no_exempt,
  counterparty_names, undertaker_name, undertaker_dept,
  our_signatory_name, our_signatory_title, our_signatory_is_legal_rep,
  counterparty_signatory_name, counterparty_signatory_title, counterparty_signatory_is_legal_rep,
  entrust_reason, is_triple_major, decision_method, decision_method_other, meeting_type, meeting_type_other,
  final_approver_name, final_approver_title, is_gov_procurement, procurement_method_other, procurement_plan_text,
  procurement_start_date, supplier_confirm_date, response_docs_complete, credit_checked, bid_award_cents,
  acquisition_method, acquisition_method_other, tender_body_type, consortium_members,
  dept_reviewer_name, related_mgmt_depts, related_mgmt_reviewers, unit_approver_name, unit_approver_title,
  farmer_wage_account, term_type, term_start_date, term_end_date, term_condition_text,
  deliverable_submitted, final_accepted, has_warranty, warranty_months, warranty_retention_ratio_scaled,
  settled_gross_cents, settled_net_cents, received_cents,
  distribution_status, distributed_at, company_filed_at,
  archive_status, archive_checked_at, archive_transferred_at, archive_transfer_no, archive_defer_note,
  completed_date, out_of_plan_approved_date,
  CASE WHEN source = 'import' THEN 'standard_import' ELSE 'manual' END,
  'normal',
  org_id,
  org_id,
  org_id
FROM ct_contract;

DROP TRIGGER IF EXISTS trg_ct_risk_insert;
DROP TRIGGER IF EXISTS trg_ct_risk_update;
DROP TRIGGER IF EXISTS trg_ct_risk_delete;
DROP TABLE ct_contract;
ALTER TABLE ct_contract_v73 RENAME TO ct_contract;
CREATE UNIQUE INDEX idx_ct_contract_legal_no ON ct_contract(COALESCE(legal_entity_org_id, org_id), normalized_no);
CREATE INDEX idx_ct_contract_org ON ct_contract(org_id, status);
CREATE INDEX idx_ct_contract_project ON ct_contract(project_id);
CREATE INDEX idx_ct_contract_direction ON ct_contract(direction, org_id, status);
CREATE INDEX idx_ct_contract_source_income ON ct_contract(source_income_contract_id);
CREATE INDEX idx_ct_contract_proc_record ON ct_contract(procurement_record_id);
CREATE INDEX idx_ct_contract_conflict_group ON ct_contract(duplicate_conflict_group) WHERE duplicate_conflict_group <> '';
CREATE INDEX idx_ct_contract_updated ON ct_contract(updated_at, id);
CREATE TRIGGER trg_ct_sync_monotonic AFTER UPDATE ON ct_contract
WHEN NEW.updated_at <= OLD.updated_at OR NEW.updated_at <= (SELECT MAX(updated_at) FROM ct_contract WHERE id <> NEW.id)
BEGIN
  UPDATE ct_contract SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT MAX(updated_at) FROM ct_contract), '+0.001 seconds') WHERE id = NEW.id;
END;
CREATE TRIGGER trg_ct_risk_insert AFTER INSERT ON risk_event WHEN NEW.source = 'contract' AND NEW.subject_type IN ('contract','project')
BEGIN UPDATE ct_contract SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (NEW.subject_type = 'contract' AND id = NEW.subject_id) OR (NEW.subject_type = 'project' AND project_id = NEW.subject_id AND org_id = NEW.org_id); END;
CREATE TRIGGER trg_ct_risk_update AFTER UPDATE ON risk_event WHEN NEW.source = 'contract' AND NEW.subject_type IN ('contract','project')
BEGIN UPDATE ct_contract SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (NEW.subject_type = 'contract' AND id = NEW.subject_id) OR (NEW.subject_type = 'project' AND project_id = NEW.subject_id AND org_id = NEW.org_id); END;
CREATE TRIGGER trg_ct_risk_delete AFTER DELETE ON risk_event WHEN OLD.source = 'contract' AND OLD.subject_type IN ('contract','project')
BEGIN UPDATE ct_contract SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (OLD.subject_type = 'contract' AND id = OLD.subject_id) OR (OLD.subject_type = 'project' AND project_id = OLD.subject_id AND org_id = OLD.org_id); END;

/* 9. 新建复合币种结构化明细表 ct_contract_currency_line 与多源台账溯源表 ct_legacy_source_trace */
CREATE TABLE ct_contract_currency_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  amount_role TEXT NOT NULL DEFAULT 'contract_original'
    CHECK (amount_role IN ('contract_original','settlement_agreed','change_delta')),
  fx_rate_scaled INTEGER,
  fx_rate_date TEXT,
  fx_rate_source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (contract_id, amount_role, line_no)
);
CREATE INDEX idx_ct_currency_line_contract ON ct_contract_currency_line(contract_id);

CREATE TABLE ct_legacy_source_trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  import_id INTEGER REFERENCES ct_import(id),
  source_file TEXT NOT NULL,
  source_file_sha256 TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  pipeline_version TEXT NOT NULL,
  raw_contract_no TEXT NOT NULL DEFAULT '',
  raw_amount_text TEXT NOT NULL DEFAULT '',
  raw_sign_date TEXT NOT NULL DEFAULT '',
  as_of_date TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  conflict_flags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (source_file_sha256, source_sheet, source_row, pipeline_version)
);
CREATE INDEX idx_ct_trace_contract ON ct_legacy_source_trace(contract_id);

/* 10. 重建 ct_document: 补充单价合同工程量/工程价款结算书证据枚举 */
CREATE TABLE ct_document_v73 (
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
  change_id INTEGER REFERENCES ct_change(id)
);
INSERT INTO ct_document_v73 (id, contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at, evidence_kind, change_id)
SELECT id, contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at, evidence_kind, change_id
FROM ct_document;
DROP TABLE ct_document;
ALTER TABLE ct_document_v73 RENAME TO ct_document;
CREATE INDEX idx_ct_document_contract ON ct_document(contract_id, doc_type);
CREATE INDEX idx_ct_document_change ON ct_document(change_id) WHERE change_id IS NOT NULL;
CREATE TRIGGER trg_ct_document_u BEFORE UPDATE ON ct_document BEGIN SELECT RAISE(ABORT, '合同文档不可修改'); END;
CREATE TRIGGER trg_ct_document_d BEFORE DELETE ON ct_document BEGIN SELECT RAISE(ABORT, '合同文档不可删除'); END;

/* 11. 重建 ct_legal_run: 支持受限 .doc 解析通道 doc_converted，保留只追加不可变触发器 */
CREATE TABLE ct_legal_run_v73 (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  document_id INTEGER NOT NULL REFERENCES ct_document(id),
  document_sha256 TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  context_fingerprint TEXT NOT NULL,
  policy_refs_json TEXT NOT NULL,
  template_id INTEGER REFERENCES ct_legal_template(id),
  template_approval_status TEXT,
  job_id INTEGER REFERENCES app_job(id) ON DELETE SET NULL,
  parse_channel TEXT NOT NULL CHECK (parse_channel IN ('docx_native','doc_converted','pdf_external_api','ocr_fallback','failed')),
  parse_status TEXT NOT NULL CHECK (parse_status IN ('ok','degraded','unavailable','failed')),
  model_status TEXT NOT NULL CHECK (model_status IN ('ok','unavailable','invalid','failed','skipped')),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','revise','manual_review')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('high','medium','low','info')),
  summary_json TEXT NOT NULL,
  elements_json TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES app_user(id),
  created_at TEXT NOT NULL
);
INSERT INTO ct_legal_run_v73 (
  id, contract_id, document_id, document_sha256, contract_version, context_fingerprint, policy_refs_json,
  template_id, template_approval_status, job_id, parse_channel, parse_status, model_status, verdict,
  risk_level, summary_json, elements_json, stats_json, created_by_user_id, created_at
)
SELECT
  id, contract_id, document_id, document_sha256, contract_version, context_fingerprint, policy_refs_json,
  template_id, template_approval_status, job_id, parse_channel, parse_status, model_status, verdict,
  risk_level, summary_json, elements_json, stats_json, created_by_user_id, created_at
FROM ct_legal_run;
DROP TABLE ct_legal_run;
ALTER TABLE ct_legal_run_v73 RENAME TO ct_legal_run;
CREATE INDEX idx_ct_legal_run_contract ON ct_legal_run(contract_id, id DESC);
CREATE TRIGGER trg_ct_legal_run_u BEFORE UPDATE ON ct_legal_run BEGIN SELECT RAISE(ABORT,'legal record is immutable'); END;
CREATE TRIGGER trg_ct_legal_run_d BEFORE DELETE ON ct_legal_run BEGIN SELECT RAISE(ABORT,'legal record is immutable'); END;

/* 12. 重建 ct_settlement: 放宽附件 8 注 2 合法负向扣款子项，防绕过拦截常规负净额，受控放行历史负向红冲 */
CREATE TABLE ct_settlement_v73 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  period_no INTEGER NOT NULL CHECK (period_no > 0),
  settlement_kind TEXT NOT NULL DEFAULT 'progress' CHECK (settlement_kind IN ('progress','final')),
  settlement_date TEXT NOT NULL,
  in_contract_cents INTEGER NOT NULL DEFAULT 0,
  change_claim_cents INTEGER NOT NULL DEFAULT 0,
  other_add_cents INTEGER NOT NULL DEFAULT 0,
  gross_payable_cents INTEGER NOT NULL,
  deduct_prepayment_cents INTEGER NOT NULL DEFAULT 0,
  deduct_retention_cents INTEGER NOT NULL DEFAULT 0,
  deduct_penalty_cents INTEGER NOT NULL DEFAULT 0,
  total_deduct_cents INTEGER NOT NULL,
  net_payable_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  evidence_document_id INTEGER REFERENCES ct_document(id),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1)),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','standard_import','legacy_migration')),
  migration_mode TEXT NOT NULL DEFAULT 'normal' CHECK (migration_mode IN ('normal','legacy_tolerant')),
  is_reversal INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  reversal_of_id INTEGER REFERENCES ct_settlement_v73(id),
  reversal_reason TEXT NOT NULL DEFAULT '',
  import_source_ref TEXT NOT NULL DEFAULT '',
  UNIQUE (contract_id, period_no),
  CHECK (
    gross_payable_cents = in_contract_cents + change_claim_cents + other_add_cents
    AND total_deduct_cents = deduct_prepayment_cents + deduct_retention_cents + deduct_penalty_cents
    AND net_payable_cents = gross_payable_cents - total_deduct_cents
    AND (
      (origin != 'legacy_migration' AND migration_mode = 'normal' AND is_reversal = 0
        AND in_contract_cents >= 0 AND other_add_cents >= 0 AND gross_payable_cents >= 0 AND net_payable_cents >= 0)
      OR (origin = 'legacy_migration' AND migration_mode = 'legacy_tolerant' AND is_reversal = 0
        AND in_contract_cents >= 0 AND other_add_cents >= 0 AND gross_payable_cents >= 0 AND net_payable_cents >= 0)
      OR (origin = 'legacy_migration' AND migration_mode = 'legacy_tolerant' AND is_reversal = 1
        AND length(trim(reversal_reason)) > 0 AND length(trim(import_source_ref)) > 0)
    )
  )
);
INSERT INTO ct_settlement_v73 (
  id, contract_id, period_no, settlement_kind, settlement_date,
  in_contract_cents, change_claim_cents, other_add_cents, gross_payable_cents,
  deduct_prepayment_cents, deduct_retention_cents, deduct_penalty_cents, total_deduct_cents, net_payable_cents,
  note, evidence_document_id, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
  review_comment, exception_reason, self_review
)
SELECT
  id, contract_id, period_no, settlement_kind, settlement_date,
  in_contract_cents, change_claim_cents, other_add_cents, gross_payable_cents,
  deduct_prepayment_cents, deduct_retention_cents, deduct_penalty_cents, total_deduct_cents, net_payable_cents,
  note, evidence_document_id, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
  review_comment, exception_reason, self_review
FROM ct_settlement;
DROP TABLE ct_settlement;
ALTER TABLE ct_settlement_v73 RENAME TO ct_settlement;
CREATE INDEX idx_ct_settlement_contract ON ct_settlement(contract_id, status);
CREATE UNIQUE INDEX idx_ct_settlement_final ON ct_settlement(contract_id) WHERE settlement_kind = 'final' AND status IN ('submitted','approved');
CREATE TRIGGER trg_ct_settlement_once BEFORE UPDATE OF status ON ct_settlement WHEN OLD.status <> 'submitted'
BEGIN SELECT RAISE(ABORT, '结算单只能复核一次'); END;
CREATE TRIGGER trg_ct_settlement_d BEFORE DELETE ON ct_settlement BEGIN SELECT RAISE(ABORT, '结算单不可删除'); END;

/* 13. 重建 ct_payment: 保留 feasibility_doc_id，增加历史迁移截点与负向红冲受控保护 */
CREATE TABLE ct_payment_v73 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','import_baseline')),
  settlement_id INTEGER REFERENCES ct_settlement(id),
  payment_type TEXT NOT NULL DEFAULT 'progress' CHECK (payment_type IN ('prepayment','progress','final','warranty_release','other')),
  node_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '人民币',
  amount_cents INTEGER NOT NULL CHECK (
    amount_cents > 0 OR (origin = 'legacy_migration' AND kind = 'import_baseline' AND is_reversal = 1 AND amount_cents <> 0 AND length(trim(reversal_reason)) > 0)
  ),
  planned_date TEXT,
  evidence_document_id INTEGER REFERENCES ct_document(id),
  approval_tier TEXT CHECK (approval_tier IS NULL OR approval_tier IN ('secondary_unit_head','finance_vp','general_manager','collective_decision')),
  approver_name TEXT NOT NULL DEFAULT '',
  approver_title TEXT NOT NULL DEFAULT '',
  approval_doc_id INTEGER REFERENCES ct_document(id),
  feasibility_doc_id INTEGER REFERENCES ct_document(id),
  is_farmer_wage_transfer INTEGER NOT NULL DEFAULT 0 CHECK (is_farmer_wage_transfer IN (0,1)),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','paid')),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1)),
  paid_date TEXT,
  voucher_no TEXT,
  invoice_document_id INTEGER REFERENCES ct_document(id),
  paid_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  paid_at TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','standard_import','legacy_migration')),
  is_reversal INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  reversal_of_id INTEGER REFERENCES ct_payment_v73(id),
  reversal_reason TEXT NOT NULL DEFAULT '',
  as_of_date TEXT,
  import_source_ref TEXT NOT NULL DEFAULT '',
  CHECK (status <> 'paid' OR (paid_date IS NOT NULL AND (kind = 'import_baseline' OR invoice_document_id IS NOT NULL)))
);
INSERT INTO ct_payment_v73 (
  id, contract_id, kind, settlement_id, payment_type, node_name, currency, amount_cents, planned_date,
  evidence_document_id, approval_tier, approver_name, approver_title, approval_doc_id, feasibility_doc_id,
  is_farmer_wage_transfer, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
  review_comment, exception_reason, self_review, paid_date, voucher_no, invoice_document_id, paid_by_user_id, paid_at,
  origin
)
SELECT
  id, contract_id, kind, settlement_id, payment_type, node_name, currency, amount_cents, planned_date,
  evidence_document_id, approval_tier, approver_name, approver_title, approval_doc_id, feasibility_doc_id,
  is_farmer_wage_transfer, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
  review_comment, exception_reason, self_review, paid_date, voucher_no, invoice_document_id, paid_by_user_id, paid_at,
  CASE WHEN kind = 'import_baseline' THEN 'standard_import' ELSE 'manual' END
FROM ct_payment;
DROP TABLE ct_payment;
ALTER TABLE ct_payment_v73 RENAME TO ct_payment;
CREATE INDEX idx_ct_payment_contract ON ct_payment(contract_id, status);
CREATE INDEX idx_ct_payment_paid ON ct_payment(status, paid_date);
CREATE TRIGGER trg_ct_payment_flow BEFORE UPDATE OF status ON ct_payment
WHEN NOT ((OLD.status = 'submitted' AND NEW.status IN ('approved','rejected')) OR (OLD.status = 'approved' AND NEW.status = 'paid'))
BEGIN SELECT RAISE(ABORT, '付款状态只能按 提交→批准/驳回→支付 推进'); END;

/* 14. 重建 ct_receipt: 增加历史迁移截点与负向红冲受控保护 */
CREATE TABLE ct_receipt_v73 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','import_baseline')),
  settlement_id INTEGER REFERENCES ct_settlement(id),
  node_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '人民币',
  amount_cents INTEGER NOT NULL CHECK (
    amount_cents > 0 OR (origin = 'legacy_migration' AND kind = 'import_baseline' AND is_reversal = 1 AND amount_cents <> 0 AND length(trim(reversal_reason)) > 0)
  ),
  planned_date TEXT,
  invoice_document_id INTEGER REFERENCES ct_document(id),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','received')),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1)),
  received_date TEXT,
  voucher_no TEXT,
  received_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  received_at TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','standard_import','legacy_migration')),
  is_reversal INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  reversal_of_id INTEGER REFERENCES ct_receipt_v73(id),
  reversal_reason TEXT NOT NULL DEFAULT '',
  as_of_date TEXT,
  import_source_ref TEXT NOT NULL DEFAULT '',
  CHECK (status <> 'received' OR received_date IS NOT NULL)
);
INSERT INTO ct_receipt_v73 (
  id, contract_id, kind, settlement_id, node_name, currency, amount_cents, planned_date,
  invoice_document_id, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
  review_comment, exception_reason, self_review, received_date, voucher_no, received_by_user_id, received_at,
  origin
)
SELECT
  id, contract_id, kind, settlement_id, node_name, currency, amount_cents, planned_date,
  invoice_document_id, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
  review_comment, exception_reason, self_review, received_date, voucher_no, received_by_user_id, received_at,
  CASE WHEN kind = 'import_baseline' THEN 'standard_import' ELSE 'manual' END
FROM ct_receipt;
DROP TABLE ct_receipt;
ALTER TABLE ct_receipt_v73 RENAME TO ct_receipt;
CREATE INDEX idx_ct_receipt_contract ON ct_receipt(contract_id, status);
CREATE INDEX idx_ct_receipt_received ON ct_receipt(status, received_date);
CREATE TRIGGER trg_ct_receipt_flow BEFORE UPDATE OF status ON ct_receipt
WHEN NOT ((OLD.status = 'submitted' AND NEW.status IN ('approved','rejected')) OR (OLD.status = 'approved' AND NEW.status = 'received'))
BEGIN SELECT RAISE(ABORT, '收款状态只能按 提交→批准/驳回→到账 推进'); END;

/* 15. 重建 ct_change: 仅对历史迁入事实放宽 evidence_document_id 可空，迁入后新发起变更仍强制要求证据附件 */
CREATE TABLE ct_change_v73 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  org_root_id INTEGER REFERENCES org(id),
  change_kind TEXT NOT NULL DEFAULT 'change' CHECK (change_kind IN ('change','claim_by_contractor','counter_claim','suspend','terminate')),
  delta_cents INTEGER NOT NULL DEFAULT 0,
  change_matter TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  evidence_document_id INTEGER REFERENCES ct_document(id),
  involves_biz_or_entity_change INTEGER NOT NULL DEFAULT 0 CHECK (involves_biz_or_entity_change IN (0,1)),
  involves_tech_change INTEGER NOT NULL DEFAULT 0 CHECK (involves_tech_change IN (0,1)),
  is_independent_delegable INTEGER NOT NULL DEFAULT 0 CHECK (is_independent_delegable IN (0,1)),
  decision_method TEXT CHECK (decision_method IS NULL OR decision_method IN ('meeting','approval','other')),
  decision_method_other TEXT NOT NULL DEFAULT '',
  meeting_type TEXT,
  meeting_type_other TEXT NOT NULL DEFAULT '',
  final_approver_name TEXT NOT NULL DEFAULT '',
  final_approver_title TEXT NOT NULL DEFAULT '',
  required_approval_tier TEXT NOT NULL DEFAULT 'undertaker_unit' CHECK (required_approval_tier IN ('undertaker_unit','undertaker_vp','tech_and_undertaker_vp','dual_vp','general_manager','management_board')),
  actual_approval_tier TEXT CHECK (actual_approval_tier IS NULL OR actual_approval_tier IN ('undertaker_unit','undertaker_vp','tech_and_undertaker_vp','dual_vp','general_manager','management_board')),
  supplement_no TEXT,
  normalized_supplement_no TEXT,
  has_dispute INTEGER NOT NULL DEFAULT 0 CHECK (has_dispute IN (0,1)),
  tech_review_applied_at TEXT,
  tech_review_replied_at TEXT,
  tech_special_audit_doc_id INTEGER REFERENCES ct_document(id),
  out_of_plan_doc_id INTEGER REFERENCES ct_document(id),
  guarantor_consent_doc_id INTEGER REFERENCES ct_document(id),
  discipline_filed_at TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1)),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','standard_import','legacy_migration')),
  CHECK (origin = 'legacy_migration' OR evidence_document_id IS NOT NULL)
);
INSERT INTO ct_change_v73 (
  id, contract_id, org_root_id, change_kind, delta_cents, change_matter, reason, evidence_document_id,
  involves_biz_or_entity_change, involves_tech_change, is_independent_delegable,
  decision_method, decision_method_other, meeting_type, meeting_type_other, final_approver_name, final_approver_title,
  required_approval_tier, actual_approval_tier, supplement_no, normalized_supplement_no, has_dispute,
  tech_review_applied_at, tech_review_replied_at, tech_special_audit_doc_id, out_of_plan_doc_id, guarantor_consent_doc_id,
  discipline_filed_at, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
  review_comment, exception_reason, self_review
)
SELECT
  id, contract_id, org_root_id, change_kind, delta_cents, change_matter, reason, evidence_document_id,
  involves_biz_or_entity_change, involves_tech_change, is_independent_delegable,
  decision_method, decision_method_other, meeting_type, meeting_type_other, final_approver_name, final_approver_title,
  required_approval_tier, actual_approval_tier, supplement_no, normalized_supplement_no, has_dispute,
  tech_review_applied_at, tech_review_replied_at, tech_special_audit_doc_id, out_of_plan_doc_id, guarantor_consent_doc_id,
  discipline_filed_at, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
  review_comment, exception_reason, self_review
FROM ct_change;
DROP TABLE ct_change;
ALTER TABLE ct_change_v73 RENAME TO ct_change;
CREATE INDEX idx_ct_change_contract ON ct_change(contract_id, status);
CREATE UNIQUE INDEX idx_ct_change_supp_no ON ct_change(org_root_id, normalized_supplement_no) WHERE normalized_supplement_no IS NOT NULL;
CREATE TRIGGER trg_ct_change_once BEFORE UPDATE OF status ON ct_change WHEN OLD.status <> 'submitted'
BEGIN SELECT RAISE(ABORT, '合同变更只能复核一次'); END;
`;
