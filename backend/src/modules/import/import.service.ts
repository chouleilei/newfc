import crypto from 'crypto';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { centsToYuanString, isQuantityType, scaledToQuantityString, signOfType, type AccountType } from '../../core/money';
import * as budget from '../budget/budget.service';
import * as actual from '../actual/actual.service';
import { writeLog } from '../audit/log';
import { assertCleaningBaseline } from '../io/cleaning/baseline';
import { assertNoFinanceOwnedConflicts } from '../finance-import/owned-scope';
import {
  insertPreviewDetails,
  type PreviewDetailInput,
  type PreviewDetailRow,
  type UnifiedPreviewSummary,
} from './preview-detail';

export interface ImportBatchRow {
  id: number;
  kind: 'budget' | 'actual';
  status: 'pending' | 'committed' | 'rolled_back' | 'cancelled';
  target_version_id: number | null;
  history: 0 | 1;
  original_name: string;
  sha256: string;
  file_blob: Buffer;
  payload_json: string;
  summary_json: string;
  cleaning_plan_json: string;
  before_json: string;
  after_json: string;
  result_json: string;
  created_at: string;
  committed_at: string | null;
  rolled_back_at: string | null;
}

interface ActualPayload {
  history: boolean;
  note: string;
  clearBlankMemos?: boolean;
  batches: { year: number; snapshotDate: string; entries: actual.ActualEntryInput[] }[];
}

interface BudgetPayload {
  versionId: number;
  entries: budget.BudgetEntryInput[];
}

interface RawActualValue {
  year: number;
  orgId: number;
  accountId: number;
  amountCents: number;
  quantity: number | null;
  memo: string;
}

