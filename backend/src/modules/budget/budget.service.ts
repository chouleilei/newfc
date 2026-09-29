import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import { createOrReuseSnapshot, loadSnapshotNodes } from '../tree/snapshot';
import { displayToSignedCents, centsToYuanString, isQuantityType, quantityStringToScaled, scaledToQuantityString, safeIntegerAdd, type AccountType } from '../../core/money';
import { computeLeafIds } from '../../core/tree';
import type { TreeNodeRow } from '../../core/tree';
import { rollup } from '../../core/rollup';
import { listMetrics, listMetricsForVersion, snapshotMetricsForVersion, assertNoCycle } from '../metric/metric.service';
import { isAccountVisibleForScope } from '../../core/accountScope';
import { budgetQualityReport } from '../check/budget-quality';
import { listRows } from '../actual/actual.helpers';

/** 预算版本与编制(方案六)。 */

export interface BudgetVersionRow {
  id: number;
  year: number;
  name: string;
  status: 'draft' | 'locked' | 'archived';
  is_current: 0 | 1;
  kind: 'budget' | 'forecast';
  org_tree_snapshot_id: number;
  account_tree_snapshot_id: number;
  source_version_id: number | null;
  note: string;
  created_at: string;
  updated_at: string;
  locked_at: string | null;
  generation_json: string;
  /** 草稿整包明细的单调乐观并发版本。 */
  revision: number;
}

export interface BudgetEntryInput {
  orgId: number;
  accountId: number;
  amount?: string; // 元字符串(界面口径,金额科目必填)
  quantity?: string; // 数量字符串(最多四位小数,数量型科目必填)
  formula?: string; // 行内计算公式(如 "=35*1.2*12")
  note?: string; // 测算依据/附注说明
}

/**
 * 汇总格备注(测算依据):组织或科目至少一侧非叶子的单元格批注。
 * 与 budget_entry.note 互补:叶子×叶子格子的附注仍在明细行上;
 * 汇总格是聚合值、没有明细行,批注落在 budget_cell_note。
 * 不带金额,不参与汇总/勾稽/指标,也不进导入导出。
 */
export interface BudgetCellNoteInput {
  orgId: number;
  accountId: number;
  note: string;
}

export interface BudgetEntryRow {
  org_id: number;
  account_id: number;
  amount_cents: number;
  quantity: number | null;
  formula: string;
  note: string;
  updated_at: string;
}

export interface BudgetCheckpointCell {
  orgId: number;
  accountId: number;
  amountCents: number;
  quantity: number | null;
  formula: string;
  note: string;
}

/** 记录点变化的类型判别(AI 功能增强计划 §四.阶段六.1):仅金额/仅数量/仅公式/仅附注/混合。 */
export type BudgetCheckpointChangeKind = 'amount' | 'quantity' | 'formula' | 'note' | 'mixed';

export interface BudgetCheckpointChange {
  orgId: number;
  accountId: number;
  kind: BudgetCheckpointChangeKind;
  before: Omit<BudgetCheckpointCell, 'orgId' | 'accountId'>;
  after: Omit<BudgetCheckpointCell, 'orgId' | 'accountId'>;
}

export interface BudgetCompilationCheckpoint {
  id: number;
  versionId: number;
  sequenceNo: number;
  title: string;
  changeCount: number;
  autoCreated: boolean;
  createdAt: string;
  changes: BudgetCheckpointChange[];
  /** 本轮修改小结(AI 功能增强计划 §四.阶段六):事务外异步生成,未生成时为空串,前端回退变化清单。 */
  summary: string;
  summarySource: '' | 'template' | 'model';
  summaryModel: string;
  summaryPromptVersion: string;
  summaryGeneratedAt: string;
  /** 数字守卫结果:null 未经过守卫(模板稿/未生成),true 通过,false 失败已回退模板。 */
  summaryGuardOk: boolean | null;
}

interface BudgetCheckpointDbRow {
  id: number;
  version_id: number;
  sequence_no: number;
  title: string;
  snapshot_json: string;
  changes_json: string;
  change_count: number;
  auto_created: 0 | 1;
  created_at: string;
  summary?: string;
  summary_source?: string;
  summary_model?: string;
  summary_prompt_version?: string;
  summary_generated_at?: string;
  summary_guard_ok?: number | null;
}

const EMPTY_CHECKPOINT_VALUE: Omit<BudgetCheckpointCell, 'orgId' | 'accountId'> = {
  amountCents: 0,
  quantity: null,
  formula: '',
  note: '',
};

function loadCheckpointCells(db: DB, versionId: number): BudgetCheckpointCell[] {
  const entryCells = (db.prepare(
    `SELECT org_id, account_id, amount_cents, quantity, formula, note
     FROM budget_entry WHERE version_id = ? ORDER BY org_id, account_id`
  ).all(versionId) as { org_id: number; account_id: number; amount_cents: number; quantity: number | null; formula: string; note: string }[])
    .map((r) => ({
      orgId: r.org_id,
      accountId: r.account_id,
      amountCents: r.amount_cents,
      quantity: r.quantity,
      formula: r.formula ?? '',
      note: r.note ?? '',
    }));
  // 汇总格备注与明细行同键空间且互斥(保存链路强制),并入记录点 diff 后
  // 「较上次记录有 N 处修改」与单元格历史对汇总格同样成立;汇总格没有数值维度,补零值占位。
  const summaryCells = (db.prepare(
    'SELECT org_id, account_id, note FROM budget_cell_note WHERE version_id = ? ORDER BY org_id, account_id'
  ).all(versionId) as { org_id: number; account_id: number; note: string }[])
    .map((r) => ({
      orgId: r.org_id,
      accountId: r.account_id,
      amountCents: 0,
      quantity: null,
      formula: '',
      note: r.note ?? '',
    }));
  return [...entryCells, ...summaryCells];
}

function parseCheckpointSnapshot(raw: string): BudgetCheckpointCell[] {
  const parsed = JSON.parse(raw) as BudgetCheckpointCell[];
  if (!Array.isArray(parsed)) throw new Error('编制记录快照格式损坏');
  return parsed;
}

function checkpointValueOf(cell: BudgetCheckpointCell | undefined): Omit<BudgetCheckpointCell, 'orgId' | 'accountId'> {
  return cell
    ? { amountCents: cell.amountCents, quantity: cell.quantity, formula: cell.formula, note: cell.note }
    : { ...EMPTY_CHECKPOINT_VALUE };
}

function checkpointValuesEqual(
  a: Omit<BudgetCheckpointCell, 'orgId' | 'accountId'>,
  b: Omit<BudgetCheckpointCell, 'orgId' | 'accountId'>,
): boolean {
  return a.amountCents === b.amountCents
    && a.quantity === b.quantity
    && a.formula === b.formula
    && a.note === b.note;
}

/** 变化类型判别:单一维度变化给具体类型,多维度同时变化为 mixed。金额与数量视为不同维度。 */
export function checkpointChangeKind(
  before: Omit<BudgetCheckpointCell, 'orgId' | 'accountId'>,
  after: Omit<BudgetCheckpointCell, 'orgId' | 'accountId'>,
): BudgetCheckpointChangeKind {
  const dims: BudgetCheckpointChangeKind[] = [];
  if (before.amountCents !== after.amountCents) dims.push('amount');
  if (before.quantity !== after.quantity) dims.push('quantity');
  if (before.formula !== after.formula) dims.push('formula');
  if (before.note !== after.note) dims.push('note');
  return dims.length === 1 ? dims[0] : 'mixed';
}

function diffCheckpointCells(base: BudgetCheckpointCell[], target: BudgetCheckpointCell[]): BudgetCheckpointChange[] {
  const baseMap = new Map(base.map((c) => [`${c.orgId}:${c.accountId}`, c]));
  const targetMap = new Map(target.map((c) => [`${c.orgId}:${c.accountId}`, c]));
  const keys = new Set([...baseMap.keys(), ...targetMap.keys()]);
  const changes: BudgetCheckpointChange[] = [];
  for (const key of keys) {
    const bCell = baseMap.get(key);
    const tCell = targetMap.get(key);
    const before = checkpointValueOf(bCell);
    const after = checkpointValueOf(tCell);
    if (checkpointValuesEqual(before, after)) continue;
    const [orgId, accountId] = key.split(':').map(Number);
    changes.push({ orgId, accountId, kind: checkpointChangeKind(before, after), before, after });
  }
  changes.sort((a, b) => a.orgId - b.orgId || a.accountId - b.accountId);
  return changes;
}

