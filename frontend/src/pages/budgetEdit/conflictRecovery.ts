/**
 * 预算并发冲突恢复(UX-20/UX-21)纯函数模块:
 * - 三方比较:编辑基线(最后与服务器一致的修订) / 本地未提交输入 / 服务器最新矩阵
 * - 精确值比较:金额按原始分(利润方向)、数量按 10^4 缩放整数,显示相同但分值不同也算差异
 * - 恢复文件(本地待保存修改导出)的生成、解析与内容校验
 * - 基于最新服务器矩阵构造恢复方案(默认保留服务器值,只应用用户选定的本地修改)
 *
 * 本模块不接触网络与认证信息;恢复文件仅包含版本标识、基线 revision 与各格精确值。
 */

import {
  amountSchema,
  quantitySchema,
  wanToCents,
  yuanToCents,
  quantityToScaled,
  centsToWan,
  centsToYuanGrouped,
  formatQuantity,
  cellValueEquivalent,
  signOfType,
} from '../../utils/money';
import { isFormula, evaluateFormula } from '../../utils/formula';
import type { CellUpdate } from '../../hooks/useGridInteraction';
import type { MatrixResponse } from './types';

/** 一格的精确状态:金额为原始分(利润方向,收入+ 成本/费用-),数量为 10^4 缩放整数 */
export interface ExactCell {
  amountCents: number | null;
  quantityScaled: number | null;
  formula: string;
  note: string;
}

export const EMPTY_CELL: ExactCell = { amountCents: null, quantityScaled: null, formula: '', note: '' };

/** 编辑基线:最后一次与服务器一致的矩阵状态(revision 即保存时使用的 expectedRevision) */
export interface ConflictBaseline {
  revision: number;
  /** 仅含服务器端存在的明细格(orgId:accountId -> 精确状态) */
  cells: Map<string, ExactCell>;
  summaryNotes: Map<string, string>;
}

/** 本地草稿四张表(与 useGridInteraction / 页面汇总备注同构) */
export interface DraftMaps {
  values: Map<string, string>;
  formulas: Map<string, string>;
  notes: Map<string, string>;
  summaryNotes: Map<string, string>;
}

/** 导入恢复文件后叠加在本地侧的修改(summaryNotes 值为 null 表示清除意图) */
export interface ImportOverlay {
  cells: Map<string, ExactCell>;
  summaryNotes: Map<string, string | null>;
}

export type ConflictCategory = 'local_only' | 'server_only' | 'both';

export const CONFLICT_CATEGORY_LABEL: Record<ConflictCategory, string> = {
  local_only: '仅本地修改',
  server_only: '仅服务器修改',
  both: '双方都修改',
};

export interface CellDiff {
  key: string;
  orgId: number;
  accountId: number;
  kind: 'detail' | 'summary_note';
  accountType: string;
  category: ConflictCategory;
  /** 三方的精确状态;null = 该侧无任何内容(不存在/已清空) */
  baseline: ExactCell | null;
  local: ExactCell | null;
  server: ExactCell | null;
  /** 本地把基线有内容的格清空(删除意图) */
  localDelete: boolean;
  /** 本地显示值无法解析为合法金额/数量(不能提交) */
  localInvalid: boolean;
  /** 三方不全等的方面(金额/数量/公式/附注/汇总备注) */
  aspects: string[];
}

export interface ThreeWayDiffResult {
  diffs: CellDiff[];
  /** 双方改成完全一致的格数(无需处理,不列入差异清单) */
  convergedCount: number;
}

/* ============ 精确状态规范化与比较 ============ */

/** 0 分/0 数量与「无内容」在显示与保存语义上等价,比较前统一归并为 null */
export function normalizeCell(cell: ExactCell): ExactCell {
  return {
    amountCents: cell.amountCents === 0 ? null : cell.amountCents,
    quantityScaled: cell.quantityScaled === 0 ? null : cell.quantityScaled,
    formula: cell.formula.trim(),
    note: cell.note.trim(),
  };
}

export function cellIsEmpty(cell: ExactCell | null | undefined): boolean {
  if (!cell) return true;
  const n = normalizeCell(cell);
  return n.amountCents == null && n.quantityScaled == null && n.formula === '' && n.note === '';
}

