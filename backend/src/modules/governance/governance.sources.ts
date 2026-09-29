/**
 * 数据治理的问题来源:把来源事实转换为问题候选,并按 source_ref 重算来源事实哈希。
 * source_ref 形如 `eas_recon_result:<id>`、`eas_batch:<id>:project:<编码>`、`eas_batch:<id>:supplier:<名称>`、
 * `statement_batch:<id>:<检查码>`;哈希只覆盖不可变的来源行,所以正常情况下永不变化。
 */
import crypto from 'crypto';
import type { DB } from '../../db/connection';
import { resolveEntity } from '../master/master.service';
import type { OrgScope } from '../security/scope';
import { EAS_SOURCE_SYSTEM } from '../eas/eas.service';
import type { GovScanRequest, GovSourceType } from '../../contracts/governance';

export interface IssueCandidate {
  issueKey: string; sourceType: GovSourceType; problemType: string; sourceRef: string; orgId: number | null; period: string;
  severity: 'error' | 'warning'; title: string; detail: Record<string, unknown>; sourceHash: string;
}

/** 规范 JSON(对象键排序;bigint 转字符串)的 sha256。 */
export function sha256Json(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

const issueKey = (...parts: (string | number | null)[]) => sha256Json(parts.map((p) => (p === null ? '' : String(p))));

const RULE_LABELS: Record<string, string> = {
  required_files: '三类文件齐全', voucher_balance_movement: '凭证与余额发生额一致', period_continuity: '跨期连续', auxiliary_requirements: '辅助核算要求',
};

function scopeSql(s: OrgScope, column: string): { sql: string; params: number[] } {
  if (s.all) return { sql: '1=1', params: [] };
  if (s.orgIds.size === 0) return { sql: '0=1', params: [] };
  return { sql: `${column} IN (${[...s.orgIds].map(() => '?').join(',')})`, params: [...s.orgIds] };
}

function filterSql(column: { org: string; period: string }, f: GovScanRequest): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (f.orgId) { parts.push(`${column.org} = ?`); params.push(f.orgId); }
  if (f.period) { parts.push(`${column.period} = ?`); params.push(f.period); }
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
}