function latestCheckpointRow(db: DB, versionId: number): BudgetCheckpointDbRow | undefined {
  return db.prepare(
    'SELECT * FROM budget_compilation_checkpoint WHERE version_id = ? ORDER BY sequence_no DESC LIMIT 1'
  ).get(versionId) as BudgetCheckpointDbRow | undefined;
}

function checkpointBaseline(db: DB, version: BudgetVersionRow): BudgetCheckpointCell[] {
  const latest = latestCheckpointRow(db, version.id);
  if (latest) return parseCheckpointSnapshot(latest.snapshot_json);
  // 复制修订稿的首次记录只展示相对来源定稿的变化;全新版本则相对空白底稿。
  return version.source_version_id != null ? loadCheckpointCells(db, version.source_version_id) : [];
}

function checkpointFromRow(row: BudgetCheckpointDbRow): BudgetCompilationCheckpoint {
  // 旧数据兼容:V31 之前写入的 changes_json 没有 kind 字段,读取时按 before/after 补判别。
  const changes = (JSON.parse(row.changes_json) as (Omit<BudgetCheckpointChange, 'kind'> & { kind?: BudgetCheckpointChangeKind })[])
    .map((change) => ({
      ...change,
      kind: change.kind ?? checkpointChangeKind(change.before, change.after),
    }));
  return {
    id: row.id,
    versionId: row.version_id,
    sequenceNo: row.sequence_no,
    title: row.title,
    changeCount: row.change_count,
    autoCreated: row.auto_created === 1,
    createdAt: row.created_at,
    changes,
    summary: row.summary ?? '',
    summarySource: (row.summary_source ?? '') as '' | 'template' | 'model',
    summaryModel: row.summary_model ?? '',
    summaryPromptVersion: row.summary_prompt_version ?? '',
    summaryGeneratedAt: row.summary_generated_at ?? '',
    summaryGuardOk: row.summary_guard_ok == null ? null : row.summary_guard_ok === 1,
  };
}

