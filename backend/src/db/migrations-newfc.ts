import type { Migration } from './migrations';

/**
 * newfc 自有迁移(V39 起)。只追加,不修改已发布条目。
 * 每条注明功能 ID;表结构规则见 specs/data-contracts.md。
 */
export const NEWFC_MIGRATIONS: Migration[] = [
  {
    version: 39,
    name: 'security_users_roles_sessions',
    sql: `
/* platform_auth / security_administration / audit_log(T-1)。
   用户身份与角色授权独立于组织树;组织数据范围(app_user_org_scope)是单独授权,
   授予某组织即含其全部下级。会话持久化(仅存令牌 SHA-256),重启不丢会话。 */
CREATE TABLE app_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(username) BETWEEN 2 AND 64),
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  all_orgs INTEGER NOT NULL DEFAULT 0 CHECK (all_orgs IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE app_role (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 64),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE app_role_permission (
  role_id INTEGER NOT NULL REFERENCES app_role(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE app_user_role (
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES app_role(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE app_user_org_scope (
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES org(id),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE app_session (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  revoked_at TEXT
);
CREATE INDEX idx_app_session_user ON app_session(user_id);

/* 审计定位:操作人、结果、来源与请求 ID。旧记录这些列为空(继承期日志无身份)。 */
ALTER TABLE operation_log ADD COLUMN actor_user_id INTEGER;
ALTER TABLE operation_log ADD COLUMN actor TEXT NOT NULL DEFAULT '';
ALTER TABLE operation_log ADD COLUMN result TEXT NOT NULL DEFAULT 'success';
ALTER TABLE operation_log ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE operation_log ADD COLUMN request_id TEXT NOT NULL DEFAULT '';
ALTER TABLE operation_log ADD COLUMN ip TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_operation_log_actor ON operation_log(actor_user_id, id);
CREATE INDEX idx_operation_log_entity ON operation_log(entity_type, entity_id);
`,
  },
  {
    version: 40,
    name: 'jobs_and_model_calls',
    sql: `
/* AC-F21 持久任务与模型调用观测。
   app_job:导入、报告、预测重算、知识索引等较长操作的统一状态;进程重启后 queued/running
   由启动恢复标为 interrupted(不静默丢失,也不假装成功),可由用户重新提交。
   状态:queued → running → succeeded / failed / cancelled / interrupted。
   progress_permille 为 0～1000 的整数千分比,避免浮点进度。 */
CREATE TABLE app_job (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  progress_permille INTEGER NOT NULL DEFAULT 0 CHECK (progress_permille BETWEEN 0 AND 1000),
  progress_message TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  org_scope_id INTEGER REFERENCES org(id),
  request_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  heartbeat_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_app_job_status ON app_job(status, id);
CREATE INDEX idx_app_job_owner ON app_job(created_by, id);
CREATE UNIQUE INDEX idx_app_job_idem ON app_job(kind, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

/* 任务步骤:工具/规则/模型/IO 每一步的输入输出摘要与来源引用(已脱敏,不存凭据)。 */
CREATE TABLE app_job_step (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES app_job(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  step_type TEXT NOT NULL DEFAULT 'rule' CHECK (step_type IN ('rule','tool','model','io','system')),
  status TEXT NOT NULL CHECK (status IN ('success','error','skipped')),
  detail TEXT NOT NULL DEFAULT '',
  input_json TEXT,
  output_json TEXT,
  source_refs_json TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  elapsed_ms INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, seq)
);

/* 模型调用记录:不保存提示词/回答正文,只保存规模、耗时、结果与错误分类。
   token 优先取供应商 usage,缺失时按字符估算并标记 tokens_estimated=1。 */
CREATE TABLE ai_model_call (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  channel_name TEXT NOT NULL DEFAULT '',
  stream INTEGER NOT NULL DEFAULT 0 CHECK (stream IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('success','error','timeout','cancelled')),
  error_type TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0,1)),
  latency_ms INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  completion_chars INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  tokens_estimated INTEGER NOT NULL DEFAULT 1 CHECK (tokens_estimated IN (0,1)),
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  job_id INTEGER REFERENCES app_job(id) ON DELETE SET NULL,
  actor_user_id INTEGER,
  source TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_model_call_time ON ai_model_call(created_at);
CREATE INDEX idx_ai_model_call_job ON ai_model_call(job_id);
`,
  },
  {
    version: 41,
    name: 'master_data_and_settings',
    sql: `
/* AC-F07 主数据基础:项目、供应商与跨域编码映射。
   - 组织/科目沿用继承的 org/account(含 tree_snapshot 历史树),不另建第二套。
   - 停用只改 status,历史事实按 id 引用且保存发生时名称,停用/改名不重算历史。
   - md_code_mapping 按有效期版本化:变更 = 退役旧行(valid_to)+ 新增行,绝不原地改目标;
     按日期解析可复现历史口径。同一来源系统/实体/编码同一时刻只允许一条生效映射。 */
CREATE TABLE md_project (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  project_type TEXT NOT NULL DEFAULT '',
  org_id INTEGER NOT NULL REFERENCES org(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_md_project_org ON md_project(org_id);

CREATE TABLE md_supplier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  supplier_type TEXT NOT NULL DEFAULT '',
  credit_code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE md_code_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_system TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('org','account','project','supplier')),
  match_kind TEXT NOT NULL DEFAULT 'code' CHECK (match_kind IN ('code','name')),
  source_key TEXT NOT NULL,
  source_label TEXT NOT NULL DEFAULT '',
  target_id INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  retired_by INTEGER
);
CREATE UNIQUE INDEX idx_md_mapping_active ON md_code_mapping(source_system, entity_type, match_kind, source_key) WHERE valid_to IS NULL;
CREATE INDEX idx_md_mapping_lookup ON md_code_mapping(entity_type, match_kind, source_key, valid_from);

/* AC-F23 业务设置:键在代码注册表中定义类型与校验,库内只存值;secret 类只写不回显。 */
CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 42,
    name: 'assistant_owner',
    sql: `
/* AC-F20/AC-X04 助手记录归属:会话、写操作预览、保存的洞察记录创建人。
   受限用户只看自己的;迁移前遗留行(owner 为空)只对全组织用户可见。
   删除用户时置空而不删记录,审计可追溯。 */
ALTER TABLE ai_conversation ADD COLUMN owner_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE ai_action ADD COLUMN owner_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE ai_insight ADD COLUMN owner_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL;
CREATE INDEX idx_ai_conversation_owner ON ai_conversation(owner_user_id, updated_at);
CREATE INDEX idx_ai_action_owner ON ai_action(owner_user_id);
CREATE INDEX idx_ai_insight_owner ON ai_insight(owner_user_id);
`,
  },
  {
    version: 43,
    name: 'import_batch_operator',
    sql: `
/* AC-X05 / data-contracts「导入预览绑定操作者」:预览记录创建人,确认时核对。
   迁移前的遗留预览(为空)不做核对;删除用户时置空。 */
ALTER TABLE import_batch ADD COLUMN created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL;
`,
  },
  {
    version: 44,
    name: 'file_objects_and_eas_workspace',
    sql: `
/* 文件对象层(T-3 公共基础):内容寻址不可变原件的登记。业务表只引用 id,下载经业务 service 鉴权。 */
CREATE TABLE file_object (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  original_name TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

/* AC-F05 EAS 原始事实与期间控制。金额为整数分;原始行不可改(触发器),批次切换只改批次/集合状态。 */
CREATE TABLE eas_correction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES org(id),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('submitted','candidate_import','pending_review','approved','returned')),
  reason TEXT NOT NULL,
  expected_current_set_id INTEGER NOT NULL,
  candidate_set_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT
);
CREATE UNIQUE INDEX idx_eas_correction_pending ON eas_correction(org_id, period)
  WHERE status IN ('submitted','candidate_import','pending_review');

CREATE TABLE eas_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_type TEXT NOT NULL CHECK (data_type IN ('voucher','balance','auxiliary')),
  org_id INTEGER NOT NULL REFERENCES org(id),
  source_company TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  debit_total_cents INTEGER NOT NULL DEFAULT 0,
  credit_total_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','active','superseded')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  correction_id INTEGER REFERENCES eas_correction(id),
  parser_version TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_eas_batch_idem ON eas_batch(org_id, period, data_type, file_sha256, IFNULL(correction_id, 0));
CREATE INDEX idx_eas_batch_scope ON eas_batch(org_id, period, data_type);

CREATE TABLE eas_voucher_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES eas_batch(id),
  source_row INTEGER NOT NULL,
  voucher_date TEXT NOT NULL,
  voucher_no TEXT NOT NULL,
  entry_no TEXT NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  summary TEXT,
  debit_cents INTEGER NOT NULL,
  credit_cents INTEGER NOT NULL,
  project_code TEXT,
  project_name TEXT,
  dept_name TEXT,
  supplier_name TEXT,
  fund_source TEXT
);
CREATE INDEX idx_eas_voucher_batch ON eas_voucher_line(batch_id, account_code);

CREATE TABLE eas_balance_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES eas_batch(id),
  source_row INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  begin_debit_cents INTEGER NOT NULL,
  begin_credit_cents INTEGER NOT NULL,
  debit_cents INTEGER NOT NULL,
  credit_cents INTEGER NOT NULL,
  end_debit_cents INTEGER NOT NULL,
  end_credit_cents INTEGER NOT NULL,
  project_code TEXT,
  project_name TEXT,
  dept_name TEXT,
  supplier_name TEXT
);
CREATE INDEX idx_eas_balance_batch ON eas_balance_line(batch_id, account_code);