function json<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export function createBatch(
  db: DB,
  input: {
    kind: 'budget' | 'actual';
    targetVersionId?: number;
    history?: boolean;
    originalName: string;
    file: Buffer;
    payload: ActualPayload | BudgetPayload;
    summary: Record<string, unknown>;
    cleaningPlan?: unknown;
    /** 统一预览(UX-14):创建批次时冻结的摘要 DTO 与逐行明细,与批次同事务写入 */
    preview?: { summary: UnifiedPreviewSummary; details: PreviewDetailInput[] };
  },
): ImportBatchRow {
  const now = new Date().toISOString();
  const digest = crypto.createHash('sha256').update(input.file).digest('hex');
  const previewBaseline = (() => {
    if (input.kind === 'budget') {
      const payload = input.payload as BudgetPayload;
      // 基线用全量版本快照(见 budgetCellSnapshot 注释),而非仅命中 key。
      return crypto.createHash('sha256').update(JSON.stringify(budgetVersionSnapshot(db, payload.versionId))).digest('hex');
    }
    const payload = input.payload as ActualPayload;
    if (payload.history) return null;
    const keys = new Set(payload.batches.flatMap((group) => group.entries.map((entry) => `${group.year}:${entry.orgId}:${entry.accountId}`)));
    return crypto.createHash('sha256').update(JSON.stringify(rawActualSnapshot(db, keys))).digest('hex');
  })();
  const info = { id: 0 };
  // INSERT 与审计日志同事务:writeLog 失败(如磁盘满)不应留下无 operation_log 的孤儿 pending 批次;
  // 统一预览摘要与逐行明细也在同一事务冻结,任何一步失败都不留下半成品预览。
  db.transaction(() => {
    const res = db.prepare(
      `INSERT INTO import_batch
        (kind, status, target_version_id, history, original_name, sha256, file_blob, payload_json, summary_json, cleaning_plan_json, created_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.kind, input.targetVersionId ?? null, input.history ? 1 : 0, input.originalName.slice(0, 255), digest, input.file, JSON.stringify(input.payload), JSON.stringify({ ...input.summary, previewBaseline, ...(input.preview ? { unifiedPreview: input.preview.summary } : {}) }), JSON.stringify(input.cleaningPlan ?? {}), now);
    info.id = Number(res.lastInsertRowid);
    if (input.preview) insertPreviewDetails(db, info.id, input.preview.details, now);
    writeLog(db, 'import.preview', 'import_batch', info.id, { kind: input.kind, sha256: digest, originalName: input.originalName, ...input.summary });
  })();
  return getBatch(db, info.id);
}

export function getBatch(db: DB, id: number): ImportBatchRow {
  const row = db.prepare('SELECT * FROM import_batch WHERE id = ?').get(id) as ImportBatchRow | undefined;
  if (!row) throw Errors.notFound('导入批次');
  return row;
}

export function listBatches(db: DB, limit = 100): Omit<ImportBatchRow, 'file_blob' | 'payload_json' | 'before_json' | 'after_json'>[] {
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100;
  return db.prepare(
    `SELECT id, kind, status, target_version_id, history, original_name, sha256, summary_json, cleaning_plan_json,
            result_json, created_at, committed_at, rolled_back_at
     FROM import_batch ORDER BY id DESC LIMIT ?`,
  ).all(safeLimit) as Omit<ImportBatchRow, 'file_blob' | 'payload_json' | 'before_json' | 'after_json'>[];
}

/**
 * 预算导入的并发基线必须覆盖**整个版本**的明细,而非仅本批命中的单元格:
 * commit 走的是 `saveEntries` 整包替换(不在 merged 集合里的旧行会被 DELETE),
 * 而 merged 来自预览时刻的全量快照。若基线只哈希命中 key,预览→确认之间另一会话
 * 在**未被本批命中**的格子上新增/修改,基线仍会通过,但该改动不在 merged 里,
 * 会被整包替换静默删除。全量快照让任何并发改动都使基线失配、强制重新预览。
 * keys 仍保留用于 before/after 的差异快照(回滚证据),不参与基线。
 */
function budgetCellSnapshot(db: DB, versionId: number, keys: Set<string>) {
  return (db.prepare(
    `SELECT org_id, account_id, amount_cents, quantity, formula, note
     FROM budget_entry WHERE version_id = ? ORDER BY org_id, account_id`,
  ).all(versionId) as budget.BudgetEntryRow[])
    .filter((row) => keys.has(`${row.org_id}:${row.account_id}`));
}

/** 全量版本快照(基线用):不过滤 key,任何并发改动都会改变哈希。 */
function budgetVersionSnapshot(db: DB, versionId: number) {
  return db.prepare(
    `SELECT org_id, account_id, amount_cents, quantity, formula, note
     FROM budget_entry WHERE version_id = ? ORDER BY org_id, account_id`,
  ).all(versionId) as budget.BudgetEntryRow[];
}

function allBudgetInputs(db: DB, versionId: number): Map<string, budget.BudgetEntryInput> {
  const matrix = budget.getEditMatrix(db, versionId);
  return new Map(matrix.entries.map((entry) => [`${entry.orgId}:${entry.accountId}`, {
    orgId: entry.orgId,
    accountId: entry.accountId,
    amount: entry.amountDisplay || undefined,
    quantity: entry.quantity ?? undefined,
    formula: entry.formula,
    note: entry.note,
  }]));
}

function rawActualSnapshot(db: DB, keys: Set<string>): RawActualValue[] {
  const rows = db.prepare(
    `SELECT year, org_id, account_id, cumulative_amount_cents, quantity, memo
     FROM actual_current ORDER BY year, org_id, account_id`,
  ).all() as { year: number; org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null; memo: string }[];
  return rows.filter((row) => keys.has(`${row.year}:${row.org_id}:${row.account_id}`)).map((row) => ({
    year: row.year,
    orgId: row.org_id,
    accountId: row.account_id,
    amountCents: row.cumulative_amount_cents,
    quantity: row.quantity,
    memo: row.memo,
  }));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function financeBaseline(db: DB, payload: ActualPayload): string {
  const keys = new Set(payload.batches.flatMap((group) => group.entries.map((entry) => `${group.year}:${entry.orgId}:${entry.accountId}`)));
  const rows = db.prepare(
    'SELECT year,org_id,account_id,cumulative_amount_cents,quantity,updated_at FROM actual_current ORDER BY year,org_id,account_id',
  ).all() as { year:number; org_id:number; account_id:number; cumulative_amount_cents:number; quantity:number|null; updated_at:string }[];
  return crypto.createHash('sha256').update(JSON.stringify(rows.filter((row) => keys.has(`${row.year}:${row.org_id}:${row.account_id}`)))).digest('hex');
}

export function commitBatch(db: DB, id: number): ImportBatchRow {
  const batch = getBatch(db, id);
  if (batch.status !== 'pending') throw Errors.conflict(`导入批次状态为 ${batch.status},不能重复确认`);
  const now = new Date().toISOString();
  let before: unknown[] = [];
  let after: unknown[] = [];
  let result: Record<string, unknown> = {};
  db.transaction(() => {
    if (batch.kind === 'budget') {
      const payload = json<BudgetPayload>(batch.payload_json);
      const summary = json<{ previewBaseline?: unknown; cleaningBaseline?: unknown }>(batch.summary_json);
      if (!Object.prototype.hasOwnProperty.call(summary, 'previewBaseline')
        || typeof summary.previewBaseline !== 'string') {
        throw Errors.conflict('该预算导入预览创建于并发基线启用前，请取消后重新预览');
      }
      const version = budget.getVersion(db, payload.versionId);
      if (version.status !== 'draft') throw Errors.conflict('目标预算版本已不再是草稿,导入预览已失效');
      const keys = new Set(payload.entries.map((entry) => `${entry.orgId}:${entry.accountId}`));
      before = budgetCellSnapshot(db, payload.versionId, keys);
      // 基线对全量版本重算(与预览侧 budgetVersionSnapshot 同口径):
      // 任何并发改动(不止命中格)都会使基线失配,阻止整包替换误删。
      const currentBaseline = crypto.createHash('sha256').update(JSON.stringify(budgetVersionSnapshot(db, payload.versionId))).digest('hex');
      if (currentBaseline !== summary.previewBaseline) {
        throw Errors.conflict('预算导入预览后版本已有其他改动，禁止静默覆盖，请重新预览');
      }
      if (summary.cleaningBaseline !== undefined) {
        assertCleaningBaseline(db, { targetKind: 'budget', versionId: payload.versionId }, summary.cleaningBaseline);
      }
      const merged = allBudgetInputs(db, payload.versionId);
      for (const entry of payload.entries) merged.set(`${entry.orgId}:${entry.accountId}`, entry);
      result = budget.saveEntries(db, payload.versionId, [...merged.values()]);
      after = budgetCellSnapshot(db, payload.versionId, keys);
    } else {
      const payload = json<ActualPayload>(batch.payload_json);
      const summary = json<Record<string, unknown>>(batch.summary_json);
      const hasPreviewBaseline = Object.prototype.hasOwnProperty.call(summary, 'previewBaseline');
      const validPreviewBaseline = payload.history
        ? summary.previewBaseline === null
        : typeof summary.previewBaseline === 'string';
      if (!hasPreviewBaseline || !validPreviewBaseline) {
        throw Errors.conflict('该实际导入预览创建于并发基线启用前，请取消后重新预览');
      }
      const keys = new Set(payload.batches.flatMap((group) => group.entries.map((entry) => `${group.year}:${entry.orgId}:${entry.accountId}`)));
      if (!payload.history && typeof summary.previewBaseline === 'string' && typeof summary.financeConversionId !== 'number') {
        const currentBaseline = crypto.createHash('sha256').update(JSON.stringify(rawActualSnapshot(db, keys))).digest('hex');
        if (currentBaseline !== summary.previewBaseline) {
          throw Errors.conflict('实际导入预览后命中单元格已被修改，禁止静默覆盖，请重新预览');
        }
      }
      if (typeof summary.financeConversionId === 'number') {
        if (typeof summary.baseline !== 'string') {
          throw Errors.conflict('该财务转换导入缺少拥有范围基线，请取消后重新转换并预览');
        }
        const conversion = db.prepare('SELECT status,mapping_version_id,output_sha256 FROM finance_conversion_batch WHERE id=?').get(summary.financeConversionId) as { status:string; mapping_version_id:number; output_sha256:string|null } | undefined;
        const mapping = conversion && db.prepare('SELECT status FROM finance_mapping_version WHERE id=?').get(conversion.mapping_version_id) as { status:string } | undefined;
        if (!conversion || conversion.status !== 'validated' || mapping?.status !== 'locked' || conversion.output_sha256 !== batch.sha256) {
          throw Errors.conflict('财务转换批次、映射口径或输出文件已变化，导入预览失效');
        }
        if (financeBaseline(db, payload) !== summary.baseline) {
          throw Errors.conflict('预览后拥有范围内实际数已被修改，禁止静默覆盖，请重新转换并处理冲突');
        }
      }
      if (summary.cleaningBaseline !== undefined) {
        if (payload.history || payload.batches.length !== 1) throw Errors.conflict('清洗实际数批次目标格式无效，请取消后重新预览');
        const group = payload.batches[0];
        assertCleaningBaseline(db, { targetKind: 'actual-current', year: group.year, snapshotDate: group.snapshotDate }, summary.cleaningBaseline);
      }
      if (!payload.history && typeof summary.financeConversionId !== 'number') {
        assertNoFinanceOwnedConflicts(db, payload.batches.flatMap((group) => group.entries.map((entry) => ({ orgId: entry.orgId, accountId: entry.accountId }))));
      }
      if (!payload.history) before = rawActualSnapshot(db, keys);
      const results: { year: number; snapshotDate: string; count: number; batchId: number }[] = [];
      for (const group of payload.batches) {
        const saved = actual.saveActual(db, {
          year: group.year,
          snapshotDate: group.snapshotDate,
          entries: group.entries,
          source: 'excel_import',
          note: payload.note,
          mode: 'upsert',
          history: payload.history,
          clearBlankMemos: payload.clearBlankMemos === true,
        });
        db.prepare('UPDATE actual_snapshot_batch SET import_batch_id = ? WHERE id = ?').run(id, saved.batchId);
        results.push({ year: group.year, snapshotDate: group.snapshotDate, count: group.entries.length, batchId: saved.batchId });
      }
      if (!payload.history) after = rawActualSnapshot(db, keys);
      result = { results, count: payload.batches.reduce((sum, group) => sum + group.entries.length, 0) };
    }
    db.prepare(
      `UPDATE import_batch SET status = 'committed', before_json = ?, after_json = ?, result_json = ?, committed_at = ? WHERE id = ?`,
    ).run(JSON.stringify(before), JSON.stringify(after), JSON.stringify(result), now, id);
    db.prepare('DELETE FROM import_cleaning_preview_row WHERE import_batch_id = ?').run(id);
    db.prepare("UPDATE finance_conversion_batch SET status='imported',imported_at=? WHERE import_batch_id=?").run(now, id);
    writeLog(db, 'import.commit', 'import_batch', id, { kind: batch.kind, ...result });
  })();
  return getBatch(db, id);
}

export function rollbackBatch(db: DB, id: number): ImportBatchRow {
  const batch = getBatch(db, id);
  if (batch.status !== 'committed') throw Errors.conflict(`导入批次状态为 ${batch.status},不能撤销`);
  if (batch.kind === 'actual' && batch.history === 1) throw Errors.conflict('历史补录不改变当前实际,请通过快照修订管理处理');
  const now = new Date().toISOString();
  db.transaction(() => {
    if (batch.kind === 'budget') {
      const payload = json<BudgetPayload>(batch.payload_json);
      const version = budget.getVersion(db, payload.versionId);
      if (version.status !== 'draft') throw Errors.conflict('目标版本已经定稿,不能撤销导入');
      const keys = new Set(payload.entries.map((entry) => `${entry.orgId}:${entry.accountId}`));
      const current = budgetCellSnapshot(db, payload.versionId, keys);
      const expected = json<budget.BudgetEntryRow[]>(batch.after_json);
      if (!sameJson(current, expected)) throw Errors.conflict('导入后相关预算单元格已被修改,为避免覆盖新数据不能自动撤销');
      const merged = allBudgetInputs(db, payload.versionId);
      for (const key of keys) merged.delete(key);
      const before = json<budget.BudgetEntryRow[]>(batch.before_json);
      const matrix = budget.getEditMatrix(db, payload.versionId);
      const typeOf = new Map(matrix.accountNodes.map((node) => [node.id, node.type as AccountType]));
      for (const row of before) {
        const type = typeOf.get(row.account_id) ?? 'expense';
        merged.set(`${row.org_id}:${row.account_id}`, {
          orgId: row.org_id,
          accountId: row.account_id,
          amount: isQuantityType(type) ? undefined : centsToYuanString(row.amount_cents * signOfType(type)),
          quantity: row.quantity == null ? undefined : scaledToQuantityString(row.quantity),
          formula: row.formula,
          note: row.note,
        });
      }
      budget.saveEntries(db, payload.versionId, [...merged.values()]);
    } else {
      const payload = json<ActualPayload>(batch.payload_json);
      const keys = new Set(payload.batches.flatMap((group) => group.entries.map((entry) => `${group.year}:${entry.orgId}:${entry.accountId}`)));
      const current = rawActualSnapshot(db, keys);
      const expected = json<RawActualValue[]>(batch.after_json);
      if (!sameJson(current, expected)) throw Errors.conflict('导入后相关实际数已被修改,为避免覆盖新数据不能自动撤销');
      const before = json<RawActualValue[]>(batch.before_json);
      const beforeByKey = new Map(before.map((row) => [`${row.year}:${row.orgId}:${row.accountId}`, row]));
      const accountRows = db.prepare('SELECT id, type FROM account').all() as { id: number; type: AccountType }[];
      const typeOf = new Map(accountRows.map((row) => [row.id, row.type]));
      const groups = new Map<number, actual.ActualEntryInput[]>();
      for (const key of keys) {
        const [year, orgId, accountId] = key.split(':').map(Number);
        const row = beforeByKey.get(key);
        const type = typeOf.get(accountId) ?? 'expense';
        const entry: actual.ActualEntryInput = { orgId, accountId, memo: row?.memo ?? '撤销 Excel 导入' };
        if (isQuantityType(type)) entry.quantity = row?.quantity == null ? '0' : scaledToQuantityString(row.quantity);
        else entry.amount = centsToYuanString((row?.amountCents ?? 0) * signOfType(type));
        groups.set(year, [...(groups.get(year) ?? []), entry]);
      }
      for (const [year, entries] of groups) {
        const state = actual.getYearState(db, year);
        const currentBatch = state?.current_batch_id == null ? undefined : actual.getBatch(db, state.current_batch_id);
        actual.saveActual(db, {
          year,
          snapshotDate: currentBatch?.snapshot_date ?? `${year}-12-31`,
          entries,
          source: 'excel_import',
          note: `撤销导入批次 #${id}`,
          mode: 'upsert',
          clearBlankMemos: true,
        });
      }
    }
    db.prepare("UPDATE import_batch SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?").run(now, id);
    // 撤销后清掉转换批次上的导入链接,否则该转换批次永远无法重新创建导入预览
    // (createImportPreview 见到非空 import_batch_id 就拒绝)。
    db.prepare('UPDATE finance_conversion_batch SET status = ?, imported_at = NULL, import_batch_id = NULL WHERE import_batch_id = ?').run('validated', id);
    writeLog(db, 'import.rollback', 'import_batch', id, { kind: batch.kind });
  })();
  return getBatch(db, id);
}