function recordCompilationCheckpointInternal(
  db: DB,
  version: BudgetVersionRow,
  input: { title?: string; autoCreated?: boolean },
): { created: boolean; checkpoint: BudgetCompilationCheckpoint | null; changeCount: number } {
  const snapshot = loadCheckpointCells(db, version.id);
  const changes = diffCheckpointCells(checkpointBaseline(db, version), snapshot);
  if (changes.length === 0) return { created: false, checkpoint: null, changeCount: 0 };
  const max = db.prepare(
    'SELECT MAX(sequence_no) AS n FROM budget_compilation_checkpoint WHERE version_id = ?'
  ).get(version.id) as { n: number | null };
  const sequenceNo = (max.n ?? 0) + 1;
  const title = input.title?.trim().slice(0, 200) || (input.autoCreated ? '定稿前记录' : `第 ${sequenceNo} 次编制记录`);
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO budget_compilation_checkpoint
      (version_id, sequence_no, title, snapshot_json, changes_json, change_count, auto_created, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(version.id, sequenceNo, title, JSON.stringify(snapshot), JSON.stringify(changes), changes.length, input.autoCreated ? 1 : 0, now);
  const id = Number(info.lastInsertRowid);
  writeLog(db, 'budget.checkpoint', 'budget_version', version.id, {
    checkpointId: id,
    sequenceNo,
    title,
    changeCount: changes.length,
    autoCreated: Boolean(input.autoCreated),
  });
  const row = db.prepare('SELECT * FROM budget_compilation_checkpoint WHERE id = ?').get(id) as BudgetCheckpointDbRow;
  return { created: true, checkpoint: checkpointFromRow(row), changeCount: changes.length };
}

export function listVersions(db: DB, year?: number): BudgetVersionRow[] {
  const sql = year != null
    ? 'SELECT * FROM budget_version WHERE year = ? ORDER BY created_at DESC, id DESC'
    : 'SELECT * FROM budget_version ORDER BY year DESC, created_at DESC, id DESC';
  const rows = (year != null ? db.prepare(sql).all(year) : db.prepare(sql).all()) as BudgetVersionRow[];
  return rows.map((row) => ({ ...row, kind: row.kind ?? 'budget', generation_json: row.generation_json ?? '{}' }));
}

export function getVersion(db: DB, id: number): BudgetVersionRow {
  const row = db.prepare('SELECT * FROM budget_version WHERE id = ?').get(id) as BudgetVersionRow | undefined;
  if (!row) throw Errors.notFound('预算版本');
  return { ...row, kind: row.kind ?? 'budget', generation_json: row.generation_json ?? '{}' };
}

function assertNameFree(db: DB, year: number, name: string, excludeId?: number): void {
  const row = db.prepare('SELECT id FROM budget_version WHERE year = ? AND name = ?').get(year, name) as { id: number } | undefined;
  if (row && row.id !== excludeId) throw Errors.conflict(`${year} 年度已存在同名版本「${name}」`);
}

export interface CreateVersionOptions {
  year: number;
  name: string;
  kind?: 'budget' | 'forecast';
  note?: string;
  /** 基于历史底稿快速生成新版本:预算、当前实际或指定实际快照。 */
  baseFrom?: 'budget' | 'actual' | 'actual_snapshot';
  baseYear?: number;
  /** baseFrom=actual_snapshot 时使用的 actual_snapshot_batch.id。 */
  baseSnapshotId?: number;
  /** 增长率系数(如 0.05 表示增长 5%, -0.03 表示下调 3%) */
  growthRate?: string | number;
}

const VERSION_BASE_SOURCES = new Set(['budget', 'actual', 'actual_snapshot']);

/** TypeScript 联合类型在 HTTP/JSON 边界会被擦除，因此服务层仍必须做运行时枚举校验。 */
function assertVersionBaseSource(value: unknown, required: boolean): asserts value is CreateVersionOptions['baseFrom'] {
  if (value == null || value === '') {
    if (required) throw Errors.validation('请选择初稿来源');
    return;
  }
  if (typeof value !== 'string' || !VERSION_BASE_SOURCES.has(value)) {
    throw Errors.validation('baseFrom 必须为 budget、actual 或 actual_snapshot');
  }
}

function parseRateMillion(input: string | number | undefined): bigint {
  if (input == null || String(input).trim() === '') return 0n;
  const raw = String(input).trim();
  if (!/^[+-]?\d{1,2}(\.\d{1,6})?$/.test(raw)) {
    throw Errors.validation('增长率格式不正确,应为 -1 到 10 之间且最多六位小数');
  }
  const negative = raw.startsWith('-');
  const body = raw.replace(/^[+-]/, '');
  const [whole, fraction = ''] = body.split('.');
  const scaled = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  const signed = negative ? -scaled : scaled;
  if (signed < -1_000_000n || signed > 10_000_000n) {
    throw Errors.validation('增长率必须在 -100% 到 1000% 之间');
  }
  return signed;
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const rounded = (abs + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

function scaleIntegerByRate(value: number, rateMillion: bigint): number {
  const result = roundDivide(BigInt(value) * (1_000_000n + rateMillion), 1_000_000n);
  const n = Number(result);
  if (!Number.isSafeInteger(n)) throw Errors.validation('生成后的金额或数量超出安全范围');
  return n;
}

/** 供助手等预览层复用的整数增长计算，不暴露浮点金额运算。 */
export function scaleIntegerByGrowthRate(value: number, growthRate: string | number | undefined): number {
  return scaleIntegerByRate(value, parseRateMillion(growthRate));
}

export interface VersionGenerationItem {
  orgId: number;
  accountId: number;
  /** 来源中没有该组合时为 false；确认时零值组合不会被伪造为已填报。 */
  hasSource: boolean;
  sourceAmountCents: number;
  suggestedAmountCents: number;
  changeCents: number;
  sourceQuantity: number | null;
  suggestedQuantity: number | null;
  changeQuantity: number | null;
  changeRate: number | null;
  source: string;
  reason: string;
}

export interface VersionGenerationPreview {
  sourceLabel: string;
  sourceId: number | null;
  sourceType: 'budget_version' | 'actual_current' | 'actual_snapshot';
  sourceSnapshotDate: string | null;
  treeSnapshotIds: { org: number | null; account: number | null };
  sourceCount: number;
  /** 确认时真正会写入的组合数(树快照叶子 + 适用范围都通过)。 */
  generatedCount: number;
  /** 来源行里不会被写入的数量(非叶子、不在目标树快照内，或科目不适用于该组织)。 */
  skippedCount: number;
  /** 其中因「科目不适用于该组织」被剔除的来源行数与金额，便于核对差额。 */
  outOfScopeCount: number;
  outOfScopeAmountCents: number;
  candidateCount: number;
  sourceAmountCents: number;
  generatedAmountCents: number;
  items: VersionGenerationItem[];
}

/** 返回预算草案逐叶子组合的确定性变化明细。 */
export function previewVersionGenerationDetails(db: DB, input: CreateVersionOptions): VersionGenerationPreview {
  assertVersionBaseSource(input.baseFrom, true);
  const year = input.year;
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw Errors.validation('目标年度不合法');
  const baseYear = input.baseYear ?? year - 1;
  const rateMillion = parseRateMillion(input.growthRate);
  const currentOrgRows = listRows(db, 'org');
  const currentAccountRows = listRows(db, 'account');
  const leafOrgs = computeLeafIds(currentOrgRows);
  const leafAccs = computeLeafIds(currentAccountRows);
  let sourceId: number | null = null;
  let sourceLabel = '';
  let sourceType: VersionGenerationPreview['sourceType'] = input.baseFrom === 'budget' ? 'budget_version' : input.baseFrom === 'actual' ? 'actual_current' : 'actual_snapshot';
  let sourceSnapshotDate: string | null = null;
  let treeSnapshotIds: { org: number | null; account: number | null } = { org: null, account: null };
  let rows: { org_id: number; account_id: number; amount_cents: number; quantity: number | null }[] = [];
  if (input.baseFrom === 'budget') {
    const candidates = listVersions(db, baseYear).filter((v) => v.kind === 'budget' && v.status !== 'draft');
    const source = candidates.find((v) => v.is_current) ?? candidates[0];
    if (!source) throw Errors.validation(`${baseYear} 年没有可用的定稿预算版本`);
    sourceId = source.id;
    sourceLabel = `${baseYear} 年预算「${source.name}」`;
    treeSnapshotIds = { org: source.org_tree_snapshot_id, account: source.account_tree_snapshot_id };
    rows = db.prepare('SELECT org_id, account_id, amount_cents, quantity FROM budget_entry WHERE version_id = ?').all(source.id) as typeof rows;
  } else if (input.baseFrom === 'actual') {
    sourceLabel = `${baseYear} 年当前实际`;
    rows = db.prepare('SELECT org_id, account_id, cumulative_amount_cents AS amount_cents, quantity FROM actual_current WHERE year = ?').all(baseYear) as typeof rows;
    if (rows.length === 0) throw Errors.validation(`${baseYear} 年没有可用于生成初稿的当前实际数`);
    const current = db.prepare('SELECT b.snapshot_date,b.org_tree_snapshot_id,b.account_tree_snapshot_id FROM actual_year_state s LEFT JOIN actual_snapshot_batch b ON b.id=s.current_batch_id WHERE s.year=?').get(baseYear) as { snapshot_date?: string; org_tree_snapshot_id?: number; account_tree_snapshot_id?: number } | undefined;
    sourceSnapshotDate = current?.snapshot_date ?? null;
    treeSnapshotIds = { org: current?.org_tree_snapshot_id ?? null, account: current?.account_tree_snapshot_id ?? null };
  } else {
    const snapshotId = Number(input.baseSnapshotId);
    if (!Number.isSafeInteger(snapshotId) || snapshotId <= 0) throw Errors.validation('请选择实际快照批次');
    const batch = db.prepare('SELECT id,year,snapshot_date FROM actual_snapshot_batch WHERE id=?').get(snapshotId) as { id: number; year: number; snapshot_date: string } | undefined;
    if (!batch) throw Errors.notFound('实际快照批次');
    if (batch.year !== baseYear) throw Errors.validation('实际快照年度与基准年度不一致');
    sourceId = batch.id;
    sourceLabel = `${baseYear} 年实际快照 ${batch.snapshot_date}`;
    sourceSnapshotDate = batch.snapshot_date;
    const snapshotTrees = db.prepare('SELECT org_tree_snapshot_id,account_tree_snapshot_id FROM actual_snapshot_batch WHERE id=?').get(snapshotId) as { org_tree_snapshot_id: number; account_tree_snapshot_id: number };
    treeSnapshotIds = { org: snapshotTrees.org_tree_snapshot_id, account: snapshotTrees.account_tree_snapshot_id };
    rows = db.prepare('SELECT org_id, account_id, cumulative_amount_cents AS amount_cents, quantity FROM actual_snapshot_entry WHERE batch_id=?').all(snapshotId) as typeof rows;
    if (rows.length === 0) throw Errors.validation('指定实际快照没有可用于生成初稿的数据');
  }
  const valid = rows.filter((row) => leafOrgs.has(row.org_id) && leafAccs.has(row.account_id));
  const orgById = new Map(currentOrgRows.map((row) => [row.id, row]));
  const accountById = new Map(currentAccountRows.map((row) => [row.id, row]));
  const inScope = (orgId: number, accountId: number): boolean => {
    const org = orgById.get(orgId);
    const acc = accountById.get(accountId);
    return Boolean(org && acc && isAccountVisibleForScope(acc.code, new Set([org.code])));
  };
  // 来源行里「科目不适用于该组织」的组合确认时不会写入(见 versionCellFilter)，
  // 因此这里必须一起排除，否则 sourceAmountCents 会包含永远不会落库的金额，
  // 与 generatedAmountCents 的差额就不再只是增长率。
  const writable = valid.filter((row) => inScope(row.org_id, row.account_id));
  const outOfScope = valid.filter((row) => !inScope(row.org_id, row.account_id));
  const sourceByKey = new Map(writable.map((row) => [`${row.org_id}:${row.account_id}`, row]));
  // 预览覆盖所有适用的叶子组织×叶子科目组合；缺少来源值的组合以零作为
  // 建议基准，但不会在确认时写入空的 budget_entry。
  const candidates: { org_id: number; account_id: number; amount_cents: number; quantity: number | null; hasSource: boolean }[] = [];
  for (const orgId of leafOrgs) for (const accountId of leafAccs) {
    if (!inScope(orgId, accountId)) continue;
    const source = sourceByKey.get(`${orgId}:${accountId}`);
    candidates.push({ org_id: orgId, account_id: accountId, amount_cents: source?.amount_cents ?? 0, quantity: source?.quantity ?? null, hasSource: Boolean(source) });
  }
  const rateText = (Number(rateMillion) / 1_000_000 * 100).toFixed(6).replace(/\.?(0+)$/, '');
  const items: VersionGenerationItem[] = candidates.map((row) => {
    const suggestedAmountCents = scaleIntegerByRate(row.amount_cents, rateMillion);
    const suggestedQuantity = row.quantity == null ? null : scaleIntegerByRate(row.quantity, rateMillion);
    const changeCents = suggestedAmountCents - row.amount_cents;
    const changeQuantity = row.quantity == null || suggestedQuantity == null ? null : suggestedQuantity - row.quantity;
    return {
      orgId: row.org_id,
      accountId: row.account_id,
      hasSource: row.hasSource,
      sourceAmountCents: row.amount_cents,
      suggestedAmountCents,
      changeCents,
      sourceQuantity: row.quantity ?? null,
      suggestedQuantity,
      changeQuantity,
      /* changeRate 分母用带符号来源值,使符号与 changeCents 一致:
         成本/费用科目的存储值为负,分母取绝对值会把 +5% 的增长显示成 -5%,
         与 reason 文案「按 X% 增长率调整」方向相反。带符号分母下 changeRate
         恒等于输入增长率(rateMillion),收入/成本/费用口径统一。 */
      changeRate: row.amount_cents !== 0
        ? changeCents / row.amount_cents
        : row.quantity != null && row.quantity !== 0 && changeQuantity != null
          ? changeQuantity / row.quantity
          : null,
      source: sourceLabel,
      reason: `以${sourceLabel}为基准，按 ${rateText}% 增长率调整`,
    };
  });
  return {
    sourceLabel,
    sourceId,
    sourceType,
    sourceSnapshotDate,
    treeSnapshotIds,
    sourceCount: rows.length,
    generatedCount: writable.length,
    skippedCount: rows.length - writable.length,
    outOfScopeCount: outOfScope.length,
    outOfScopeAmountCents: outOfScope.reduce((sum, row) => safeIntegerAdd(sum, row.amount_cents, '草案范围外金额汇总'), 0),
    candidateCount: candidates.length,
    sourceAmountCents: writable.reduce((sum, row) => safeIntegerAdd(sum, row.amount_cents, '草案来源金额汇总'), 0),
    generatedAmountCents: items.reduce((sum, row) => safeIntegerAdd(sum, row.suggestedAmountCents, '草案建议金额汇总'), 0),
    items,
  };
}

export function previewVersionGeneration(db: DB, input: CreateVersionOptions): Omit<VersionGenerationPreview, 'items'> {
  const { items: _items, ...summary } = previewVersionGenerationDetails(db, input);
  return summary;
}

/**
 * 目标版本「可落库组合」判定：树快照叶子 + 组织-科目适用范围。
 *
 * 与预算录入(`saveEntries`)、实际数保存(`actual.service`)、Excel 导入
 * (`io/excel.ts`)以及草案预览(`previewVersionGenerationDetails`)完全同口径。
 * 从历史底稿批量生成初稿时必须一起用上：只按叶子过滤会把「科目不适用于该组织」
 * 的存量脏数据复制进新版本，而这些格子在编制界面上根本不展示，
 * 却仍然参与汇总——预览的合计也会因此小于实际写入的合计。
 */
function versionCellFilter(db: DB, versionId: number): (orgId: number, accountId: number) => boolean {
  const target = versionLeaves(db, getVersion(db, versionId));
  return (orgId: number, accountId: number) => {
    if (!target.leafOrgs.has(orgId) || !target.leafAccs.has(accountId)) return false;
    const orgCode = target.orgCodeOf.get(orgId);
    const accCode = target.accCodeOf.get(accountId);
    if (!orgCode || !accCode) return false;
    return isAccountVisibleForScope(String(accCode), new Set([String(orgCode)]));
  };
}

/** 创建版本:自动绑定当前组织树与科目树快照(方案六/三.2),支持以上年预算或实际为基准生成初始草稿 */
export function createVersion(db: DB, input: CreateVersionOptions): BudgetVersionRow {
  // HTTP JSON 边界不做类型担保:name/note 为非字符串时 .trim() 会抛 TypeError 变 500,
  // 必须先做运行时校验,把客户端错误落在 400。
  if (typeof input.name !== 'string' || !input.name.trim()) throw Errors.validation('版本名称不能为空');
  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') throw Errors.validation('备注必须是字符串');
  assertVersionBaseSource(input.baseFrom, false);
  const year = input.year;
  const kind = input.kind ?? 'budget';
  if (kind !== 'budget' && kind !== 'forecast') throw Errors.validation('版本用途必须是 budget 或 forecast');
  const rateMillion = parseRateMillion(input.growthRate);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw Errors.validation('预算年度不合法');
  assertNameFree(db, year, input.name.trim());
  const orgCount = (db.prepare('SELECT COUNT(*) AS c FROM org').get() as { c: number }).c;
  const accCount = (db.prepare('SELECT COUNT(*) AS c FROM account').get() as { c: number }).c;
  if (orgCount === 0) throw Errors.validation('请先建立组织树');
  if (accCount === 0) throw Errors.validation('请先建立科目树');
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const orgSnap = createOrReuseSnapshot(db, 'org');
    const accSnap = createOrReuseSnapshot(db, 'account');
    const versionColumns = new Set((db.pragma('table_info(budget_version)') as { name: string }[]).map((row) => row.name));
    const info = versionColumns.has('kind')
      ? db.prepare(
        `INSERT INTO budget_version (year, name, status, is_current, org_tree_snapshot_id, account_tree_snapshot_id, kind, generation_json, note, created_at, updated_at)
         VALUES (?, ?, 'draft', 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(year, input.name.trim(), orgSnap, accSnap, kind, JSON.stringify({ baseFrom: input.baseFrom ?? null, baseYear: input.baseYear ?? null, baseSnapshotId: input.baseSnapshotId ?? null, growthRate: input.growthRate ?? 0 }), input.note?.trim() ?? '', now, now)
      : db.prepare(
        `INSERT INTO budget_version (year, name, status, is_current, org_tree_snapshot_id, account_tree_snapshot_id, note, created_at, updated_at)
         VALUES (?, ?, 'draft', 0, ?, ?, ?, ?, ?)`,
      ).run(year, input.name.trim(), orgSnap, accSnap, input.note?.trim() ?? '', now, now);
    const id = Number(info.lastInsertRowid);

    // 如果指定了历史底稿基准,批量复制生成初始草稿数据
    let copied = 0;
    let skipped = 0;
    if (input.baseFrom) {
      previewVersionGeneration(db, input); // 缺少来源或增长率非法时整笔创建回滚
      const baseYear = input.baseYear ?? (year - 1);
      const writable = versionCellFilter(db, id);
      if (input.baseFrom === 'budget') {
        const baseVers = listVersions(db, baseYear).filter((v) => v.kind === 'budget' && v.status !== 'draft');
        const bv = baseVers.find((v) => v.is_current) ?? baseVers[0];
        if (bv) {
          const entries = db.prepare('SELECT org_id, account_id, amount_cents, quantity, formula, note FROM budget_entry WHERE version_id = ?').all(bv.id) as BudgetEntryRow[];
          const insertStmt = db.prepare('INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, quantity, formula, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
          for (const e of entries) {
            if (!writable(e.org_id, e.account_id)) { skipped += 1; continue; }
            const adjAmount = scaleIntegerByRate(e.amount_cents, rateMillion);
            const adjQuantity = e.quantity == null ? null : scaleIntegerByRate(e.quantity, rateMillion);
            insertStmt.run(id, e.org_id, e.account_id, adjAmount, adjQuantity, e.formula ?? '', e.note ?? '', now);
            copied += 1;
          }
        }
      } else if (input.baseFrom === 'actual' || input.baseFrom === 'actual_snapshot') {
        const actualRows = input.baseFrom === 'actual'
          ? db.prepare('SELECT org_id, account_id, cumulative_amount_cents AS amount_cents, quantity, memo FROM actual_current WHERE year = ?').all(baseYear)
          : db.prepare('SELECT e.org_id, e.account_id, e.cumulative_amount_cents AS amount_cents, e.quantity, \'\' AS memo FROM actual_snapshot_entry e JOIN actual_snapshot_batch b ON b.id=e.batch_id WHERE e.batch_id = ? AND b.year = ?').all(input.baseSnapshotId, baseYear);
        const actuals = actualRows as (BudgetEntryRow & { memo: string })[];
        const insertStmt = db.prepare('INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, quantity, formula, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const a of actuals) {
          if (!writable(a.org_id, a.account_id)) { skipped += 1; continue; }
          const adjAmount = scaleIntegerByRate(a.amount_cents, rateMillion);
          const adjQuantity = a.quantity == null ? null : scaleIntegerByRate(a.quantity, rateMillion);
          insertStmt.run(id, a.org_id, a.account_id, adjAmount, adjQuantity, '', a.memo ?? '', now);
          copied += 1;
        }
      }
    }

    writeLog(db, 'budget.create', 'budget_version', id, { year, kind, name: input.name.trim(), orgSnap, accSnap, baseFrom: input.baseFrom, baseYear: input.baseYear, growthRate: input.growthRate, ...(input.baseFrom ? { generatedEntries: copied, skippedEntries: skipped } : {}) });
    return id;
  });
  return getVersion(db, tx());
}

/** 草稿允许改名和备注;锁定后不可修改(方案六.2) */
export function renameVersion(db: DB, id: number, input: { name?: string; note?: string }): BudgetVersionRow {
  const v = getVersion(db, id);
  if (v.status !== 'draft') throw Errors.conflict('只有草稿版本可以改名和修改备注');
  if (input.name !== undefined) {
    if (!input.name.trim()) throw Errors.validation('版本名称不能为空');
    assertNameFree(db, v.year, input.name.trim(), id);
  }
  db.transaction(() => {
    db.prepare('UPDATE budget_version SET name = ?, note = ?, updated_at = ? WHERE id = ?').run(
      input.name !== undefined ? input.name.trim() : v.name,
      input.note !== undefined ? input.note.trim() : v.note,
      new Date().toISOString(),
      id
    );
    writeLog(db, 'budget.rename', 'budget_version', id, { name: input.name, note: input.note });
  })();
  return getVersion(db, id);
}

export function deleteVersion(db: DB, id: number): void {
  const v = getVersion(db, id);
  if (v.status !== 'draft') throw Errors.conflict('锁定版本不能删除;归档版本保留历史');
  const linkedImport = db.prepare('SELECT id, status FROM import_batch WHERE target_version_id = ? ORDER BY id DESC LIMIT 1')
    .get(id) as { id: number; status: string } | undefined;
  if (linkedImport) {
    throw Errors.conflict(`草稿存在关联导入批次 #${linkedImport.id}（${linkedImport.status}），为保留审计原件不能直接删除`);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM budget_entry WHERE version_id = ?').run(id);
    db.prepare('DELETE FROM budget_cell_note WHERE version_id = ?').run(id);
    db.prepare('DELETE FROM budget_version WHERE id = ?').run(id);
    writeLog(db, 'budget.delete', 'budget_version', id, { year: v.year, name: v.name });
  })();
}

/** 版本树快照的叶子集合 */
function versionLeaves(db: DB, v: BudgetVersionRow): { orgRows: TreeNodeRow[]; accRows: TreeNodeRow[]; leafOrgs: Set<number>; leafAccs: Set<number>; orgTypeOf: Map<number, AccountType>; orgCodeOf: Map<number, string>; accCodeOf: Map<number, string> } {
  const orgRows = loadSnapshotNodes(db, v.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, v.account_tree_snapshot_id);
  const leafOrgs = computeLeafIds(orgRows);
  const leafAccs = computeLeafIds(accRows);
  const orgTypeOf = new Map<number, AccountType>();
  for (const a of accRows) orgTypeOf.set(a.id, (a.type ?? 'expense') as AccountType);
  return {
    orgRows,
    accRows,
    leafOrgs,
    leafAccs,
    orgTypeOf,
    orgCodeOf: new Map(orgRows.map((r) => [r.id, r.code])),
    accCodeOf: new Map(accRows.map((r) => [r.id, r.code])),
  };
}

/**
 * 整包保存(方案六.5):提交全部非零值,事务内全量比对替换。
 * 后端逐条:草稿校验、快照归属、叶子校验、金额转分(或数量转 10^4 缩放)、按科目类型转符号、零值删除、非零 upsert。
 *
 * cellNotes(汇总格备注)与 entries 同事务、同 revision 整包替换;
 * 不传(undefined)表示不动汇总备注——Excel 导入、助手批量调整等只写叶子明细的链路保持原样。
 */
export function saveEntries(
  db: DB,
  versionId: number,
  entries: BudgetEntryInput[],
  expectedRevision?: number,
  cellNotes?: BudgetCellNoteInput[],
): { saved: number; deleted: number; cellNotesSaved: number; cellNotesDeleted: number; revision: number } {
  const v = getVersion(db, versionId);
  if (v.status !== 'draft') throw Errors.conflict('只有草稿版本可以编辑明细');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw Errors.validation('expectedRevision 必须是非负整数');
  }
  const { orgRows, accRows, leafOrgs, leafAccs, orgTypeOf, orgCodeOf, accCodeOf } = versionLeaves(db, v);

  const seen = new Set<string>();
  const parsed: { orgId: number; accountId: number; amountCents: number; quantity: number | null; formula: string; note: string }[] = [];
  for (const [i, e] of entries.entries()) {
    const key = `${e.orgId}:${e.accountId}`;
    if (seen.has(key)) throw Errors.validation(`第 ${i + 1} 条明细重复:组织 ${e.orgId} × 科目 ${e.accountId}`);
    seen.add(key);
    if (!leafOrgs.has(e.orgId)) throw Errors.validation(`组织 ${e.orgId} 不在版本绑定的组织树快照中或不是叶子组织`);
    if (!leafAccs.has(e.accountId)) throw Errors.validation(`科目 ${e.accountId} 不在版本绑定的科目树快照中或不是叶子科目`);
    const type = orgTypeOf.get(e.accountId);
    if (!type) throw Errors.validation(`科目 ${e.accountId} 类型缺失`);
    // 科目-组织业务适用范围校验(与实际数保存/前端展示口径一致):预算与实际必须落在同一套组合上,
    // 否则可编制出实际数侧永远无法录入的预算,完成率口径失真
    const orgCode = orgCodeOf.get(e.orgId);
    const accCode = accCodeOf.get(e.accountId);
    if (orgCode && accCode && !isAccountVisibleForScope(accCode, new Set([orgCode]))) {
      throw Errors.validation(`第 ${i + 1} 条:科目 ${accCode} 不适用于组织 ${orgCode},不能编制该组织的预算`);
    }
    const formula = typeof e.formula === 'string' ? e.formula.trim() : '';
    const note = typeof e.note === 'string' ? e.note.trim() : '';
    if (isQuantityType(type)) {
      if (e.quantity == null || !String(e.quantity).trim()) throw Errors.validation(`第 ${i + 1} 条:科目 ${e.accountId} 为数量型科目,数量不能为空`);
      parsed.push({ orgId: e.orgId, accountId: e.accountId, amountCents: 0, quantity: quantityStringToScaled(e.quantity), formula, note });
    } else {
      if (e.amount == null || !String(e.amount).trim()) throw Errors.validation(`第 ${i + 1} 条:科目 ${e.accountId} 为金额科目,金额不能为空`);
      parsed.push({ orgId: e.orgId, accountId: e.accountId, amountCents: displayToSignedCents(e.amount, type), quantity: null, formula, note });
    }
  }

  // 汇总格备注校验:两侧 ID 必须在版本绑定快照内,且至少一侧非叶子
  // (叶子×叶子的附注属于 budget_entry.note,两处同写会造成双份真源)。
  // 不做科目-组织适用范围判定:批注不产生数值,聚合格本身没有单一组织口径。
  let parsedNotes: { orgId: number; accountId: number; note: string }[] | null = null;
  if (cellNotes !== undefined) {
    if (!Array.isArray(cellNotes)) throw Errors.validation('cellNotes 必须是数组');
    const orgIds = new Set(orgRows.map((r) => r.id));
    const accIds = new Set(accRows.map((r) => r.id));
    const seenNotes = new Set<string>();
    parsedNotes = [];
    for (const [i, n] of cellNotes.entries()) {
      if (n == null || typeof n !== 'object') throw Errors.validation(`第 ${i + 1} 条汇总格备注必须是对象`);
      const orgId = Number(n.orgId);
      const accountId = Number(n.accountId);
      if (!Number.isSafeInteger(orgId) || orgId <= 0 || !Number.isSafeInteger(accountId) || accountId <= 0) {
        throw Errors.validation(`第 ${i + 1} 条汇总格备注的组织与科目 ID 必须是正整数`);
      }
      const key = `${orgId}:${accountId}`;
      if (seenNotes.has(key)) throw Errors.validation(`第 ${i + 1} 条汇总格备注重复:组织 ${orgId} × 科目 ${accountId}`);
      seenNotes.add(key);
      if (!orgIds.has(orgId)) throw Errors.validation(`第 ${i + 1} 条:组织 ${orgId} 不在版本绑定的组织树快照中`);
      if (!accIds.has(accountId)) throw Errors.validation(`第 ${i + 1} 条:科目 ${accountId} 不在版本绑定的科目树快照中`);
      if (leafOrgs.has(orgId) && leafAccs.has(accountId)) {
        throw Errors.validation(`第 ${i + 1} 条:叶子组织 × 叶子科目的附注请随明细 entries 保存,不属于汇总格备注`);
      }
      if (typeof n.note !== 'string') throw Errors.validation(`第 ${i + 1} 条汇总格备注必须是字符串`);
      const note = n.note.trim();
      if (note.length > 2000) throw Errors.validation(`第 ${i + 1} 条汇总格备注不能超过 2000 字符`);
      if (note) parsedNotes.push({ orgId, accountId, note });
    }
  }

  let deleted = 0;
  let saved = 0;
  let cellNotesSaved = 0;
  let cellNotesDeleted = 0;
  let nextRevision = v.revision;
  const tx = db.transaction(() => {
    const current = getVersion(db, versionId);
    if (current.status !== 'draft') throw Errors.conflict('只有草稿版本可以编辑明细');
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw Errors.conflict(`预算草稿已被其他页面更新（当前修订 ${current.revision}，提交基线 ${expectedRevision}），请刷新后查看差异`);
    }
    // 全量比对替换:先删除不在提交集合中的旧记录
    // 有效条目 = 金额/数量非零,或携带公式/测算附注(零值测算依据也需保留)
    const keepEntry = (p: { amountCents: number; quantity: number | null; formula: string; note: string }) =>
      p.amountCents !== 0 || (p.quantity ?? 0) !== 0 || p.formula !== '' || p.note !== '';
    const keepKeys = new Set(parsed.filter(keepEntry).map((p) => `${p.orgId}:${p.accountId}`));
    const olds = db.prepare('SELECT id, org_id, account_id FROM budget_entry WHERE version_id = ?').all(versionId) as { id: number; org_id: number; account_id: number }[];
    const delStmt = db.prepare('DELETE FROM budget_entry WHERE id = ?');
    for (const o of olds) {
      if (!keepKeys.has(`${o.org_id}:${o.account_id}`)) { delStmt.run(o.id); deleted++; }
    }
    const upsert = db.prepare(
      `INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, quantity, formula, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(version_id, org_id, account_id) DO UPDATE SET
         amount_cents = excluded.amount_cents,
         quantity = excluded.quantity,
         formula = excluded.formula,
         note = excluded.note,
         updated_at = excluded.updated_at`
    );
    const now = new Date().toISOString();
    for (const p of parsed) {
      if (!keepEntry(p)) continue; // 零金额零数量且无公式/附注不保存
      upsert.run(versionId, p.orgId, p.accountId, p.amountCents, p.quantity, p.formula, p.note, now);
      saved++;
    }
    if (parsedNotes !== null) {
      // 与明细同口径的整包替换:未提交的旧汇总备注删除,空备注在解析阶段已剔除
      const keepNoteKeys = new Set(parsedNotes.map((p) => `${p.orgId}:${p.accountId}`));
      const oldNotes = db.prepare('SELECT id, org_id, account_id FROM budget_cell_note WHERE version_id = ?').all(versionId) as { id: number; org_id: number; account_id: number }[];
      const delNote = db.prepare('DELETE FROM budget_cell_note WHERE id = ?');
      for (const o of oldNotes) {
        if (!keepNoteKeys.has(`${o.org_id}:${o.account_id}`)) { delNote.run(o.id); cellNotesDeleted++; }
      }
      const upsertNote = db.prepare(
        `INSERT INTO budget_cell_note (version_id, org_id, account_id, note, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(version_id, org_id, account_id) DO UPDATE SET
           note = excluded.note,
           updated_at = excluded.updated_at`
      );
      for (const p of parsedNotes) {
        upsertNote.run(versionId, p.orgId, p.accountId, p.note, now);
        cellNotesSaved++;
      }
    }
    // 草稿采用实时自动保存:这里只持久化数据,不写编制业务日志。
    // 用户主动“记录本轮修改”或定稿时才由 recordCompilationCheckpoint 留痕。
    nextRevision = current.revision + 1;
    db.prepare('UPDATE budget_version SET updated_at = ?, revision = ? WHERE id = ?').run(now, nextRevision, versionId);
  });
  tx();
  return { saved, deleted, cellNotesSaved, cellNotesDeleted, revision: nextRevision };
}