CREATE TABLE eas_aux_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES eas_batch(id),
  source_row INTEGER NOT NULL,
  aux_type TEXT NOT NULL,
  aux_code TEXT NOT NULL,
  aux_name TEXT NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  begin_cents INTEGER NOT NULL,
  debit_cents INTEGER NOT NULL,
  credit_cents INTEGER NOT NULL,
  end_cents INTEGER NOT NULL,
  supplier_name TEXT
);
CREATE INDEX idx_eas_aux_batch ON eas_aux_line(batch_id, account_code, aux_type);

CREATE TRIGGER trg_eas_voucher_immutable_u BEFORE UPDATE ON eas_voucher_line BEGIN SELECT RAISE(ABORT, 'EAS 原始凭证行不可修改'); END;
CREATE TRIGGER trg_eas_voucher_immutable_d BEFORE DELETE ON eas_voucher_line BEGIN SELECT RAISE(ABORT, 'EAS 原始凭证行不可删除'); END;
CREATE TRIGGER trg_eas_balance_immutable_u BEFORE UPDATE ON eas_balance_line BEGIN SELECT RAISE(ABORT, 'EAS 原始余额行不可修改'); END;
CREATE TRIGGER trg_eas_balance_immutable_d BEFORE DELETE ON eas_balance_line BEGIN SELECT RAISE(ABORT, 'EAS 原始余额行不可删除'); END;
CREATE TRIGGER trg_eas_aux_immutable_u BEFORE UPDATE ON eas_aux_line BEGIN SELECT RAISE(ABORT, 'EAS 原始辅助核算行不可修改'); END;
CREATE TRIGGER trg_eas_aux_immutable_d BEFORE DELETE ON eas_aux_line BEGIN SELECT RAISE(ABORT, 'EAS 原始辅助核算行不可删除'); END;

CREATE TABLE eas_recon_set (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES org(id),
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('incomplete','failed','passed')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  correction_id INTEGER REFERENCES eas_correction(id),
  error_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  activated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  activated_at TEXT
);
CREATE UNIQUE INDEX idx_eas_recon_current ON eas_recon_set(org_id, period) WHERE is_current = 1;
CREATE INDEX idx_eas_recon_scope ON eas_recon_set(org_id, period);

CREATE TABLE eas_recon_set_batch (
  set_id INTEGER NOT NULL REFERENCES eas_recon_set(id),
  data_type TEXT NOT NULL CHECK (data_type IN ('voucher','balance','auxiliary')),
  batch_id INTEGER NOT NULL REFERENCES eas_batch(id),
  PRIMARY KEY (set_id, data_type)
);

CREATE TABLE eas_recon_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES eas_recon_set(id),
  rule_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed','warning','incomplete','failed')),
  diff_count INTEGER NOT NULL DEFAULT 0,
  diff_cents INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_eas_recon_result_set ON eas_recon_result(set_id);

CREATE TABLE eas_aux_requirement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES org(id),
  account_code TEXT NOT NULL,
  aux_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, account_code, aux_type)
);

CREATE TABLE eas_period_lock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES org(id),
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('locked','unlocked')),
  set_id INTEGER NOT NULL REFERENCES eas_recon_set(id),
  reason TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  locked_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  locked_at TEXT,
  unlocked_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  unlocked_at TEXT,
  UNIQUE (org_id, period)
);