export function cancelBatch(db: DB, id: number): void {
  const batch = getBatch(db, id);
  if (batch.status !== 'pending') throw Errors.conflict('只有待确认的导入预览可以取消');
  db.transaction(() => {
    db.prepare('DELETE FROM import_cleaning_preview_row WHERE import_batch_id = ?').run(id);
    // 统一预览明细遵循同一清理政策:取消即删除明细,批次摘要与审计保留
    db.prepare('DELETE FROM import_preview_detail WHERE import_batch_id = ?').run(id);
    db.prepare("UPDATE import_batch SET status = 'cancelled', file_blob = X'', payload_json = '{}' WHERE id = ?").run(id);
    writeLog(db, 'import.cancel', 'import_batch', id, { kind: batch.kind });
  })();
}

/**
 * pending 批次的原始文件 blob 过期清理(默认 7 天):
 * 预览后不确认也不取消,file_blob(可达 10MB)会永久滞留 SQLite。
 * 过期批次与 cancel 同口径:清 blob/payload 并标记 cancelled,返回清理条数。
 * 在备份/启动路径调用;不删记录本体,保留审计痕迹。
 */
export function sweepExpiredPendingBatches(db: DB, maxAgeMs = 7 * 24 * 3600 * 1000): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db.prepare(
    "SELECT id FROM import_batch WHERE status = 'pending' AND created_at < ?",
  ).all(cutoff) as { id: number }[];
  if (!stale.length) return 0;
  db.transaction(() => {
    const delRows = db.prepare('DELETE FROM import_cleaning_preview_row WHERE import_batch_id = ?');
    const delDetails = db.prepare('DELETE FROM import_preview_detail WHERE import_batch_id = ?');
    const cancel = db.prepare("UPDATE import_batch SET status = 'cancelled', file_blob = X'', payload_json = '{}' WHERE id = ?");
    for (const { id } of stale) {
      delRows.run(id);
      delDetails.run(id);
      cancel.run(id);
      writeLog(db, 'import.expire', 'import_batch', id, { reason: 'pending 预览过期清理' });
    }
  })();
  return stale.length;
}

