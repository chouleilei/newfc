import type { DB } from '../../db/connection';

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
  | 'auth.login' | 'auth.login_failed' | 'auth.logout';

export function writeLog(
  db: DB,
  action: LogAction,
  entityType: string,
  entityId: string | number,
  detail: Record<string, unknown> = {}
): void {
  try {
    db.prepare(
      'INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(action, entityType, String(entityId), JSON.stringify(detail), new Date().toISOString());
  } catch (err) {
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
}

export function queryLogs(
  db: DB,
  opts: { page?: number; pageSize?: number; action?: string; entityType?: string } = {}
): { total: number; items: OperationLogRow[] } {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.action) { where.push('action = ?'); params.push(opts.action); }
  if (opts.entityType) { where.push('entity_type = ?'); params.push(opts.entityType); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM operation_log ${whereSql}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(`SELECT * FROM operation_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as OperationLogRow[];
  return { total, items };
}
