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
];