/** 清空草稿数据 */
export function clearEntries(db: DB, versionId: number, expectedRevision?: number): { deleted: number; revision: number } {
  const v = getVersion(db, versionId);
  if (v.status !== 'draft') throw Errors.conflict('只有草稿版本可以清空数据');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw Errors.validation('expectedRevision 必须是非负整数');
  }
  let count = 0;
  let nextRevision = v.revision;
  db.transaction(() => {
    const current = getVersion(db, versionId);
    if (current.status !== 'draft') throw Errors.conflict('只有草稿版本可以清空数据');
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw Errors.conflict(`预算草稿已被其他页面更新（当前修订 ${current.revision}，提交基线 ${expectedRevision}），禁止清空新数据`);
    }
    const info = db.prepare('DELETE FROM budget_entry WHERE version_id = ?').run(versionId);
    const notesInfo = db.prepare('DELETE FROM budget_cell_note WHERE version_id = ?').run(versionId);
    count = info.changes + notesInfo.changes;
    nextRevision = current.revision + 1;
    db.prepare('UPDATE budget_version SET updated_at = ?, revision = ? WHERE id = ?').run(new Date().toISOString(), nextRevision, versionId);
    writeLog(db, 'budget.clear', 'budget_version', versionId, { deleted: count });
  })();
  return { deleted: count, revision: nextRevision };
}

