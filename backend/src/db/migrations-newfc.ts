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
];