const orgNameOf = (db: DB, id: number) => (db.prepare('SELECT name FROM org WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `#${id}`;

/* ---------- eas_recon:每个公司期间最新一次预检中失败的规则 ---------- */

function easReconCandidates(db: DB, s: OrgScope, f: GovScanRequest): IssueCandidate[] {
  const sc = scopeSql(s, 'x.org_id');
  const ft = filterSql({ org: 'x.org_id', period: 'x.period' }, f);
  const rows = db.prepare(`SELECT r.id, r.set_id, r.rule_code, r.diff_count, x.org_id, x.period
    FROM eas_recon_set x JOIN eas_recon_result r ON r.set_id = x.id
    WHERE x.id = (SELECT MAX(y.id) FROM eas_recon_set y WHERE y.org_id = x.org_id AND y.period = x.period)
      AND r.status = 'failed' AND ${sc.sql} AND ${ft.sql} ORDER BY x.org_id, x.period, r.id`).all(...sc.params, ...ft.params) as
    { id: number; set_id: number; rule_code: string; diff_count: number; org_id: number; period: string }[];
  return rows.map((r) => {
    const ref = `eas_recon_result:${r.id}`;
    const label = RULE_LABELS[r.rule_code] ?? r.rule_code;
    return {
      issueKey: issueKey('eas_recon', r.org_id, r.period, r.rule_code), sourceType: 'eas_recon', problemType: r.rule_code, sourceRef: ref,
      orgId: r.org_id, period: r.period, severity: 'error', title: `${orgNameOf(db, r.org_id)} ${r.period} EAS 预检未通过:${label}(${r.diff_count} 处差异)`,
      detail: { setId: r.set_id, ruleCode: r.rule_code, diffCount: r.diff_count }, sourceHash: hashOfSource(db, ref),
    };
  });
}

/* ---------- eas_master:当前生效凭证中无法解析到主数据的项目编码/供应商 ---------- */

function easMasterCandidates(db: DB, s: OrgScope, f: GovScanRequest): IssueCandidate[] {
  const sc = scopeSql(s, 'b.org_id');
  const ft = filterSql({ org: 'b.org_id', period: 'b.period' }, f);
  const batches = db.prepare(`SELECT b.id, b.org_id, b.period FROM eas_batch b
    WHERE b.data_type = 'voucher' AND b.is_current = 1 AND ${sc.sql} AND ${ft.sql} ORDER BY b.id`).all(...sc.params, ...ft.params) as
    { id: number; org_id: number; period: string }[];
  const out: IssueCandidate[] = [];
  for (const b of batches) {
    const values = db.prepare(`SELECT 'project' AS entity, project_code AS value, COUNT(*) AS lines FROM eas_voucher_line WHERE batch_id = ? AND project_code IS NOT NULL GROUP BY project_code
      UNION ALL SELECT 'supplier', supplier_name, COUNT(*) FROM eas_voucher_line WHERE batch_id = ? AND supplier_name IS NOT NULL GROUP BY supplier_name`)
      .all(b.id, b.id) as { entity: 'project' | 'supplier'; value: string; lines: number }[];
    for (const v of values) {
      const r = v.entity === 'project'
        ? resolveEntity(db, 'project', { code: v.value, sourceSystem: EAS_SOURCE_SYSTEM })
        : resolveEntity(db, 'supplier', { name: v.value, sourceSystem: EAS_SOURCE_SYSTEM });
      if (r.targetId) continue;
      const ref = `eas_batch:${b.id}:${v.entity}:${v.value}`;
      const label = v.entity === 'project' ? '项目编码' : '供应商';
      out.push({
        issueKey: issueKey('eas_master', b.org_id, b.period, `unmapped_${v.entity}`, v.value), sourceType: 'eas_master', problemType: `unmapped_${v.entity}`,
        sourceRef: ref, orgId: b.org_id, period: b.period, severity: 'warning',
        title: `${orgNameOf(db, b.org_id)} ${b.period} 凭证中的${label}“${v.value}”无法对应主数据`,
        detail: { entity: v.entity, value: v.value, batchId: b.id, lineCount: v.lines, matchedBy: r.matchedBy, candidates: r.candidates.slice(0, 5) },
        sourceHash: hashOfSource(db, ref),
      });
    }
  }
  return out;
}

/* ---------- statement:当前财报批次的校验警告 ---------- */

function statementCandidates(db: DB, s: OrgScope, f: GovScanRequest): IssueCandidate[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stmt_batch'").get();
  if (!exists) return [];
  const sc = scopeSql(s, 'b.org_id');
  const ft = filterSql({ org: 'b.org_id', period: 'b.period' }, f);
  const rows = db.prepare(`SELECT b.id, b.org_id, b.period, b.checks_json FROM stmt_batch b
    WHERE b.is_current = 1 AND ${sc.sql} AND ${ft.sql} ORDER BY b.id`).all(...sc.params, ...ft.params) as
    { id: number; org_id: number; period: string; checks_json: string }[];
  const out: IssueCandidate[] = [];
  for (const b of rows) {
    const checks = JSON.parse(b.checks_json) as { code: string; level: string; message: string }[];
    for (const c of checks.filter((x) => x.level === 'warning')) {
      const ref = `statement_batch:${b.id}:${c.code}`;
      out.push({
        issueKey: issueKey('statement', b.org_id, b.period, c.code), sourceType: 'statement', problemType: c.code, sourceRef: ref,
        orgId: b.org_id, period: b.period, severity: 'warning', title: `${orgNameOf(db, b.org_id)} ${b.period} 财务报表:${c.message}`,
        detail: { batchId: b.id, code: c.code, message: c.message }, sourceHash: hashOfSource(db, ref),
      });
    }
  }
  return out;
}

export function collectCandidates(db: DB, s: OrgScope, f: GovScanRequest): IssueCandidate[] {
  return [...easReconCandidates(db, s, f), ...easMasterCandidates(db, s, f), ...statementCandidates(db, s, f)];
}

/** 按 source_ref 重算来源事实哈希;来源对象不存在时返回 'missing'。 */
export function hashOfSource(db: DB, ref: string): string {
  const [kind, idText, ...rest] = ref.split(':');
  const id = Number(idText);
  if (kind === 'eas_recon_result') {
    const row = db.prepare('SELECT id, set_id, rule_code, status, diff_count, diff_cents, details_json FROM eas_recon_result WHERE id = ?').safeIntegers(true).get(id);
    return row ? sha256Json(row) : 'missing';
  }
  if (kind === 'eas_recon_set') {
    const rows = db.prepare('SELECT id, rule_code, status, diff_count, diff_cents FROM eas_recon_result WHERE set_id = ? ORDER BY id').safeIntegers(true).all(id);
    return rows.length ? sha256Json(rows) : 'missing';
  }
  if (kind === 'eas_batch') {
    const [entity, ...valueParts] = rest;
    const value = valueParts.join(':');
    const column = entity === 'project' ? 'project_code' : entity === 'supplier' ? 'supplier_name' : null;
    if (!column) return 'missing';
    const rows = db.prepare(`SELECT id, source_row, voucher_no, entry_no, account_code, debit_cents, credit_cents FROM eas_voucher_line
      WHERE batch_id = ? AND ${column} = ? ORDER BY id`).safeIntegers(true).all(id, value);
    return rows.length ? sha256Json(rows) : 'missing';
  }
  if (kind === 'statement_batch') {
    const row = db.prepare('SELECT id, file_sha256, checks_json FROM stmt_batch WHERE id = ?').get(id);
    return row ? sha256Json({ row, check: rest.join(':') }) : 'missing';
  }
  return 'missing';
}
