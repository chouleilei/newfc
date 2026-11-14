/**
 * T-10 ～ T-12 合同全生命周期与监督报送迁移 (V68 ～ V70)。
 * V68 使用 Migration.rebuild = true 在 PRAGMA foreign_keys = OFF + 单事务内执行整表原子重建与外键核验。
 */

export const CONTRACT_LIFECYCLE_V68_SQL = `
/* 1. 重建 ct_contract: 扩展 8 阶段状态机、suspended 状态、单价合同/多币种、立项与以收定支、相对方与签署授权、决策采购时间链、正交分发与归档状态 */
CREATE TABLE ct_contract_v68 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no TEXT NOT NULL,
  normalized_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contract_type TEXT NOT NULL DEFAULT '',
  org_id INTEGER NOT NULL REFERENCES org(id),
  project_id INTEGER REFERENCES md_project(id),
  supplier_id INTEGER REFERENCES md_supplier(id),
  original_cents INTEGER NOT NULL DEFAULT 0 CHECK (original_cents >= 0),
  approved_change_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
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
  source_income_contract_id INTEGER REFERENCES ct_contract_v68(id),
  parent_contract_id INTEGER REFERENCES ct_contract_v68(id),
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
  settled_gross_cents INTEGER NOT NULL DEFAULT 0 CHECK (settled_gross_cents >= 0),
  settled_net_cents INTEGER NOT NULL DEFAULT 0 CHECK (settled_net_cents >= 0),
  received_cents INTEGER NOT NULL DEFAULT 0 CHECK (received_cents >= 0),
  distribution_status TEXT NOT NULL DEFAULT 'pending' CHECK (distribution_status IN ('pending','completed')),
  distributed_at TEXT,
  company_filed_at TEXT,
  archive_status TEXT NOT NULL DEFAULT 'collecting' CHECK (archive_status IN ('collecting','checked','transferred')),
  archive_checked_at TEXT,
  archive_transferred_at TEXT,
  archive_transfer_no TEXT,
  archive_defer_note TEXT,
  CHECK (original_cents >= 0 AND settled_gross_cents >= 0 AND settled_net_cents >= 0 AND paid_cents >= 0 AND received_cents >= 0),
  CHECK (pricing_mode = 'unit_price' OR (original_cents + approved_change_cents >= 0 AND paid_cents <= original_cents + approved_change_cents AND received_cents <= original_cents + approved_change_cents)),
  CHECK (pricing_mode <> 'unit_price' OR (estimated_ceiling_cents IS NULL OR (paid_cents <= estimated_ceiling_cents AND received_cents <= estimated_ceiling_cents)))
);

INSERT INTO ct_contract_v68 (
  id, contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id,
  original_cents, approved_change_cents, paid_cents, payment_cap_ratio_scaled,
  stage, status, status_reason, sign_date, effective_date, source, import_id, version,
  created_by_user_id, created_at, updated_at,
  legal_category, party_role, signing_entity_level, is_procurement, procurement_target, procurement_method, procurement_tier, is_important,
  report_category, final_accepted, archive_status, archive_checked_at, archive_transferred_at
)
SELECT
  id, contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id,
  original_cents, approved_change_cents, paid_cents, payment_cap_ratio_scaled,
  CASE WHEN stage = 'archived' THEN 'closed' ELSE stage END,
  CASE WHEN stage = 'archived' AND status = 'active' THEN 'closed' ELSE status END,
  status_reason, sign_date, effective_date, source, import_id, version,
  created_by_user_id, created_at, updated_at,
  legal_category, party_role, signing_entity_level, is_procurement, procurement_target, procurement_method, procurement_tier, is_important,
  CASE
    WHEN procurement_target = 'construction' OR legal_category IN ('small_construction','construction') THEN 'engineering'
    WHEN procurement_target = 'goods' OR legal_category = 'goods_procurement' THEN 'goods'
    WHEN procurement_target = 'service' OR legal_category IN ('tech_service','general_service') THEN 'service'
    ELSE 'other'
  END,
  CASE WHEN stage = 'archived' THEN 1 ELSE 0 END,
  CASE WHEN stage = 'archived' THEN 'transferred' ELSE 'collecting' END,
  CASE WHEN stage = 'archived' THEN updated_at ELSE NULL END,
  CASE WHEN stage = 'archived' THEN updated_at ELSE NULL END
FROM ct_contract;

DROP TABLE ct_contract;
ALTER TABLE ct_contract_v68 RENAME TO ct_contract;
CREATE INDEX idx_ct_contract_org ON ct_contract(org_id, status);
CREATE INDEX idx_ct_contract_project ON ct_contract(project_id);
CREATE INDEX idx_ct_contract_direction ON ct_contract(direction, org_id, status);
CREATE INDEX idx_ct_contract_source_income ON ct_contract(source_income_contract_id);

/* 2. 重建 ct_document: 扩展 doc_type 与 evidence_kind 枚举，新增 change_id 绑定列，保留只追加不可变触发器 */
CREATE TABLE ct_document_v68 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('procurement','contract_text','signed','performance','acceptance','invoice','change','settlement','authorization','qualification','guarantee','dispute','other')),
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  name TEXT NOT NULL,
  uploaded_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL,
  evidence_kind TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN (
    'procurement_scheme_approval','bid_award_approval','award_notice','evaluation_report','company_approval','client_written_offer','legal_opinion','triple_major_decision','tech_spec','safety_protocol',
    'supplier_qualification','our_signatory_auth','counterparty_signatory_auth','change_decision','change_agreement','guarantor_consent','termination_agreement','warranty_release_visa','payment_approval_form','out_of_plan_approval','other'
  )),
  change_id INTEGER REFERENCES ct_change(id)
);

INSERT INTO ct_document_v68 (id, contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at, evidence_kind, change_id)
SELECT id, contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at, evidence_kind, NULL
FROM ct_document;

DROP TABLE ct_document;
ALTER TABLE ct_document_v68 RENAME TO ct_document;
CREATE INDEX idx_ct_document_contract ON ct_document(contract_id, doc_type);
CREATE INDEX idx_ct_document_change ON ct_document(change_id) WHERE change_id IS NOT NULL;
CREATE TRIGGER trg_ct_document_u BEFORE UPDATE ON ct_document BEGIN SELECT RAISE(ABORT, '合同文档不可修改'); END;
CREATE TRIGGER trg_ct_document_d BEFORE DELETE ON ct_document BEGIN SELECT RAISE(ABORT, '合同文档不可删除'); END;

/* 3. 新建 ct_undertaker_handover: 承办人动态交接只追加表 */
CREATE TABLE ct_undertaker_handover (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  from_undertaker TEXT NOT NULL DEFAULT '',
  to_undertaker TEXT NOT NULL,
  to_dept TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  left_post_date TEXT,
  handover_date TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ct_handover_contract ON ct_undertaker_handover(contract_id, id);
CREATE TRIGGER trg_ct_handover_u BEFORE UPDATE ON ct_undertaker_handover BEGIN SELECT RAISE(ABORT, '承办人交接记录只追加'); END;
CREATE TRIGGER trg_ct_handover_d BEFORE DELETE ON ct_undertaker_handover BEGIN SELECT RAISE(ABORT, '承办人交接记录只追加'); END;

/* 4. 新建 ct_settlement: 进度/竣工结算单表（对齐合同管理办法附件 8 三栏勾稽） */
CREATE TABLE ct_settlement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  period_no INTEGER NOT NULL CHECK (period_no > 0),
  settlement_kind TEXT NOT NULL DEFAULT 'progress' CHECK (settlement_kind IN ('progress','final')),
  settlement_date TEXT NOT NULL,
  in_contract_cents INTEGER NOT NULL DEFAULT 0 CHECK (in_contract_cents >= 0),
  change_claim_cents INTEGER NOT NULL DEFAULT 0,
  other_add_cents INTEGER NOT NULL DEFAULT 0 CHECK (other_add_cents >= 0),
  gross_payable_cents INTEGER NOT NULL CHECK (gross_payable_cents >= 0),
  deduct_prepayment_cents INTEGER NOT NULL DEFAULT 0 CHECK (deduct_prepayment_cents >= 0),
  deduct_retention_cents INTEGER NOT NULL DEFAULT 0 CHECK (deduct_retention_cents >= 0),
  deduct_penalty_cents INTEGER NOT NULL DEFAULT 0 CHECK (deduct_penalty_cents >= 0),
  total_deduct_cents INTEGER NOT NULL CHECK (total_deduct_cents >= 0),
  net_payable_cents INTEGER NOT NULL CHECK (net_payable_cents >= 0),
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
  UNIQUE (contract_id, period_no),
  CHECK (
    gross_payable_cents = in_contract_cents + change_claim_cents + other_add_cents
    AND total_deduct_cents = deduct_prepayment_cents + deduct_retention_cents + deduct_penalty_cents
    AND net_payable_cents = gross_payable_cents - total_deduct_cents
  )
);
CREATE INDEX idx_ct_settlement_contract ON ct_settlement(contract_id, status);
CREATE UNIQUE INDEX idx_ct_settlement_final ON ct_settlement(contract_id) WHERE settlement_kind = 'final' AND status IN ('submitted','approved');
CREATE TRIGGER trg_ct_settlement_once BEFORE UPDATE OF status ON ct_settlement WHEN OLD.status <> 'submitted'
BEGIN SELECT RAISE(ABORT, '结算单只能复核一次'); END;
CREATE TRIGGER trg_ct_settlement_d BEFORE DELETE ON ct_settlement BEGIN SELECT RAISE(ABORT, '结算单不可删除'); END;

/* 5. 重建 ct_payment: 新增结算单绑定、付款类型、币种、50万/500万分级审批人与附件、农民工专户标记 */
CREATE TABLE ct_payment_v68 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','import_baseline')),
  settlement_id INTEGER REFERENCES ct_settlement(id),
  payment_type TEXT NOT NULL DEFAULT 'progress' CHECK (payment_type IN ('prepayment','progress','final','warranty_release','other')),
  node_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '人民币',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  planned_date TEXT,
  evidence_document_id INTEGER REFERENCES ct_document(id),
  approval_tier TEXT CHECK (approval_tier IS NULL OR approval_tier IN ('secondary_unit_head','finance_vp','general_manager','collective_decision')),
  approver_name TEXT NOT NULL DEFAULT '',
  approver_title TEXT NOT NULL DEFAULT '',
  approval_doc_id INTEGER REFERENCES ct_document(id),
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
  CHECK (status <> 'paid' OR (paid_date IS NOT NULL AND (kind = 'import_baseline' OR invoice_document_id IS NOT NULL)))
);

INSERT INTO ct_payment_v68 (
  id, contract_id, kind, node_name, amount_cents, planned_date, evidence_document_id,
  status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, review_comment,
  exception_reason, self_review, paid_date, voucher_no, invoice_document_id, paid_by_user_id, paid_at
)
SELECT
  id, contract_id, kind, node_name, amount_cents, planned_date, evidence_document_id,
  status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, review_comment,
  exception_reason, self_review, paid_date, voucher_no, invoice_document_id, paid_by_user_id, paid_at
FROM ct_payment;

DROP TABLE ct_payment;
ALTER TABLE ct_payment_v68 RENAME TO ct_payment;
CREATE INDEX idx_ct_payment_contract ON ct_payment(contract_id, status);
CREATE INDEX idx_ct_payment_paid ON ct_payment(status, paid_date);
CREATE TRIGGER trg_ct_payment_flow BEFORE UPDATE OF status ON ct_payment
WHEN NOT ((OLD.status = 'submitted' AND NEW.status IN ('approved','rejected')) OR (OLD.status = 'approved' AND NEW.status = 'paid'))
BEGIN SELECT RAISE(ABORT, '付款状态只能按 提交→批准/驳回→支付 推进'); END;

/* 6. 新建 ct_receipt: 收入合同正向收款表 */
CREATE TABLE ct_receipt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','import_baseline')),
  settlement_id INTEGER REFERENCES ct_settlement(id),
  node_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '人民币',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
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
  CHECK (status <> 'received' OR received_date IS NOT NULL)
);
CREATE INDEX idx_ct_receipt_contract ON ct_receipt(contract_id, status);
CREATE INDEX idx_ct_receipt_received ON ct_receipt(status, received_date);
CREATE TRIGGER trg_ct_receipt_flow BEFORE UPDATE OF status ON ct_receipt
WHEN NOT ((OLD.status = 'submitted' AND NEW.status IN ('approved','rejected')) OR (OLD.status = 'approved' AND NEW.status = 'received'))
BEGIN SELECT RAISE(ABORT, '收款状态只能按 提交→批准/驳回→到账 推进'); END;
`;