/* ============ UX-14:批次只读详情与冻结明细分页 ============ */

export type DetailCapability = 'frozen-detail' | 'legacy-summary';

export interface BatchActionGate {
  allowed: boolean;
  reason?: string;
}

export interface ImportBatchDetail {
  id: number;
  kind: 'budget' | 'actual';
  status: ImportBatchRow['status'];
  history: boolean;
  originalName: string;
  sha256: string;
  createdAt: string;
  committedAt: string | null;
  rolledBackAt: string | null;
  /** 业务目标:预算为绑定版本,实际为 年度×截止日 分组(多年度不折叠为单一 year) */
  target: {
    versionId?: number;
    versionName?: string;
    year?: number;
    years?: number[];
    periods?: { year: number; snapshotDate: string; entryCount: number }[];
  };
  /** 创建时冻结的统一预览摘要;旧批次没有时为 null */
  preview: UnifiedPreviewSummary | null;
  /** 批次原有业务摘要(各导入路径自有的补充信息) */
  summary: Record<string, unknown>;
  /** 提交/撤销后的结果;pending 批次为 null */
  result: Record<string, unknown> | null;
  detailCapability: DetailCapability;
  detailNote?: string;
  actions: { confirm: BatchActionGate; cancel: BatchActionGate; rollback: BatchActionGate };
}

