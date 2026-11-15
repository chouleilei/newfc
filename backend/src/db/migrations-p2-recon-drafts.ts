/**
 * 阶段三 P2 数据库迁移（V75）：
 * 1. ex_split_alert_log：报销 ≤ 30,000.00 元滚动窗口高频拆单监测日志表（联动 PW_14 风险事件）；
 * 2. eas_recon_note：EAS 2241 质保金到期、供应商异常负余额、1604 在建工程遗留财务核对备注表（只写附加台账，不改动 EAS 原始导入表）。
 */
export const P2_RECON_DRAFTS_V75_SQL = `
CREATE TABLE IF NOT EXISTS ex_split_alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES org(id),
  normalized_category TEXT NOT NULL,
  supplier_or_payee TEXT,
  window_days INTEGER NOT NULL DEFAULT 30 CHECK (window_days >= 1),
  anchor_date TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL,
  claim_nos_json TEXT NOT NULL,
  claim_count INTEGER NOT NULL CHECK (claim_count >= 2),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  risk_event_id INTEGER REFERENCES risk_event(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ex_split_alert_org ON ex_split_alert_log(org_id, anchor_date DESC);

CREATE TABLE IF NOT EXISTS eas_recon_note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES org(id),
  period TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('warranty_2241_overdue','supplier_negative_balance','cip_1604_legacy')),
  target_key TEXT NOT NULL,
  recon_status TEXT NOT NULL CHECK (recon_status IN ('pending','to_writeoff','explained_normal','resolved')),
  voucher_ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated_by_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, period, target_key)
);
CREATE INDEX IF NOT EXISTS idx_eas_recon_note_lookup ON eas_recon_note(org_id, period, category, recon_status);
`;