export const CONTRACT_LIFECYCLE_V69_SQL = `
/* 1. 重建 ct_change: 去掉 delta_cents <> 0 限制、支持四位一体变更/索赔/中止/解除、附件5定级、法人单位内唯一补充协议号 */
CREATE TABLE ct_change_v69 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  org_root_id INTEGER REFERENCES org(id),
  change_kind TEXT NOT NULL DEFAULT 'change' CHECK (change_kind IN ('change','claim_by_contractor','counter_claim','suspend','terminate')),
  delta_cents INTEGER NOT NULL DEFAULT 0,
  change_matter TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  evidence_document_id INTEGER NOT NULL REFERENCES ct_document(id),
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
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1))
);

INSERT INTO ct_change_v69 (
  id, contract_id, org_root_id, change_kind, delta_cents, change_matter, reason, evidence_document_id,
  status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, review_comment, exception_reason, self_review
)
SELECT
  ch.id, ch.contract_id, (SELECT c.org_id FROM ct_contract c WHERE c.id = ch.contract_id), 'change', ch.delta_cents, '', ch.reason, ch.evidence_document_id,
  ch.status, ch.submitted_by_user_id, ch.submitted_at, ch.reviewed_by_user_id, ch.reviewed_at, ch.review_comment, ch.exception_reason, ch.self_review
FROM ct_change ch;

DROP TABLE ct_change;
ALTER TABLE ct_change_v69 RENAME TO ct_change;
CREATE INDEX idx_ct_change_contract ON ct_change(contract_id, status);
CREATE UNIQUE INDEX idx_ct_change_supp_no ON ct_change(org_root_id, normalized_supplement_no) WHERE normalized_supplement_no IS NOT NULL;
CREATE TRIGGER trg_ct_change_once BEFORE UPDATE OF status ON ct_change WHEN OLD.status <> 'submitted'
BEGIN SELECT RAISE(ABORT, '合同变更只能复核一次'); END;

/* 2. 新建 ct_guarantee: 保函/保证金/工程保险台账 */
CREATE TABLE ct_guarantee (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  guarantee_type TEXT NOT NULL CHECK (guarantee_type IN ('bid_bond','prepayment_guarantee','performance_guarantee','warranty_guarantee','engineering_insurance')),
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  issuer_name TEXT NOT NULL DEFAULT '',
  guarantee_no TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  deposit_cents INTEGER NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  ratio_scaled INTEGER CHECK (ratio_scaled IS NULL OR ratio_scaled BETWEEN 0 AND 1000000),
  effective_date TEXT,
  expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','claimed','returned')),
  claim_occurred_at TEXT,
  claim_reported_at TEXT,
  returned_date TEXT,
  document_id INTEGER REFERENCES ct_document(id),
  note TEXT NOT NULL DEFAULT '',
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ct_guarantee_contract ON ct_guarantee(contract_id, status);
CREATE INDEX idx_ct_guarantee_expiry ON ct_guarantee(status, expiry_date);

/* 3. 新建 ct_warranty: 质保期记录与期满签证表 */
CREATE TABLE ct_warranty (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL UNIQUE REFERENCES ct_contract(id),
  start_date TEXT,
  end_date TEXT,
  retention_cents INTEGER NOT NULL DEFAULT 0 CHECK (retention_cents >= 0),
  defect_records_json TEXT NOT NULL DEFAULT '[]',
  inspection_date TEXT,
  inspection_conclusion TEXT CHECK (inspection_conclusion IS NULL OR inspection_conclusion IN ('passed','rectifying')),
  visa_document_id INTEGER REFERENCES ct_document(id),
  released_payment_id INTEGER REFERENCES ct_payment(id),
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

/* 4. 新建 ct_dispute: 纠纷与诉讼仲裁 17 列台账表 */
CREATE TABLE ct_dispute (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  change_id INTEGER REFERENCES ct_change(id),
  occurred_date TEXT NOT NULL,
  reported_to_dept_at TEXT,
  litigation_type TEXT NOT NULL DEFAULT '',
  cause_of_action TEXT NOT NULL DEFAULT '',
  counterparty_and_role TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'negotiation' CHECK (stage IN ('negotiation','mediation','arbitration','litigation_1st','litigation_2nd','execution','closed')),
  institution_name TEXT NOT NULL DEFAULT '',
  case_no TEXT NOT NULL DEFAULT '',
  involved_org_name TEXT NOT NULL DEFAULT '',
  our_litigation_role TEXT NOT NULL DEFAULT '',
  accepted_date TEXT,
  case_summary TEXT NOT NULL DEFAULT '',
  gm_approved_at TEXT,
  legal_doc_form TEXT NOT NULL DEFAULT '',
  closed_date TEXT,
  dispute_cents INTEGER NOT NULL DEFAULT 0 CHECK (dispute_cents >= 0),
  judgment_result TEXT NOT NULL DEFAULT '',
  actual_settled_cents INTEGER CHECK (actual_settled_cents IS NULL OR actual_settled_cents >= 0),
  law_firm_and_lawyer TEXT NOT NULL DEFAULT '',
  filed_to_mgmt_at TEXT,
  filed_to_discipline_at TEXT,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ct_dispute_contract ON ct_dispute(contract_id, stage);
`;

