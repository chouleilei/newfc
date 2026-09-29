import type { DB } from '../../../db/connection';
import crypto from 'crypto';
import { AppError, Errors } from '../../../core/errors';
import { centsToYuanString, quantityStringToScaled, safeIntegerAdd, yuanStringToCents } from '../../../core/money';
import * as imports from '../../import/import.service';
import * as budget from '../../budget/budget.service';
import { writeLog } from '../../audit/log';
import { assertNoFinanceOwnedConflicts } from '../../finance-import/owned-scope';
import { loadSnapshotNodes } from '../../tree/snapshot';
import { importedAmountToYuan, normalizeImportedNumber } from '../import-values';
import { MAX_IMPORT_ERRORS } from '../import-limits';
import { createCleaningBaseline } from './baseline';
import { unifiedSummary, type PreviewDetailInput } from '../../import/preview-detail';
import type { CleaningPlan, CleaningTarget } from './plan';
import type { CleaningUploadStore } from './upload-store';
import type { CleaningAnalysisRow, CleaningApplyResult, CleaningIssue } from './apply';

export type CleaningPreviewAction = 'insert' | 'overwrite' | 'unchanged' | 'clear' | 'excluded';

interface PreviewRow extends CleaningAnalysisRow {
  action: CleaningPreviewAction;
  /** 冻结明细用的精确旧/新值(金额为整数分,数量为缩放整数);排除行与无旧值时为 null */
  beforeValue: number | null;
  afterValue: number | null;
  hadOld: boolean;
}

interface BudgetCurrent {
  amount_cents: number;
  quantity: number | null;
  formula: string;
  note: string;
}

interface ActualCurrent {
  cumulative_amount_cents: number;
  quantity: number | null;
  memo: string;
}

function incompleteError(analysis: CleaningApplyResult): AppError {
  const rowErrors = analysis.errors.map((item) => ({ row: item.row, field: item.field, message: `${item.sheetName ? `${item.sheetName}!` : ''}${item.row || ''} ${item.message}`.trim() }));
  return new AppError(
    'CLEANING_PREVIEW_INCOMPLETE',
    `仍有 ${analysis.counts.errors} 条错误和 ${analysis.counts.unresolved} 个未决映射，不能创建待确认批次`,
    422,
    rowErrors,
    { errors: analysis.errors, unresolved: analysis.unresolved, counts: analysis.counts },
  );
}