export function cellsEqual(a: ExactCell | null | undefined, b: ExactCell | null | undefined): boolean {
  const x = a ? normalizeCell(a) : EMPTY_CELL;
  const y = b ? normalizeCell(b) : EMPTY_CELL;
  return (x.amountCents ?? null) === (y.amountCents ?? null)
    && (x.quantityScaled ?? null) === (y.quantityScaled ?? null)
    && x.formula === y.formula
    && x.note === y.note;
}

/* ============ 基线捕获与推进 ============ */

export type AccountTypeOf = (accountId: number) => string | undefined;

/** 从服务器矩阵捕获精确基线(编辑开始 / 恢复时采纳的最新矩阵) */
export function captureBaseline(matrix: MatrixResponse): ConflictBaseline {
  const typeById = new Map(matrix.accountNodes.map((n) => [n.id, n.type ?? 'expense']));
  const cells = new Map<string, ExactCell>();
  for (const e of matrix.entries) {
    const type = typeById.get(e.accountId) ?? 'expense';
    cells.set(`${e.orgId}:${e.accountId}`, {
      amountCents: type === 'quantity' ? null : e.amountCents,
      quantityScaled: type === 'quantity' && e.quantity != null && e.quantity.trim() !== ''
        ? quantityToScaled(e.quantity)
        : null,
      formula: e.formula ?? '',
      note: e.note ?? '',
    });
  }
  const summaryNotes = new Map<string, string>();
  for (const n of matrix.cellNotes ?? []) {
    if (n.note?.trim()) summaryNotes.set(`${n.orgId}:${n.accountId}`, n.note);
  }
  return { revision: matrix.version.revision, cells, summaryNotes };
}

/**
 * 保存成功后同步推进基线:整包替换语义下,服务器新状态 = 本次实际提交的 entries/cellNotes
 * (payload 的金额/数量均为精确值,未编辑格走原始精度直通)。
 */
export function baselineFromSave(
  revision: number,
  payload: {
    entries: { orgId: number; accountId: number; amount?: string; quantity?: string; formula?: string; note?: string }[];
    cellNotes: { orgId: number; accountId: number; note: string }[];
  },
  accountTypeOf: AccountTypeOf,
): ConflictBaseline {
  const cells = new Map<string, ExactCell>();
  for (const e of payload.entries) {
    const type = accountTypeOf(e.accountId) ?? 'expense';
    if (type === 'quantity') {
      const q = e.quantity != null && e.quantity.trim() !== '' ? quantityToScaled(e.quantity) : null;
      cells.set(`${e.orgId}:${e.accountId}`, { amountCents: null, quantityScaled: q, formula: e.formula ?? '', note: e.note ?? '' });
    } else {
      const yuan = e.amount != null ? yuanToCents(e.amount) : null;
      cells.set(`${e.orgId}:${e.accountId}`, {
        amountCents: yuan == null ? null : yuan * signOfType(type),
        quantityScaled: null,
        formula: e.formula ?? '',
        note: e.note ?? '',
      });
    }
  }
  const summaryNotes = new Map<string, string>();
  for (const n of payload.cellNotes) {
    if (n.note?.trim()) summaryNotes.set(`${n.orgId}:${n.accountId}`, n.note);
  }
  return { revision, cells, summaryNotes };
}

/* ============ 本地侧精确化 ============ */

/**
 * 本地一格的精确状态。金额显示为万元两位小数,未编辑过的格子显示相同但可能
 * 掩盖原始分值:与基线显示等价时直通基线精确分(与 buildSavePayload 同口径),
 * 否则按显示值精确解析;解析失败标记 invalid(该格不能提交)。
 */