export const CONTRACT_LIFECYCLE_V70_SQL = `
/* 1. 扩展 org 报送层级全称 & ct_import 多表类型 */
ALTER TABLE org ADD COLUMN report_full_name TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_import ADD COLUMN import_kind TEXT NOT NULL DEFAULT 'standard_ledger' CHECK (import_kind IN (
  'standard_ledger','monthly_ledger_wan','supervision_expense_base','supervision_expense_exec','supervision_expense_change',
  'supervision_income_base','supervision_income_exec','supervision_income_change'
));

/* 2. 新建 ct_evaluation: 履约后评价表(联动供应商库) */
CREATE TABLE ct_evaluation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL UNIQUE REFERENCES ct_contract(id),
  supplier_id INTEGER REFERENCES md_supplier(id),
  quality_score INTEGER NOT NULL CHECK (quality_score BETWEEN 1 AND 5),
  schedule_score INTEGER NOT NULL CHECK (schedule_score BETWEEN 1 AND 5),
  service_score INTEGER NOT NULL CHECK (service_score BETWEEN 1 AND 5),
  total_score INTEGER NOT NULL CHECK (total_score BETWEEN 3 AND 15),
  recommendation TEXT NOT NULL CHECK (recommendation IN ('preferred','normal','restricted','blacklisted')),
  comment TEXT NOT NULL DEFAULT '',
  evaluated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX idx_ct_evaluation_supplier ON ct_evaluation(supplier_id);

/* 3. 新建 ct_supervision_export_log: 报送导出审计表 */
CREATE TABLE ct_supervision_export_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  export_kind TEXT NOT NULL CHECK (export_kind IN ('monthly_ledger','supervision_package')),
  org_id INTEGER REFERENCES org(id),
  period TEXT NOT NULL DEFAULT '',
  scope_mode TEXT NOT NULL DEFAULT 'all',
  contract_count INTEGER NOT NULL DEFAULT 0,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ct_sup_export_log_created ON ct_supervision_export_log(created_at DESC);

/* 4. 重建 std_report: 注册 contract_monthly_pack 月度 5 表冻结快照类型 */
CREATE TABLE std_report_v70 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL CHECK (report_type IN ('budget_execution','statement_summary','eas_recon','contract_payment_ledger','risk_rectification_ledger','contract_monthly_pack')),
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
INSERT INTO std_report_v70 (id, report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, status,
    generated_by_user_id, generated_at, reviewed_by_user_id, reviewed_at, review_comment, exception_reason, self_review)
  SELECT id, report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, status,
    generated_by_user_id, generated_at, reviewed_by_user_id, reviewed_at, review_comment, exception_reason, self_review FROM std_report;
DROP TABLE std_report;
ALTER TABLE std_report_v70 RENAME TO std_report;
CREATE INDEX idx_std_report_type ON std_report(report_type, period);
CREATE INDEX idx_std_report_org ON std_report(org_id);
CREATE TRIGGER trg_std_report_frozen_u BEFORE UPDATE OF report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json,
  sources_json, content_sha256, generated_by_user_id, generated_at ON std_report
BEGIN SELECT RAISE(ABORT, '标准报表冻结内容不可修改'); END;
CREATE TRIGGER trg_std_report_review_once BEFORE UPDATE OF status ON std_report
WHEN NOT (OLD.status = 'generated' AND NEW.status = 'reviewed')
BEGIN SELECT RAISE(ABORT, '标准报表只能复核一次'); END;
CREATE TRIGGER trg_std_report_d BEFORE DELETE ON std_report BEGIN SELECT RAISE(ABORT, '标准报表不可删除'); END;

/* 5. 预置 10 条合同全生命周期量化预警规则 */
INSERT OR IGNORE INTO risk_rule (code, name, source, detector, builtin, level, threshold, suggestion) VALUES
  ('CONTRACT_SIGN_BEFORE_PROCUREMENT', '采购日期倒置或未批先签', 'contract', 'CONTRACT_SIGN_BEFORE_PROCUREMENT', 1, 'high', NULL, '核对开始采购、供应商确定与签署日期顺序，补齐前置招采及批准依据。'),
  ('CONTRACT_PERFORM_BEFORE_EFFECTIVE', '未签先履约或早于生效日付款', 'contract', 'CONTRACT_PERFORM_BEFORE_EFFECTIVE', 1, 'high', NULL, '核查履约开始日期及收付款日期与合同签署/生效日先后，非应急项目严禁未生效先履行。'),
  ('CONTRACT_EMERGENCY_OVERDUE', '应急项目逾期未补立项或未完成签约', 'contract', 'CONTRACT_EMERGENCY_OVERDUE', 1, 'high', NULL, '应急项目须在开工后 5 个工作日补办计划立项、15 个工作日内完成正式合同审批签署。'),
  ('CONTRACT_DISTRIBUTION_OVERDUE', '签署超 10 工作日未分发或未报公司备案', 'contract', 'CONTRACT_DISTRIBUTION_OVERDUE', 1, 'medium', NULL, '请于合同签署后 10 个工作日内上传盖章扫描件完成分发，分/子公司进项合同同步报企管部与结算中心备案。'),
  ('CONTRACT_UNDERTAKER_UNASSIGNED', '在途合同缺承办人或调离超 15 工作日未交接', 'contract', 'CONTRACT_UNDERTAKER_UNASSIGNED', 1, 'medium', NULL, '明确当前合同承办人；承办人调离岗位须在 15 个工作日内完成交接登记（制度 4.10.4）。'),
  ('CONTRACT_CHANGE_TIER_MISMATCH', '变更越权审批、缺补充协议或未备案超时', 'contract', 'CONTRACT_CHANGE_TIER_MISMATCH', 1, 'high', NULL, '按制度附件 5 补齐对应层级审批、法人内唯一补充协议编号、纪审部备案及 10 日技术审查反馈。'),
  ('CONTRACT_SPLIT_EVADE_TENDER', '疑似拆分合同规避采购层级或公开招标', 'contract', 'CONTRACT_SPLIT_EVADE_TENDER', 1, 'high', NULL, '核查同年度同项目同相对方同类采购拆分合并金额，按合并层级补办合规采购程序。'),
  ('CONTRACT_OVER_SETTLE_OR_PAY', '超结算超额支付、漏扣款或施工缺专户', 'contract', 'CONTRACT_OVER_SETTLE_OR_PAY', 1, 'high', NULL, '核对累计净结算、累计实付、预付款扣回及施工合同农民工工资专户登记。'),
  ('CONTRACT_LONG_UNSETTLED', '合同到期超 180 天未完成最终结算', 'contract', 'CONTRACT_LONG_UNSETTLED', 1, 'medium', NULL, '督促推进最终验收与竣工结算单编制复核，清理长期未结在途合同。'),
  ('CONTRACT_GUARANTEE_WARRANTY_DUE', '保函临期/索赔未报、质保超期或纠纷未双备案', 'contract', 'CONTRACT_GUARANTEE_WARRANTY_DUE', 1, 'medium', NULL, '及时办理保函续期/退还或 2 日内索赔书面报告、质保期满验收签证及结案纠纷企管/纪审双备案。');
`;