function rootAccountCodeResolver(db: DB, analysis: CleaningApplyResult): (accountId: number) => string {
  const rows = analysis.target.targetKind === 'budget'
    ? loadSnapshotNodes(db, budget.getVersion(db, analysis.target.versionId!).account_tree_snapshot_id)
    : db.prepare('SELECT id, parent_id, code FROM account').all() as { id: number; parent_id: number | null; code: string }[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const cache = new Map<number, string>();
  return (accountId: number) => {
    const cached = cache.get(accountId);
    if (cached !== undefined) return cached;
    let current = byId.get(accountId);
    while (current?.parent_id != null && byId.has(current.parent_id)) current = byId.get(current.parent_id);
    const code = current?.code ?? '';
    cache.set(accountId, code);
    return code;
  };
}

function add(total: number, value: number, label: string): number {
  return safeIntegerAdd(total, value, label);
}

function actionsAndSummary(db: DB, analysis: CleaningApplyResult): { rows: PreviewRow[]; summary: Record<string, unknown> } {
  const entryByKey = new Map(analysis.entries.map((entry) => [`${entry.orgId}:${entry.accountId}`, entry]));
  const budgetCurrent = new Map<string, BudgetCurrent>();
  const actualCurrent = new Map<string, ActualCurrent>();
  if (analysis.target.targetKind === 'budget') {
    const rows = db.prepare(
      'SELECT org_id, account_id, amount_cents, quantity, formula, note FROM budget_entry WHERE version_id = ?',
    ).all(analysis.target.versionId!) as (BudgetCurrent & { org_id: number; account_id: number })[];
    for (const row of rows) budgetCurrent.set(`${row.org_id}:${row.account_id}`, row);
  } else {
    const rows = db.prepare(
      'SELECT org_id, account_id, cumulative_amount_cents, quantity, memo FROM actual_current WHERE year = ?',
    ).all(analysis.target.year!) as (ActualCurrent & { org_id: number; account_id: number })[];
    for (const row of rows) actualCurrent.set(`${row.org_id}:${row.account_id}`, row);
  }
  const actionCounts: Record<CleaningPreviewAction, number> = { insert: 0, overwrite: 0, unchanged: 0, clear: 0, excluded: 0 };
  let beforeAmountCents = 0;
  let afterAmountCents = 0;
  let excludedSourceAmountCents = 0;
  const amountChanges = new Map<string, { orgCode: string; rootAccountCode: string; changeCents: number }>();
  const quantityGroups = new Map<string, { accountCode: string; unit: string; quantityAgg: string; beforeScaled: number; afterScaled: number; changeScaled: number }>();
  const excludedQuantityGroups = new Map<string, { accountCode: string; unit: string; quantityScaled: number }>();
  const previewRows: PreviewRow[] = [];
  const rootAccountCode = rootAccountCodeResolver(db, analysis);
  const clearBlankMemos = analysis.plan.clearBlankNotes === true
    && analysis.plan.columns.some((column) => column.field === 'note');
  let largeChangeCount = 0;
  const largeChangeWarnings: CleaningIssue[] = [];

  for (const sourceRow of analysis.rows) {
    if (sourceRow.excluded) {
      actionCounts.excluded++;
      previewRows.push({ ...sourceRow, action: 'excluded', beforeValue: null, afterValue: null, hadOld: false });
      try {
        if (analysis.valueKind === 'amount' && sourceRow.sourceValueText.trim()) {
          excludedSourceAmountCents = add(excludedSourceAmountCents, yuanStringToCents(importedAmountToYuan(sourceRow.sourceValueText, analysis.plan.amountUnit!)), '排除金额合计');
        } else if (analysis.valueKind === 'quantity' && sourceRow.sourceValueText.trim()) {
          const scaled = sourceRow.quantityScaled ?? quantityStringToScaled(normalizeImportedNumber(sourceRow.sourceValueText));
          const target = analysis.targets.accounts.find((item) => item.id === sourceRow.targetAccountId);
          const key = target?.code ?? (sourceRow.sourceAccountText || '未匹配科目');
          const group = excludedQuantityGroups.get(key) ?? { accountCode: target?.code ?? key, unit: target?.unit ?? '', quantityScaled: 0 };
          group.quantityScaled = add(group.quantityScaled, scaled, '排除数量合计');
          excludedQuantityGroups.set(key, group);
        }
      } catch { /* 排除行不因无法解析而阻断；原始值仍在逐行预览中 */ }
      continue;
    }
    if (sourceRow.targetOrgId == null || sourceRow.targetAccountId == null) continue;
    const key = `${sourceRow.targetOrgId}:${sourceRow.targetAccountId}`;
    const entry = entryByKey.get(key)!;
    let action: CleaningPreviewAction;
    let hadOld = false;
    let beforeValue = 0;
    let afterValue = analysis.valueKind === 'amount' ? sourceRow.expectedSignedCents! : sourceRow.quantityScaled!;
    if (analysis.target.targetKind === 'budget') {
      const old = budgetCurrent.get(key);
      hadOld = old != null;
      beforeValue = analysis.valueKind === 'amount' ? old?.amount_cents ?? 0 : old?.quantity ?? 0;
      const formula = 'formula' in entry ? entry.formula ?? '' : '';
      const note = 'note' in entry ? entry.note ?? '' : '';
      const sameMetadata = (old?.formula ?? '') === formula && (old?.note ?? '') === note;
      const emptyAfter = afterValue === 0 && formula === '' && note === '';
      if (!old) action = emptyAfter ? 'unchanged' : 'insert';
      else if (beforeValue === afterValue && sameMetadata) action = 'unchanged';
      else if (emptyAfter || (afterValue === 0 && beforeValue !== 0)) action = 'clear';
      else action = 'overwrite';
    } else {
      const old = actualCurrent.get(key);
      hadOld = old != null;
      beforeValue = analysis.valueKind === 'amount' ? old?.cumulative_amount_cents ?? 0 : old?.quantity ?? 0;
      const importedMemo = 'memo' in entry ? entry.memo ?? '' : '';
      const memo = clearBlankMemos ? importedMemo : importedMemo || old?.memo || '';
      const sameMemo = (old?.memo ?? '') === memo;
      if (!old) action = afterValue === 0 ? 'unchanged' : 'insert';
      else if (beforeValue === afterValue && sameMemo) action = 'unchanged';
      else if (afterValue === 0) action = 'clear';
      else action = 'overwrite';
    }
    if (action === 'overwrite' && beforeValue !== 0) {
      const ratio = Math.abs(afterValue / beforeValue);
      if (ratio > 10 || ratio < 0.1) {
        const message = '变化较大（超过 10 倍或减少到 1/10 以下）';
        sourceRow.warnings.push(message);
        largeChangeWarnings.push({
          sheetName: sourceRow.sheetName,
          row: sourceRow.rowNumber,
          field: analysis.valueKind,
          code: 'LARGE_CHANGE',
          message,
        });
        largeChangeCount++;
      }
    }
    actionCounts[action]++;
    previewRows.push({ ...sourceRow, action, beforeValue, afterValue, hadOld });
    if (analysis.valueKind === 'amount') {
      beforeAmountCents = add(beforeAmountCents, beforeValue, '导入前金额合计');
      afterAmountCents = add(afterAmountCents, afterValue, '导入后金额合计');
      const rootCode = rootAccountCode(sourceRow.targetAccountId);
      const groupKey = `${sourceRow.targetOrgCode}:${rootCode}`;
      const oldGroup = amountChanges.get(groupKey) ?? { orgCode: sourceRow.targetOrgCode!, rootAccountCode: rootCode, changeCents: 0 };
      oldGroup.changeCents = add(oldGroup.changeCents, add(afterValue, -beforeValue, '单元格金额变化'), '组织科目金额变化');
      amountChanges.set(groupKey, oldGroup);
    } else {
      const target = analysis.targets.accounts.find((item) => item.id === sourceRow.targetAccountId)!;
      const group = quantityGroups.get(target.code) ?? {
        accountCode: target.code,
        unit: target.unit ?? '',
        quantityAgg: target.quantityAgg ?? 'sum',
        beforeScaled: 0,
        afterScaled: 0,
        changeScaled: 0,
      };
      if (group.quantityAgg === 'sum') {
        group.beforeScaled = add(group.beforeScaled, beforeValue, '导入前数量合计');
        group.afterScaled = add(group.afterScaled, afterValue, '导入后数量合计');
        group.changeScaled = add(group.changeScaled, add(afterValue, -beforeValue, '单元格数量变化'), '数量变化合计');
      }
      quantityGroups.set(target.code, group);
    }
  }
  const largeWarningLimit = largeChangeWarnings.length > 0
    ? Math.min(largeChangeWarnings.length, Math.max(1, Math.floor(MAX_IMPORT_ERRORS / 2)))
    : 0;
  const warningSamples = [
    ...analysis.warnings.slice(0, MAX_IMPORT_ERRORS - largeWarningLimit),
    ...largeChangeWarnings.slice(0, largeWarningLimit),
  ];
  return {
    rows: previewRows,
    summary: {
      targetKind: analysis.target.targetKind,
      valueKind: analysis.valueKind,
      amountUnit: analysis.plan.amountUnit,
      signConvention: analysis.plan.signConvention,
      scopeLabel: '本次命中单元格范围',
      counts: { ...analysis.counts, ...actionCounts, warnings: analysis.counts.warnings + largeChangeCount, largeChange: largeChangeCount },
      actions: actionCounts,
      ...(analysis.valueKind === 'amount' ? {
        amount: {
          beforeCents: beforeAmountCents,
          afterCents: afterAmountCents,
          changeCents: add(afterAmountCents, -beforeAmountCents, '导入金额变化'),
          excludedSourceAmountCents,
          changesByOrgAndRoot: [...amountChanges.values()],
        },
      } : {
        quantity: {
          groups: [...quantityGroups.values()],
          excludedGroups: [...excludedQuantityGroups.values()],
        },
      }),
      warnings: warningSamples,
      clearSemantics: analysis.target.targetKind === 'actual-current'
        ? '显式零删除当前实际记录'
        : '显式零在公式和备注均为空时删除预算记录，否则清零并保留公式或备注',
    },
  };
}

export function createPendingCleaningPreview(
  db: DB,
  input: { analysis: CleaningApplyResult; originalName: string; file: Buffer; actor?: string },
): { importBatchId: number; sha256: string; summary: Record<string, unknown> } {
  const { analysis } = input;
  if (analysis.errors.length > 0 || analysis.unresolved.length > 0) throw incompleteError(analysis);
  if (analysis.entries.length === 0) throw Errors.validation('没有可导入的有效行');
  if (analysis.target.targetKind === 'actual-current') {
    assertNoFinanceOwnedConflicts(db, analysis.entries.map((entry) => ({ orgId: entry.orgId, accountId: entry.accountId })));
  }
  const calculated = actionsAndSummary(db, analysis);
  // UX-14 适配:清洗已有完整差异,映射为统一预览明细(金额为整数分,数量为缩放整数),
  // 与批次、计划、清洗预览行在同一事务冻结;确认/撤销仍走原 imports 服务。
  const isBudgetTarget = analysis.target.targetKind === 'budget';
  const isAmount = analysis.valueKind === 'amount';
  const previewDetails: PreviewDetailInput[] = calculated.rows.map((row) => ({
    groupYear: isBudgetTarget ? null : analysis.target.year!,
    groupDate: isBudgetTarget ? null : analysis.target.snapshotDate!,
    sourceSheet: row.sheetName,
    sourceRow: row.rowNumber,
    orgId: row.targetOrgId ?? null,
    orgCode: row.targetOrgCode ?? '',
    accountId: row.targetAccountId ?? null,
    accountCode: row.targetAccountCode ?? '',
    valueKind: isAmount ? 'amount' : 'quantity',
    oldCents: isAmount && row.hadOld ? row.beforeValue : null,
    newCents: isAmount && row.action !== 'excluded' ? row.afterValue : null,
    oldQuantity: !isAmount && row.hadOld ? row.beforeValue : null,
    newQuantity: !isAmount && row.action !== 'excluded' ? row.afterValue : null,
    oldText: '',
    newText: row.note ?? '',
    oldFormula: '',
    newFormula: '',
    action: row.action,
    warning: row.warnings.join('；'),
  }));
  const previewSummary = unifiedSummary({
    kind: isBudgetTarget ? 'budget' : 'actual',
    source: 'cleaning',
    history: false,
    target: isBudgetTarget
      ? (() => { const v = budget.getVersion(db, analysis.target.versionId!); return { versionId: v.id, versionName: v.name, year: v.year }; })()
      : { year: analysis.target.year!, years: [analysis.target.year!] },
    periods: isBudgetTarget ? [] : [{ year: analysis.target.year!, snapshotDate: analysis.target.snapshotDate!, entryCount: analysis.entries.length }],
    orgCodes: previewDetails.map((row) => row.orgCode),
    details: previewDetails,
    updatesCurrent: !isBudgetTarget,
    createsSnapshot: !isBudgetTarget,
    comparisonBasis: isBudgetTarget ? 'budget_entry' : 'actual_current',
    resultLocation: isBudgetTarget ? 'budget_entry' : 'actual_current_and_snapshot',
  });
  let batchId = 0;
  let sha256 = '';
  const finalSummary = db.transaction(() => {
    // 与批次、计划、预览行同一事务生成，避免树/年度基线与可确认 payload 脱节。
    const cleaningBaseline = createCleaningBaseline(db, analysis.target);
    const summary = { ...calculated.summary, cleaningBaseline };
    const payload = analysis.target.targetKind === 'budget'
      ? { versionId: analysis.target.versionId!, entries: analysis.entries }
      : {
          history: false,
          note: '非标准 Excel 清洗导入',
          clearBlankMemos: analysis.plan.clearBlankNotes === true
            && analysis.plan.columns.some((column) => column.field === 'note'),
          batches: [{ year: analysis.target.year!, snapshotDate: analysis.target.snapshotDate!, entries: analysis.entries }],
        };
    const batch = imports.createBatch(db, {
      kind: analysis.target.targetKind === 'budget' ? 'budget' : 'actual',
      targetVersionId: analysis.target.versionId,
      history: false,
      originalName: input.originalName,
      file: input.file,
      payload,
      summary,
      cleaningPlan: analysis.plan,
      preview: { summary: previewSummary, details: previewDetails },
    });
    batchId = batch.id;
    sha256 = batch.sha256;
    const insert = db.prepare(
      `INSERT INTO import_cleaning_preview_row
        (import_batch_id, sheet_name, row_number, source_org_text, source_account_text, source_value_text,
         target_org_code, target_account_code, normalized_value, expected_value_text, action, warning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of calculated.rows) {
      insert.run(batch.id, row.sheetName, row.rowNumber, row.sourceOrgText, row.sourceAccountText, row.sourceValueText,
        row.targetOrgCode ?? '', row.targetAccountCode ?? '', row.normalizedValue,
        analysis.valueKind === 'amount' && row.expectedSignedCents != null ? centsToYuanString(row.expectedSignedCents) : '',
        row.action, row.warnings.join('；'));
    }
    writeLog(db, 'cleaning.preview', 'import_batch', batch.id, {
      actor: input.actor ?? '',
      templateId: analysis.plan.templateId,
      amountUnit: analysis.plan.amountUnit,
      signConvention: analysis.plan.signConvention,
      actions: (summary as { actions?: unknown }).actions,
    });
    return summary;
  })();
  return { importBatchId: batchId, sha256, summary: finalSummary };
}

export interface CleaningPreviewRowDb {
  id: number;
  import_batch_id: number;
  sheet_name: string;
  row_number: number;
  source_org_text: string;
  source_account_text: string;
  source_value_text: string;
  target_org_code: string;
  target_account_code: string;
  normalized_value: string;
  expected_value_text: string;
  action: CleaningPreviewAction;
  warning: string;
}

export function listPreviewRows(
  db: DB,
  batchId: number,
  options: { page?: number; pageSize?: number; action?: string; warningOnly?: boolean } = {},
): { total: number; page: number; pageSize: number; items: CleaningPreviewRowDb[] } {
  const batch = imports.getBatch(db, batchId);
  if (batch.status !== 'pending') throw Errors.conflict('逐行清洗预览只在待确认批次生命周期内提供');
  if (!batch.cleaning_plan_json || batch.cleaning_plan_json === '{}') throw Errors.notFound('清洗预览');
  const page = Number.isSafeInteger(options.page) ? Math.max(1, options.page!) : 1;
  const pageSize = Number.isSafeInteger(options.pageSize) ? Math.min(200, Math.max(1, options.pageSize!)) : 100;
  const allowed = new Set<CleaningPreviewAction>(['insert', 'overwrite', 'unchanged', 'clear', 'excluded']);
  if (options.action && !allowed.has(options.action as CleaningPreviewAction)) throw Errors.validation('action 筛选值不合法');
  const clauses = ['import_batch_id = ?'];
  const params: unknown[] = [batchId];
  if (options.action) { clauses.push('action = ?'); params.push(options.action); }
  if (options.warningOnly) clauses.push("warning <> ''");
  const where = clauses.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM import_cleaning_preview_row WHERE ${where}`).get(...params) as { count: number }).count;
  const items = db.prepare(
    `SELECT * FROM import_cleaning_preview_row WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`,
  ).all(...params, pageSize, (page - 1) * pageSize) as CleaningPreviewRowDb[];
  return { total, page, pageSize, items };
}

/* ============ UX-16:清洗预览恢复(「修改导入配置」) ============ */

export interface CleaningReopenResult {
  /** 被取消的旧预览批次 */
  sourceBatchId: number;
  /** 新临时上传凭证,仅经响应体返回;不进 URL、日志或助手上下文 */
  token: string;
  originalName: string;
  /** 原文件 SHA-256,用于前端核对重传/复用文件的一致性 */
  sha256: string;
  plan: CleaningPlan;
  target: CleaningTarget;
  /** true=响应丢失后的重复请求命中既有恢复会话,未创建新临时副本 */
  reused: boolean;
}

interface CleaningReopenSessionRow {
  id: number;
  import_batch_id: number;
  upload_token: string;
  original_name: string;
  file_sha256: string;
  plan_json: string;
  target_json: string;
  created_at: string;
}

/** 从批次固化内容恢复清洗计划与目标;非清洗批次直接拒绝。 */
function recoverCleaningPlanAndTarget(batch: imports.ImportBatchRow): { plan: CleaningPlan; target?: CleaningTarget } {
  let rawPlan: unknown;
  try { rawPlan = JSON.parse(batch.cleaning_plan_json); } catch { rawPlan = undefined; }
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)
    || typeof (rawPlan as { targetKind?: unknown }).targetKind !== 'string') {
    throw Errors.conflict('该批次不是非标准 Excel 清洗预览，不支持恢复修改配置');
  }
  const plan = rawPlan as CleaningPlan;
  let target: CleaningTarget | undefined;
  if (batch.kind === 'budget') {
    // 预算目标在取消后仍保留在 target_version_id;pending 批次也可从 payload 读取
    let payloadVersionId: number | undefined;
    try {
      const payload = JSON.parse(batch.payload_json) as { versionId?: unknown };
      if (Number.isSafeInteger(payload.versionId)) payloadVersionId = payload.versionId as number;
    } catch { /* payload 已清空时回落到 target_version_id */ }
    const versionId = payloadVersionId ?? batch.target_version_id ?? undefined;
    if (versionId != null) target = { targetKind: 'budget', versionId };
  } else {
    try {
      const payload = JSON.parse(batch.payload_json) as { batches?: { year?: unknown; snapshotDate?: unknown }[] };
      const first = Array.isArray(payload.batches) ? payload.batches[0] : undefined;
      if (first && Number.isSafeInteger(first.year) && typeof first.snapshotDate === 'string') {
        target = { targetKind: 'actual-current', year: first.year as number, snapshotDate: first.snapshotDate };
      }
    } catch { /* 继续走摘要回落 */ }
    if (!target) {
      // 取消/过期批次 payload 已清空:从创建时冻结的统一预览摘要恢复 年度×截止日
      try {
        const summary = JSON.parse(batch.summary_json) as { unifiedPreview?: { target?: { year?: unknown }; periods?: { year?: unknown; snapshotDate?: unknown }[] } };
        const period = summary.unifiedPreview?.periods?.[0];
        const year = period?.year ?? summary.unifiedPreview?.target?.year;
        if (Number.isSafeInteger(year) && typeof period?.snapshotDate === 'string') {
          target = { targetKind: 'actual-current', year: year as number, snapshotDate: period.snapshotDate };
        }
      } catch { /* 摘要不可解析时 target 留空,由错误明细如实标注 */ }
    }
  }
  return { plan, target };
}