export function localExactCell(
  key: string,
  draft: Pick<DraftMaps, 'values' | 'formulas' | 'notes'>,
  baselineCells: ReadonlyMap<string, ExactCell>,
  accountType: string,
  overlay?: ImportOverlay | null,
): { cell: ExactCell; invalid: boolean } {
  const hit = overlay?.cells.get(key);
  if (hit) return { cell: normalizeCell(hit), invalid: false };

  const display = draft.values.get(key) ?? '';
  const base = baselineCells.get(key);
  let amountCents: number | null = null;
  let quantityScaled: number | null = null;
  let invalid = false;
  if (display.trim() !== '') {
    if (accountType === 'quantity') {
      const scaled = quantityToScaled(display);
      if (scaled == null) invalid = true; else quantityScaled = scaled;
    } else {
      const baseDisplay = base?.amountCents != null ? centsToWan(base.amountCents * signOfType(accountType)) : '';
      if (base != null && cellValueEquivalent(display, baseDisplay)) {
        amountCents = base.amountCents;
      } else {
        const cents = wanToCents(display);
        if (cents == null) invalid = true; else amountCents = cents * signOfType(accountType);
      }
    }
  }
  return {
    cell: normalizeCell({
      amountCents,
      quantityScaled,
      formula: draft.formulas.get(key) ?? '',
      note: draft.notes.get(key) ?? '',
    }),
    invalid,
  };
}

/* ============ 三方比较 ============ */

const CATEGORY_RANK: Record<ConflictCategory, number> = { both: 0, local_only: 1, server_only: 2 };

function diffAspects(
  accountType: string,
  b: ExactCell | null,
  l: ExactCell | null,
  s: ExactCell | null,
): string[] {
  const aspects: string[] = [];
  const valueOf = (c: ExactCell | null) => {
    const n = c ? normalizeCell(c) : EMPTY_CELL;
    return accountType === 'quantity' ? n.quantityScaled : n.amountCents;
  };
  const bv = valueOf(b); const lv = valueOf(l); const sv = valueOf(s);
  if (!(bv === lv && lv === sv)) aspects.push(accountType === 'quantity' ? '数量' : '金额');
  const textOf = (c: ExactCell | null, field: 'formula' | 'note') => (c ? normalizeCell(c)[field] : '');
  if (!(textOf(b, 'formula') === textOf(l, 'formula') && textOf(l, 'formula') === textOf(s, 'formula'))) aspects.push('公式');
  if (!(textOf(b, 'note') === textOf(l, 'note') && textOf(l, 'note') === textOf(s, 'note'))) aspects.push('附注');
  return aspects;
}

/**
 * 三方逐格比较。分类:本地相对基线有变化且服务器没有 -> 仅本地修改;反之仅服务器修改;
 * 都变了且彼此不同 -> 双方都修改;都变了但完全一致 -> 收敛(不计入差异清单)。
 * 删除(清空)作为一种本地/服务器修改参与分类。
 */