function statusReason(status: ImportBatchRow['status']): string {
  switch (status) {
    case 'committed': return '批次已确认提交';
    case 'cancelled': return '预览已取消或过期';
    case 'rolled_back': return '批次已撤销';
    default: return '';
  }
}

/** 只读批次详情(UX-14/UX-19):不返回文件正文,也不返回可供修改后重放的 payload。 */
export function getBatchDetail(db: DB, id: number): ImportBatchDetail {
  const batch = getBatch(db, id);
  const summary = json<Record<string, unknown>>(batch.summary_json);
  const preview = (summary.unifiedPreview ?? null) as UnifiedPreviewSummary | null;
  const detailCount = (db.prepare('SELECT COUNT(*) AS count FROM import_preview_detail WHERE import_batch_id = ?').get(id) as { count: number }).count;
  const detailCapability: DetailCapability = detailCount > 0 ? 'frozen-detail' : 'legacy-summary';
  const detailNote = detailCapability === 'frozen-detail'
    ? undefined
    : batch.status === 'cancelled'
      ? '该预览已取消或过期，逐行明细已按清理政策移除；批次摘要与审计日志保留'
      : '该批次创建于统一预览明细冻结能力启用前，仅提供已有摘要；需要完整逐行差异请重新预览';

  const target: ImportBatchDetail['target'] = {};
  if (batch.kind === 'budget' && batch.target_version_id != null) {
    const version = db.prepare('SELECT name, year FROM budget_version WHERE id = ?').get(batch.target_version_id) as { name: string; year: number } | undefined;
    target.versionId = batch.target_version_id;
    if (version) {
      target.versionName = version.name;
      target.year = version.year;
    }
  } else if (batch.kind === 'actual') {
    if (preview?.periods?.length) {
      target.periods = preview.periods;
      target.years = preview.target.years;
      target.year = preview.target.year;
    } else {
      const years = Array.isArray(summary.years) ? (summary.years as number[]) : undefined;
      if (years?.length) {
        target.years = years;
        target.year = years[0];
      }
    }
  }

  const pending = batch.status === 'pending';
  const historyBlocked = batch.kind === 'actual' && batch.history === 1;
  return {
    id: batch.id,
    kind: batch.kind,
    status: batch.status,
    history: batch.history === 1,
    originalName: batch.original_name,
    sha256: batch.sha256,
    createdAt: batch.created_at,
    committedAt: batch.committed_at,
    rolledBackAt: batch.rolled_back_at,
    target,
    preview,
    summary,
    result: batch.status === 'committed' || batch.status === 'rolled_back' ? json<Record<string, unknown>>(batch.result_json) : null,
    detailCapability,
    detailNote,
    actions: {
      confirm: pending ? { allowed: true } : { allowed: false, reason: statusReason(batch.status) },
      cancel: pending ? { allowed: true } : { allowed: false, reason: statusReason(batch.status) },
      rollback: batch.status !== 'committed'
        ? { allowed: false, reason: batch.status === 'pending' ? '批次尚未确认，可取消而非撤销' : statusReason(batch.status) }
        : historyBlocked
          ? { allowed: false, reason: '历史补录不改变当前实际，请通过快照修订管理处理' }
          : { allowed: true, reason: '仅当导入后相关数据未再改动时可撤销成功' },
    },
  };
}