function reopenExpiredError(
  batchId: number,
  identity: { originalName: string; sha256: string },
  recovered: { plan: CleaningPlan; target?: CleaningTarget | null },
  reason: string,
): AppError {
  // 明确区分「可恢复的计划」与「无法找回的文件」:不得声称能恢复已清除的原件
  return new AppError(
    'CLEANING_SOURCE_EXPIRED',
    `${reason}，已清除的文件无法找回；请重新上传文件后重新分析（原计划与目标已随响应返回，可直接沿用）`,
    410,
    undefined,
    {
      sourceBatchId: batchId,
      originalName: identity.originalName,
      sha256: identity.sha256,
      plan: recovered.plan,
      target: recovered.target ?? null,
    },
  );
}

/**
 * 恢复待确认清洗预览(易用性方案 §5.3,顺序固定):
 * 校验旧 pending 批次及原文件 → 复制到有容量限制的临时存储 →
 * 事务内(取消服务复核状态、写恢复会话与审计) → 返回新 token 与计划。
 * 临时文件创建失败时旧批次保持可用;事务失败时定点清理新副本,旧批次不被取消;
 * 重复请求返回同一有效会话,不创建多份临时副本。
 */
export function reopenCleaningPreview(
  db: DB,
  batchId: number,
  options: {
    store: Pick<CleaningUploadStore, 'put' | 'remove' | 'peek'>;
    actor?: string;
    /** 取消服务可注入(测试事务失败路径);默认使用现有批次取消服务 */
    cancel?: (db: DB, id: number) => void;
  },
): CleaningReopenResult {
  const batch = imports.getBatch(db, batchId);
  const existing = db.prepare('SELECT * FROM cleaning_reopen_session WHERE import_batch_id = ?')
    .get(batchId) as CleaningReopenSessionRow | undefined;
  if (existing) {
    // 幂等:同批次已有恢复会话;临时文件仍有效则返回同一会话(peek 同时滑动刷新 TTL)
    if (options.store.peek(existing.upload_token, true)) {
      return {
        sourceBatchId: batchId,
        token: existing.upload_token,
        originalName: existing.original_name,
        sha256: existing.file_sha256,
        plan: JSON.parse(existing.plan_json) as CleaningPlan,
        target: JSON.parse(existing.target_json) as CleaningTarget,
        reused: true,
      };
    }
    throw reopenExpiredError(batchId, { originalName: existing.original_name, sha256: existing.file_sha256 }, {
      plan: JSON.parse(existing.plan_json) as CleaningPlan,
      target: JSON.parse(existing.target_json) as CleaningTarget,
    }, '上次恢复会话的临时文件已过期或被清理');
  }

  const recovered = recoverCleaningPlanAndTarget(batch);
  if (batch.status !== 'pending') {
    if (batch.status === 'cancelled') {
      throw reopenExpiredError(batchId, { originalName: batch.original_name, sha256: batch.sha256 }, recovered, '原文件已随预览取消或过期清除');
    }
    throw Errors.conflict(`清洗预览批次已${batch.status === 'committed' ? '确认提交' : '撤销'}，不能恢复修改配置；如需调整请走撤销或重新导入流程`);
  }
  if (!batch.file_blob || batch.file_blob.length === 0) {
    throw reopenExpiredError(batchId, { originalName: batch.original_name, sha256: batch.sha256 }, recovered, '批次中已不再保存原文件');
  }
  const digest = crypto.createHash('sha256').update(batch.file_blob).digest('hex');
  if (digest !== batch.sha256) {
    throw Errors.conflict('批次原文件指纹与记录不一致，请重新上传并重新分析');
  }
  if (!recovered.target) throw Errors.conflict('无法从批次恢复清洗目标，请取消后重新上传分析');
  const target = recovered.target;

  // 步骤 b:先把原件复制到有 TTL/容量限制的临时存储;失败时旧批次保持 pending 可用
  const metadata = options.store.put(batch.original_name, batch.file_blob);
  try {
    // 步骤 c:单一事务——取消服务内部复核 pending 状态(防并发),写恢复会话(原批次唯一键)与审计
    db.transaction(() => {
      (options.cancel ?? imports.cancelBatch)(db, batchId);
      db.prepare(
        `INSERT INTO cleaning_reopen_session
          (import_batch_id, upload_token, original_name, file_sha256, plan_json, target_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(batchId, metadata.token, metadata.originalName, batch.sha256,
        JSON.stringify(recovered.plan), JSON.stringify(target), new Date().toISOString());
      // 凭证不落日志:审计只记批次、文件名与指纹
      writeLog(db, 'cleaning.reopen', 'import_batch', batchId, {
        actor: options.actor ?? '',
        originalName: batch.original_name,
        sha256: batch.sha256,
        targetKind: recovered.plan.targetKind,
      });
    })();
  } catch (error) {
    // 事务失败:定点清理刚创建的新临时副本,旧批次因回滚不被取消
    try { options.store.remove(metadata.token); } catch { /* 清理失败留待机会式清扫 */ }
    // 唯一键冲突=并发请求已写入恢复会话:按幂等语义返回既有会话
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const raced = db.prepare('SELECT * FROM cleaning_reopen_session WHERE import_batch_id = ?')
        .get(batchId) as CleaningReopenSessionRow | undefined;
      if (raced && options.store.peek(raced.upload_token, true)) {
        return {
          sourceBatchId: batchId,
          token: raced.upload_token,
          originalName: raced.original_name,
          sha256: raced.file_sha256,
          plan: JSON.parse(raced.plan_json) as CleaningPlan,
          target: JSON.parse(raced.target_json) as CleaningTarget,
          reused: true,
        };
      }
    }
    throw error;
  }
  return {
    sourceBatchId: batchId,
    token: metadata.token,
    originalName: metadata.originalName,
    sha256: batch.sha256,
    plan: recovered.plan,
    target,
    reused: false,
  };
}