export function computeThreeWayDiff(opts: {
  baseline: ConflictBaseline;
  local: DraftMaps;
  server: MatrixResponse;
  accountTypeOf: AccountTypeOf;
  overlay?: ImportOverlay | null;
}): ThreeWayDiffResult {
  const { baseline, local, server, accountTypeOf, overlay } = opts;
  const serverBaseline = captureBaseline(server);
  const diffs: CellDiff[] = [];
  let convergedCount = 0;

  const keys = new Set<string>([
    ...baseline.cells.keys(),
    ...serverBaseline.cells.keys(),
    ...local.values.keys(),
    ...local.formulas.keys(),
    ...local.notes.keys(),
    ...(overlay ? overlay.cells.keys() : []),
  ]);
  for (const key of keys) {
    const [orgId, accountId] = key.split(':').map(Number);
    const accountType = accountTypeOf(accountId) ?? 'expense';
    const b = baseline.cells.get(key) ?? null;
    const s = serverBaseline.cells.get(key) ?? null;
    const { cell: l, invalid } = localExactCell(key, local, baseline.cells, accountType, overlay);

    const localChanged = !cellsEqual(l, b);
    const serverChanged = !cellsEqual(s, b);
    if (!localChanged && !serverChanged) continue;
    if (cellsEqual(l, s)) { convergedCount++; continue; }
    const category: ConflictCategory = localChanged && serverChanged ? 'both' : localChanged ? 'local_only' : 'server_only';
    diffs.push({
      key, orgId, accountId, kind: 'detail', accountType, category,
      baseline: cellIsEmpty(b) ? null : b,
      local: cellIsEmpty(l) ? null : normalizeCell(l),
      server: cellIsEmpty(s) ? null : s,
      localDelete: localChanged && cellIsEmpty(l) && !cellIsEmpty(b),
      localInvalid: invalid,
      aspects: diffAspects(accountType, b, l, s),
    });
  }

  const noteKeys = new Set<string>([
    ...baseline.summaryNotes.keys(),
    ...serverBaseline.summaryNotes.keys(),
    ...local.summaryNotes.keys(),
    ...(overlay ? overlay.summaryNotes.keys() : []),
  ]);
  for (const key of noteKeys) {
    const [orgId, accountId] = key.split(':').map(Number);
    const overlayHit = overlay?.summaryNotes.has(key) ? overlay.summaryNotes.get(key) ?? null : undefined;
    const b = baseline.summaryNotes.get(key)?.trim() ?? '';
    const s = serverBaseline.summaryNotes.get(key)?.trim() ?? '';
    const l = overlayHit !== undefined ? (overlayHit ?? '').trim() : (local.summaryNotes.get(key)?.trim() ?? '');
    const localChanged = l !== b;
    const serverChanged = s !== b;
    if (!localChanged && !serverChanged) continue;
    if (l === s) { convergedCount++; continue; }
    const category: ConflictCategory = localChanged && serverChanged ? 'both' : localChanged ? 'local_only' : 'server_only';
    const toCell = (text: string): ExactCell | null => (text === '' ? null : { ...EMPTY_CELL, note: text });
    diffs.push({
      key, orgId, accountId, kind: 'summary_note', accountType: accountTypeOf(accountId) ?? 'expense', category,
      baseline: toCell(b), local: toCell(l), server: toCell(s),
      localDelete: localChanged && l === '' && b !== '',
      localInvalid: false,
      aspects: ['汇总备注'],
    });
  }

  diffs.sort((a, b2) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b2.category]
    || a.orgId - b2.orgId || a.accountId - b2.accountId || (a.kind === b2.kind ? 0 : a.kind === 'detail' ? -1 : 1));
  return { diffs, convergedCount };
}

/* ============ 恢复文件(导出本地待保存修改) ============ */

export const RECOVERY_FILE_KIND = 'budget-conflict-recovery';
export const RECOVERY_FILE_FORMAT = 1;

export interface RecoveryEntry {
  orgId: number;
  accountId: number;
  kind: 'money' | 'quantity';
  /** 精确值:金额为原始分(利润方向),数量为 10^4 缩放整数;无内容为 null */
  amountCents: number | null;
  quantityScaled: number | null;
  /** 录入时的显示文本(万元/数量原样),供人工核对 */
  display: string;
  formula: string;
  note: string;
  /** 删除意图:基线有内容、本地清空 */
  delete: boolean;
}

export interface RecoverySummaryNote {
  orgId: number;
  accountId: number;
  note: string;
  delete: boolean;
}

export interface RecoveryFile {
  kind: typeof RECOVERY_FILE_KIND;
  formatVersion: typeof RECOVERY_FILE_FORMAT;
  versionId: number;
  versionName: string;
  year: number;
  baselineRevision: number;
  exportedAt: string;
  entries: RecoveryEntry[];
  summaryNotes: RecoverySummaryNote[];
}

/**
 * 导出当前浏览器中未提交的本地修改(差异清单中本地侧有变化的格子,
 * 含删除意图),精确值 + 显示文本双写。不包含任何认证信息。
 */