export const CONTRACT_LIFECYCLE_V71_SQL = `
/* V71: 扩展 ma_metric.calculator 枚举以支持收入合同实收与收款比例计算器 */
CREATE TABLE ma_metric_v71 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('money','ratio')),
  calculator TEXT NOT NULL CHECK (calculator IN ('budget_amount','actual_amount','execution_rate','eas_balance','statement_item','allocated_cost',
    'contract_paid','contract_payment_rate','contract_received','contract_receipt_rate','plan_execution_rate','risk_open_amount','investment_deviation_rate')),
  params_json TEXT NOT NULL DEFAULT '{}',
  thresholds_json TEXT NOT NULL DEFAULT '{}',
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO ma_metric_v71 (id, code, name, unit, calculator, params_json, thresholds_json, builtin, status, version, created_by_user_id, created_at, updated_at)
  SELECT id, code, name, unit, calculator, params_json, thresholds_json, builtin, status, version, created_by_user_id, created_at, updated_at FROM ma_metric;
DROP TABLE ma_metric;
ALTER TABLE ma_metric_v71 RENAME TO ma_metric;
`;

/** V72 仅追加：复核修复，不修改 V68～V71 的已登记迁移。 */
export const CONTRACT_LIFECYCLE_V72_SQL = `
CREATE TABLE ct_document_v72 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('procurement','contract_text','signed','performance','acceptance','invoice','change','settlement','authorization','qualification','guarantee','dispute','other')),
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  name TEXT NOT NULL,
  uploaded_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL,
  evidence_kind TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN (
    'procurement_scheme_approval','bid_award_approval','award_notice','evaluation_report','company_approval','client_written_offer','legal_opinion','triple_major_decision','tech_spec','safety_protocol',
    'supplier_qualification','our_signatory_auth','counterparty_signatory_auth','change_decision','change_agreement','guarantor_consent','termination_agreement','warranty_release_visa','payment_approval_form','out_of_plan_approval','tech_special_audit','funding_feasibility','other'
  )),
  change_id INTEGER REFERENCES ct_change(id)
);

INSERT INTO ct_document_v72 (id, contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at, evidence_kind, change_id)
SELECT id, contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at, evidence_kind, change_id
FROM ct_document;

DROP TABLE ct_document;
ALTER TABLE ct_document_v72 RENAME TO ct_document;
CREATE INDEX idx_ct_document_contract ON ct_document(contract_id, doc_type);
CREATE INDEX idx_ct_document_change ON ct_document(change_id) WHERE change_id IS NOT NULL;
CREATE TRIGGER trg_ct_document_u BEFORE UPDATE ON ct_document BEGIN SELECT RAISE(ABORT, '合同文档不可修改'); END;
CREATE TRIGGER trg_ct_document_d BEFORE DELETE ON ct_document BEGIN SELECT RAISE(ABORT, '合同文档不可删除'); END;


/* 历史污染不能靠汇率猜测修复；发现错币种必须先人工核对，整棒迁移回滚。 */
CREATE TEMP TABLE ct_currency_guard (invalid INTEGER);
CREATE TEMP TRIGGER ct_currency_guard_fail BEFORE INSERT ON ct_currency_guard WHEN NEW.invalid = 1
BEGIN SELECT RAISE(ABORT, '合同收付款流水与主合同币种不一致，请先核对历史记录后重试迁移'); END;
INSERT INTO ct_currency_guard SELECT EXISTS(
 SELECT 1 FROM ct_payment p JOIN ct_contract c ON c.id = p.contract_id WHERE p.currency <> c.currency
 UNION ALL SELECT 1 FROM ct_receipt r JOIN ct_contract c ON c.id = r.contract_id WHERE r.currency <> c.currency
);
DROP TABLE ct_currency_guard;

ALTER TABLE ct_contract ADD COLUMN completed_date TEXT;
ALTER TABLE ct_contract ADD COLUMN out_of_plan_approved_date TEXT;
UPDATE ct_contract SET completed_date = COALESCE(
  (SELECT substr(MAX(created_at), 1, 10) FROM ct_event WHERE contract_id = ct_contract.id AND event_type IN ('archive','terminate')),
  substr(updated_at, 1, 10)) WHERE status IN ('closed','terminated');
ALTER TABLE ct_payment ADD COLUMN feasibility_doc_id INTEGER REFERENCES ct_document(id);

CREATE TABLE md_supplier_evaluation (
  contract_id INTEGER PRIMARY KEY REFERENCES ct_contract(id),
  supplier_id INTEGER NOT NULL REFERENCES md_supplier(id),
  quality_score INTEGER NOT NULL, schedule_score INTEGER NOT NULL, service_score INTEGER NOT NULL,
  recommendation TEXT NOT NULL, comment TEXT NOT NULL, evaluated_at TEXT NOT NULL
);
INSERT INTO md_supplier_evaluation SELECT contract_id, supplier_id, quality_score, schedule_score, service_score, recommendation, comment, evaluated_at
FROM ct_evaluation WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_supplier_evaluation ON md_supplier_evaluation(supplier_id);

/* 归属从严回填至祖先法人；历史跨部门重号将由唯一索引阻断迁移，禁止静默重编号。 */
UPDATE ct_change SET org_root_id = (
 WITH RECURSIVE ancestors(id, parent_id) AS (
   SELECT o.id, o.parent_id FROM org o JOIN ct_contract c ON c.org_id = o.id WHERE c.id = ct_change.contract_id
   UNION ALL SELECT o.id, o.parent_id FROM org o JOIN ancestors a ON o.id = a.parent_id
 ) SELECT id FROM ancestors WHERE parent_id IS NULL
);

CREATE INDEX idx_ct_contract_updated ON ct_contract(updated_at, id);
CREATE TRIGGER trg_ct_sync_monotonic AFTER UPDATE ON ct_contract
WHEN NEW.updated_at <= OLD.updated_at OR NEW.updated_at <= (SELECT MAX(updated_at) FROM ct_contract WHERE id <> NEW.id)
BEGIN
 UPDATE ct_contract SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT MAX(updated_at) FROM ct_contract), '+0.001 seconds') WHERE id = NEW.id;
END;

/* 风险扫描/处置也必须推进门户同步版本，闭环后不能继续保留旧风险数。 */
CREATE TRIGGER trg_ct_risk_insert AFTER INSERT ON risk_event WHEN NEW.source = 'contract' AND NEW.subject_type IN ('contract','project')
BEGIN UPDATE ct_contract SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (NEW.subject_type = 'contract' AND id = NEW.subject_id) OR (NEW.subject_type = 'project' AND project_id = NEW.subject_id AND org_id = NEW.org_id); END;
CREATE TRIGGER trg_ct_risk_update AFTER UPDATE ON risk_event WHEN NEW.source = 'contract' AND NEW.subject_type IN ('contract','project')
BEGIN UPDATE ct_contract SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (NEW.subject_type = 'contract' AND id = NEW.subject_id) OR (NEW.subject_type = 'project' AND project_id = NEW.subject_id AND org_id = NEW.org_id); END;
CREATE TRIGGER trg_ct_risk_delete AFTER DELETE ON risk_event WHEN OLD.source = 'contract' AND OLD.subject_type IN ('contract','project')
BEGIN UPDATE ct_contract SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (OLD.subject_type = 'contract' AND id = OLD.subject_id) OR (OLD.subject_type = 'project' AND project_id = OLD.subject_id AND org_id = OLD.org_id); END;
`;
