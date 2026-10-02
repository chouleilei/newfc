/**
 * 财务预测工作流(T-7,AC-F11):版本复核、运行发布/撤回、已发布列表、基准时间线、运行洞察。
 *
 * - 冻结即提交复核;复核只一次(通过/退回),提交人 ≠ 复核人(管理员同人须写例外原因)。退回的版本复制为新草稿后再冻结。
 * - 只有已复核通过版本的成功运行可以发布;同一运行只发布一次,撤回须写原因且不可恢复(重新发布需另一运行)。
 * - 基准时间线按版本号排列各冻结版本的成功基准运行,输出按行合计并与上一版对比。
 * - 洞察为确定性模板 + 可选模型改写(数字/名称护栏),只追加;模型调用在事务外。
 */
import { promptSupplement } from '../../modules/settings/prompt-supplements.service';
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { add, div, fx, FX_ZERO, sub, toFixed } from '../../core/fixed';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope, requirePermission, scopeFilterSql } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import { rewriteTemplateNarrative } from '../../assistant/narrative';
import { FORECAST_INSIGHT_REWRITE_TASK, PROMPT_VERSION } from '../../assistant/prompts';
import { forecastInsightAiEnabled } from '../../assistant/feature-flags';
import type { FfBaselineTimelineDto, FfInsightDto, FfPublicationDto, FfReviewQueueItemDto, ForecastOutput } from '../../contracts/finance-forecast';
import {
  assertActive, compareForecastRun, getForecastRun, getForecastVersion, reviewStatusOf, userName, versionReview, visibleModel, visibleVersion,
  type ModelRow, type RunRow, type VersionRow,
} from './forecast.service';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);

/* ---------------- 版本复核 ---------------- */

/** 与首页待办同口径:仅使用中模型的已冻结、尚未复核版本。 */
export function listForecastReviewQueue(db: DB, q: { orgId?: number }): { items: FfReviewQueueItemDto[] } {
  requirePermission(currentAuth(), 'forecast:read');
  const scope = currentOrgScope(db);
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const f = scopeFilterSql(scope, 'm.org_id');
  const rows = db.prepare(`SELECT v.id AS versionId, m.id AS modelId, m.name AS modelName, m.org_id AS orgId,
    o.name AS orgName, v.version_no AS versionNo, v.note, v.frozen_at AS frozenAt,
    COALESCE(NULLIF(u.display_name, ''), u.username) AS frozenBy
    FROM ff_version v JOIN ff_model m ON m.id = v.model_id JOIN org o ON o.id = m.org_id
    LEFT JOIN app_user u ON u.id = v.frozen_by_user_id
    WHERE m.status = 'active' AND v.status = 'frozen'
      AND NOT EXISTS (SELECT 1 FROM ff_version_review r WHERE r.version_id = v.id)
      AND ${f.sql}${q.orgId ? ' AND m.org_id = ?' : ''}
    ORDER BY v.frozen_at, v.id`).all(...f.params, ...(q.orgId ? [q.orgId] : [])) as FfReviewQueueItemDto[];
  return { items: rows };
}