export function buildRecoveryFile(opts: {
  versionId: number;
  versionName: string;
  year: number;
  baselineRevision: number;
  diffs: CellDiff[];
  /** 本地录入显示文本(key -> 网格显示值),删除/无值格为空串 */
  localDisplay: ReadonlyMap<string, string>;
  exportedAt?: string;
}): RecoveryFile {
  const entries: RecoveryEntry[] = [];
  const summaryNotes: RecoverySummaryNote[] = [];
  for (const d of opts.diffs) {
    // 只导出本地相对基线有变化的内容;仅服务器修改无需备份
    if (d.category === 'server_only') continue;
    if (d.kind === 'summary_note') {
      summaryNotes.push({
        orgId: d.orgId, accountId: d.accountId,
        note: d.local?.note ?? '',
        delete: d.localDelete,
      });
      continue;
    }
    const l = d.local ?? EMPTY_CELL;
    entries.push({
      orgId: d.orgId,
      accountId: d.accountId,
      kind: d.accountType === 'quantity' ? 'quantity' : 'money',
      amountCents: d.accountType === 'quantity' ? null : l.amountCents,
      quantityScaled: d.accountType === 'quantity' ? l.quantityScaled : null,
      display: d.localDelete ? '' : (opts.localDisplay.get(d.key) ?? ''),
      formula: l.formula,
      note: l.note,
      delete: d.localDelete,
    });
  }
  return {
    kind: RECOVERY_FILE_KIND,
    formatVersion: RECOVERY_FILE_FORMAT,
    versionId: opts.versionId,
    versionName: opts.versionName,
    year: opts.year,
    baselineRevision: opts.baselineRevision,
    exportedAt: opts.exportedAt ?? new Date().toISOString(),
    entries,
    summaryNotes,
  };
}

export type RecoveryParseResult =
  | { ok: true; file: RecoveryFile }
  | { ok: false; error: string };

function isSafeIntOrNull(v: unknown): boolean {
  return v == null || (typeof v === 'number' && Number.isSafeInteger(v));
}

/** 解析并做结构/版本校验:版本不匹配、格式损坏一律明确拒绝(旧文件不能覆盖另一版本) */
export function parseRecoveryFile(text: string, expectedVersionId: number): RecoveryParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '恢复文件不是有效的 JSON，文件可能已损坏' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '恢复文件格式损坏：顶层不是对象' };
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== RECOVERY_FILE_KIND) return { ok: false, error: '这不是预算冲突恢复文件（缺少 kind 标识）' };
  if (obj.formatVersion !== RECOVERY_FILE_FORMAT) return { ok: false, error: `恢复文件格式版本不受支持（${String(obj.formatVersion)}）` };
  if (typeof obj.versionId !== 'number' || !Number.isInteger(obj.versionId)) return { ok: false, error: '恢复文件格式损坏：版本 ID 缺失' };
  if (obj.versionId !== expectedVersionId) {
    return { ok: false, error: `恢复文件属于版本 #${obj.versionId}，不能应用到当前版本 #${expectedVersionId}` };
  }
  if (typeof obj.baselineRevision !== 'number' || !Number.isInteger(obj.baselineRevision)) {
    return { ok: false, error: '恢复文件格式损坏：基线 revision 缺失' };
  }
  if (!Array.isArray(obj.entries) || !Array.isArray(obj.summaryNotes)) {
    return { ok: false, error: '恢复文件格式损坏：entries/summaryNotes 缺失' };
  }
  for (let i = 0; i < obj.entries.length; i++) {
    const e = obj.entries[i] as Record<string, unknown>;
    if (typeof e !== 'object' || e === null) return { ok: false, error: `恢复文件格式损坏：第 ${i + 1} 条明细不是对象` };
    if (!Number.isInteger(e.orgId) || !Number.isInteger(e.accountId)) return { ok: false, error: `恢复文件格式损坏：第 ${i + 1} 条明细的组织/科目 ID 非法` };
    if (e.kind !== 'money' && e.kind !== 'quantity') return { ok: false, error: `恢复文件格式损坏：第 ${i + 1} 条明细类型非法` };
    if (!isSafeIntOrNull(e.amountCents) || !isSafeIntOrNull(e.quantityScaled)) {
      return { ok: false, error: `恢复文件格式损坏：第 ${i + 1} 条明细的精确值不是安全整数` };
    }
    if (typeof e.display !== 'string' || typeof e.formula !== 'string' || typeof e.note !== 'string' || typeof e.delete !== 'boolean') {
      return { ok: false, error: `恢复文件格式损坏：第 ${i + 1} 条明细字段类型错误` };
    }
  }
  for (let i = 0; i < obj.summaryNotes.length; i++) {
    const n = obj.summaryNotes[i] as Record<string, unknown>;
    if (typeof n !== 'object' || n === null || !Number.isInteger(n.orgId) || !Number.isInteger(n.accountId)
      || typeof n.note !== 'string' || typeof n.delete !== 'boolean') {
      return { ok: false, error: `恢复文件格式损坏：第 ${i + 1} 条汇总备注字段错误` };
    }
  }
  return { ok: true, file: obj as unknown as RecoveryFile };
}

