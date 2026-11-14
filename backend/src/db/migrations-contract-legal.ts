/** T-9 / V67: frozen legal sources and append-only runs. */
export const CONTRACT_LEGAL_SQL = `
ALTER TABLE ct_contract ADD COLUMN legal_category TEXT NOT NULL DEFAULT 'other' CHECK(legal_category IN ('goods_procurement','small_construction','tech_service','general_service','construction','income_sales','important_special','other'));
ALTER TABLE ct_contract ADD COLUMN party_role TEXT NOT NULL DEFAULT 'buyer' CHECK(party_role IN ('buyer','seller','employer','contractor','client','provider','other'));
ALTER TABLE ct_contract ADD COLUMN signing_entity_level TEXT NOT NULL DEFAULT 'company' CHECK(signing_entity_level IN ('company','secondary_unit'));
ALTER TABLE ct_contract ADD COLUMN is_procurement INTEGER NOT NULL DEFAULT 1 CHECK(is_procurement IN (0,1));
ALTER TABLE ct_contract ADD COLUMN procurement_target TEXT CHECK(procurement_target IS NULL OR procurement_target IN ('construction','goods','service'));
ALTER TABLE ct_contract ADD COLUMN procurement_method TEXT CHECK(procurement_method IS NULL OR procurement_method IN ('public_tender','invited_tender','negotiation','inquiry','bidding','direct','direct_reimburse'));
ALTER TABLE ct_contract ADD COLUMN procurement_tier TEXT CHECK(procurement_tier IS NULL OR procurement_tier IN ('tier_1','tier_2','tier_3','exempt_small','non_procurement'));
ALTER TABLE ct_contract ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0 CHECK(is_important IN (0,1));
ALTER TABLE ct_document ADD COLUMN evidence_kind TEXT CHECK(evidence_kind IS NULL OR evidence_kind IN ('procurement_scheme_approval','bid_award_approval','award_notice','evaluation_report','company_approval','client_written_offer','legal_opinion','triple_major_decision','tech_spec','safety_protocol','other'));
CREATE TABLE ct_legal_policy (
 id INTEGER PRIMARY KEY, code TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), title TEXT NOT NULL, doc_no TEXT NOT NULL,
 effective_from TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')), retired_reason TEXT, retired_at TEXT,
 source_note TEXT NOT NULL, source_file_object_id INTEGER REFERENCES file_object(id), created_by_user_id INTEGER REFERENCES app_user(id), created_at TEXT NOT NULL, UNIQUE(code,version));
CREATE TABLE ct_legal_policy_clause (
 id INTEGER PRIMARY KEY, policy_id INTEGER NOT NULL REFERENCES ct_legal_policy(id), clause_no TEXT NOT NULL, chapter_title TEXT NOT NULL,
 clause_text TEXT NOT NULL, rule_tags_json TEXT NOT NULL, sort_order INTEGER NOT NULL, UNIQUE(policy_id,clause_no));
CREATE TABLE ct_legal_template (
 id INTEGER PRIMARY KEY, code TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), name TEXT NOT NULL, legal_category TEXT NOT NULL,
 approval_status TEXT NOT NULL DEFAULT 'candidate' CHECK(approval_status IN ('candidate','official','retired')), promoted_by_user_id INTEGER REFERENCES app_user(id), promoted_at TEXT,
 retired_reason TEXT, retired_at TEXT, source_file_object_id INTEGER REFERENCES file_object(id), notes TEXT NOT NULL,
 created_by_user_id INTEGER REFERENCES app_user(id), created_at TEXT NOT NULL, UNIQUE(code,version));
CREATE TABLE ct_legal_template_clause (
 id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES ct_legal_template(id), clause_key TEXT NOT NULL, clause_no TEXT NOT NULL, title TEXT NOT NULL,
 tier TEXT NOT NULL CHECK(tier IN ('fixed','default_ref','placeholder')), standard_text TEXT NOT NULL, default_value_note TEXT NOT NULL,
 placeholder_keys_json TEXT NOT NULL, policy_clause_ref INTEGER REFERENCES ct_legal_policy_clause(id), sort_order INTEGER NOT NULL, UNIQUE(template_id,clause_key));
CREATE TABLE ct_doc_parse_cache (
 id INTEGER PRIMARY KEY, file_sha256 TEXT NOT NULL, parser_kind TEXT NOT NULL, parser_version TEXT NOT NULL,
 text_content TEXT NOT NULL, paragraphs_json TEXT NOT NULL, stats_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(file_sha256,parser_kind,parser_version));
CREATE TABLE ct_legal_run (
 id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES ct_contract(id), document_id INTEGER NOT NULL REFERENCES ct_document(id), document_sha256 TEXT NOT NULL,
 contract_version INTEGER NOT NULL, context_fingerprint TEXT NOT NULL, policy_refs_json TEXT NOT NULL, template_id INTEGER REFERENCES ct_legal_template(id), template_approval_status TEXT,
 job_id INTEGER REFERENCES app_job(id) ON DELETE SET NULL, parse_channel TEXT NOT NULL CHECK(parse_channel IN ('docx_native','pdf_external_api','ocr_fallback','failed')),
 parse_status TEXT NOT NULL CHECK(parse_status IN ('ok','degraded','unavailable','failed')), model_status TEXT NOT NULL CHECK(model_status IN ('ok','unavailable','invalid','failed','skipped')),
 verdict TEXT NOT NULL CHECK(verdict IN ('pass','revise','manual_review')), risk_level TEXT NOT NULL CHECK(risk_level IN ('high','medium','low','info')),
 summary_json TEXT NOT NULL, elements_json TEXT NOT NULL, stats_json TEXT NOT NULL, created_by_user_id INTEGER REFERENCES app_user(id), created_at TEXT NOT NULL);
CREATE INDEX idx_ct_legal_run_contract ON ct_legal_run(contract_id,id DESC);
CREATE TABLE ct_legal_finding (
 id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES ct_legal_run(id), source TEXT NOT NULL CHECK(source IN ('rule','template_diff','parse_ocr','model')), code TEXT NOT NULL,
 severity TEXT NOT NULL CHECK(severity IN ('high','medium','low','info')), blocking INTEGER NOT NULL CHECK(blocking IN (0,1)), title TEXT NOT NULL, message TEXT NOT NULL,
 location_ref TEXT NOT NULL, excerpt TEXT NOT NULL, expected_text TEXT NOT NULL, suggested_text TEXT NOT NULL,
 policy_clause_id INTEGER REFERENCES ct_legal_policy_clause(id), template_clause_id INTEGER REFERENCES ct_legal_template_clause(id), sort_order INTEGER NOT NULL);
ALTER TABLE ct_review ADD COLUMN legal_run_id INTEGER REFERENCES ct_legal_run(id);
ALTER TABLE ct_review ADD COLUMN override_high_risk INTEGER NOT NULL DEFAULT 0 CHECK(override_high_risk IN (0,1));
CREATE TRIGGER trg_ct_review_legal_once BEFORE UPDATE ON ct_review WHEN OLD.status<>'submitted' AND (NEW.legal_run_id IS NOT OLD.legal_run_id OR NEW.override_high_risk<>OLD.override_high_risk) BEGIN SELECT RAISE(ABORT,'contract review is final'); END;
${[
  'ct_legal_policy_clause',
  'ct_legal_template_clause',
  'ct_legal_run',
  'ct_legal_finding',
  'ct_doc_parse_cache',
]
  .map(
    (
      t,
    ) => `CREATE TRIGGER trg_${t}_u BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'legal record is immutable'); END;
