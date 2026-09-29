import type { DB } from '../../db/connection';
import { currentContext } from '../../core/request-context';

/** 操作日志(方案四.12):组织/科目变更、版本操作、实际数、年度关闭、备份恢复等。 */

export type LogAction =
  | 'org.create' | 'org.update' | 'org.move' | 'org.deactivate' | 'org.activate' | 'org.delete'
  | 'account.create' | 'account.update' | 'account.move' | 'account.deactivate' | 'account.activate' | 'account.delete'
  | 'metric.create' | 'metric.update' | 'metric.delete'
  | 'sheet.create' | 'sheet.update' | 'sheet.delete'
  | 'budget.create' | 'budget.save' | 'budget.checkpoint' | 'budget.clear' | 'budget.rename'
  | 'budget.lock' | 'budget.set_current' | 'budget.copy' | 'budget.archive' | 'budget.delete'
  | 'actual.save' | 'actual.import' | 'actual.history_import' | 'actual.snapshot.delete'
  | 'year.freeze' | 'year.reopen'
  | 'backup.create' | 'backup.restore'
  | 'migration.apply'
  | 'import.failed' | 'import.preview' | 'import.commit' | 'import.rollback' | 'import.cancel' | 'import.expire'
  | 'cleaning.analyze' | 'cleaning.preview' | 'cleaning.reopen'
  | 'template.create' | 'template.update' | 'template.delete'
  | 'alias.create' | 'alias.update' | 'alias.delete'
  | 'calculation_rule.save'
  | 'finance.parallel_compare' | 'finance.parallel_explain' | 'finance.parallel_review'
  | 'finance.profile.create' | 'finance.profile.update'
  | 'finance.mapping.create' | 'finance.mapping.clone' | 'finance.mapping.replace_org'
  | 'finance.mapping.replace_account' | 'finance.mapping.replace_reconciliation'
  | 'finance.mapping.lock' | 'finance.mapping.retire'
  | 'finance.mapping.import'
  | 'finance.conversion.create' | 'finance.conversion.cancel' | 'finance.conversion.recover'
  | 'ai.preview' | 'ai.confirm' | 'ai.cancel' | 'ai.insight'
  | 'ai.conversation.rename' | 'ai.conversation.delete' | 'ai.insight.delete'
  | 'ai.chat'
  | 'settings.ai_channel.create' | 'settings.ai_channel.update' | 'settings.ai_channel.delete'
    | 'settings.ai_channel.test' | 'settings.ai_binding.save' | 'settings.ai_channel.fallback'
  | 'auth.login' | 'auth.login_failed' | 'auth.logout'
  | NewfcLogAction;

/** newfc 新增领域的动作:`领域.动作`,领域前缀受限,避免随意字符串。 */
export type NewfcLogAction = `${'auth' | 'security' | 'settings' | 'task' | 'master' | 'project' | 'supplier' | 'eas' | 'governance'
  | 'statement' | 'mgmt' | 'project_budget' | 'plan' | 'contract' | 'expense' | 'investment' | 'forecast' | 'risk'
  | 'report' | 'knowledge' | 'file' | 'assistant' | 'backup' | 'search' | 'access'}.${string}`;

export type LogResult = 'success' | 'failure' | 'denied';

/** 审计正文不得包含凭据:键名命中以下模式的值一律替换。 */
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential/i;

export function sanitizeDetail(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => sanitizeDetail(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && !/^(passwordReset|mustChangePassword|tokenUsage)$/.test(k) ? '[redacted]' : sanitizeDetail(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

export function writeLog(
  db: DB,
  action: LogAction,
  entityType: string,
  entityId: string | number,
  detail: Record<string, unknown> = {},
  result: LogResult = 'success',
): void {
  // 操作人、来源与请求 ID 取自服务端请求上下文(认证中间件/任务执行器写入),调用点无需逐个传递。
  const ctx = currentContext();
  try {
    db.prepare(
      `INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at, actor_user_id, actor, result, source, request_id, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(action, entityType, String(entityId), JSON.stringify(sanitizeDetail(detail)), new Date().toISOString(),
      ctx?.auth?.userId ?? null, ctx?.auth?.username ?? (ctx ? ctx.source : 'system'), result, ctx?.source ?? 'system',
      ctx?.requestId ?? '', ctx?.ip ?? '');
  } catch (err) {
    // 迁移 V39 之前的库(迁移前自动备份写日志)没有新增列:退回旧列写入
    if (err instanceof Error && err.message.includes('has no column named')) {
      db.prepare('INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(action, entityType, String(entityId), JSON.stringify(sanitizeDetail(detail)), new Date().toISOString());
      return;
    }
    // 兜底:首次启动的迁移前阶段(如迁移前自动备份)库中还没有 operation_log 表,
    // 丢一条启动期日志可接受;其余错误照常抛出
    if (!(err instanceof Error) || !err.message.includes('no such table: operation_log')) throw err;
  }
}

export interface OperationLogRow {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string;
  detail_json: string;
  created_at: string;
  actor_user_id: number | null;
  actor: string;
  result: LogResult;
  source: string;
  request_id: string;
  ip: string;
}

export interface LogQuery {
  page?: number;
  pageSize?: number;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: number;
  result?: string;
  requestId?: string;
  from?: string;
  to?: string;
}

export function queryLogs(db: DB, opts: LogQuery = {}): { total: number; items: OperationLogRow[] } {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.action) {
    // 以 . 结尾表示按前缀筛选(如 security.)
    if (opts.action.endsWith('.')) { where.push('action LIKE ?'); params.push(`${opts.action.replace(/[%_]/g, '')}%`); }
    else { where.push('action = ?'); params.push(opts.action); }
  }
  if (opts.entityType) { where.push('entity_type = ?'); params.push(opts.entityType); }
  if (opts.entityId) { where.push('entity_id = ?'); params.push(opts.entityId); }
  if (opts.actorUserId) { where.push('actor_user_id = ?'); params.push(opts.actorUserId); }
  if (opts.result) { where.push('result = ?'); params.push(opts.result); }
  if (opts.requestId) { where.push('request_id = ?'); params.push(opts.requestId); }
  if (opts.from) { where.push('created_at >= ?'); params.push(opts.from); }
  if (opts.to) { where.push('created_at <= ?'); params.push(opts.to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM operation_log ${whereSql}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(`SELECT * FROM operation_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as OperationLogRow[];
  return { total, items };
}