/** 内容级校验:公式可求值、科目存在、数量/金额在可表示范围内。返回错误清单(空 = 通过) */
export function validateRecoveryContent(file: RecoveryFile, accountTypeOf: AccountTypeOf): string[] {
  const errors: string[] = [];
  file.entries.forEach((e, i) => {
    const type = accountTypeOf(e.accountId);
    if (type == null) {
      errors.push(`第 ${i + 1} 条明细：科目 #${e.accountId} 不在当前版本的科目快照中`);
      return;
    }
    const declared = e.kind === 'quantity' ? 'quantity' : 'money';
    const actual = type === 'quantity' ? 'quantity' : 'money';
    if (declared !== actual) errors.push(`第 ${i + 1} 条明细：科目 #${e.accountId} 的类型与恢复文件不一致`);
    if (e.formula.trim() !== '') {
      if (!isFormula(e.formula)) errors.push(`第 ${i + 1} 条明细：公式必须以 = 开头`);
      else if (!evaluateFormula(e.formula, actual === 'quantity' ? 4 : 2).ok) errors.push(`第 ${i + 1} 条明细：公式「${e.formula}」无法求值`);
    }
  });
  return errors;
}

/** 恢复文件 -> 本地侧重叠(走同一三方差异确认流程;delete 转为清空意图) */
export function overlayFromRecovery(file: RecoveryFile): ImportOverlay {
  const cells = new Map<string, ExactCell>();
  for (const e of file.entries) {
    cells.set(`${e.orgId}:${e.accountId}`, e.delete
      ? { ...EMPTY_CELL }
      : normalizeCell({ amountCents: e.amountCents, quantityScaled: e.quantityScaled, formula: e.formula, note: e.note }));
  }
  const summaryNotes = new Map<string, string | null>();
  for (const n of file.summaryNotes) {
    summaryNotes.set(`${n.orgId}:${n.accountId}`, n.delete ? null : n.note);
  }
  return { cells, summaryNotes };
}

/* ============ 恢复方案(基于最新服务器矩阵应用选定本地修改) ============ */

/** 精确状态 -> 网格显示值(万元/数量显示串;本地导出值均为两位/四位小数,可无损失往返) */
export function displayOfExact(cell: ExactCell | null, accountType: string): string {
  if (!cell) return '';
  const n = normalizeCell(cell);
  if (accountType === 'quantity') return n.quantityScaled != null ? formatQuantity(n.quantityScaled) : '';
  return n.amountCents != null ? centsToWan(n.amountCents * signOfType(accountType)) : '';
}

/** 精确值的人读核对文本(金额到分,数量原值) */
export function exactTextOf(cell: ExactCell | null, accountType: string): string {
  if (!cell) return '';
  const n = normalizeCell(cell);
  if (accountType === 'quantity') return n.quantityScaled != null ? formatQuantity(n.quantityScaled) : '';
  return n.amountCents != null ? `${centsToYuanGrouped(n.amountCents * signOfType(accountType))} 元` : '';
}

function displayValueEqual(a: string, b: string, accountType: string): boolean {
  const ta = a.trim(); const tb = b.trim();
  if (ta === '' && tb === '') return true;
  if (accountType === 'quantity') {
    const sa = quantityToScaled(ta); const sb = quantityToScaled(tb);
    if (sa != null || sb != null) return sa === sb;
    return ta === tb;
  }
  const ca = wanToCents(ta); const cb = wanToCents(tb);
  if (ca != null || cb != null) return ca === cb;
  return ta === tb;
}

export interface ResolutionPlan {
  /** 当前网格 -> 合并目标的写入(经 applyCells 统一入口与校验) */
  updates: CellUpdate[];
  /** 合并后的完整草稿(服务器最新值 + 选定本地修改),用于整包保存 */
  merged: DraftMaps;
  /** 无法提交的内容(非法金额/数量/公式),非空时禁止应用 */
  errors: string[];
}

/**
 * 构造恢复方案:以服务器最新矩阵为基础,未选定的差异保留服务器值,
 * 选定的差异恢复为本地值。汇总备注同口径合并。
 */
