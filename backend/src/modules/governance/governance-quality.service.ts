/**
 * 数据治理补齐 lishui(T-7,AC-F06):质量评分、主数据匹配建议。
 *
 * - 质量评分按来源分维度:一致性(EAS 预检)、完整性(EAS 主数据对应)、准确性(财报校验)。
 *   维度分 = 100 − 8×未处理错误 − 2×未处理警告 − 1×待复核,下限 0;综合分按 0.4/0.3/0.3 加权,保留两位小数。
 *   只统计当前用户组织范围内的问题;规则固定,页面展示公式,便于解释。
 * - 匹配建议只读:对未处理/待复核的 EAS 主数据问题,按项目名称(凭证行上的项目名)或供应商名称与有效主数据做相似度打分,
 *   给出前 3 个候选(≥0.6);不比编码(同批顺序编码彼此高度相似,会误导);采用建议仍走“映射覆盖”处置 → 复核,不自动写映射。项目候选按组织范围裁剪。
 */
import type { DB } from '../../db/connection';
import { currentAuth } from '../../core/request-context';
import { fuzzySimilarity, normalizeMatchText } from '../../core/text-similarity';
import { orgInScope, resolveOrgScope, type OrgScope } from '../security/scope';
import type { GovMatchSuggestionDto, GovQualityScoreDto, GovSourceType } from '../../contracts/governance';
import { getIssue } from './governance.service';

function scope(db: DB): OrgScope {
  const auth = currentAuth();
  return auth ? resolveOrgScope(db, auth) : { all: true };
}
function scopeWhere(s: OrgScope, where: string[], params: unknown[]): boolean {
  if (s.all) return true;
  if (s.orgIds.size === 0) return false;
  where.push(`org_id IN (${[...s.orgIds].map(() => '?').join(',')})`);
  params.push(...s.orgIds);
  return true;
}