/** 编制界面数据:版本树口径的叶子组织/科目 + 已保存明细(金额、数量、公式、附注) + 汇总格备注 */
export function getEditMatrix(db: DB, versionId: number): {
  version: BudgetVersionRow;
  orgNodes: TreeNodeRow[];
  accountNodes: TreeNodeRow[];
  leafOrgIds: number[];
  leafAccountIds: number[];
  entries: { orgId: number; accountId: number; amountCents: number; amountDisplay: string; quantity: string | null; formula: string; note: string }[];
  cellNotes: { orgId: number; accountId: number; note: string }[];
} {
  const v = getVersion(db, versionId);
  const { orgRows, accRows, leafOrgs, leafAccs, orgTypeOf } = versionLeaves(db, v);
  const rows = db
    .prepare('SELECT org_id, account_id, amount_cents, quantity, formula, note, updated_at FROM budget_entry WHERE version_id = ?')
    .all(versionId) as BudgetEntryRow[];
  const cellNoteRows = db
    .prepare('SELECT org_id, account_id, note FROM budget_cell_note WHERE version_id = ?')
    .all(versionId) as { org_id: number; account_id: number; note: string }[];
  return {
    version: v,
    orgNodes: orgRows,
    accountNodes: accRows,
    leafOrgIds: [...leafOrgs],
    leafAccountIds: [...leafAccs],
    entries: rows.map((r) => ({
      orgId: r.org_id,
      accountId: r.account_id,
      amountCents: r.amount_cents,
      amountDisplay: isQuantityType(orgTypeOf.get(r.account_id)) ? '' : centsToYuanString(r.amount_cents * (orgTypeOf.get(r.account_id) === 'income' ? 1 : -1)),
      quantity: r.quantity != null ? scaledToQuantityString(r.quantity) : null,
      formula: r.formula ?? '',
      note: r.note ?? '',
    })),
    cellNotes: cellNoteRows.map((r) => ({ orgId: r.org_id, accountId: r.account_id, note: r.note ?? '' })),
  };
}

