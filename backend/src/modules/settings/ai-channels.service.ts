/**
 * LLM 渠道管理(侧栏导航扩展计划 §七):渠道 CRUD、连通性三态测试、按功能绑定主备渠道。
 *
 * 密钥按用户决定明文存储(单用户本地应用,SQLite 与 .env 同机同级暴露面);
 * 列表/详情返回只做脱敏预览(sk-****末4位),唯一允许 apiKey 出网的是 test 端点。
 * 校验规则与 assistant/model.ts 的 aiConfigurationIssue() 同源。
 */
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';

export const AI_FEATURES = ['chat', 'narrative', 'checkpoint_summary', 'cleaning_suggest', 'mapping_candidates', 'master_data_semantic', 'expense_audit', 'contract_legal_review'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export interface AiChannelRow {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  timeout_ms: number;
  stream: 0 | 1;
  enabled: 0 | 1;
  last_test_status: 'ok' | 'degraded' | 'fail' | null;
  last_test_latency_ms: number | null;
  last_test_message: string | null;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiFeatureBindingRow {
  feature: string;
  primary_channel_id: number | null;
  fallback_channel_id: number | null;
  updated_at: string;
}

export interface AiCallDiagnostics {
  recentCalls: number;
  okCalls: number;
  errorCalls: number;
  timeoutCalls: number;
  timeoutRate: number;
  fallbackCalls: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

interface RawModelCallObs {
  feature: string;
  channel_name: string;
  status: string;
  error_type: string | null;
  error_message: string | null;
  fallback_used: number;
  latency_ms: number;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function buildDiagnostics(rows: RawModelCallObs[]): AiCallDiagnostics {
  const recentCalls = rows.length;
  if (recentCalls === 0) {
    return {
      recentCalls: 0,
      okCalls: 0,
      errorCalls: 0,
      timeoutCalls: 0,
      timeoutRate: 0,
      fallbackCalls: 0,
      p50LatencyMs: null,
      p95LatencyMs: null,
    };
  }
  let okCalls = 0;
  let errorCalls = 0;
  let timeoutCalls = 0;
  let fallbackCalls = 0;
  const latencies: number[] = [];
  for (const r of rows) {
    const succeeded = r.status === 'success' || r.status === 'ok';
    if (succeeded) okCalls++;
    else errorCalls++;
    const isTimeout = r.status === 'timeout'
      || r.error_type === 'timeout'
      || /timeout|超时|abort/i.test(r.error_message ?? '');
    if (!succeeded && isTimeout) timeoutCalls++;
    if (r.fallback_used === 1) fallbackCalls++;
    if (Number.isFinite(r.latency_ms) && r.latency_ms >= 0) latencies.push(Math.trunc(r.latency_ms));
  }
  latencies.sort((a, b) => a - b);
  return {
    recentCalls,
    okCalls,
    errorCalls,
    timeoutCalls,
    timeoutRate: Number((timeoutCalls / recentCalls).toFixed(4)),
    fallbackCalls,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
  };
}

function loadRecentCallRows(db: DB, limit = 500): RawModelCallObs[] {
  try {
    return db.prepare(
      `SELECT feature, channel_name, status, error_type, error_message, fallback_used, latency_ms
       FROM ai_model_call ORDER BY id DESC LIMIT ?`,
    ).all(limit) as RawModelCallObs[];
  } catch {
    return [];
  }
}

/** 渠道校验:与 aiConfigurationIssue() 同款规则(URL 合法;https 或本机/可信内网 http)。 */
export function channelConfigurationIssue(input: { baseUrl: string; apiKey?: string }): string | undefined {
  const baseUrl = input.baseUrl.trim();
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { return 'baseUrl 不是合法 URL'; }
  if (parsed.protocol === 'https:') return undefined;
  if (parsed.protocol !== 'http:') return 'baseUrl 只允许 https://,或本机 http:// 服务';
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  const explicitTrustedHttp = process.env.AI_ALLOW_INSECURE_HTTP === '1';
  const testOnlyHost = Boolean(process.env.VITEST) && host.endsWith('.test');
  if (!loopback && !explicitTrustedHttp && !testOnlyHost) {
    return '公网/远程 baseUrl 必须使用 https://;可信内网 HTTP 需显式设置 AI_ALLOW_INSECURE_HTTP=1';
  }
  return undefined;
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  const tail = key.slice(-4);
  const head = key.startsWith('sk-') ? 'sk-' : key.slice(0, 2);
  return `${head}****${tail}`;
}

export function listChannels(db: DB) {
  const rows = db.prepare('SELECT * FROM ai_channel ORDER BY id').all() as AiChannelRow[];
  const calls = loadRecentCallRows(db);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    keyPreview: maskApiKey(row.api_key),
    hasKey: row.api_key.length > 0,
    model: row.model,
    timeoutMs: row.timeout_ms,
    stream: row.stream === 1,
    enabled: row.enabled === 1,
    lastTestStatus: row.last_test_status,
    lastTestLatencyMs: row.last_test_latency_ms,
    lastTestMessage: row.last_test_message,
    lastTestedAt: row.last_tested_at,
    diagnostics: buildDiagnostics(calls.filter((c) => c.channel_name === row.name)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getChannel(db: DB, id: number): AiChannelRow {
  const row = db.prepare('SELECT * FROM ai_channel WHERE id = ?').get(id) as AiChannelRow | undefined;
  if (!row) throw Errors.notFound(`渠道 #${id}`);
  return row;
}

export function createChannel(db: DB, body: {
  name?: string; baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number; stream?: boolean; enabled?: boolean;
}) {
  const name = (body.name ?? '').trim();
  const baseUrl = (body.baseUrl ?? '').trim();
  if (!name) throw Errors.validation('name 不能为空');
  if (name.length > 100) throw Errors.validation('name 最长 100 字');
  if (!baseUrl) throw Errors.validation('baseUrl 不能为空');
  const issue = channelConfigurationIssue({ baseUrl, apiKey: body.apiKey });
  if (issue) throw Errors.validation(issue);
  const model = (body.model ?? 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const rawTimeout = Number(body.timeoutMs ?? 15_000);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(120_000, Math.max(10, Math.trunc(rawTimeout))) : 15_000;
  const now = new Date().toISOString();
  try {
    const result = db.prepare(
      `INSERT INTO ai_channel (name, base_url, api_key, model, timeout_ms, stream, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, baseUrl, (body.apiKey ?? '').trim(), model, timeoutMs, body.stream === false ? 0 : 1, body.enabled === false ? 0 : 1, now, now);
    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw Errors.conflict(`渠道名称「${name}」已存在`);
    throw err;
  }
}

export function updateChannel(db: DB, id: number, body: {
  name?: string; baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number; stream?: boolean; enabled?: boolean;
}) {
  const existing = getChannel(db, id);
  const name = body.name !== undefined ? body.name.trim() : existing.name;
  const baseUrl = body.baseUrl !== undefined ? body.baseUrl.trim() : existing.base_url;
  if (!name) throw Errors.validation('name 不能为空');
  if (!baseUrl) throw Errors.validation('baseUrl 不能为空');
  // apiKey 留空表示不改动;显式传新值时按同款规则校验。
  const apiKey = body.apiKey !== undefined && body.apiKey.trim() !== '' ? body.apiKey.trim() : existing.api_key;
  const issue = channelConfigurationIssue({ baseUrl, apiKey });
  if (issue) throw Errors.validation(issue);
  const model = body.model !== undefined ? (body.model.trim() || 'gpt-4o-mini') : existing.model;
  const rawTimeout = body.timeoutMs !== undefined ? Number(body.timeoutMs) : existing.timeout_ms;
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(120_000, Math.max(10, Math.trunc(rawTimeout))) : existing.timeout_ms;
  const stream = body.stream !== undefined ? (body.stream ? 1 : 0) : existing.stream;
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
  try {
    db.prepare(
      `UPDATE ai_channel SET name=?, base_url=?, api_key=?, model=?, timeout_ms=?, stream=?, enabled=?, updated_at=? WHERE id=?`,
    ).run(name, baseUrl, apiKey, model, timeoutMs, stream, enabled, new Date().toISOString(), id);
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw Errors.conflict(`渠道名称「${name}」已存在`);
    throw err;
  }
  return { id };
}

/** 删除渠道;binding 由 ON DELETE SET NULL 自动解绑,返回受影响的功能列表。 */
export function deleteChannel(db: DB, id: number): { id: number; affectedFeatures: string[] } {
  getChannel(db, id);
  const affected = (db.prepare(
    'SELECT feature FROM ai_feature_binding WHERE primary_channel_id = ? OR fallback_channel_id = ?',
  ).all(id, id) as { feature: string }[]).map((row) => row.feature);
  db.prepare('DELETE FROM ai_channel WHERE id = ?').run(id);
  return { id, affectedFeatures: affected };
}

export function listBindings(db: DB) {
  const rows = db.prepare('SELECT * FROM ai_feature_binding').all() as AiFeatureBindingRow[];
  const byFeature = new Map(rows.map((row) => [row.feature, row]));
  const calls = loadRecentCallRows(db);
  return AI_FEATURES.map((feature) => {
    const row = byFeature.get(feature);
    return {
      feature,
      primaryChannelId: row?.primary_channel_id ?? null,
      fallbackChannelId: row?.fallback_channel_id ?? null,
      updatedAt: row?.updated_at ?? null,
      diagnostics: buildDiagnostics(calls.filter((c) => c.feature === feature)),
    };
  });
}

export function saveBindings(db: DB, body: { bindings?: { feature: string; primaryChannelId: number | null; fallbackChannelId: number | null }[] }) {
  const items = body.bindings;
  if (!Array.isArray(items)) throw Errors.validation('bindings 必须是数组');
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!AI_FEATURES.includes(item.feature as AiFeature)) throw Errors.validation(`未知功能「${item.feature}」`);
      const primary = item.primaryChannelId ?? null;
      const fallback = item.fallbackChannelId ?? null;
      for (const [label, channelId] of [['主渠道', primary], ['备用渠道', fallback]] as const) {
        if (channelId == null) continue;
        const channel = getChannel(db, channelId);
        if (channel.enabled !== 1) throw Errors.validation(`${label}「${channel.name}」已停用,不能绑定`);
      }
      if (primary != null && fallback != null && primary === fallback) {
        throw Errors.validation('备用渠道不得与主渠道相同');
      }
      db.prepare(
        `INSERT INTO ai_feature_binding (feature, primary_channel_id, fallback_channel_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(feature) DO UPDATE SET primary_channel_id=excluded.primary_channel_id,
           fallback_channel_id=excluded.fallback_channel_id, updated_at=excluded.updated_at`,
      ).run(item.feature, primary, fallback, now);
    }
  });
  tx();
  return listBindings(db);
}

/**
 * 连通性测试:用库内渠道配置发一次真实 chat/completions(非流式、固定小 prompt、max_tokens=1)。
 * 三态:ok(5 秒内合法响应)/ degraded(成功但超 5 秒,或 200 但缺 choices)/ fail(连接失败/超时/4xx/5xx/非法 JSON)。
 * 这是唯一允许用渠道 apiKey 出网的路径;请求体不带 key,服务端从库内取。
 */
export async function testChannel(db: DB, id: number, opts?: { samples?: number }): Promise<{
  status: 'ok' | 'degraded' | 'fail';
  latencyMs: number;
  message: string;
  sampleCount: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  sampleLatencies: number[];
}> {
  const channel = getChannel(db, id);
  const sampleCount = Math.min(5, Math.max(1, Math.trunc(Number(opts?.samples ?? 1) || 1)));
  const endpoint = /\/chat\/completions$/i.test(channel.base_url.replace(/\/+$/, ''))
    ? channel.base_url.replace(/\/+$/, '')
    : `${channel.base_url.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (channel.api_key) headers.authorization = `Bearer ${channel.api_key}`;

  const sampleLatencies: number[] = [];
  const sampleStatuses: ('ok' | 'degraded' | 'fail')[] = [];
  let lastMessage = '';

  for (let i = 0; i < sampleCount; i++) {
    const started = Date.now();
    let oneStatus: 'ok' | 'degraded' | 'fail' = 'fail';
    let oneMsg = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(channel.timeout_ms, 10_000));
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: channel.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: controller.signal,
      });
      const oneLatency = Date.now() - started;
      sampleLatencies.push(oneLatency);
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        oneMsg = `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
      } else {
        let data: unknown;
        try { data = await response.json(); } catch {
          oneStatus = 'fail';
          oneMsg = '返回了非法 JSON';
          data = undefined;
        }
        if (data !== undefined) {
          const hasChoices = Array.isArray((data as { choices?: unknown[] })?.choices);
          if (!hasChoices) {
            oneStatus = 'degraded';
            oneMsg = 'HTTP 200 但载荷结构异常(缺 choices)';
          } else if (oneLatency > 5_000) {
            oneStatus = 'degraded';
            oneMsg = `响应成功但超过 5 秒(${oneLatency}ms)；建议配置备用渠道故障转移`;
          } else {
            oneStatus = 'ok';
            oneMsg = `连通正常(${oneLatency}ms)`;
          }
        }
      }
    } catch (err) {
      sampleLatencies.push(Date.now() - started);
      oneMsg = (err as { name?: string })?.name === 'AbortError'
        ? `请求超时(>${Math.max(channel.timeout_ms, 10_000)}ms)`
        : `连接失败: ${err instanceof Error ? err.message : String(err)}`;
      oneMsg = oneMsg.slice(0, 300);
    } finally {
      clearTimeout(timer);
    }
    sampleStatuses.push(oneStatus);
    lastMessage = oneMsg;
  }

  const sorted = [...sampleLatencies].sort((a, b) => a - b);
  const p50LatencyMs = percentile(sorted, 50) ?? 0;
  const p95LatencyMs = percentile(sorted, 95) ?? p50LatencyMs;
  const latencyMs = sampleCount === 1 ? (sampleLatencies[0] ?? 0) : p50LatencyMs;
  const failCount = sampleStatuses.filter((s) => s === 'fail').length;
  const degradedCount = sampleStatuses.filter((s) => s === 'degraded').length;
  let status: 'ok' | 'degraded' | 'fail';
  if (failCount === sampleCount) status = 'fail';
  else if (failCount > 0 || degradedCount > 0) status = 'degraded';
  else status = 'ok';

  const message = sampleCount === 1
    ? lastMessage.slice(0, 300)
    : `${sampleCount}次探活 P50=${p50LatencyMs}ms / P95=${p95LatencyMs}ms（失败 ${failCount} 次）：${lastMessage}`.slice(0, 300);

  // 只写连通性测试结果列;updated_at 是「配置更新时间」,不能被一次测试污染
  // (listChannels 的消费方把 updated_at 当配置变更信号)。
  db.prepare(
    'UPDATE ai_channel SET last_test_status=?, last_test_latency_ms=?, last_test_message=?, last_tested_at=? WHERE id=?',
  ).run(status, latencyMs, message.slice(0, 300), new Date().toISOString(), id);
  return { status, latencyMs, message: message.slice(0, 300), sampleCount, p50LatencyMs, p95LatencyMs, sampleLatencies };
}

/**
 * 功能到渠道的解析(供模型适配层调用):
 * primary(enabled) -> fallback(enabled) -> 任一 enabled 渠道(导入的「环境变量默认」通常在此命中)。
 * 全部缺失时返回 null,由调用方回退 env。
 */
export function resolveChannelForFeature(db: DB, feature: AiFeature): AiChannelRow | null {
  const binding = db.prepare('SELECT * FROM ai_feature_binding WHERE feature = ?').get(feature) as AiFeatureBindingRow | undefined;
  const enabledById = (id: number | null | undefined): AiChannelRow | null => {
    if (id == null) return null;
    const row = db.prepare('SELECT * FROM ai_channel WHERE id = ? AND enabled = 1').get(id) as AiChannelRow | undefined;
    return row ?? null;
  };
  const primary = enabledById(binding?.primary_channel_id);
  if (primary) return primary;
  const fallback = enabledById(binding?.fallback_channel_id);
  if (fallback) return fallback;
  const any = db.prepare('SELECT * FROM ai_channel WHERE enabled = 1 ORDER BY id LIMIT 1').get() as AiChannelRow | undefined;
  return any ?? null;
}

/** 仅取 binding 的 primary(enabled),不做 fallback/任意渠道下探(适配层重试语义需要区分主备)。 */
export function primaryChannelForFeature(db: DB, feature: AiFeature): AiChannelRow | null {
  const binding = db.prepare('SELECT * FROM ai_feature_binding WHERE feature = ?').get(feature) as AiFeatureBindingRow | undefined;
  if (!binding?.primary_channel_id) return null;
  const row = db.prepare('SELECT * FROM ai_channel WHERE id = ? AND enabled = 1').get(binding.primary_channel_id) as AiChannelRow | undefined;
  return row ?? null;
}

/** binding 缺失或主备皆不可用时,回退到任一 enabled 渠道(通常是导入的「环境变量默认」)。 */
export function anyChannel(db: DB): AiChannelRow | null {
  const row = db.prepare('SELECT * FROM ai_channel WHERE enabled = 1 ORDER BY id LIMIT 1').get() as AiChannelRow | undefined;
  return row ?? null;
}

/** 主失败自动落备用:返回与 primary 不同的 enabled fallback,没有则 null。 */
export function fallbackChannelForFeature(db: DB, feature: AiFeature, primaryId: number): AiChannelRow | null {
  const binding = db.prepare('SELECT * FROM ai_feature_binding WHERE feature = ?').get(feature) as AiFeatureBindingRow | undefined;
  if (!binding?.fallback_channel_id || binding.fallback_channel_id === primaryId) return null;
  const row = db.prepare('SELECT * FROM ai_channel WHERE id = ? AND enabled = 1').get(binding.fallback_channel_id) as AiChannelRow | undefined;
  return row ?? null;
}

/** 任一启用渠道存在(供 modelConfigured 语义扩展)。 */
export function anyEnabledChannel(db: DB): boolean {
  return Boolean(db.prepare('SELECT 1 FROM ai_channel WHERE enabled = 1 LIMIT 1').get());
}
