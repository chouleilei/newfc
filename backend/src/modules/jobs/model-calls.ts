/**
 * 模型调用观测落库与查询(AC-F21)。不保存提示词/回答正文。
 */
import type { DB } from '../../db/connection';
import { currentContext } from '../../core/request-context';
import type { ModelCallRecord } from '../../assistant/model';

export function insertModelCall(db: DB, r: ModelCallRecord): void {
  const ctx = currentContext();
  db.prepare(`INSERT INTO ai_model_call (feature, provider, model, channel_name, stream, status, error_type, error_message, fallback_used,
      latency_ms, prompt_chars, completion_chars, prompt_tokens, completion_tokens, tokens_estimated, tool_call_count,
      job_id, actor_user_id, source, request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    r.feature, r.provider, r.model, r.channelName, r.stream ? 1 : 0, r.status, r.errorType, r.errorMessage, r.fallbackUsed ? 1 : 0,
    Math.max(0, Math.trunc(r.latencyMs)), r.promptChars, r.completionChars, r.promptTokens, r.completionTokens, r.tokensEstimated ? 1 : 0, r.toolCallCount,
    ctx?.jobId ?? null, ctx?.auth?.userId ?? null, ctx?.source ?? 'system', ctx?.requestId ?? '', new Date().toISOString(),
  );
}

export interface ModelCallQuery { feature?: string; status?: string; jobId?: number; from?: string; to?: string; page?: number; pageSize?: number }

function whereOf(q: ModelCallQuery): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.feature) { where.push('feature = ?'); params.push(q.feature); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.jobId) { where.push('job_id = ?'); params.push(q.jobId); }
  if (q.from) { where.push('created_at >= ?'); params.push(q.from); }
  if (q.to) { where.push('created_at <= ?'); params.push(q.to); }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listModelCalls(db: DB, q: ModelCallQuery = {}) {
  const { clause, params } = whereOf(q);
  const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
  const page = Math.max(1, q.page ?? 1);
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM ai_model_call ${clause}`).get(...params) as { c: number }).c;
  const items = db.prepare(`SELECT id, feature, provider, model, channel_name AS channelName, stream, status, error_type AS errorType,
      error_message AS errorMessage, fallback_used AS fallbackUsed, latency_ms AS latencyMs, prompt_tokens AS promptTokens,
      completion_tokens AS completionTokens, tokens_estimated AS tokensEstimated, tool_call_count AS toolCallCount,
      job_id AS jobId, actor_user_id AS actorUserId, source, request_id AS requestId, created_at AS createdAt
    FROM ai_model_call ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
  for (const item of items) {
    item.stream = item.stream === 1;
    item.fallbackUsed = item.fallbackUsed === 1;
    item.tokensEstimated = item.tokensEstimated === 1;
  }
  return { total, items };
}

/** 按功能/状态汇总:次数、平均/最大耗时、token 合计(估算与供应商口径分开统计)。 */
export function modelCallStats(db: DB, q: ModelCallQuery = {}) {
  const { clause, params } = whereOf(q);
  return db.prepare(`SELECT feature, status, COUNT(*) AS calls, CAST(ROUND(AVG(latency_ms)) AS INTEGER) AS avgLatencyMs, MAX(latency_ms) AS maxLatencyMs,
      SUM(fallback_used) AS fallbackCalls,
      SUM(CASE WHEN tokens_estimated = 0 THEN prompt_tokens + completion_tokens ELSE 0 END) AS reportedTokens,
      SUM(CASE WHEN tokens_estimated = 1 THEN prompt_tokens + completion_tokens ELSE 0 END) AS estimatedTokens
    FROM ai_model_call ${clause} GROUP BY feature, status ORDER BY feature, status`).all(...params);
}