export function reviewForecastVersion(db: DB, id: number, input: { expectedVersion: number; decision: 'approve' | 'return'; comment?: string; exceptionReason?: string }) {
  const auth = requirePermission(currentAuth(), 'forecast:review');
  db.transaction(() => {
    const { version, model } = visibleVersion(db, id);
    assertActive(model);
    if (version.status !== 'frozen') throw conflict('FORECAST_VERSION_STATE', '只有已冻结(已提交复核)的版本可以复核');
    if (version.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '版本已被其他人修改,请刷新后重试', { currentVersion: version.version });
    if (versionReview(db, id)) throw conflict('FORECAST_VERSION_STATE', '该版本已复核');
    const { selfReview } = assertDistinctReviewer(db, auth, version.frozen_by_user_id, input.exceptionReason, '预测版本');
    db.prepare(`INSERT INTO ff_version_review (version_id, decision, comment, exception_reason, self_review, reviewer_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.decision, input.comment?.trim() ?? '', selfReview ? input.exceptionReason!.trim() : null, selfReview ? 1 : 0, auth.userId, nowIso());
    writeLog(db, 'forecast.version.review', 'ff_version', id, { decision: input.decision, selfReview, contentHash: version.content_hash });
  }).immediate();
  return getForecastVersion(db, id);
}

/* ---------------- 发布 ---------------- */

interface PublicationRow {
  id: number; run_id: number; model_id: number; title: string; note: string; published_by_user_id: number | null; published_at: string;
  withdrawn_by_user_id: number | null; withdrawn_at: string | null; withdraw_reason: string | null;
}

function publicationDto(db: DB, p: PublicationRow): FfPublicationDto {
  const run = db.prepare('SELECT * FROM ff_run WHERE id = ?').get(p.run_id) as RunRow;
  const version = db.prepare('SELECT * FROM ff_version WHERE id = ?').get(run.version_id) as VersionRow;
  const model = db.prepare('SELECT * FROM ff_model WHERE id = ?').get(p.model_id) as ModelRow;
  const values = JSON.parse(run.outputs_json ?? '{}') as Record<string, string[]>;
  return {
    id: p.id, runId: p.run_id, modelId: model.id, modelName: model.name, orgId: model.org_id,
    orgName: (db.prepare('SELECT name FROM org WHERE id = ?').get(model.org_id) as { name: string } | undefined)?.name ?? '', folder: model.folder,
    versionId: version.id, versionNo: version.version_no, kind: run.kind, scenarioName: run.scenario_name, params: JSON.parse(run.params_json) as Record<string, string>,
    title: p.title, note: p.note, publishedAt: p.published_at, publishedBy: userName(db, p.published_by_user_id),
    withdrawnAt: p.withdrawn_at, withdrawnBy: userName(db, p.withdrawn_by_user_id), withdrawReason: p.withdraw_reason,
    outputs: (JSON.parse(version.outputs_json) as ForecastOutput[]).map((o) => ({ key: o.key, name: o.name, unit: o.unit, values: values[o.key] ?? [] })),
  };
}

function visiblePublication(db: DB, id: number): PublicationRow {
  const p = db.prepare('SELECT * FROM ff_run_publication WHERE id = ?').get(id) as PublicationRow | undefined;
  if (!p) throw notVisible('发布记录');
  visibleModel(db, p.model_id);
  return p;
}

export function publishForecastRun(db: DB, runId: number, input: { title?: string; note?: string }) {
  const run = getForecastRun(db, runId); // 可见性 + 任务对账
  const id = db.transaction(() => {
    const { version, model } = visibleVersion(db, run.versionId);
    assertActive(model);
    const fresh = db.prepare('SELECT status FROM ff_run WHERE id = ?').get(runId) as { status: string };
    if (fresh.status !== 'succeeded') throw conflict('FORECAST_VERSION_STATE', '只有成功的运行可以发布');
    if (reviewStatusOf(version, versionReview(db, version.id)) !== 'approved') throw conflict('FORECAST_VERSION_STATE', '版本复核通过后才能发布运行结果');
    if (db.prepare('SELECT 1 FROM ff_run_publication WHERE run_id = ?').get(runId)) throw conflict('FORECAST_RUN_PUBLISHED', '该运行已发布过;撤回后如需再次发布请重新运行');
    const title = input.title?.trim() || `${model.name} 第 ${version.version_no} 版 ${run.kind === 'baseline' ? '基准' : `情景:${run.scenarioName}`}`;
    const pid = Number(db.prepare(`INSERT INTO ff_run_publication (run_id, model_id, title, note, published_by_user_id, published_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runId, model.id, title, input.note?.trim() ?? '', currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    writeLog(db, 'forecast.run.publish', 'ff_run', runId, { publicationId: pid, versionId: version.id, kind: run.kind });
    return pid;
  }).immediate();
  return publicationDto(db, visiblePublication(db, id));
}

export function withdrawForecastPublication(db: DB, id: number, reason: string) {
  requirePermission(currentAuth(), 'forecast:review');
  db.transaction(() => {
    const p = visiblePublication(db, id);
    if (p.withdrawn_at) throw conflict('FORECAST_RUN_PUBLISHED', '发布记录已撤回');
    db.prepare('UPDATE ff_run_publication SET withdrawn_by_user_id = ?, withdrawn_at = ?, withdraw_reason = ? WHERE id = ?').run(currentAuth()?.userId ?? null, nowIso(), reason.trim(), id);
    writeLog(db, 'forecast.run.withdraw', 'ff_run', p.run_id, { publicationId: id, reason: reason.trim() });
  }).immediate();
  return publicationDto(db, visiblePublication(db, id));
}

/** 已发布运行(跨模型,按组织范围裁剪);默认不含已撤回。 */
export function listForecastPublications(db: DB, q: { orgId?: number; modelId?: number; includeWithdrawn?: '0' | '1' }) {
  if (q.orgId && !orgInScope(currentOrgScope(db), q.orgId)) throw notVisible('组织');
  if (q.modelId) visibleModel(db, q.modelId);
  const f = scopeFilterSql(currentOrgScope(db), 'm.org_id');
  const where = [f.sql];
  const params: unknown[] = [...f.params];
  if (q.orgId) { where.push('m.org_id = ?'); params.push(q.orgId); }
  if (q.modelId) { where.push('p.model_id = ?'); params.push(q.modelId); }
  if (q.includeWithdrawn !== '1') where.push('p.withdrawn_at IS NULL');
  const rows = db.prepare(`SELECT p.* FROM ff_run_publication p JOIN ff_model m ON m.id = p.model_id WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 500`)
    .all(...params) as PublicationRow[];
  return { items: rows.map((p) => publicationDto(db, p)) };
}

/* ---------------- 基准时间线 ---------------- */

const sumRow = (values: string[]) => add(...values.map((v) => fx(v)));

export function forecastBaselineTimeline(db: DB, modelId: number): FfBaselineTimelineDto {
  visibleModel(db, modelId);
  const rows = db.prepare(`SELECT v.*, r.id AS run_id, r.outputs_json AS run_outputs, r.finished_at AS run_finished_at FROM ff_version v
    JOIN ff_run r ON r.version_id = v.id AND r.kind = 'baseline' AND r.status = 'succeeded'
    WHERE v.model_id = ? AND v.status = 'frozen' ORDER BY v.version_no`).all(modelId) as (VersionRow & { run_id: number; run_outputs: string; run_finished_at: string | null })[];
  let prev: Map<string, bigint> | null = null;
  const items: FfBaselineTimelineDto['items'] = [];
  for (const v of rows) {
    const values = JSON.parse(v.run_outputs) as Record<string, string[]>;
    const totals = new Map<string, bigint>();
    const outputs = (JSON.parse(v.outputs_json) as ForecastOutput[]).map((o) => {
      const total = sumRow(values[o.key] ?? []);
      totals.set(o.key, total);
      const before = prev?.get(o.key);
      const change = before === undefined ? null : sub(total, before);
      return {
        key: o.key, name: o.name, unit: o.unit, total: toFixed(total, 6), previousTotal: before === undefined ? null : toFixed(before, 6),
        change: change === null ? null : toFixed(change, 6),
        changeRate: change === null || before === undefined || before === FX_ZERO ? null : toFixed(div(change, before < FX_ZERO ? -before : before), 6),
      };
    });
    items.push({ versionId: v.id, versionNo: v.version_no, reviewStatus: reviewStatusOf(v, versionReview(db, v.id))!, frozenAt: v.frozen_at, runId: v.run_id, finishedAt: v.run_finished_at, outputs });
    prev = totals;
  }
  return { modelId, items };
}

/* ---------------- 洞察 ---------------- */

function insightDto(db: DB, r: { id: number; run_id: number; content: string; source: 'template' | 'model'; model: string; prompt_version: string; created_by_user_id: number | null; created_at: string }): FfInsightDto {
  return { id: r.id, runId: r.run_id, content: r.content, source: r.source, model: r.model, promptVersion: r.prompt_version, createdBy: userName(db, r.created_by_user_id), createdAt: r.created_at };
}

export function listForecastInsights(db: DB, runId: number): { items: FfInsightDto[] } {
  getForecastRun(db, runId);
  const rows = db.prepare('SELECT * FROM ff_run_insight WHERE run_id = ? ORDER BY id DESC LIMIT 20').all(runId) as Parameters<typeof insightDto>[1][];
  return { items: rows.map((r) => insightDto(db, r)) };
}

const trimNum = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

/** 生成运行洞察:基准列出各输出首末期与合计;情景列出参数与相对基准差异最大的项。 */
export async function generateForecastInsight(db: DB, runId: number): Promise<FfInsightDto> {
  const run = getForecastRun(db, runId);
  if (run.status !== 'succeeded' || !run.outputs) throw conflict('FORECAST_VERSION_STATE', '运行未成功,不能生成洞察');
  const { version, model } = visibleVersion(db, run.versionId);
  const outputs = JSON.parse(version.outputs_json) as ForecastOutput[];
  const params = new Map((JSON.parse(version.params_json) as { key: string; name: string; unit: string }[]).map((p) => [p.key, p]));
  const lines = [
    '## 运行概况',
    `- 模型:${model.name}(基准年 ${model.base_year},预测 ${model.horizon_years} 年),第 ${version.version_no} 版`,
    `- 运行:${run.kind === 'baseline' ? '基准运行' : `情景“${run.scenarioName}”`},完成于 ${(run.finishedAt ?? run.createdAt).slice(0, 10)}`,
  ];
  if (run.kind === 'scenario') {
    lines.push('## 情景参数');
    for (const [k, v] of Object.entries(run.params)) { const p = params.get(k); lines.push(`- ${p?.name ?? k}:${trimNum(v)}${p?.unit ?? ''}`); }
    const cmp = compareForecastRun(db, runId);
    const moves = cmp.items.map((it) => {
      const diffs = it.values.filter((x) => x.diff !== null);
      const total = diffs.reduce((s, x) => s + fx(x.diff!), 0n);
      const baseTotal = it.values.reduce((s, x) => (x.baseline === null ? s : s + fx(x.baseline)), 0n);
      return { name: it.name, unit: it.unit, total, rate: baseTotal === FX_ZERO ? null : div(total, baseTotal < FX_ZERO ? -baseTotal : baseTotal) };
    }).sort((a, b) => ((b.total < 0n ? -b.total : b.total) > (a.total < 0n ? -a.total : a.total) ? 1 : -1));
    lines.push('## 相对基准的变化(按合计差额绝对值排序)');
    for (const m of moves.slice(0, 8)) {
      const dir = m.total > FX_ZERO ? '上升' : m.total < FX_ZERO ? '下降' : '持平';
      lines.push(`- ${m.name}:合计${dir} ${trimNum(toFixed(m.total < 0n ? -m.total : m.total, 2))}${m.unit}${m.rate === null ? '' : `(${trimNum(toFixed(m.rate * 100n, 2))}%)`}`);
    }
  } else {
    lines.push('## 输出摘要');
    for (const o of outputs) {
      const vals = run.outputs[o.key] ?? [];
      if (!vals.length) continue;
      const first = vals[0]; const last = vals[vals.length - 1];
      const dir = fx(last) > fx(first) ? '上升' : fx(last) < fx(first) ? '下降' : '持平';
      lines.push(`- ${o.name}:首期 ${trimNum(first)}${o.unit},末期 ${trimNum(last)}${o.unit},整体${dir},合计 ${trimNum(toFixed(sumRow(vals), 2))}${o.unit}`);
    }
  }
  lines.push('## 提示', '- 本洞察由运行结果确定性生成,仅作辅助参考;预测受参数与模型假设影响,正式使用以复核通过并发布的运行为准。');
  const template = lines.join('\n');
  const factTerms = [model.name, run.scenarioName, ...outputs.map((o) => o.name), ...[...params.values()].map((p) => p.name)].filter((x): x is string => !!x);
  const rewrite = await rewriteTemplateNarrative({
    enabled: forecastInsightAiEnabled(), promptVersion: PROMPT_VERSION.forecastInsight, task: FORECAST_INSIGHT_REWRITE_TASK, supplement: promptSupplement(db, 'forecastInsight'), template, factTerms, maxChars: 8000,
  });
  const id = db.transaction(() => {
    const iid = Number(db.prepare(`INSERT INTO ff_run_insight (run_id, content, source, model, prompt_version, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, rewrite.text, rewrite.source, rewrite.model, rewrite.promptVersion, currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    writeLog(db, 'forecast.run.insight', 'ff_run', runId, { insightId: iid, source: rewrite.source, model: rewrite.model, guardFailed: !!rewrite.guardFailure });
    return iid;
  }).immediate();
  return insightDto(db, db.prepare('SELECT * FROM ff_run_insight WHERE id = ?').get(id) as Parameters<typeof insightDto>[1]);
}