/**
 * 主动记录一次编制过程:相对上一个记录点(复制稿首次相对来源定稿)物化变化和当前完整快照。
 * 无变化时不制造空记录。
 */
export function recordCompilationCheckpoint(
  db: DB,
  versionId: number,
  input: { title?: string } = {},
): { created: boolean; checkpoint: BudgetCompilationCheckpoint | null; changeCount: number } {
  const version = getVersion(db, versionId);
  if (version.status !== 'draft') throw Errors.conflict('只有草稿版本可以记录编制过程');
  return db.transaction(() => recordCompilationCheckpointInternal(db, getVersion(db, versionId), input))();
}

/** 按 id 读取单个编制记录点(含旧数据 kind 兼容与小结列)。 */
export function getCompilationCheckpoint(db: DB, checkpointId: number): BudgetCompilationCheckpoint {
  const row = db.prepare('SELECT * FROM budget_compilation_checkpoint WHERE id = ?').get(checkpointId) as BudgetCheckpointDbRow | undefined;
  if (!row) throw Errors.notFound('编制记录点');
  return checkpointFromRow(row);
}

/** 编制记录列表 + 当前草稿相对最后记录点尚未记录的修改数。 */
export function listCompilationCheckpoints(db: DB, versionId: number): {
  versionId: number;
  items: BudgetCompilationCheckpoint[];
  unrecordedChangeCount: number;
  lastCheckpointAt: string | null;
} {
  const version = getVersion(db, versionId);
  const rows = db.prepare(
    'SELECT * FROM budget_compilation_checkpoint WHERE version_id = ? ORDER BY sequence_no DESC'
  ).all(versionId) as BudgetCheckpointDbRow[];
  const unrecordedChangeCount = version.status === 'draft'
    ? diffCheckpointCells(checkpointBaseline(db, version), loadCheckpointCells(db, versionId)).length
    : 0;
  return {
    versionId,
    items: rows.map(checkpointFromRow),
    unrecordedChangeCount,
    lastCheckpointAt: rows[0]?.created_at ?? null,
  };
}