export function buildResolutionPlan(opts: {
  diffs: CellDiff[];
  selectedKeys: ReadonlySet<string>;
  server: MatrixResponse;
  accountTypeOf: AccountTypeOf;
  current: DraftMaps;
}): ResolutionPlan {
  const { diffs, selectedKeys, server, accountTypeOf, current } = opts;
  const serverBaseline = captureBaseline(server);

  const mergedValues = new Map<string, string>();
  const mergedFormulas = new Map<string, string>();
  const mergedNotes = new Map<string, string>();
  const mergedSummary = new Map<string, string>(serverBaseline.summaryNotes);

  const putCell = (key: string, cell: ExactCell | null, accountType: string) => {
    const display = displayOfExact(cell, accountType);
    if (display !== '') mergedValues.set(key, display); else mergedValues.delete(key);
    const formula = cell ? normalizeCell(cell).formula : '';
    const note = cell ? normalizeCell(cell).note : '';
    if (formula !== '') mergedFormulas.set(key, formula); else mergedFormulas.delete(key);
    if (note !== '') mergedNotes.set(key, note); else mergedNotes.delete(key);
  };

  // 基础:服务器最新矩阵
  for (const [key, cell] of serverBaseline.cells) {
    putCell(key, cell, accountTypeOf(Number(key.split(':')[1])) ?? 'expense');
  }
  // 差异:选定 -> 本地;未选定 -> 服务器
  for (const d of diffs) {
    const target = selectedKeys.has(d.key) ? d.local : d.server;
    if (d.kind === 'summary_note') {
      const note = target ? normalizeCell(target).note : '';
      if (note !== '') mergedSummary.set(d.key, note); else mergedSummary.delete(d.key);
      continue;
    }
    putCell(d.key, target, d.accountType);
  }

  // 当前网格 -> 合并目标的增量写入
  const updates: CellUpdate[] = [];
  const touchKeys = new Set<string>([
    ...mergedValues.keys(), ...mergedFormulas.keys(), ...mergedNotes.keys(),
    ...current.values.keys(), ...current.formulas.keys(), ...current.notes.keys(),
  ]);
  for (const key of touchKeys) {
    const accountType = accountTypeOf(Number(key.split(':')[1])) ?? 'expense';
    const value = mergedValues.get(key) ?? '';
    const formula = mergedFormulas.get(key) ?? '';
    const note = mergedNotes.get(key) ?? '';
    const same = displayValueEqual(value, current.values.get(key) ?? '', accountType)
      && formula === (current.formulas.get(key)?.trim() ?? '')
      && note === (current.notes.get(key)?.trim() ?? '');
    if (!same) updates.push({ key, value, formula: formula || null, note: note || null, type: accountType });
  }

  // 提交前校验:非法金额/数量/公式不能进入保存链路
  const errors: string[] = [];
  for (const d of diffs) {
    if (selectedKeys.has(d.key) && d.localInvalid) {
      errors.push(`单元格 ${d.key} 的本地值不是合法${d.accountType === 'quantity' ? '数量' : '金额'}格式，无法恢复（请先在网格中修正或放弃该格）`);
    }
  }
  for (const [key, display] of mergedValues) {
    if (display.trim() === '') continue;
    const accountType = accountTypeOf(Number(key.split(':')[1])) ?? 'expense';
    const ok = accountType === 'quantity' ? quantitySchema.safeParse(display).success : amountSchema.safeParse(display).success;
    if (!ok) errors.push(`单元格 ${key} 的${accountType === 'quantity' ? '数量' : '金额'}「${display}」不是合法格式`);
  }
  for (const [key, formula] of mergedFormulas) {
    const accountType = accountTypeOf(Number(key.split(':')[1])) ?? 'expense';
    if (isFormula(formula) && !evaluateFormula(formula, accountType === 'quantity' ? 4 : 2).ok) {
      errors.push(`单元格 ${key} 的公式「${formula}」无法求值`);
    }
  }

  return {
    updates,
    merged: { values: mergedValues, formulas: mergedFormulas, notes: mergedNotes, summaryNotes: mergedSummary },
    errors,
  };
}
