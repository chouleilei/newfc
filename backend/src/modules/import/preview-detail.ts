import type { DB } from '../../db/connection';
import { displayToSignedCents, isQuantityType, quantityStringToScaled, type AccountType } from '../../core/money';
import * as budget from '../budget/budget.service';
import { listRows } from '../actual/actual.helpers';
import type { ActualEntryInput } from '../actual/actual.service';
import type { BudgetEntryInput } from '../budget/budget.service';

/**
 * 统一导入预览明细(易用性方案 UX-14,§5.3)。
 * 标准预算/实际导入在创建批次时按服务端整数分/缩放整数冻结逐行差异;
 * 清洗与财务转换由各自预览服务把既有差异适配为同一结构。
 * 差异判断一律使用整数分/缩放整数,不使用万元显示值。
 */

export type PreviewAction = 'insert' | 'overwrite' | 'clear' | 'unchanged' | 'note_change' | 'excluded' | 'skipped';
export type PreviewValueKind = 'amount' | 'quantity' | 'memo';
export type PreviewSource = 'standard' | 'cleaning' | 'finance';

export interface PreviewDetailInput {
  groupYear: number | null;
  groupDate: string | null;
  sourceSheet: string;
  sourceRow: number | null;
  orgId: number | null;
  orgCode: string;
  accountId: number | null;
  accountCode: string;
  valueKind: PreviewValueKind;
  oldCents: number | null;
  newCents: number | null;
  oldQuantity: number | null;
  newQuantity: number | null;
  oldText: string;
  newText: string;
  oldFormula: string;
  newFormula: string;
  action: PreviewAction;
  warning: string;
}

export interface PreviewActionCounts {
  insert: number;
  overwrite: number;
  clear: number;
  unchanged: number;
  noteChange: number;
  excluded: number;
  skipped: number;
}

/** 统一预览摘要 DTO(§5.3):创建批次时冻结进 summary_json.unifiedPreview。 */
export interface UnifiedPreviewSummary {
  schemaVersion: 1;
  kind: 'budget' | 'actual';
  source: PreviewSource;
  history: boolean;
  target: { versionId?: number; versionName?: string; year?: number; years?: number[] };
  /** 实际导入按 年度×截止日 分组;预算导入为空数组 */
  periods: { year: number; snapshotDate: string; entryCount: number }[];
  orgScope: { count: number; codes: string[] };
  /** 明细行内的精确值口径:金额为整数分,数量为 10^4 缩放整数 */
  amountUnit: 'yuan';
  /** 符号口径:收入为正、成本费用为负(利润方向),与存储一致 */
  signConvention: 'profit_direction';
  actions: PreviewActionCounts;
  warnings: number;
  updatesCurrent: boolean;
  createsSnapshot: boolean;
  /** 差异比较基线:当前累计 / 同日历史快照(历史补录) / 预算版本明细 */
  comparisonBasis: 'actual_current' | 'history_snapshot' | 'budget_entry';
  resultLocation: 'budget_entry' | 'actual_current_and_snapshot' | 'actual_history_snapshot';
}

export function countActions(details: PreviewDetailInput[]): PreviewActionCounts {
  const counts: PreviewActionCounts = { insert: 0, overwrite: 0, clear: 0, unchanged: 0, noteChange: 0, excluded: 0, skipped: 0 };
  for (const row of details) {
    if (row.action === 'note_change') counts.noteChange++;
    else counts[row.action]++;
  }
  return counts;
}

/** 由明细行装配统一摘要,保证四条导入路径的动作计数口径一致。 */
export function unifiedSummary(input: {
  kind: 'budget' | 'actual';
  source: PreviewSource;
  history: boolean;
  target: UnifiedPreviewSummary['target'];
  periods: UnifiedPreviewSummary['periods'];
  orgCodes: string[];
  details: PreviewDetailInput[];
  updatesCurrent: boolean;
  createsSnapshot: boolean;
  comparisonBasis: UnifiedPreviewSummary['comparisonBasis'];
  resultLocation: UnifiedPreviewSummary['resultLocation'];
}): UnifiedPreviewSummary {
  const codes = [...new Set(input.orgCodes.filter(Boolean))].sort();
  return {
    schemaVersion: 1,
    kind: input.kind,
    source: input.source,
    history: input.history,
    target: input.target,
    periods: input.periods,
    orgScope: { count: codes.length, codes },
    amountUnit: 'yuan',
    signConvention: 'profit_direction',
    actions: countActions(input.details),
    warnings: input.details.filter((row) => row.warning !== '').length,
    updatesCurrent: input.updatesCurrent,
    createsSnapshot: input.createsSnapshot,
    comparisonBasis: input.comparisonBasis,
    resultLocation: input.resultLocation,
  };
}