/** 单元格变动历史：供预算页与 AI 只读问答复用。 */
export function getBudgetCellHistory(db: DB, versionId: number, orgId: number, accountId: number) {
  const version = getVersion(db, versionId);
  const rows = db.prepare('SELECT id, sequence_no, title, auto_created, created_at, changes_json FROM budget_compilation_checkpoint WHERE version_id = ? ORDER BY sequence_no DESC').all(versionId) as any[];
  const changes = rows.flatMap((row) => {
    const list = JSON.parse(row.changes_json || '[]') as any[];
    return list.filter((c) => c.orgId === orgId && c.accountId === accountId).map((c) => ({ checkpointId: row.id, sequenceNo: row.sequence_no, title: row.title, autoCreated: Boolean(row.auto_created), createdAt: row.created_at, before: c.before, after: c.after }));
  });
  return { version: { id: version.id, year: version.year, name: version.name, status: version.status }, orgId, accountId, changes };
}

/**
 * 定稿结构问题(AI 功能增强计划 §四.阶段一.3)。
 *
 * 原来 problems 是嵌裸数字 ID 的字符串,前端无法按组织/科目定位;
 * 现在携带行号与 orgId/accountId,message 中的裸 ID 解析为编码+名称。
 * canFinalize 判定与阻断逻辑不变:任何问题都阻断定稿。
 */
export interface StructureProblem {
  code: 'STRUCTURE_INVALID';
  severity: 'blocking';
  message: string;
  /** 明细行序号(1 起);快照为空、指标循环等非行级问题没有该字段。 */
  row?: number;
  orgId?: number;
  accountId?: number;
}