CREATE TABLE eas_period_lock_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lock_id INTEGER NOT NULL REFERENCES eas_period_lock(id),
  action TEXT NOT NULL CHECK (action IN ('lock','unlock','correction_switch')),
  set_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE eas_correction_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  correction_id INTEGER NOT NULL REFERENCES eas_correction(id),
  action TEXT NOT NULL CHECK (action IN ('approve','return')),
  comment TEXT,
  exception_reason TEXT,
  reviewer_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 45,
    name: 'data_governance',
    sql: `
/* AC-F06 数据治理。问题按来源去重(issue_key),处置经复核生效;治理从不改写原始事实,
   source_hash 是问题所依据事实的快照哈希,重验或生效时不一致即 GOVERNANCE_FACT_MUTATED。 */
CREATE TABLE gov_issue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('eas_recon','eas_master','statement')),
  problem_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  org_id INTEGER REFERENCES org(id),
  period TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('error','warning')),
  title TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','pending_review','resolved','dismissed')),
  reopen_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX idx_gov_issue_scope ON gov_issue(org_id, period, status);

CREATE TABLE gov_disposition (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES gov_issue(id),
  kind TEXT NOT NULL CHECK (kind IN ('mapping_override','false_positive','reimport')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_review','approved','returned')),
  source_hash_before TEXT NOT NULL,
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_gov_disposition_pending ON gov_disposition(issue_id) WHERE status = 'pending_review';

CREATE TABLE gov_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  disposition_id INTEGER NOT NULL UNIQUE REFERENCES gov_disposition(id),
  action TEXT NOT NULL CHECK (action IN ('approve','return')),
  comment TEXT,
  exception_reason TEXT,
  reviewer_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE gov_effect_proof (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  disposition_id INTEGER NOT NULL UNIQUE REFERENCES gov_disposition(id),
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK (verified IN (0,1)),
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

/* 预检结果是治理问题的来源事实,同样不可改 */
CREATE TRIGGER trg_eas_recon_result_immutable_u BEFORE UPDATE ON eas_recon_result BEGIN SELECT RAISE(ABORT, 'EAS 对账结果不可修改'); END;
CREATE TRIGGER trg_eas_recon_result_immutable_d BEFORE DELETE ON eas_recon_result BEGIN SELECT RAISE(ABORT, 'EAS 对账结果不可删除'); END;

/* T-3 新增权限码:只补给尚无该能力的内置模板角色(INSERT OR IGNORE,不覆盖管理员对角色的修改) */
INSERT OR IGNORE INTO app_role_permission (role_id, permission) SELECT id, 'statements:import' FROM app_role WHERE code IN ('admin','data_maintainer');
INSERT OR IGNORE INTO app_role_permission (role_id, permission) SELECT id, 'mgmt:review' FROM app_role WHERE code IN ('admin','business_reviewer');
`,
  },
  {
    version: 46,
    name: 'financial_statements',
    sql: `
/* AC-F10 财务报表:四表模板解析为表项与事实(整数分)。按 组织 + 期间 + 口径 + sha256 幂等;
   同一组织期间口径只有一个当前批次;表项与事实不可改。 */
CREATE TABLE stmt_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES org(id),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  scope TEXT NOT NULL CHECK (scope IN ('parent','subsidiary','consolidated')),
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  template_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','active','superseded','voided')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  item_count INTEGER NOT NULL,
  fact_count INTEGER NOT NULL,
  warning_count INTEGER NOT NULL DEFAULT 0,
  checks_json TEXT NOT NULL DEFAULT '[]',
  sheets_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  activated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  activated_at TEXT,
  voided_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  voided_at TEXT,
  void_reason TEXT
);
CREATE UNIQUE INDEX idx_stmt_batch_idem ON stmt_batch(org_id, period, scope, file_sha256);
CREATE UNIQUE INDEX idx_stmt_batch_current ON stmt_batch(org_id, period, scope) WHERE is_current = 1;

CREATE TABLE stmt_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES stmt_batch(id),
  sheet_code TEXT NOT NULL CHECK (sheet_code IN ('balance_sheet','income_statement','cash_flow_statement','equity_change_statement')),
  side TEXT CHECK (side IN ('asset','liability_equity')),
  row_no INTEGER NOT NULL,
  line_no TEXT,
  item_name TEXT NOT NULL,
  semantic_key TEXT,
  item_type TEXT NOT NULL CHECK (item_type IN ('total','subtotal','detail'))
);
CREATE INDEX idx_stmt_item_batch ON stmt_item(batch_id, sheet_code);

CREATE TABLE stmt_fact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES stmt_batch(id),
  item_id INTEGER NOT NULL REFERENCES stmt_item(id),
  field_key TEXT NOT NULL,
  field_name TEXT NOT NULL,
  amount_cents INTEGER,
  text_value TEXT,
  formula_text TEXT,
  source_cell TEXT NOT NULL
);
CREATE INDEX idx_stmt_fact_item ON stmt_fact(item_id);
CREATE INDEX idx_stmt_fact_batch ON stmt_fact(batch_id);

CREATE TRIGGER trg_stmt_item_immutable_u BEFORE UPDATE ON stmt_item BEGIN SELECT RAISE(ABORT, '财务报表表项不可修改'); END;
CREATE TRIGGER trg_stmt_item_immutable_d BEFORE DELETE ON stmt_item BEGIN SELECT RAISE(ABORT, '财务报表表项不可删除'); END;
CREATE TRIGGER trg_stmt_fact_immutable_u BEFORE UPDATE ON stmt_fact BEGIN SELECT RAISE(ABORT, '财务报表事实不可修改'); END;
CREATE TRIGGER trg_stmt_fact_immutable_d BEFORE DELETE ON stmt_fact BEGIN SELECT RAISE(ABORT, '财务报表事实不可删除'); END;
`,
  },
  {
    version: 47,
    name: 'management_accounting',
    sql: `
/* management_accounting(AC-F14,T-3):维度、指标与计算快照、成本分摊及调整、预算调整、预警、绩效。
   快照只追加:数值与证据不可改,失效只改 status/invalidated_*。金额为整数分,比率为 10^6 缩放整数。 */
CREATE TABLE ma_dimension (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  member_type TEXT NOT NULL CHECK (member_type IN ('org','project','account','custom')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ma_dimension_member (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dimension_id INTEGER NOT NULL REFERENCES ma_dimension(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('org','project','account','custom')),
  ref_id INTEGER,
  org_id INTEGER REFERENCES org(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (dimension_id, code)
);

CREATE TABLE ma_metric (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('money','ratio')),
  calculator TEXT NOT NULL CHECK (calculator IN ('budget_amount','actual_amount','execution_rate','eas_balance','statement_item','allocated_cost')),
  params_json TEXT NOT NULL DEFAULT '{}',
  thresholds_json TEXT NOT NULL DEFAULT '{}',
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO ma_metric (code, name, unit, calculator, builtin, created_at, updated_at)
VALUES ('ALLOCATED_COST', '分摊成本', 'money', 'allocated_cost', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE ma_calc_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('calc','allocation')),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  request_json TEXT NOT NULL DEFAULT '{}',
  snapshot_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ma_metric_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ma_calc_run(id),
  metric_id INTEGER NOT NULL REFERENCES ma_metric(id),
  org_id INTEGER NOT NULL REFERENCES org(id),
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid','unavailable','invalidated')),
  value_cents INTEGER,
  value_scaled INTEGER,
  compare_cents INTEGER,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  alloc_run_id INTEGER,
  adjustment_id INTEGER,
  invalidated_at TEXT,
  invalidated_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ma_snapshot_lookup ON ma_metric_snapshot(metric_id, org_id, period, status);
CREATE INDEX idx_ma_snapshot_run ON ma_metric_snapshot(run_id);
CREATE INDEX idx_ma_snapshot_alloc ON ma_metric_snapshot(alloc_run_id);
CREATE TRIGGER trg_ma_snapshot_immutable_u BEFORE UPDATE OF run_id, metric_id, org_id, period, value_cents, value_scaled, compare_cents,
  reasons_json, evidence_json, alloc_run_id, adjustment_id, created_at ON ma_metric_snapshot
BEGIN SELECT RAISE(ABORT, '指标快照数值不可修改'); END;
CREATE TRIGGER trg_ma_snapshot_status_u BEFORE UPDATE OF status ON ma_metric_snapshot
WHEN NOT (OLD.status = 'valid' AND NEW.status = 'invalidated')
BEGIN SELECT RAISE(ABORT, '指标快照只能从有效变为失效'); END;
CREATE TRIGGER trg_ma_snapshot_immutable_d BEFORE DELETE ON ma_metric_snapshot BEGIN SELECT RAISE(ABORT, '指标快照不可删除'); END;

CREATE TABLE ma_cost_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  org_id INTEGER NOT NULL REFERENCES org(id),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ma_cost_pool_org ON ma_cost_pool(org_id, period);

CREATE TABLE ma_alloc_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL REFERENCES ma_cost_pool(id),
  target_org_id INTEGER NOT NULL REFERENCES org(id),
  weight_scaled INTEGER NOT NULL CHECK (weight_scaled >= 0),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE UNIQUE INDEX idx_ma_alloc_rule_active ON ma_alloc_rule(pool_id, target_org_id) WHERE retired_at IS NULL;

CREATE TABLE ma_alloc_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL REFERENCES ma_cost_pool(id),
  pool_version INTEGER NOT NULL,
  period TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  calc_run_id INTEGER REFERENCES ma_calc_run(id),
  status TEXT NOT NULL CHECK (status IN ('confirmed','voided')),
  version INTEGER NOT NULL DEFAULT 1,
  confirmed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  confirmed_at TEXT NOT NULL,
  voided_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  voided_at TEXT,
  void_reason TEXT
);
CREATE UNIQUE INDEX idx_ma_alloc_run_confirmed ON ma_alloc_run(pool_id) WHERE status = 'confirmed';

CREATE TABLE ma_alloc_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ma_alloc_run(id),
  rule_id INTEGER REFERENCES ma_alloc_rule(id),
  target_org_id INTEGER NOT NULL REFERENCES org(id),
  weight_scaled INTEGER NOT NULL,
  base_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE INDEX idx_ma_alloc_result_run ON ma_alloc_result(run_id);
CREATE TRIGGER trg_ma_alloc_result_base_u BEFORE UPDATE OF run_id, rule_id, target_org_id, weight_scaled, base_cents, sort_order ON ma_alloc_result
BEGIN SELECT RAISE(ABORT, '分摊结果基数不可修改'); END;
CREATE TRIGGER trg_ma_alloc_result_d BEFORE DELETE ON ma_alloc_result BEGIN SELECT RAISE(ABORT, '分摊结果不可删除'); END;

CREATE TABLE ma_alloc_adjustment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ma_alloc_run(id),
  from_result_id INTEGER NOT NULL REFERENCES ma_alloc_result(id),
  to_result_id INTEGER NOT NULL REFERENCES ma_alloc_result(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1)),
  CHECK (from_result_id <> to_result_id)
);
CREATE INDEX idx_ma_alloc_adjustment_run ON ma_alloc_adjustment(run_id, status);

CREATE TABLE ma_budget_adjustment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_version_id INTEGER NOT NULL REFERENCES budget_version(id),
  org_id INTEGER NOT NULL REFERENCES org(id),
  account_id INTEGER NOT NULL REFERENCES account(id),
  before_cents INTEGER NOT NULL,
  after_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','effective','rejected')),
  new_version_id INTEGER REFERENCES budget_version(id),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1))
);
CREATE UNIQUE INDEX idx_ma_budget_adjustment_pending ON ma_budget_adjustment(source_version_id, org_id, account_id) WHERE status = 'pending';

CREATE TABLE ma_alert (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id INTEGER NOT NULL REFERENCES ma_metric(id),
  org_id INTEGER NOT NULL REFERENCES org(id),
  period TEXT NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('upper','lower','deviation')),
  level TEXT NOT NULL CHECK (level IN ('warning','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','closed')),
  snapshot_id INTEGER NOT NULL REFERENCES ma_metric_snapshot(id),
  run_id INTEGER NOT NULL REFERENCES ma_calc_run(id),
  value_text TEXT NOT NULL,
  threshold_text TEXT NOT NULL,
  message TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  cause_category TEXT,
  ack_note TEXT,
  acknowledged_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  acknowledged_at TEXT,
  close_note TEXT,
  closed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  closed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ma_alert_open ON ma_alert(metric_id, org_id, period, alert_type) WHERE status <> 'closed';

CREATE TABLE ma_perf_scheme (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ma_perf_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme_id INTEGER NOT NULL REFERENCES ma_perf_scheme(id),
  metric_id INTEGER NOT NULL REFERENCES ma_metric(id),
  weight_scaled INTEGER NOT NULL CHECK (weight_scaled > 0),
  target_text TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('higher_better','lower_better')),
  sort_order INTEGER NOT NULL,
  UNIQUE (scheme_id, metric_id)
);

CREATE TABLE ma_perf_score (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme_id INTEGER NOT NULL REFERENCES ma_perf_scheme(id),
  scheme_version INTEGER NOT NULL,
  run_id INTEGER NOT NULL REFERENCES ma_calc_run(id),
  org_id INTEGER NOT NULL REFERENCES org(id),
  period TEXT NOT NULL,
  score_scaled INTEGER NOT NULL,
  details_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scored' CHECK (status IN ('scored','reviewed')),
  review_action TEXT CHECK (review_action IN ('confirm','adjust')),
  adjusted_score_scaled INTEGER,
  adjust_reason TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1)),
  scored_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  scored_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT
);
CREATE INDEX idx_ma_perf_score_org ON ma_perf_score(org_id, period);
CREATE TRIGGER trg_ma_perf_score_original_u BEFORE UPDATE OF scheme_id, scheme_version, run_id, org_id, period, score_scaled, details_json, scored_by_user_id, scored_at ON ma_perf_score
BEGIN SELECT RAISE(ABORT, '绩效原始评分不可修改'); END;
`,
  },
  {
    version: 48,
    name: 'standard_reports',
    sql: `
/* standard_reports(AC-F19,T-3):生成时冻结列、行、摘要与来源引用,此后页面与导出只读冻结内容。
   org_id 为空表示全组织口径。冻结内容由触发器保护,复核只改 status/review_*。 */
CREATE TABLE std_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL CHECK (report_type IN ('budget_execution','statement_summary','eas_recon')),
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
CREATE INDEX idx_std_report_type ON std_report(report_type, period);
CREATE INDEX idx_std_report_org ON std_report(org_id);
CREATE TRIGGER trg_std_report_frozen_u BEFORE UPDATE OF report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json,
  sources_json, content_sha256, generated_by_user_id, generated_at ON std_report
BEGIN SELECT RAISE(ABORT, '标准报表冻结内容不可修改'); END;
CREATE TRIGGER trg_std_report_review_once BEFORE UPDATE OF status ON std_report
WHEN NOT (OLD.status = 'generated' AND NEW.status = 'reviewed')
BEGIN SELECT RAISE(ABORT, '标准报表只能复核一次'); END;
CREATE TRIGGER trg_std_report_d BEFORE DELETE ON std_report BEGIN SELECT RAISE(ABORT, '标准报表不可删除'); END;
`,
  },
  {
    version: 49,
    name: 'project_budget',
    sql: `
/* project_budget(AC-F09,T-4):项目预算按“年度 + 执行期间”导入批次,每批一个原件;同一年度期间最多一个当前批次。
   批次涉及的组织由明细 org_id 决定(取 md_project.org_id),组织范围按明细裁剪。明细不可改删。 */
CREATE TABLE pb_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period, 1, 4) = CAST(year AS TEXT)),
  name TEXT NOT NULL,
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','voided')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  row_count INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  activated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  activated_at TEXT,
  voided_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  voided_at TEXT,
  void_reason TEXT,
  CHECK (status <> 'voided' OR is_current = 0),
  UNIQUE (year, period, file_sha256)
);
CREATE UNIQUE INDEX idx_pb_batch_current ON pb_batch(year, period) WHERE is_current = 1;

CREATE TABLE pb_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES pb_batch(id),
  row_no INTEGER NOT NULL,
  project_id INTEGER NOT NULL REFERENCES md_project(id),
  project_code TEXT NOT NULL,
  project_name TEXT NOT NULL,
  org_id INTEGER NOT NULL REFERENCES org(id),
  fund_source TEXT NOT NULL,
  expense_category TEXT NOT NULL DEFAULT '',
  budget_cents INTEGER NOT NULL CHECK (budget_cents >= 0),
  executed_cents INTEGER NOT NULL CHECK (executed_cents >= 0),
  exec_month TEXT NOT NULL CHECK (exec_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  UNIQUE (batch_id, project_id, fund_source, org_id, expense_category, exec_month)
);
CREATE INDEX idx_pb_entry_batch_org ON pb_entry(batch_id, org_id);
CREATE INDEX idx_pb_entry_project ON pb_entry(project_id);
CREATE TRIGGER trg_pb_entry_u BEFORE UPDATE ON pb_entry BEGIN SELECT RAISE(ABORT, '项目预算明细不可修改'); END;
CREATE TRIGGER trg_pb_entry_d BEFORE DELETE ON pb_entry BEGIN SELECT RAISE(ABORT, '项目预算明细不可删除'); END;
`,
  },
  {
    version: 50,
    name: 'plan_execution',
    sql: `
/* plan_execution(AC-F15,T-4):计划执行按“计划年度 + 实际期间”导入批次。
   每个字段声明口径 measure,指标只按口径取数,不互相兜底;金额整数分,数量 4 位、比率 6 位缩放整数。
   明细行 org_id 必填(项目取 md_project.org_id,否则按承办单位解析);分类/小计行不归属组织,只对全组织用户可见。 */
CREATE TABLE plan_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  actual_period TEXT NOT NULL CHECK (actual_period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(actual_period, 1, 4) = CAST(year AS TEXT)),
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  amount_unit TEXT NOT NULL CHECK (amount_unit IN ('yuan','wan')),
  status TEXT NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','voided')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  item_count INTEGER NOT NULL,
  fact_count INTEGER NOT NULL,
  sheets_json TEXT NOT NULL DEFAULT '[]',
  ignored_sheets_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  activated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  activated_at TEXT,
  voided_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  voided_at TEXT,
  void_reason TEXT,
  CHECK (status <> 'voided' OR is_current = 0),
  UNIQUE (year, actual_period, file_sha256)
);
CREATE UNIQUE INDEX idx_plan_batch_current ON plan_batch(year, actual_period) WHERE is_current = 1;

CREATE TABLE plan_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES plan_batch(id),
  sheet_code TEXT NOT NULL CHECK (sheet_code IN ('investment','purchase','maintenance')),
  row_no INTEGER NOT NULL,
  seq_no TEXT NOT NULL DEFAULT '',
  item_name TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('detail','category','subtotal')),
  path TEXT NOT NULL DEFAULT '',
  item_key TEXT NOT NULL,
  project_id INTEGER REFERENCES md_project(id),
  org_id INTEGER REFERENCES org(id),
  CHECK (item_type <> 'detail' OR org_id IS NOT NULL),
  UNIQUE (batch_id, sheet_code, row_no)
);
CREATE INDEX idx_plan_item_batch_org ON plan_item(batch_id, org_id);
CREATE INDEX idx_plan_item_project ON plan_item(project_id);

CREATE TABLE plan_fact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES plan_batch(id),
  item_id INTEGER NOT NULL REFERENCES plan_item(id),
  field_key TEXT NOT NULL,
  measure TEXT NOT NULL CHECK (measure IN ('annual_plan','annual_actual_ytd','cumulative','total','snapshot')),
  value_type TEXT NOT NULL CHECK (value_type IN ('amount','quantity','ratio','text')),
  amount_cents INTEGER,
  scaled_value INTEGER,
  text_value TEXT,
  source_cell TEXT NOT NULL,
  CHECK ((value_type = 'amount') = (amount_cents IS NOT NULL)),
  CHECK ((value_type IN ('quantity','ratio')) = (scaled_value IS NOT NULL)),
  UNIQUE (item_id, field_key)
);
CREATE INDEX idx_plan_fact_batch ON plan_fact(batch_id, field_key);
CREATE TRIGGER trg_plan_item_u BEFORE UPDATE ON plan_item BEGIN SELECT RAISE(ABORT, '计划执行行不可修改'); END;
CREATE TRIGGER trg_plan_item_d BEFORE DELETE ON plan_item BEGIN SELECT RAISE(ABORT, '计划执行行不可删除'); END;
CREATE TRIGGER trg_plan_fact_u BEFORE UPDATE ON plan_fact BEGIN SELECT RAISE(ABORT, '计划执行事实不可修改'); END;
CREATE TRIGGER trg_plan_fact_d BEFORE DELETE ON plan_fact BEGIN SELECT RAISE(ABORT, '计划执行事实不可删除'); END;
`,
  },
  {
    version: 51,
    name: 'project_contract',
    sql: `
/* project_contract / contract_import(AC-F16 / AC-F04,T-4)。
   当前金额 = 原始金额 + 已批准变更;已付只由支付登记(含导入基线)累加,且不超过当前金额。
   文档、事件只追加;审核/变更/付款复核一次定论。阶段:initiation→procurement→drafting→approval→performance→settlement→archived。 */
CREATE TABLE ct_import (
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
  confirmed_at TEXT
);

CREATE TABLE ct_contract (
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
  stage TEXT NOT NULL DEFAULT 'initiation' CHECK (stage IN ('initiation','procurement','drafting','approval','performance','settlement','archived')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','terminated','voided')),
  status_reason TEXT,
  sign_date TEXT,
  effective_date TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  import_id INTEGER REFERENCES ct_import(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (original_cents + approved_change_cents >= 0),
  CHECK (paid_cents <= original_cents + approved_change_cents)
);
CREATE INDEX idx_ct_contract_org ON ct_contract(org_id, status);
CREATE INDEX idx_ct_contract_project ON ct_contract(project_id);

CREATE TABLE ct_document (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('procurement','contract_text','signed','performance','acceptance','invoice','change','settlement','other')),
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  name TEXT NOT NULL,
  uploaded_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX idx_ct_document_contract ON ct_document(contract_id, doc_type);
CREATE TRIGGER trg_ct_document_u BEFORE UPDATE ON ct_document BEGIN SELECT RAISE(ABORT, '合同文档不可修改'); END;
CREATE TRIGGER trg_ct_document_d BEFORE DELETE ON ct_document BEGIN SELECT RAISE(ABORT, '合同文档不可删除'); END;

CREATE TABLE ct_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  document_id INTEGER NOT NULL REFERENCES ct_document(id),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  submit_note TEXT NOT NULL DEFAULT '',
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1))
);
CREATE UNIQUE INDEX idx_ct_review_pending ON ct_review(contract_id) WHERE status = 'submitted';

CREATE TABLE ct_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  delta_cents INTEGER NOT NULL CHECK (delta_cents <> 0),
  reason TEXT NOT NULL,
  evidence_document_id INTEGER NOT NULL REFERENCES ct_document(id),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1))
);
CREATE INDEX idx_ct_change_contract ON ct_change(contract_id, status);

CREATE TABLE ct_payment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','import_baseline')),
  node_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  planned_date TEXT,
  evidence_document_id INTEGER REFERENCES ct_document(id),
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
CREATE INDEX idx_ct_payment_contract ON ct_payment(contract_id, status);
CREATE INDEX idx_ct_payment_paid ON ct_payment(status, paid_date);

CREATE TABLE ct_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES ct_contract(id),
  event_type TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  actor_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ct_event_contract ON ct_event(contract_id, id);
CREATE TRIGGER trg_ct_event_u BEFORE UPDATE ON ct_event BEGIN SELECT RAISE(ABORT, '合同事件只追加'); END;
CREATE TRIGGER trg_ct_event_d BEFORE DELETE ON ct_event BEGIN SELECT RAISE(ABORT, '合同事件只追加'); END;
CREATE TRIGGER trg_ct_review_once BEFORE UPDATE OF status ON ct_review WHEN OLD.status <> 'submitted'
BEGIN SELECT RAISE(ABORT, '合同审核只能处理一次'); END;
CREATE TRIGGER trg_ct_change_once BEFORE UPDATE OF status ON ct_change WHEN OLD.status <> 'submitted'
BEGIN SELECT RAISE(ABORT, '合同变更只能复核一次'); END;
CREATE TRIGGER trg_ct_payment_flow BEFORE UPDATE OF status ON ct_payment
WHEN NOT ((OLD.status = 'submitted' AND NEW.status IN ('approved','rejected')) OR (OLD.status = 'approved' AND NEW.status = 'paid'))
BEGIN SELECT RAISE(ABORT, '付款状态只能按 提交→批准/驳回→支付 推进'); END;
`,
  },
  {
    version: 52,
    name: 'expense_audit',
    sql: `
/* expense_audit(AC-F22,T-4):报销单在本系统原生登记;制度依据按条款维护,规则阈值与材料要求来自条款。
   审核运行、发现、人工复核只追加;提交后单据内容冻结(content_sha256),补件只追加附件。 */
CREATE TABLE ex_policy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  effective_from TEXT NOT NULL CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  effective_to TEXT CHECK (effective_to IS NULL OR effective_to >= effective_from),
  file_object_id INTEGER REFERENCES file_object(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (code, version)
);

CREATE TABLE ex_policy_clause (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL REFERENCES ex_policy(id),
  clause_no TEXT NOT NULL,
  clause_text TEXT NOT NULL,
  expense_types_json TEXT NOT NULL DEFAULT '[]',
  limit_cents INTEGER CHECK (limit_cents IS NULL OR limit_cents >= 0),
  required_keywords_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (policy_id, clause_no)
);
/* 条款随制度版本冻结:修改制度 = 新版本;已被审核运行引用的条款保持可追溯。 */
CREATE TRIGGER trg_ex_policy_clause_u BEFORE UPDATE ON ex_policy_clause BEGIN SELECT RAISE(ABORT, '制度条款不可修改,请发布新版本'); END;
CREATE TRIGGER trg_ex_policy_clause_d BEFORE DELETE ON ex_policy_clause BEGIN SELECT RAISE(ABORT, '制度条款不可删除'); END;

CREATE TABLE ex_claim (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_no TEXT NOT NULL UNIQUE,
  org_id INTEGER NOT NULL REFERENCES org(id),
  applicant TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  expense_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  occurred_date TEXT NOT NULL CHECK (occurred_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','audited','reviewed','supplement')),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('pass','reject')),
  review_version INTEGER NOT NULL DEFAULT 1,
  content_sha256 TEXT,
  submit_round INTEGER NOT NULL DEFAULT 0,
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ex_claim_org ON ex_claim(org_id, status);

CREATE TABLE ex_claim_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES ex_claim(id),
  line_no INTEGER NOT NULL,
  expense_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  invoice_no TEXT NOT NULL DEFAULT '',
  invoice_date TEXT,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (claim_id, line_no)
);

CREATE TABLE ex_attachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES ex_claim(id),
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  file_sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  kind_hint TEXT NOT NULL DEFAULT '',
  submit_round INTEGER NOT NULL,
  uploaded_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX idx_ex_attachment_claim ON ex_attachment(claim_id);
CREATE TRIGGER trg_ex_attachment_u BEFORE UPDATE ON ex_attachment BEGIN SELECT RAISE(ABORT, '报销附件不可修改'); END;

/* OCR 结果按附件内容摘要缓存,同一原件不重复识别。 */
CREATE TABLE ex_ocr_cache (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  text_content TEXT NOT NULL,
  pages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE ex_audit_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES ex_claim(id),
  review_version INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  job_id INTEGER,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
  ocr_status TEXT NOT NULL CHECK (ocr_status IN ('ok','unavailable','failed','not_needed')),
  model_status TEXT NOT NULL CHECK (model_status IN ('ok','unavailable','invalid','failed')),
  policy_refs_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ex_audit_run_claim ON ex_audit_run(claim_id, id);

CREATE TABLE ex_finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ex_audit_run(id),
  source TEXT NOT NULL CHECK (source IN ('rule','ocr','model')),
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','low','medium','high')),
  message TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  clause_id INTEGER REFERENCES ex_policy_clause(id)
);
CREATE INDEX idx_ex_finding_run ON ex_finding(run_id);

CREATE TABLE ex_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES ex_claim(id),
  run_id INTEGER NOT NULL REFERENCES ex_audit_run(id),
  review_version INTEGER NOT NULL,
  conclusion TEXT NOT NULL CHECK (conclusion IN ('pass','reject','supplement_required')),
  dispositions_json TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1)),
  reviewer_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (claim_id, review_version)
);
CREATE TRIGGER trg_ex_audit_run_u BEFORE UPDATE ON ex_audit_run BEGIN SELECT RAISE(ABORT, '审核运行只追加'); END;
CREATE TRIGGER trg_ex_audit_run_d BEFORE DELETE ON ex_audit_run BEGIN SELECT RAISE(ABORT, '审核运行只追加'); END;
CREATE TRIGGER trg_ex_finding_u BEFORE UPDATE ON ex_finding BEGIN SELECT RAISE(ABORT, '审核发现只追加'); END;
CREATE TRIGGER trg_ex_finding_d BEFORE DELETE ON ex_finding BEGIN SELECT RAISE(ABORT, '审核发现只追加'); END;
CREATE TRIGGER trg_ex_review_u BEFORE UPDATE ON ex_review BEGIN SELECT RAISE(ABORT, '复核记录不可修改'); END;
CREATE TRIGGER trg_ex_review_d BEFORE DELETE ON ex_review BEGIN SELECT RAISE(ABORT, '复核记录不可删除'); END;
`,
  },
  {
    version: 53,
    name: 'project_contract_linkage',
    rebuild: true,
    sql: `
/* project_contract_linkage(T-4 联动):CHECK 枚举扩展只能整表重建。
   - ma_metric.calculator 追加 contract_paid / contract_payment_rate / plan_execution_rate;
   - std_report.report_type 追加 contract_payment_ledger(合同付款台账)。
   rebuild 迁移:外键关闭后在单事务内“建新表 → 全量复制 → 删旧表 → 改名 → 重建索引与触发器”,
   提交前 foreign_key_check;子表 REFERENCES 按表名解析,改名后自然指回新表。 */
CREATE TABLE ma_metric_v53 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('money','ratio')),
  calculator TEXT NOT NULL CHECK (calculator IN ('budget_amount','actual_amount','execution_rate','eas_balance','statement_item','allocated_cost',
    'contract_paid','contract_payment_rate','plan_execution_rate')),
  params_json TEXT NOT NULL DEFAULT '{}',
  thresholds_json TEXT NOT NULL DEFAULT '{}',
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO ma_metric_v53 (id, code, name, unit, calculator, params_json, thresholds_json, builtin, status, version, created_by_user_id, created_at, updated_at)
  SELECT id, code, name, unit, calculator, params_json, thresholds_json, builtin, status, version, created_by_user_id, created_at, updated_at FROM ma_metric;
DROP TABLE ma_metric;
ALTER TABLE ma_metric_v53 RENAME TO ma_metric;

CREATE TABLE std_report_v53 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL CHECK (report_type IN ('budget_execution','statement_summary','eas_recon','contract_payment_ledger')),
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
INSERT INTO std_report_v53 (id, report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, status,
    generated_by_user_id, generated_at, reviewed_by_user_id, reviewed_at, review_comment, exception_reason, self_review)
  SELECT id, report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, status,
    generated_by_user_id, generated_at, reviewed_by_user_id, reviewed_at, review_comment, exception_reason, self_review FROM std_report;
DROP TABLE std_report;
ALTER TABLE std_report_v53 RENAME TO std_report;
CREATE INDEX idx_std_report_type ON std_report(report_type, period);
CREATE INDEX idx_std_report_org ON std_report(org_id);
CREATE TRIGGER trg_std_report_frozen_u BEFORE UPDATE OF report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json,
  sources_json, content_sha256, generated_by_user_id, generated_at ON std_report
BEGIN SELECT RAISE(ABORT, '标准报表冻结内容不可修改'); END;
CREATE TRIGGER trg_std_report_review_once BEFORE UPDATE OF status ON std_report
WHEN NOT (OLD.status = 'generated' AND NEW.status = 'reviewed')
BEGIN SELECT RAISE(ABORT, '标准报表只能复核一次'); END;
CREATE TRIGGER trg_std_report_d BEFORE DELETE ON std_report BEGIN SELECT RAISE(ABORT, '标准报表不可删除'); END;
`,
  },
  {
    version: 54,
    name: 'investment_feasibility',
    sql: `
/* investment_feasibility(AC-F12,T-5)。标准模型 standard-1.0:输入为版本化 JSON 文档(万元,6 位小数字符串),
   测算在事务外完成,运行记录冻结输入与结果,不可修改/删除。 */
CREATE TABLE if_project (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  org_id INTEGER NOT NULL REFERENCES org(id),
  md_project_id INTEGER REFERENCES md_project(id),
  description TEXT NOT NULL DEFAULT '',
  construction_start_year INTEGER NOT NULL CHECK (construction_start_year BETWEEN 2000 AND 2100),
  operation_start_year INTEGER NOT NULL CHECK (operation_start_year BETWEEN 2000 AND 2100),
  horizon_years INTEGER NOT NULL CHECK (horizon_years BETWEEN 1 AND 60),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (operation_start_year > construction_start_year)
);
CREATE INDEX idx_if_project_org ON if_project(org_id, status);

CREATE TABLE if_scenario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES if_project(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  assumptions_hash TEXT NOT NULL,
  source_file_object_id INTEGER REFERENCES file_object(id),
  source_file_name TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, code)
);

CREATE TABLE if_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES if_scenario(id),
  kind TEXT NOT NULL CHECK (kind IN ('base','sensitivity')),
  scenario_version INTEGER NOT NULL,
  project_years_json TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  parameter_hash TEXT NOT NULL,
  model_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
  all_checks_passed INTEGER CHECK (all_checks_passed IN (0,1)),
  result_json TEXT,
  error_message TEXT,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_if_run_scenario ON if_run(scenario_id, kind, id);
CREATE TRIGGER trg_if_run_u BEFORE UPDATE ON if_run BEGIN SELECT RAISE(ABORT, '测算运行结果冻结,不可修改'); END;
CREATE TRIGGER trg_if_run_d BEFORE DELETE ON if_run BEGIN SELECT RAISE(ABORT, '测算运行结果不可删除'); END;

CREATE TABLE if_import (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES if_project(id),
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','confirmed')),
  assumptions_json TEXT,
  errors_json TEXT NOT NULL DEFAULT '[]',
  scenario_id INTEGER REFERENCES if_scenario(id),
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
`,
  },
  {
    version: 55,
    name: 'investment_control',
    sql: `
/* investment_control(四算对比,AC-F13,T-5)。金额整数分;版本确认后科目冻结;对比快照不可修改/删除。 */
CREATE TABLE ic_project (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  md_project_id INTEGER NOT NULL UNIQUE REFERENCES md_project(id),
  org_id INTEGER NOT NULL REFERENCES org(id),
  approved_cents INTEGER CHECK (approved_cents IS NULL OR approved_cents >= 0),
  approval_doc_no TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ic_project_org ON ic_project(org_id, status);

CREATE TABLE ic_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES ic_project(id),
  version_type TEXT NOT NULL CHECK (version_type IN ('estimate','design_estimate','adjusted_estimate','construction_budget','settlement','final_account')),
  version_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','voided')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  static_cents INTEGER NOT NULL DEFAULT 0,
  dynamic_cents INTEGER NOT NULL DEFAULT 0,
  approval_doc_no TEXT NOT NULL DEFAULT '',
  approval_date TEXT,
  source_file_object_id INTEGER REFERENCES file_object(id),
  source_file_name TEXT,
  content_hash TEXT,
  void_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  confirmed_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, version_type, version_no),
  CHECK (is_current = 0 OR status = 'confirmed')
);
CREATE UNIQUE INDEX idx_ic_version_current ON ic_version(project_id, version_type) WHERE is_current = 1;

CREATE TABLE ic_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES ic_version(id),
  row_no INTEGER NOT NULL,
  item_code TEXT NOT NULL,
  parent_code TEXT,
  level INTEGER NOT NULL CHECK (level >= 1),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  static_cents INTEGER NOT NULL CHECK (static_cents >= 0),
  dynamic_cents INTEGER NOT NULL CHECK (dynamic_cents >= 0),
  source_cell TEXT,
  canonical_code TEXT,
  mapping_status TEXT NOT NULL CHECK (mapping_status IN ('matched','need_mapping','manual','ignored')),
  mapping_method TEXT,
  UNIQUE (version_id, item_code)
);
CREATE TRIGGER trg_ic_item_frozen_u BEFORE UPDATE ON ic_item
WHEN (SELECT status FROM ic_version WHERE id = OLD.version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, '已确认版本的科目不可修改'); END;
CREATE TRIGGER trg_ic_item_frozen_d BEFORE DELETE ON ic_item
WHEN (SELECT status FROM ic_version WHERE id = OLD.version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, '已确认版本的科目不可删除'); END;

CREATE TABLE ic_import (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES ic_project(id),
  version_type TEXT NOT NULL,
  file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  errors_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','confirmed')),
  version_id INTEGER REFERENCES ic_version(id),
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE TABLE ic_comparison (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES ic_project(id),
  base_version_id INTEGER NOT NULL REFERENCES ic_version(id),
  target_version_id INTEGER NOT NULL REFERENCES ic_version(id),
  base_content_hash TEXT NOT NULL,
  target_content_hash TEXT NOT NULL,
  redline_version_id INTEGER REFERENCES ic_version(id),
  thresholds_json TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ic_comparison_project ON ic_comparison(project_id, id);
CREATE TRIGGER trg_ic_comparison_u BEFORE UPDATE ON ic_comparison BEGIN SELECT RAISE(ABORT, '对比快照不可修改'); END;
CREATE TRIGGER trg_ic_comparison_d BEFORE DELETE ON ic_comparison BEGIN SELECT RAISE(ABORT, '对比快照不可删除'); END;
`,
  },
  {
    version: 56,
    name: 'finance_forecast',
    sql: `
/* finance_forecast(AC-F11,T-5)。工作簿以 JSON 保存,内置受限公式引擎在 Worker 中重算;
   冻结版本不可修改;运行结束(成功/失败)后不可修改,失败不保存部分输出。 */
CREATE TABLE ff_model (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  org_id INTEGER NOT NULL REFERENCES org(id),
  base_year INTEGER NOT NULL CHECK (base_year BETWEEN 2000 AND 2100),
  horizon_years INTEGER NOT NULL CHECK (horizon_years BETWEEN 1 AND 30),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ff_model_org ON ff_model(org_id, status);

CREATE TABLE ff_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES ff_model(id),
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','frozen')),
  workbook_json TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '[]',
  outputs_json TEXT NOT NULL DEFAULT '[]',
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  source_file_object_id INTEGER REFERENCES file_object(id),
  source_file_name TEXT,
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frozen_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  frozen_at TEXT,
  UNIQUE (model_id, version_no)
);
CREATE TRIGGER trg_ff_version_frozen_u BEFORE UPDATE ON ff_version WHEN OLD.status = 'frozen'
BEGIN SELECT RAISE(ABORT, '冻结的预测版本不可修改'); END;
CREATE TRIGGER trg_ff_version_d BEFORE DELETE ON ff_version BEGIN SELECT RAISE(ABORT, '预测版本不可删除'); END;

CREATE TABLE ff_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES ff_version(id),
  kind TEXT NOT NULL CHECK (kind IN ('baseline','scenario')),
  scenario_name TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  outputs_json TEXT,
  error_code TEXT,
  error_message TEXT,
  diagnostics_json TEXT,
  job_id INTEGER,
  duration_ms INTEGER,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (status <> 'succeeded' OR outputs_json IS NOT NULL),
  CHECK (status <> 'failed' OR outputs_json IS NULL)
);
CREATE INDEX idx_ff_run_version ON ff_run(version_id, id);
CREATE UNIQUE INDEX idx_ff_run_baseline ON ff_run(version_id) WHERE kind = 'baseline' AND status = 'succeeded';
CREATE TRIGGER trg_ff_run_final_u BEFORE UPDATE ON ff_run WHEN OLD.status IN ('succeeded','failed')
BEGIN SELECT RAISE(ABORT, '已结束的预测运行不可修改'); END;
CREATE TRIGGER trg_ff_run_d BEFORE DELETE ON ff_run BEGIN SELECT RAISE(ABORT, '预测运行不可删除'); END;
`,
  },
  {
    version: 57,
    name: 'risk_workflow',
    sql: `
/* risk_workflow(AC-F17,T-5)。event_key = 规则:对象类型:对象ID[:子项],同一对象跨批次不拆单;
   时间线只追加。状态:open→confirmed→rectifying→rectified→closed;open/confirmed→false_positive;rectified→rectifying(退回);
   closed 再次命中由扫描重开为 open。 */
CREATE TABLE risk_rule (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('project_budget','plan','contract','investment_control','feasibility')),
  level TEXT NOT NULL CHECK (level IN ('high','medium','low')),
  threshold TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  suggestion TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at TEXT
);
INSERT INTO risk_rule (code, name, source, level, threshold, suggestion) VALUES
  ('PB_LOW_EXEC', '项目预算执行率偏低', 'project_budget', 'medium', '0.3', '核实项目进度与资金拨付计划，必要时调整年度预算。'),
  ('PB_OVER_BUDGET', '项目预算超支', 'project_budget', 'high', NULL, '核查超支原因，补办预算调整或停止无预算支出。'),
  ('PLAN_LOW_EXEC', '年度投资计划执行率偏低', 'plan', 'medium', '0.5', '分析计划滞后原因，制定赶工或调整计划措施。'),
  ('CONTRACT_PAY_OVER_CAP', '合同付款超过付款上限比例', 'contract', 'high', NULL, '核对付款节点与结算依据，暂停超比例付款。'),
  ('IC_OVER_REDLINE', '投资超出批复概算红线', 'investment_control', 'high', NULL, '履行调整概算审批，落实超概原因与责任。'),
  ('IC_CONTROL_BREAK', '四算控制链被突破', 'investment_control', 'high', NULL, '复核预算/结算编制依据与变更签证。'),
  ('IC_DEVIATION_EXCEED', '科目投资偏差超限', 'investment_control', 'medium', NULL, '分析偏差科目的设计变更、价格或工程量原因。'),
  ('FEAS_NPV_NEGATIVE', '可行性测算净现值为负', 'feasibility', 'high', NULL, '复核收入、成本、投资和融资参数。'),
  ('FEAS_IRR_LOW', '可行性测算收益率未达标或无解', 'feasibility', 'medium', NULL, '开展价格、发电量、成本和投资敏感性复核。'),
  ('FEAS_DSCR_LOW', '偿债覆盖率不足', 'feasibility', 'medium', NULL, '调整资本金、贷款期限或运营现金流安排。'),
  ('FEAS_FUNDING_GAP', '测算期存在资金缺口', 'feasibility', 'medium', NULL, '补充备用资金或调整融资与还款节奏。'),
  ('FEAS_MODEL_CHECK', '测算模型检查未通过', 'feasibility', 'high', NULL, '修正参数后重新测算，不得绕过模型检查。');

CREATE TABLE risk_scan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_json TEXT NOT NULL,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  cleared_count INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE risk_event (
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
CREATE INDEX idx_risk_event_org ON risk_event(org_id, status);
CREATE INDEX idx_risk_event_rule ON risk_event(rule_code, status);

CREATE TABLE risk_action (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES risk_event(id),
  action TEXT NOT NULL CHECK (action IN ('detect','redetect','reopen','suppressed','confirm','start','submit','approve','return','false_positive','comment')),
  from_status TEXT,
  to_status TEXT,
  comment TEXT NOT NULL DEFAULT '',
  attachment_file_object_id INTEGER REFERENCES file_object(id),
  attachment_name TEXT,
  scan_id INTEGER REFERENCES risk_scan(id),
  exception_reason TEXT,
  actor_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_risk_action_event ON risk_action(event_id, id);
CREATE TRIGGER trg_risk_action_u BEFORE UPDATE ON risk_action BEGIN SELECT RAISE(ABORT, '风险时间线只追加'); END;
CREATE TRIGGER trg_risk_action_d BEFORE DELETE ON risk_action BEGIN SELECT RAISE(ABORT, '风险时间线只追加'); END;
`,
  },
  {
    version: 58,
    name: 'ai_reports',
    sql: `
/* ai_reports(AC-F18,T-5)。draft→pending_approval→approved→published;published 只能修订(新修订号的 draft),
   新修订发布后旧版 superseded。审批后章节冻结;发布快照与 DOCX/PDF 产物不可修改。 */
CREATE TABLE rpt_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_no TEXT NOT NULL,
  revision_no INTEGER NOT NULL DEFAULT 1,
  previous_report_id INTEGER REFERENCES rpt_report(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('monthly_execution','annual_review','budget_discussion','risk_investment')),
  params_json TEXT NOT NULL DEFAULT '{}',
  org_id INTEGER REFERENCES org(id),
  year INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','published','superseded')),
  model_status TEXT NOT NULL DEFAULT 'template',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT,
  approved_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at TEXT,
  approval_comment TEXT,
  exception_reason TEXT,
  self_approval INTEGER NOT NULL DEFAULT 0 CHECK (self_approval IN (0,1)),
  return_comment TEXT,
  published_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  published_at TEXT,
  UNIQUE (series_no, revision_no)
);
CREATE INDEX idx_rpt_report_org ON rpt_report(org_id, status);
CREATE UNIQUE INDEX idx_rpt_report_open_revision ON rpt_report(series_no) WHERE status IN ('draft','pending_approval','approved');
CREATE TRIGGER trg_rpt_report_frozen BEFORE UPDATE OF title, kind, params_json, org_id, year, series_no, revision_no ON rpt_report
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, '报告已提交或发布,内容冻结'); END;
CREATE TRIGGER trg_rpt_report_d BEFORE DELETE ON rpt_report WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, '只有草稿报告可以删除'); END;

CREATE TABLE rpt_section (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES rpt_report(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '{}',
  citations_json TEXT NOT NULL DEFAULT '[]',
  edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0,1)),
  updated_at TEXT NOT NULL,
  UNIQUE (report_id, key)
);
CREATE TRIGGER trg_rpt_section_frozen BEFORE UPDATE ON rpt_section
WHEN (SELECT status FROM rpt_report WHERE id = OLD.report_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, '报告已提交或发布,章节冻结'); END;

CREATE TABLE rpt_section_edit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES rpt_report(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES rpt_section(id) ON DELETE CASCADE,
  before_body TEXT NOT NULL,
  after_body TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER trg_rpt_section_edit_u BEFORE UPDATE ON rpt_section_edit BEGIN SELECT RAISE(ABORT, '修改历史只追加'); END;

CREATE TABLE rpt_publication (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL UNIQUE REFERENCES rpt_report(id),
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  docx_file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  pdf_file_object_id INTEGER NOT NULL REFERENCES file_object(id),
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER trg_rpt_publication_u BEFORE UPDATE ON rpt_publication BEGIN SELECT RAISE(ABORT, '发布快照不可修改'); END;
CREATE TRIGGER trg_rpt_publication_d BEFORE DELETE ON rpt_publication BEGIN SELECT RAISE(ABORT, '发布快照不可删除'); END;
`,
  },
  {
    version: 59,
    name: 'risk_investment_linkage',
    rebuild: true,
    sql: `
/* risk_investment_linkage(T-5 联动):CHECK 枚举扩展只能整表重建(同 V53)。
   - ma_metric.calculator 追加 risk_open_amount / investment_deviation_rate;
   - std_report.report_type 追加 risk_rectification_ledger(风险整改台账)。
   rebuild 迁移:外键关闭后在单事务内“建新表 → 全量复制 → 删旧表 → 改名 → 重建索引与触发器”,
   提交前 foreign_key_check;子表 REFERENCES 按表名解析,改名后自然指回新表。 */
CREATE TABLE ma_metric_v59 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('money','ratio')),
  calculator TEXT NOT NULL CHECK (calculator IN ('budget_amount','actual_amount','execution_rate','eas_balance','statement_item','allocated_cost',
    'contract_paid','contract_payment_rate','plan_execution_rate','risk_open_amount','investment_deviation_rate')),
  params_json TEXT NOT NULL DEFAULT '{}',
  thresholds_json TEXT NOT NULL DEFAULT '{}',
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO ma_metric_v59 (id, code, name, unit, calculator, params_json, thresholds_json, builtin, status, version, created_by_user_id, created_at, updated_at)
  SELECT id, code, name, unit, calculator, params_json, thresholds_json, builtin, status, version, created_by_user_id, created_at, updated_at FROM ma_metric;
DROP TABLE ma_metric;
ALTER TABLE ma_metric_v59 RENAME TO ma_metric;

CREATE TABLE std_report_v59 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL CHECK (report_type IN ('budget_execution','statement_summary','eas_recon','contract_payment_ledger','risk_rectification_ledger')),
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
INSERT INTO std_report_v59 (id, report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, status,
    generated_by_user_id, generated_at, reviewed_by_user_id, reviewed_at, review_comment, exception_reason, self_review)
  SELECT id, report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, status,
    generated_by_user_id, generated_at, reviewed_by_user_id, reviewed_at, review_comment, exception_reason, self_review FROM std_report;
DROP TABLE std_report;
ALTER TABLE std_report_v59 RENAME TO std_report;
CREATE INDEX idx_std_report_type ON std_report(report_type, period);
CREATE INDEX idx_std_report_org ON std_report(org_id);
CREATE TRIGGER trg_std_report_frozen_u BEFORE UPDATE OF report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json,
  sources_json, content_sha256, generated_by_user_id, generated_at ON std_report
BEGIN SELECT RAISE(ABORT, '标准报表冻结内容不可修改'); END;
CREATE TRIGGER trg_std_report_review_once BEFORE UPDATE OF status ON std_report
WHEN NOT (OLD.status = 'generated' AND NEW.status = 'reviewed')
BEGIN SELECT RAISE(ABORT, '标准报表只能复核一次'); END;
CREATE TRIGGER trg_std_report_d BEFORE DELETE ON std_report BEGIN SELECT RAISE(ABORT, '标准报表不可删除'); END;
`,
  },
  {
    version: 60,
    name: 'expense_clause_keyword_min',
    sql: `
/* expense_clause_keyword_min(OPEN-05 与 lishui 一致):条款必备材料可设“至少命中 N 项”。
   NULL = 每个关键词都须命中(原行为);lishui 首版规则为 min(2, 关键词数)。条款仍随制度版本冻结。 */
ALTER TABLE ex_policy_clause ADD COLUMN keyword_min_matches INTEGER CHECK (keyword_min_matches IS NULL OR keyword_min_matches >= 1);
`,
  },
  {
    version: 61,
    name: 'risk_rules_lishui_parity',
    rebuild: true,
    sql: `
/* risk_workflow(lishui 规则补齐):risk_rule.source 追加 eas,CHECK 只能整表重建(同 V53/V59)。
   - detector:命中计算器编码。内置规则 detector = code;自定义规则复用某个内置计算器,
     只改名称/等级/阈值/建议,并可限定组织(org_id,含下级)。事件键按规则 code,自定义规则与内置规则的事件互不合并。
   - builtin:内置规则不可删除;自定义规则只停用不删除(历史事件引用规则 code)。
   - 阈值按计算器声明的类型解释:ratio(0～1)或 amount(元,十进制字符串)。
   新增内置规则(对应 lishui risk/scan.py):付款超前形象进度、完成投资逼近概算、投资计划明细未关联项目(对应 PROJECT_CODE_MISSING)、
   已支付缺凭证号(对应 CONTRACT_CODE_MISSING 的付款追溯断点)、供应商大额集中付款、大额凭证缺项目辅助核算、
   预付/暂估/挂账待清理、项目预算执行与 EAS 入账差异。
   risk_ai_note:风险解释(确定性模板 + 可选模型改写)只追加,不改风险事实与状态。 */
CREATE TABLE risk_rule_v61 (
  code TEXT PRIMARY KEY CHECK (length(code) BETWEEN 3 AND 48),
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('project_budget','plan','contract','investment_control','feasibility','eas')),
  detector TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 1 CHECK (builtin IN (0,1)),
  org_id INTEGER REFERENCES org(id),
  level TEXT NOT NULL CHECK (level IN ('high','medium','low')),
  threshold TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  suggestion TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT,
  updated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at TEXT,
  CHECK (builtin = 0 OR org_id IS NULL)
);
INSERT INTO risk_rule_v61 (code, name, source, detector, builtin, level, threshold, enabled, suggestion, version, updated_by_user_id, updated_at)
  SELECT code, name, source, code, 1, level, threshold, enabled, suggestion, version, updated_by_user_id, updated_at FROM risk_rule;
DROP TABLE risk_rule;
ALTER TABLE risk_rule_v61 RENAME TO risk_rule;
INSERT INTO risk_rule (code, name, source, detector, level, threshold, suggestion) VALUES
  ('PLAN_PAY_AHEAD_PROGRESS', '付款进度超前于形象进度', 'plan', 'PLAN_PAY_AHEAD_PROGRESS', 'medium', '0.2', '核对付款节点与工程量确认,暂停超进度付款。'),
  ('PLAN_ESTIMATE_NEAR_LIMIT', '累计完成投资逼近批复概算', 'plan', 'PLAN_ESTIMATE_NEAR_LIMIT', 'high', '0.9', '评估剩余工程量与概算余额,必要时启动概算调整。'),
  ('PLAN_PROJECT_UNMAPPED', '投资计划明细未关联项目', 'plan', 'PLAN_PROJECT_UNMAPPED', 'low', NULL, '在主数据中补齐项目或编码映射后重新导入计划,保证跨系统可核对。'),
  ('CONTRACT_PAY_NO_VOUCHER', '已支付款项缺少凭证号', 'contract', 'CONTRACT_PAY_NO_VOUCHER', 'medium', NULL, '补登支付凭证号,保证付款可追溯到 EAS 凭证。'),
  ('SUPPLIER_LARGE_PAYMENTS', '供应商大额集中付款', 'contract', 'SUPPLIER_LARGE_PAYMENTS', 'medium', '1000000', '核查同一供应商多笔付款的合同依据与审批链。'),
  ('EAS_PROJECT_CODE_MISSING', '大额凭证缺少项目辅助核算', 'eas', 'EAS_PROJECT_CODE_MISSING', 'medium', '100000', '补录项目辅助核算或说明不归属项目的原因。'),
  ('EAS_LONG_UNCLEARED', '预付/暂估/挂账事项待清理', 'eas', 'EAS_LONG_UNCLEARED', 'low', NULL, '核对往来账龄,按合同与发票及时清理预付、暂估与挂账。'),
  ('EAS_BUDGET_DIFF', '项目预算执行与 EAS 入账差异', 'eas', 'EAS_BUDGET_DIFF', 'medium', '0.1', '逐项核对项目预算执行数与 EAS 凭证,查明口径或入账差异。');

CREATE TABLE risk_ai_note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES risk_event(id),
  kind TEXT NOT NULL CHECK (kind IN ('explain')),
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('template','model')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_risk_ai_note_event ON risk_ai_note(event_id, id);
CREATE TRIGGER trg_risk_ai_note_u BEFORE UPDATE ON risk_ai_note BEGIN SELECT RAISE(ABORT, '风险解释只追加'); END;
CREATE TRIGGER trg_risk_ai_note_d BEFORE DELETE ON risk_ai_note BEGIN SELECT RAISE(ABORT, '风险解释只追加'); END;
`,
  },
  {
    version: 62,
    name: 'forecast_workflow',
    sql: `
/* finance_forecast 补齐 lishui 能力(T-7):模型目录、版本复核、运行发布、运行洞察。
   冻结版本与已结束运行本身不可修改,因此复核/发布/洞察各自独立成表:复核与洞察只追加;发布只允许撤回一次。 */
ALTER TABLE ff_model ADD COLUMN folder TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_ff_model_folder ON ff_model(folder);

CREATE TABLE ff_version_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES ff_version(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','return')),
  comment TEXT NOT NULL DEFAULT '',
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1)),
  reviewer_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ff_version_review_once ON ff_version_review(version_id);
CREATE TRIGGER trg_ff_version_review_u BEFORE UPDATE ON ff_version_review BEGIN SELECT RAISE(ABORT, '版本复核记录不可修改'); END;
CREATE TRIGGER trg_ff_version_review_d BEFORE DELETE ON ff_version_review BEGIN SELECT RAISE(ABORT, '版本复核记录不可删除'); END;

CREATE TABLE ff_run_publication (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL UNIQUE REFERENCES ff_run(id),
  model_id INTEGER NOT NULL REFERENCES ff_model(id),
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  published_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  published_at TEXT NOT NULL,
  withdrawn_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  withdrawn_at TEXT,
  withdraw_reason TEXT,
  CHECK ((withdrawn_at IS NULL) = (withdraw_reason IS NULL))
);
CREATE INDEX idx_ff_run_publication_model ON ff_run_publication(model_id, id);
CREATE TRIGGER trg_ff_run_publication_u BEFORE UPDATE ON ff_run_publication
  WHEN OLD.withdrawn_at IS NOT NULL OR NEW.run_id <> OLD.run_id OR NEW.model_id <> OLD.model_id OR NEW.title <> OLD.title OR NEW.note <> OLD.note
    OR NEW.published_at <> OLD.published_at OR NEW.withdrawn_at IS NULL
BEGIN SELECT RAISE(ABORT, '发布记录只允许撤回一次'); END;
CREATE TRIGGER trg_ff_run_publication_d BEFORE DELETE ON ff_run_publication BEGIN SELECT RAISE(ABORT, '发布记录不可删除'); END;

CREATE TABLE ff_run_insight (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ff_run(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('template','model')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ff_run_insight_run ON ff_run_insight(run_id, id);
CREATE TRIGGER trg_ff_run_insight_u BEFORE UPDATE ON ff_run_insight BEGIN SELECT RAISE(ABORT, '预测洞察只追加'); END;
CREATE TRIGGER trg_ff_run_insight_d BEFORE DELETE ON ff_run_insight BEGIN SELECT RAISE(ABORT, '预测洞察只追加'); END;

/* 新权限 forecast:review 授予已存在的业务复核角色(新库由内置角色模板带出)。 */
INSERT OR IGNORE INTO app_role_permission (role_id, permission) SELECT id, 'forecast:review' FROM app_role WHERE code = 'business_reviewer';
`,
  },
  {
    version: 63,
    name: 'feasibility_workflow',
    sql: `
/* investment_feasibility 补齐 lishui(T-7,AC-F12):基准方案(每项目至多一个)、方案删除(软删,运行留存)、
   可行性报告:由成功基准运行生成(模板 + 可选模型改写),草稿 → 提交复核 → 通过/退回;退回可重新提交;通过后冻结。 */
ALTER TABLE if_scenario ADD COLUMN is_baseline INTEGER NOT NULL DEFAULT 0 CHECK (is_baseline IN (0,1));
ALTER TABLE if_scenario ADD COLUMN deleted_at TEXT;
ALTER TABLE if_scenario ADD COLUMN deleted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_if_scenario_baseline ON if_scenario(project_id) WHERE is_baseline = 1;
CREATE TRIGGER trg_if_scenario_baseline_deleted BEFORE UPDATE OF is_baseline ON if_scenario
  WHEN NEW.is_baseline = 1 AND NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT, '已删除方案不能设为基准'); END;
CREATE TRIGGER trg_if_scenario_d BEFORE DELETE ON if_scenario BEGIN SELECT RAISE(ABORT, '方案只能软删除'); END;

CREATE TABLE if_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES if_scenario(id),
  run_id INTEGER NOT NULL REFERENCES if_run(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('template','model')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','approved','returned')),
  submitted_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at TEXT,
  reviewer_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_comment TEXT,
  exception_reason TEXT,
  self_review INTEGER NOT NULL DEFAULT 0 CHECK (self_review IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status NOT IN ('approved','returned') OR reviewed_at IS NOT NULL)
);
CREATE INDEX idx_if_report_scenario ON if_report(scenario_id, id);
CREATE INDEX idx_if_report_status ON if_report(status, id);
CREATE TRIGGER trg_if_report_content BEFORE UPDATE OF content, run_id, scenario_id, source, model, prompt_version ON if_report
  BEGIN SELECT RAISE(ABORT, '可行性报告正文与依据运行不可修改,请重新生成'); END;
CREATE TRIGGER trg_if_report_approved BEFORE UPDATE ON if_report WHEN OLD.status = 'approved'
  BEGIN SELECT RAISE(ABORT, '已复核通过的可行性报告不可修改'); END;
CREATE TRIGGER trg_if_report_d BEFORE DELETE ON if_report BEGIN SELECT RAISE(ABORT, '可行性报告不可删除'); END;

/* 新权限 investment:review 授予已存在的业务复核角色。 */
INSERT OR IGNORE INTO app_role_permission (role_id, permission) SELECT id, 'investment:review' FROM app_role WHERE code = 'business_reviewer';
`,
  },
];