export interface PreviewRowQuery {
  page?: number;
  pageSize?: number;
  orgId?: number;
  action?: string;
  warningOnly?: boolean;
}

export interface PreviewRowDto {
  id: number;
  groupYear: number | null;
  groupDate: string | null;
  sourceSheet: string;
  /** 源行号可追溯到源文件;null 表示该批次无法定位源行 */
  sourceRow: number | null;
  orgId: number | null;
  orgCode: string;
  accountId: number | null;
  accountCode: string;
  valueKind: PreviewDetailRow['value_kind'];
  oldCents: number | null;
  newCents: number | null;
  oldQuantity: number | null;
  newQuantity: number | null;
  oldText: string;
  newText: string;
  oldFormula: string;
  newFormula: string;
  /** 展示用无损字符串:金额为元(利润方向符号),数量为自然单位;不用于差异判断 */
  oldValue: string | null;
  newValue: string | null;
  action: PreviewDetailRow['action'];
  warning: string;
}

function toPreviewRowDto(row: PreviewDetailRow): PreviewRowDto {
  const valueText = (cents: number | null, quantity: number | null) =>
    row.value_kind === 'amount' ? (cents == null ? null : centsToYuanString(cents))
      : row.value_kind === 'quantity' ? (quantity == null ? null : scaledToQuantityString(quantity))
        : null;
  return {
    id: row.id,
    groupYear: row.group_year,
    groupDate: row.group_date,
    sourceSheet: row.source_sheet,
    sourceRow: row.source_row,
    orgId: row.org_id,
    orgCode: row.org_code,
    accountId: row.account_id,
    accountCode: row.account_code,
    valueKind: row.value_kind,
    oldCents: row.old_cents,
    newCents: row.new_cents,
    oldQuantity: row.old_quantity,
    newQuantity: row.new_quantity,
    oldText: row.old_text,
    newText: row.new_text,
    oldFormula: row.old_formula,
    newFormula: row.new_formula,
    oldValue: valueText(row.old_cents, row.old_quantity),
    newValue: valueText(row.new_cents, row.new_quantity),
    action: row.action,
    warning: row.warning,
  };
}