/** 锁定前完整性检查(方案六.3) */
export function validateForLock(db: DB, versionId: number): { ok: boolean; problems: StructureProblem[] } {
  const v = getVersion(db, versionId);
  const problems: StructureProblem[] = [];
  const { orgRows, accRows, leafOrgs, leafAccs } = versionLeaves(db, v);
  const push = (message: string, extra: { row?: number; orgId?: number; accountId?: number } = {}) => {
    problems.push({ code: 'STRUCTURE_INVALID', severity: 'blocking', message, ...extra });
  };
  // 展示标签优先取版本绑定快照,快照外 ID 退回当前主数据,最后才退到 #id。
  const currentOrgById = new Map(listRows(db, 'org').map((row) => [row.id, row]));
  const currentAccById = new Map(listRows(db, 'account').map((row) => [row.id, row]));
  const snapshotOrgById = new Map(orgRows.map((row) => [row.id, row]));
  const snapshotAccById = new Map(accRows.map((row) => [row.id, row]));
  const orgLabel = (id: number) => {
    const row = snapshotOrgById.get(id) ?? currentOrgById.get(id);
    return row ? `${row.code} ${row.name}` : `#${id}`;
  };
  const accLabel = (id: number) => {
    const row = snapshotAccById.get(id) ?? currentAccById.get(id);
    return row ? `${row.code} ${row.name}` : `#${id}`;
  };
  if (orgRows.length === 0) push('版本绑定的组织树快照为空');
  if (accRows.length === 0) push('版本绑定的科目树快照为空');
  const rows = db
    .prepare('SELECT org_id, account_id, amount_cents FROM budget_entry WHERE version_id = ?')
    .all(versionId) as (Pick<BudgetEntryRow, 'org_id' | 'account_id' | 'amount_cents'>)[];
  const orgIds = new Set(orgRows.map((r) => r.id));
  const accIds = new Set(accRows.map((r) => r.id));
  for (const [i, e] of rows.entries()) {
    const rowNo = i + 1;
    if (!orgIds.has(e.org_id)) push(`明细第 ${rowNo} 行:组织 ${orgLabel(e.org_id)} 不在版本树快照中`, { row: rowNo, orgId: e.org_id });
    else if (!leafOrgs.has(e.org_id)) push(`明细第 ${rowNo} 行:组织 ${orgLabel(e.org_id)} 不是叶子组织`, { row: rowNo, orgId: e.org_id });
    if (!accIds.has(e.account_id)) push(`明细第 ${rowNo} 行:科目 ${accLabel(e.account_id)} 不在版本树快照中`, { row: rowNo, accountId: e.account_id });
    else if (!leafAccs.has(e.account_id)) push(`明细第 ${rowNo} 行:科目 ${accLabel(e.account_id)} 不是叶子科目`, { row: rowNo, accountId: e.account_id });
    if (!Number.isSafeInteger(e.amount_cents)) push(`明细第 ${rowNo} 行:金额超范围`, { row: rowNo, orgId: e.org_id, accountId: e.account_id });
  }
  // 指标公式循环
  const metrics = listMetrics(db);
  const defs = new Map<number, { sourceType: 'account' | 'metric'; sourceAccountId?: number | null; sourceMetricId?: number | null; coefficient: 1 | -1; sortOrder?: number }[]>();
  for (const m of metrics) {
    defs.set(m.id, m.terms.map((t) => ({
      sourceType: t.source_type,
      sourceAccountId: t.source_account_id,
      sourceMetricId: t.source_metric_id,
      coefficient: t.coefficient,
      sortOrder: t.sort_order,
    })));
  }
  for (const m of metrics) {
    try {
      assertNoCycle(defs, m.id);
    } catch (err) {
      push(err instanceof Error ? err.message : `指标 ${m.code} 公式异常`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 锁定版本:单事务完成校验、置状态、写日志(方案六.3)。
 * 传入 expectedRevision 时(UX-07 新确认 UI 必传),在同一事务内复核修订号与质量检查结果;
 * 缺省保持旧调用兼容。复核失败整笔回滚,不留下记录点或状态变更。 */
export function lockVersion(db: DB, versionId: number, options: { expectedRevision?: number } = {}): BudgetVersionRow {
  const { expectedRevision } = options;
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw Errors.validation('expectedRevision 必须是非负整数');
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    const v = getVersion(db, versionId);
    if (v.status !== 'draft') throw Errors.conflict(`版本状态为 ${v.status},只有草稿可以定稿`);
    if (expectedRevision !== undefined && v.revision !== expectedRevision) {
      throw Errors.conflict(`版本在你确认期间已被修改（当前修订 ${v.revision}，确认基线 ${expectedRevision}），请刷新后查看最新内容再定稿`);
    }
    const check = budgetQualityReport(db, versionId);
    if (!check.canFinalize) {
      const blocking = check.issues.filter((issue) => issue.severity === 'blocking');
      throw Errors.validation('定稿前检查未通过', blocking.map((issue, i) => ({ row: i + 1, field: issue.code, message: issue.message })));
    }
    // 定稿不遗漏尚未主动记录的修改;没有变化时不生成空记录。
    const checkpoint = recordCompilationCheckpointInternal(db, v, { title: '定稿前记录', autoCreated: true });
    snapshotMetricsForVersion(db, versionId);
    db.prepare('UPDATE budget_version SET status = ?, locked_at = ?, updated_at = ? WHERE id = ?').run('locked', now, now, versionId);
    writeLog(db, 'budget.lock', 'budget_version', versionId, {
      year: v.year,
      name: v.name,
      checkpointCreated: checkpoint.created,
      checkpointChangeCount: checkpoint.changeCount,
    });
  })();
  return getVersion(db, versionId);
}

/** 设为当前生效:仅锁定版本;事务内取消原版本、设置新版本(方案六.3)。
 * 传入 expectedCurrentVersionId 时(UX-07 新确认 UI 必传,null 表示当前没有采用版本),
 * 在同一事务内复核该年度该用途(预算/预测各自管理)的原采用版本未变;缺省保持旧调用兼容。 */
export function setCurrentVersion(db: DB, versionId: number, options: { expectedCurrentVersionId?: number | null } = {}): BudgetVersionRow {
  const { expectedCurrentVersionId } = options;
  if (expectedCurrentVersionId !== undefined && expectedCurrentVersionId !== null
    && (!Number.isSafeInteger(expectedCurrentVersionId) || expectedCurrentVersionId <= 0)) {
    throw Errors.validation('expectedCurrentVersionId 必须是正整数版本 ID 或 null');
  }
  const v = getVersion(db, versionId);
  if (v.status !== 'locked') throw Errors.conflict('只有锁定版本可以设为当前生效');
  db.transaction(() => {
    if (expectedCurrentVersionId !== undefined) {
      const row = db.prepare('SELECT id, name FROM budget_version WHERE year = ? AND kind = ? AND is_current = 1').get(v.year, v.kind) as { id: number; name: string } | undefined;
      const actualCurrentId = row?.id ?? null;
      if (actualCurrentId !== expectedCurrentVersionId) {
        const actualLabel = row ? `「${row.name}」` : '无（尚未有采用版本）';
        const expectedLabel = expectedCurrentVersionId != null ? `版本 #${expectedCurrentVersionId}` : '无';
        throw Errors.conflict(`原采用版本已变化（你确认时记录的原采用为 ${expectedLabel}，当前实际为 ${actualLabel}），请刷新后重试`);
      }
    }
    db.prepare('UPDATE budget_version SET is_current = 0 WHERE year = ? AND kind = ? AND is_current = 1').run(v.year, v.kind);
    db.prepare('UPDATE budget_version SET is_current = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), versionId);
    writeLog(db, 'budget.set_current', 'budget_version', versionId, { year: v.year, kind: v.kind, name: v.name });
  })();
  return getVersion(db, versionId);
}

/** 归档:locked -> archived;当前生效版本不能直接归档(方案六.1) */
export function archiveVersion(db: DB, versionId: number): BudgetVersionRow {
  const v = getVersion(db, versionId);
  if (v.status !== 'locked') throw Errors.conflict('只有锁定版本可以归档');
  if (v.is_current) throw Errors.conflict('当前生效版本不能直接归档,请先切换当前生效版本');
  db.transaction(() => {
    db.prepare('UPDATE budget_version SET status = ?, updated_at = ? WHERE id = ?').run('archived', new Date().toISOString(), versionId);
    writeLog(db, 'budget.archive', 'budget_version', versionId, { year: v.year, name: v.name });
  })();
  return getVersion(db, versionId);
}

/**
 * 复制生成新草稿(修订锁定版本的唯一途径,方案三.2)。
 *
 * 树快照绑定分两种情形：
 * - **同年复制**(修订)：沿用源版本绑定的树快照，历史口径不可变；
 * - **跨年复制**(以上年版本为底稿开新年度)：绑定目标年度的**当前**树快照。
 *   否则新草稿会挂在源年度的旧快照上，期间新增的组织/科目在这份草稿里既不存在
 *   也无法录入，而已停用的旧节点还继续占位。跨年时同时按目标快照的叶子与
 *   组织-科目适用范围过滤来源明细(与 createVersion 同口径)。
 */
export function copyVersion(db: DB, sourceId: number, newName: string, note?: string, targetYear?: number, growthRate?: string | number): BudgetVersionRow {
  const src = getVersion(db, sourceId);
  if (src.status === 'draft') throw Errors.conflict('草稿版本无需复制,可直接编辑');
  if (!newName?.trim()) throw Errors.validation('新版本名称不能为空');
  const year = targetYear ?? src.year;
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw Errors.validation('目标年度不合法');
  const crossYear = year !== src.year;
  const rateMillion = parseRateMillion(growthRate);
  assertNameFree(db, year, newName.trim());
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const orgSnap = crossYear ? createOrReuseSnapshot(db, 'org') : src.org_tree_snapshot_id;
    const accSnap = crossYear ? createOrReuseSnapshot(db, 'account') : src.account_tree_snapshot_id;
    const info = db
      .prepare(
        `INSERT INTO budget_version (year, name, status, is_current, org_tree_snapshot_id, account_tree_snapshot_id, source_version_id, kind, generation_json, note, created_at, updated_at)
         VALUES (?, ?, 'draft', 0, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(year, newName.trim(), orgSnap, accSnap, src.id, src.kind, JSON.stringify({ copiedFromVersionId: src.id, targetYear: year, growthRate: growthRate ?? 0, rebindTreeSnapshot: crossYear }), note?.trim() ?? `复制自 ${src.name}`, now, now);
    const newId = Number(info.lastInsertRowid);
    let copied = 0;
    let skipped = 0;
    if (!crossYear && rateMillion === 0n) {
      // 同年零增长复制：树快照与源版本完全一致，直接整表拷贝。
      copied = db.prepare(
        `INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, quantity, formula, note, updated_at)
         SELECT ?, org_id, account_id, amount_cents, quantity, formula, note, ? FROM budget_entry WHERE version_id = ?`
      ).run(newId, now, sourceId).changes;
    } else {
      const rows = db.prepare('SELECT org_id,account_id,amount_cents,quantity,formula,note FROM budget_entry WHERE version_id=?').all(sourceId) as BudgetEntryRow[];
      const insert = db.prepare('INSERT INTO budget_entry (version_id,org_id,account_id,amount_cents,quantity,formula,note,updated_at) VALUES (?,?,?,?,?,?,?,?)');
      const writable = crossYear ? versionCellFilter(db, newId) : null;
      for (const row of rows) {
        if (writable && !writable(row.org_id, row.account_id)) { skipped += 1; continue; }
        insert.run(newId, row.org_id, row.account_id, scaleIntegerByRate(row.amount_cents, rateMillion), row.quantity == null ? null : scaleIntegerByRate(row.quantity, rateMillion), row.formula ?? '', row.note ?? '', now);
        copied += 1;
      }
    }
    // 汇总格备注随版本复制:同年树快照一致,全部沿用;跨年按目标快照过滤——
    // 目标树中不存在的节点直接丢弃;在目标树中已退化为叶子×叶子的组合也不再携带
    // (该组合的附注归明细行 budget_entry.note,避免双份真源)。
    const noteRows = db.prepare('SELECT org_id, account_id, note FROM budget_cell_note WHERE version_id = ?').all(sourceId) as { org_id: number; account_id: number; note: string }[];
    let copiedNotes = 0;
    let skippedNotes = 0;
    if (noteRows.length > 0) {
      const insertNote = db.prepare('INSERT INTO budget_cell_note (version_id, org_id, account_id, note, updated_at) VALUES (?, ?, ?, ?, ?)');
      if (!crossYear) {
        for (const row of noteRows) { insertNote.run(newId, row.org_id, row.account_id, row.note ?? '', now); copiedNotes += 1; }
      } else {
        const targetOrgRows = loadSnapshotNodes(db, orgSnap);
        const targetAccRows = loadSnapshotNodes(db, accSnap);
        const targetOrgIds = new Set(targetOrgRows.map((r) => r.id));
        const targetAccIds = new Set(targetAccRows.map((r) => r.id));
        const targetLeafOrgs = computeLeafIds(targetOrgRows);
        const targetLeafAccs = computeLeafIds(targetAccRows);
        for (const row of noteRows) {
          if (!targetOrgIds.has(row.org_id) || !targetAccIds.has(row.account_id)) { skippedNotes += 1; continue; }
          if (targetLeafOrgs.has(row.org_id) && targetLeafAccs.has(row.account_id)) { skippedNotes += 1; continue; }
          insertNote.run(newId, row.org_id, row.account_id, row.note ?? '', now);
          copiedNotes += 1;
        }
      }
    }
    writeLog(db, 'budget.copy', 'budget_version', newId, { sourceId, sourceName: src.name, sourceYear: src.year, year, name: newName.trim(), crossYear, orgSnap, accSnap, copiedEntries: copied, skippedEntries: skipped, copiedCellNotes: copiedNotes, skippedCellNotes: skippedNotes });
    return newId;
  });
  return getVersion(db, tx());
}

/** 版本汇总(按版本绑定树快照计算,方案八.1) */
export function versionSummary(db: DB, versionId: number) {
  const v = getVersion(db, versionId);
  const { orgRows, accRows } = versionLeaves(db, v);
  const entries = db
    .prepare('SELECT org_id, account_id, amount_cents, quantity FROM budget_entry WHERE version_id = ?')
    .all(versionId) as { org_id: number; account_id: number; amount_cents: number; quantity: number | null }[];
  const metricDefinitions = listMetricsForVersion(db, versionId);
  const metrics = metricDefinitions.filter((m) => m.status === 'active');
  const result = rollup(orgRows, accRows, entries.map((e) => ({ orgId: e.org_id, accountId: e.account_id, amountCents: e.amount_cents, quantity: e.quantity })), metricDefinitions);
  return { version: v, orgRows, accRows, rollup: result, metrics };
}