export interface PreviewDetailRow {
  id: number;
  import_batch_id: number;
  group_year: number | null;
  group_date: string | null;
  source_sheet: string;
  source_row: number | null;
  org_id: number | null;
  org_code: string;
  account_id: number | null;
  account_code: string;
  value_kind: PreviewValueKind;
  old_cents: number | null;
  new_cents: number | null;
  old_quantity: number | null;
  new_quantity: number | null;
  old_text: string;
  new_text: string;
  old_formula: string;
  new_formula: string;
  action: PreviewAction;
  warning: string;
  created_at: string;
}

export function insertPreviewDetails(db: DB, batchId: number, details: PreviewDetailInput[], createdAt: string): void {
  if (details.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO import_preview_detail
      (import_batch_id, group_year, group_date, source_sheet, source_row,
       org_id, org_code, account_id, account_code, value_kind,
       old_cents, new_cents, old_quantity, new_quantity,
       old_text, new_text, old_formula, new_formula, action, warning, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of details) {
    insert.run(
      batchId, row.groupYear, row.groupDate, row.sourceSheet, row.sourceRow,
      row.orgId, row.orgCode, row.accountId, row.accountCode, row.valueKind,
      row.oldCents, row.newCents, row.oldQuantity, row.newQuantity,
      row.oldText, row.newText, row.oldFormula, row.newFormula, row.action, row.warning, createdAt,
    );
  }
}

/**
 * 标准预算导入逐行差异。分类必须与 commitBatch → saveEntries 的真实落库结果一致:
 * merged 整包替换下,导入命中格子按 (值, 公式, 附注) 全量覆盖;
 * 值为零且无公式无附注的格子不保留(已有行被删除)。
 */
export function buildStandardBudgetPreview(
  db: DB,
  versionId: number,
  entries: BudgetEntryInput[],
  sourceRows: { rowNumber?: number; sheetName?: string }[],
): { summary: UnifiedPreviewSummary; details: PreviewDetailInput[] } {
  const version = budget.getVersion(db, versionId);
  const matrix = budget.getEditMatrix(db, versionId);
  const typeOf = new Map(matrix.accountNodes.map((node) => [node.id, (node.type ?? 'expense') as AccountType]));
  const orgCodeOf = new Map(matrix.orgNodes.map((node) => [node.id, node.code]));
  const accCodeOf = new Map(matrix.accountNodes.map((node) => [node.id, node.code]));
  const oldByKey = new Map(matrix.entries.map((entry) => [`${entry.orgId}:${entry.accountId}`, entry]));

  const details: PreviewDetailInput[] = [];
  entries.forEach((entry, index) => {
    const type = typeOf.get(entry.accountId) ?? 'expense';
    const quantityKind = isQuantityType(type);
    const valueKind: PreviewValueKind = quantityKind ? 'quantity' : 'amount';
    const newQuantity = quantityKind ? quantityStringToScaled(entry.quantity ?? '0') : null;
    const newCents = quantityKind ? null : displayToSignedCents(entry.amount ?? '0', type as Exclude<AccountType, 'quantity'>);
    const formula = (entry.formula ?? '').trim();
    const note = (entry.note ?? '').trim();
    const newValue = quantityKind ? newQuantity! : newCents!;

    const old = oldByKey.get(`${entry.orgId}:${entry.accountId}`);
    const oldValue = old == null ? 0 : quantityKind
      ? (old.quantity != null ? quantityStringToScaled(old.quantity) : 0)
      : old.amountCents;
    const oldFormula = old?.formula ?? '';
    const oldNote = old?.note ?? '';
    // 与 saveEntries 的 keepEntry 同口径:零值且无公式/附注的格子不保留
    const kept = newValue !== 0 || formula !== '' || note !== '';

    let action: PreviewAction;
    let warning = '';
    if (old == null && !kept) action = 'unchanged';
    else if (old == null) action = 'insert';
    else if (!kept) {
      action = 'clear';
      warning = '导入后该预算明细行将被删除';
    } else if (oldValue === newValue && oldFormula === formula && oldNote === note) action = 'unchanged';
    else if (oldValue !== newValue) {
      if (newValue === 0) {
        action = 'clear';
        warning = '数值将清零，公式或附注仍保留';
      } else action = 'overwrite';
    } else if (oldFormula !== formula) action = 'overwrite';
    else action = 'note_change';
    if (quantityKind && newValue < 0 && (action === 'insert' || action === 'overwrite')) {
      warning = warning ? `${warning}；数量为负值` : '数量为负值';
    }

    const source = sourceRows[index];
    details.push({
      groupYear: null,
      groupDate: null,
      sourceSheet: source?.sheetName ?? '',
      sourceRow: source?.rowNumber ?? null,
      orgId: entry.orgId,
      orgCode: orgCodeOf.get(entry.orgId) ?? '',
      accountId: entry.accountId,
      accountCode: accCodeOf.get(entry.accountId) ?? '',
      valueKind,
      oldCents: quantityKind ? null : old == null ? null : oldValue,
      newCents,
      oldQuantity: quantityKind ? (old == null ? null : oldValue) : null,
      newQuantity,
      oldText: oldNote,
      newText: note,
      oldFormula,
      newFormula: formula,
      action,
      warning,
    });
  });

  const summary = unifiedSummary({
    kind: 'budget',
    source: 'standard',
    history: false,
    target: { versionId, versionName: version.name, year: version.year },
    periods: [],
    orgCodes: details.map((row) => row.orgCode),
    details,
    updatesCurrent: false,
    createsSnapshot: false,
    comparisonBasis: 'budget_entry',
    resultLocation: 'budget_entry',
  });
  return { summary, details };
}

export interface ActualPreviewGroup {
  year: number;
  snapshotDate: string;
  entries: ActualEntryInput[];
  /** 与 entries 同序的源行位置(解析成功时一一对应;不可追溯时长度可为 0) */
  sourceRows?: { rowNumber?: number; sheetName?: string }[];
}

/** 同日历史快照(updates_current=0 的 active 批次)的既有值:历史补录的比较基线。 */
function historySnapshotBaseline(db: DB, year: number, snapshotDate: string): Map<string, { amountCents: number; quantity: number | null }> {
  const batch = db.prepare(
    `SELECT id FROM actual_snapshot_batch
     WHERE year = ? AND snapshot_date = ? AND status = 'active' AND updates_current = 0
     ORDER BY revision DESC, id DESC LIMIT 1`,
  ).get(year, snapshotDate) as { id: number } | undefined;
  const map = new Map<string, { amountCents: number; quantity: number | null }>();
  if (!batch) return map;
  const rows = db.prepare(
    'SELECT org_id, account_id, cumulative_amount_cents, quantity FROM actual_snapshot_entry WHERE batch_id = ?',
  ).all(batch.id) as { org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null }[];
  for (const row of rows) map.set(`${row.org_id}:${row.account_id}`, { amountCents: row.cumulative_amount_cents, quantity: row.quantity });
  return map;
}

/**
 * 标准/财务实际导入逐行差异。分类必须与 commitBatch → saveActual(upsert) 一致:
 * 非零 upsert、零删除当前记录;备注非空覆盖、空备注在 clearBlankMemos=false 时保留旧值。
 * 历史补录(history=true)以「同日历史快照追加」为比较基线,不用当前累计值推导覆盖或清零。
 */
export function buildStandardActualPreview(
  db: DB,
  input: { history: boolean; clearBlankMemos?: boolean; batches: ActualPreviewGroup[]; source: PreviewSource },
): { summary: UnifiedPreviewSummary; details: PreviewDetailInput[] } {
  const accRows = listRows(db, 'account');
  const typeOf = new Map(accRows.map((row) => [row.id, (row.type ?? 'expense') as AccountType]));
  const orgCodeOf = new Map((listRows(db, 'org')).map((row) => [row.id, row.code]));
  const accCodeOf = new Map(accRows.map((row) => [row.id, row.code]));
  const clearBlankMemos = input.clearBlankMemos === true;

  const details: PreviewDetailInput[] = [];
  for (const group of input.batches) {
    const baseline = input.history
      ? historySnapshotBaseline(db, group.year, group.snapshotDate)
      : new Map((db.prepare(
        'SELECT org_id, account_id, cumulative_amount_cents, quantity, memo FROM actual_current WHERE year = ?',
      ).all(group.year) as { org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null; memo: string }[])
        .map((row) => [`${row.org_id}:${row.account_id}`, { amountCents: row.cumulative_amount_cents, quantity: row.quantity, memo: row.memo }]));

    group.entries.forEach((entry, index) => {
      const type = typeOf.get(entry.accountId) ?? 'expense';
      const quantityKind = isQuantityType(type);
      const valueKind: PreviewValueKind = quantityKind ? 'quantity' : 'amount';
      const newQuantity = quantityKind ? quantityStringToScaled(entry.quantity ?? '0') : null;
      const newCents = quantityKind ? null : displayToSignedCents(entry.amount ?? '0', type as Exclude<AccountType, 'quantity'>);
      const newValue = quantityKind ? newQuantity! : newCents!;
      const old = baseline.get(`${entry.orgId}:${entry.accountId}`);
      const oldValue = old == null ? 0 : quantityKind ? (old.quantity ?? 0) : old.amountCents;
      const oldMemo = !input.history && old && 'memo' in old ? (old as { memo: string }).memo : '';
      const newMemo = entry.memo ?? '';

      let action: PreviewAction;
      let warning = '';
      if (newValue === 0) {
        if (old == null) action = 'unchanged';
        else {
          action = 'clear';
          warning = input.history ? '该截止日历史快照中的对应记录将被移除' : '当前累计记录将被清零并删除';
        }
      } else if (old == null) action = 'insert';
      else if (oldValue !== newValue) action = 'overwrite';
      else if (!input.history && newMemo !== '' && newMemo !== oldMemo) action = 'note_change';
      else action = 'unchanged';
      // 空备注清除是清洗导入的显式选项(clearBlankMemos),标准导入不开启;
      // 这里只在值相同、备注将被清掉时单独标出,避免被误判为「不变」。
      if (!input.history && clearBlankMemos && old != null && newValue === oldValue && newValue !== 0 && newMemo === '' && oldMemo !== '') {
        action = 'note_change';
        warning = warning ? `${warning}；空备注将清除现有备注` : '空备注将清除现有备注';
      }
      if (quantityKind && newValue < 0 && (action === 'insert' || action === 'overwrite')) {
        warning = warning ? `${warning}；数量为负值` : '数量为负值';
      }

      const source = group.sourceRows && group.sourceRows.length === group.entries.length ? group.sourceRows[index] : undefined;
      details.push({
        groupYear: group.year,
        groupDate: group.snapshotDate,
        sourceSheet: source?.sheetName ?? '',
        sourceRow: source?.rowNumber ?? null,
        orgId: entry.orgId,
        orgCode: orgCodeOf.get(entry.orgId) ?? '',
        accountId: entry.accountId,
        accountCode: accCodeOf.get(entry.accountId) ?? '',
        valueKind,
        oldCents: quantityKind ? null : old == null ? null : oldValue,
        newCents,
        oldQuantity: quantityKind ? (old == null ? null : oldValue) : null,
        newQuantity,
        oldText: input.history ? '' : oldMemo,
        newText: input.history ? '' : newMemo,
        oldFormula: '',
        newFormula: '',
        action,
        warning,
      });
    });
  }

  const years = [...new Set(input.batches.map((group) => group.year))].sort((a, b) => a - b);
  const summary = unifiedSummary({
    kind: 'actual',
    source: input.source,
    history: input.history,
    target: { year: years[0], years },
    periods: input.batches.map((group) => ({ year: group.year, snapshotDate: group.snapshotDate, entryCount: group.entries.length })),
    orgCodes: details.map((row) => row.orgCode),
    details,
    updatesCurrent: !input.history,
    createsSnapshot: true,
    comparisonBasis: input.history ? 'history_snapshot' : 'actual_current',
    resultLocation: input.history ? 'actual_history_snapshot' : 'actual_current_and_snapshot',
  });
  return { summary, details };
}