const PREVIEW_ACTIONS = new Set(['insert', 'overwrite', 'clear', 'unchanged', 'note_change', 'excluded', 'skipped']);

/**
 * 分页读取创建时冻结的预览明细(UX-14/UX-15):只读 import_preview_detail,
 * 不按当前数据重算差异。已提交/已撤销批次保留明细供审计;
 * 取消/过期批次与旧批次没有明细时明确报错及降级原因。
 */
export function listBatchPreviewRows(
  db: DB,
  id: number,
  options: PreviewRowQuery = {},
): { total: number; page: number; pageSize: number; detailCapability: DetailCapability; items: PreviewRowDto[] } {
  const batch = getBatch(db, id);
  const total = (db.prepare('SELECT COUNT(*) AS count FROM import_preview_detail WHERE import_batch_id = ?').get(id) as { count: number }).count;
  if (total === 0) {
    throw Errors.notFound(batch.status === 'cancelled'
      ? '预览明细(该预览已取消或过期，明细已按清理政策移除)'
      : '预览明细(该批次创建于明细冻结能力启用前，请重新预览以生成逐行差异)');
  }
  const page = Number.isSafeInteger(options.page) ? Math.max(1, options.page!) : 1;
  const pageSize = Number.isSafeInteger(options.pageSize) ? Math.min(200, Math.max(1, options.pageSize!)) : 100;
  if (options.action && !PREVIEW_ACTIONS.has(options.action)) throw Errors.validation(`action 筛选值不合法: ${options.action}`);
  const clauses = ['import_batch_id = ?'];
  const params: unknown[] = [id];
  if (options.orgId != null) {
    if (!Number.isSafeInteger(options.orgId) || options.orgId <= 0) throw Errors.validation('orgId 必须是正整数');
    clauses.push('org_id = ?');
    params.push(options.orgId);
  }
  if (options.action) {
    clauses.push('action = ?');
    params.push(options.action);
  }
  if (options.warningOnly) clauses.push("warning <> ''");
  const where = clauses.join(' AND ');
  const filtered = (db.prepare(`SELECT COUNT(*) AS count FROM import_preview_detail WHERE ${where}`).get(...params) as { count: number }).count;
  const items = db.prepare(
    `SELECT * FROM import_preview_detail WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`,
  ).all(...params, pageSize, (page - 1) * pageSize) as PreviewDetailRow[];
  return { total: filtered, page, pageSize, detailCapability: 'frozen-detail', items: items.map(toPreviewRowDto) };
}