const DIMENSIONS: { key: string; label: string; sourceType: GovSourceType; weight: number }[] = [
  { key: 'consistency', label: '一致性(EAS 预检)', sourceType: 'eas_recon', weight: 40 },
  { key: 'completeness', label: '完整性(EAS 主数据对应)', sourceType: 'eas_master', weight: 30 },
  { key: 'accuracy', label: '准确性(财报校验)', sourceType: 'statement', weight: 30 },
];
const PENALTY = { openError: 8, openWarning: 2, pendingReview: 1 };
const fmt2 = (hundredths: number) => `${Math.trunc(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;

export function governanceQualityScore(db: DB, q: { orgId?: number; period?: string } = {}): GovQualityScoreDto {
  const where: string[] = [];
  const params: unknown[] = [];
  const visible = scopeWhere(scope(db), where, params);
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  const rows = !visible ? [] : db.prepare(`SELECT source_type, severity, status, COUNT(*) AS n FROM gov_issue ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY source_type, severity, status`).all(...params) as { source_type: GovSourceType; severity: 'error' | 'warning'; status: string; n: number }[];
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((s, r) => s + r.n, 0);
  let weighted = 0; // 分数 × 权重(权重百分比),最后换算为百分之一分
  const dimensions = DIMENSIONS.map((d) => {
    const mine = (r: (typeof rows)[number]) => r.source_type === d.sourceType;
    const openErrors = count((r) => mine(r) && r.status === 'open' && r.severity === 'error');
    const openWarnings = count((r) => mine(r) && r.status === 'open' && r.severity === 'warning');
    const pendingReview = count((r) => mine(r) && r.status === 'pending_review');
    const score = Math.max(0, 100 - PENALTY.openError * openErrors - PENALTY.openWarning * openWarnings - PENALTY.pendingReview * pendingReview);
    weighted += score * d.weight;
    return {
      key: d.key, label: d.label, sourceType: d.sourceType, weight: `0.${String(d.weight).padStart(2, '0')}`, score: fmt2(score * 100),
      total: count(mine), openErrors, openWarnings, pendingReview, closed: count((r) => mine(r) && (r.status === 'resolved' || r.status === 'dismissed')),
    };
  });
  const total = count(() => true);
  return {
    score: fmt2(weighted), // Σ(分数 × 权重%) 即百分之一分
    grade: weighted >= 9000 ? '优' : weighted >= 7500 ? '良' : weighted >= 6000 ? '中' : '差',
    dimensions,
    totals: {
      total, open: count((r) => r.status === 'open'), pendingReview: count((r) => r.status === 'pending_review'),
      resolved: count((r) => r.status === 'resolved'), dismissed: count((r) => r.status === 'dismissed'),
    },
    formula: `维度分 = 100 − ${PENALTY.openError}×未处理错误 − ${PENALTY.openWarning}×未处理警告 − ${PENALTY.pendingReview}×待复核(下限 0);综合分 = ${DIMENSIONS.map((d) => `${d.label.split('(')[0]}×0.${d.weight}`).join(' + ')}`,
    computedAt: new Date().toISOString(),
  };
}

/* ---------------- 主数据匹配建议 ---------------- */

const MIN_CONFIDENCE = 0.6;
const MAX_SUGGESTIONS = 3;
interface IssueLite { id: number; version: number; org_id: number | null; period: string; status: string; detail_json: string; title: string }

function suggestionsFor(db: DB, s: OrgScope, issue: IssueLite): GovMatchSuggestionDto {
  const detail = JSON.parse(issue.detail_json) as { entity: 'project' | 'supplier'; value: string; batchId: number; lineCount: number; candidates?: { id: number; code: string; name: string }[] };
  const sourceNames = detail.entity === 'project'
    ? (db.prepare(`SELECT project_name AS n, COUNT(*) AS c FROM eas_voucher_line WHERE batch_id = ? AND project_code = ? AND project_name IS NOT NULL AND project_name != ''
        GROUP BY project_name ORDER BY c DESC, project_name LIMIT 3`).all(detail.batchId, detail.value) as { n: string }[]).map((r) => r.n)
    : [detail.value];
  const targets = detail.entity === 'project'
    ? (db.prepare("SELECT id, code, name, org_id FROM md_project WHERE status = 'active'").all() as { id: number; code: string; name: string; org_id: number }[])
      .filter((p) => orgInScope(s, p.org_id))
    : db.prepare("SELECT id, COALESCE(code, '') AS code, name FROM md_supplier WHERE status = 'active'").all() as { id: number; code: string; name: string }[];
  const scored = new Map<number, { targetId: number; code: string | null; name: string; score: number; reason: string }>();
  const consider = (t: { id: number; code: string; name: string }, score: number, reason: string) => {
    const prev = scored.get(t.id);
    if (!prev || score > prev.score) scored.set(t.id, { targetId: t.id, code: t.code || null, name: t.name, score, reason });
  };
  for (const t of targets) {
    for (const n of sourceNames) {
      const src = normalizeMatchText(n);
      if (src) consider(t, fuzzySimilarity(src, { code: '', name: t.name }), detail.entity === 'project' ? `凭证项目名“${n}”与主数据名称相似` : '供应商名称相似');
    }
  }
  const visibleIds = new Set(targets.map((t) => t.id));
  for (const c of detail.candidates ?? []) {
    if (visibleIds.has(c.id)) consider(c, 0.9, '已有多个映射候选(需人工确认)');
  }
  const suggestions = [...scored.values()].filter((x) => x.score >= MIN_CONFIDENCE)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN')).slice(0, MAX_SUGGESTIONS)
    .map((x) => ({ targetId: x.targetId, code: x.code, name: x.name, confidence: (Math.round(x.score * 100) / 100).toFixed(2), reason: x.reason }));
  const orgName = issue.org_id == null ? null : (db.prepare('SELECT name FROM org WHERE id = ?').get(issue.org_id) as { name: string } | undefined)?.name ?? null;
  return {
    issueId: issue.id, issueVersion: issue.version, status: issue.status as GovMatchSuggestionDto['status'], entity: detail.entity, value: detail.value,
    orgName, period: issue.period, lineCount: detail.lineCount, sourceNames, suggestions,
  };
}

/** 未处理/待复核的 EAS 主数据问题及其匹配建议(范围内,最多 200 条)。 */
export function listMasterDataMatches(db: DB, q: { orgId?: number; period?: string; withSuggestionsOnly?: boolean } = {}): { items: GovMatchSuggestionDto[] } {
  const s = scope(db);
  const where = ["source_type = 'eas_master'", "status IN ('open', 'pending_review')"];
  const params: unknown[] = [];
  if (!scopeWhere(s, where, params)) return { items: [] };
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  const rows = db.prepare(`SELECT id, version, org_id, period, status, detail_json, title FROM gov_issue WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`).all(...params) as IssueLite[];
  const items = rows.map((r) => suggestionsFor(db, s, r));
  return { items: q.withSuggestionsOnly ? items.filter((i) => i.suggestions.length > 0) : items };
}

/** 单个问题的匹配建议;范围外/不存在 404(复用问题详情的可见性),非主数据问题返回空建议。 */
export function issueMatchSuggestions(db: DB, id: number): GovMatchSuggestionDto | null {
  const issue = getIssue(db, id);
  if (issue.sourceType !== 'eas_master') return null;
  const row = db.prepare('SELECT id, version, org_id, period, status, detail_json, title FROM gov_issue WHERE id = ?').get(id) as IssueLite;
  return suggestionsFor(db, scope(db), row);
}