CREATE TRIGGER trg_${t}_d BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'legal record is immutable'); END;`,
  )
  .join('\n')}
CREATE TRIGGER trg_ct_legal_policy_d BEFORE DELETE ON ct_legal_policy BEGIN SELECT RAISE(ABORT,'policy history is immutable'); END;
CREATE TRIGGER trg_ct_legal_policy_u BEFORE UPDATE ON ct_legal_policy WHEN NEW.code IS NOT OLD.code OR NEW.version IS NOT OLD.version OR NEW.title IS NOT OLD.title OR NEW.doc_no IS NOT OLD.doc_no OR NEW.effective_from IS NOT OLD.effective_from OR NEW.source_note IS NOT OLD.source_note OR NEW.created_by_user_id IS NOT OLD.created_by_user_id OR NEW.created_at IS NOT OLD.created_at OR OLD.status='retired' AND NEW.status<>'retired' BEGIN SELECT RAISE(ABORT,'policy version is frozen'); END;
CREATE TRIGGER trg_ct_legal_template_d BEFORE DELETE ON ct_legal_template BEGIN SELECT RAISE(ABORT,'template history is immutable'); END;
CREATE TRIGGER trg_ct_legal_template_u BEFORE UPDATE ON ct_legal_template WHEN NEW.code IS NOT OLD.code OR NEW.version IS NOT OLD.version OR NEW.name IS NOT OLD.name OR NEW.legal_category IS NOT OLD.legal_category OR NEW.notes IS NOT OLD.notes OR NEW.created_by_user_id IS NOT OLD.created_by_user_id OR NEW.created_at IS NOT OLD.created_at OR OLD.approval_status='retired' AND NEW.approval_status<>'retired' OR OLD.approval_status='official' AND NEW.approval_status='candidate' BEGIN SELECT RAISE(ABORT,'template version is frozen'); END;
`;
