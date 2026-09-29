import type { DB } from '../../db/connection';
import { createHash } from 'node:crypto';
import { Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import { createOrReuseSnapshot, loadSnapshotNodes } from '../tree/snapshot';
import { displayToSignedCents, centsToYuanString, isQuantityType, quantityStringToScaled, scaledToQuantityString, type AccountType } from '../../core/money';
import { computeLeafIds, listRows } from './actual.helpers';
import type { TreeNodeRow } from '../../core/tree';
import { isValidDate, yearOfDate, compareDate } from '../../core/dates';
import { isAccountVisibleForScope } from '../../core/accountScope';
import { listFinanceOwnedCells } from '../finance-import/owned-scope';

/** 实际数管理(方案七):当前值 + 全量快照,同一事务。 */

export interface ActualYearStateRow {
  year: number;
  status: 'open' | 'frozen';
  current_batch_id: number | null;
  final_batch_id: number | null;
  frozen_at: string | null;
  updated_at: string;
}

export interface ActualCurrentRow {
  id: number;
  year: number;
  org_id: number;
  account_id: number;
  cumulative_amount_cents: number;
  quantity: number | null;
  source: 'manual' | 'excel_import';
  memo: string;
  updated_at: string;
}

export interface SnapshotBatchRow {
  id: number;
  year: number;
  snapshot_date: string;
  revision: number;
  status: 'active' | 'superseded';
  source: 'manual' | 'excel_import' | 'history_import';
  org_tree_snapshot_id: number;
  account_tree_snapshot_id: number;
  updates_current: 0 | 1;
  note: string;
  created_at: string;
  import_batch_id: number | null;
  entry_count?: number;
}

export interface ActualEntryInput {
  orgId: number;
  accountId: number;
  amount?: string; // 界面口径元字符串(金额科目必填)
  quantity?: string; // 数量字符串(最多四位小数,数量型科目必填)
  memo?: string;
}

export function getYearState(db: DB, year: number): ActualYearStateRow | undefined {
  return db.prepare('SELECT * FROM actual_year_state WHERE year = ?').get(year) as ActualYearStateRow | undefined;
}

export function listYearStates(db: DB): ActualYearStateRow[] {
  return db.prepare('SELECT * FROM actual_year_state ORDER BY year DESC').all() as ActualYearStateRow[];
}

function ensureYearOpen(db: DB, year: number): ActualYearStateRow {
  let state = getYearState(db, year);
  if (!state) {
    db.prepare('INSERT INTO actual_year_state (year, status, updated_at) VALUES (?, ?, ?)').run(year, 'open', new Date().toISOString());
    state = getYearState(db, year)!;
  }
  if (state.status !== 'open') throw Errors.conflict(`${year} 年度已冻结,禁止更新实际数(如需修改请先重开年度)`);
  return state;
}

function currentTreeLeaves(db: DB): { orgRows: TreeNodeRow[]; accRows: TreeNodeRow[]; leafOrgs: Set<number>; leafAccs: Set<number>; typeOf: Map<number, AccountType>; activeOrgs: Set<number>; activeAccs: Set<number>; orgCodeOf: Map<number, string>; accCodeOf: Map<number, string> } {
  const orgRows = listRows(db, 'org');
  const accRows = listRows(db, 'account');
  return {
    orgRows,
    accRows,
    leafOrgs: computeLeafIds(orgRows),
    leafAccs: computeLeafIds(accRows),
    typeOf: new Map(accRows.map((a) => [a.id, (a.type ?? 'expense') as AccountType])),
    activeOrgs: new Set(orgRows.filter((r) => r.status === 'active').map((r) => r.id)),
    activeAccs: new Set(accRows.filter((r) => r.status === 'active').map((r) => r.id)),
    orgCodeOf: new Map(orgRows.map((r) => [r.id, r.code])),
    accCodeOf: new Map(accRows.map((r) => [r.id, r.code])),
  };
}

export interface ActualSaveInput {
  year: number;
  snapshotDate: string;
  entries: ActualEntryInput[];
  source: 'manual' | 'excel_import';
  note?: string;
  /** 整包替换(界面矩阵保存)还是增量 upsert(Excel 导入) */
  mode: 'replace' | 'upsert';
  /** 历史补录:不更新当前实际,任意历史日期 */
  history?: boolean;
  /** 界面整包保存读取到的当前批次，用于阻止旧页面覆盖预览后的新修改。 */
  expectedCurrentBatchId?: number | null;
  /** 从非空现状清空为零必须由界面二次确认。 */
  allowEmptyReplace?: boolean;
  /** 导入明确提供备注列时，允许空字符串清除旧备注；默认仍保留既有备注。 */
  clearBlankMemos?: boolean;
  /**
   * 汇总格备注(非叶子组织列/非叶子科目行的批注),整包替换 actual_cell_note。
   * 不传(undefined)表示不动汇总备注——Excel 导入、财务转换等只写叶子明细的链路保持原样。
   * 不带金额,不参与汇总/快照;历史补录(history=true)不支持,传入非空即报错。
   */
  cellNotes?: { orgId: number; accountId: number; memo: string }[];
  /**
   * 幂等请求编号(UX-11):客户端在用户明确提交时生成并随请求固定。
   * 同编号同规范化内容重试直接返回原回执、不重复写入;同编号不同内容拒绝(409)。
   * 缺省保持旧行为(不去重),Excel/财务转换等既有链路不受影响。
   */
  requestId?: string;
}

/** 请求编号格式:8-64 位字母/数字/连字符/下划线(UUID、nanoid 均满足)。 */
const SAVE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function assertValidSaveRequestId(requestId: string): void {
  if (!SAVE_REQUEST_ID_PATTERN.test(requestId)) {
    throw Errors.validation('requestId 必须是 8-64 位字母、数字、连字符或下划线(建议 UUID)');
  }
}

/** 确定性序列化:对象键排序,数组保持给定顺序。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) as string;
}

/**
 * 规范化请求 hash(UX-11):排除 requestId 本身,对保存输入做确定性序列化后取 SHA-256。
 * entries/cellNotes 是整包替换语义、与数组顺序无关,按 组织×科目 排序后参与 hash,
 * 保证同一提交内容的不同序列化顺序得到同一 hash。
 */
export function actualSaveRequestHash(input: ActualSaveInput): string {
  const byCell = (a: { orgId: number; accountId: number }, b: { orgId: number; accountId: number }) =>
    (a.orgId - b.orgId) || (a.accountId - b.accountId);
  const normalized = {
    year: input.year,
    snapshotDate: input.snapshotDate,
    source: input.source,
    mode: input.mode,
    history: input.history === true,
    note: input.note ?? '',
    expectedCurrentBatchId: input.expectedCurrentBatchId ?? null,
    allowEmptyReplace: input.allowEmptyReplace === true,
    clearBlankMemos: input.clearBlankMemos === true,
    entries: input.entries
      .map((e) => ({ orgId: e.orgId, accountId: e.accountId, amount: e.amount ?? null, quantity: e.quantity ?? null, memo: e.memo ?? '' }))
      .sort(byCell),
    cellNotes: input.cellNotes === undefined
      ? null
      : input.cellNotes.map((n) => ({ orgId: n.orgId, accountId: n.accountId, memo: n.memo })).sort(byCell),
  };
  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

export interface ActualSaveResult {
  batchId: number;
  saved: number;
  deleted: number;
  cellNotesSaved: number;
  cellNotesDeleted: number;
  /** true 表示命中既有回执:本次是响应丢失后的同编号重试,未重复写入实际/快照 */
  replayed: boolean;
}

export interface ActualSaveReceiptRow {
  request_id: string;
  request_hash: string;
  year: number;
  batch_id: number;
  result_json: string;
  created_at: string;
}

export interface ActualSaveReceiptInfo {
  requestId: string;
  year: number;
  batchId: number;
  result: Omit<ActualSaveResult, 'replayed'>;
  createdAt: string;
}

/** 只读回执查询(UX-11/UX-12):响应丢失后据此确认请求是否已成功提交。 */
export function getSaveReceipt(db: DB, requestId: string): ActualSaveReceiptInfo | undefined {
  const row = db.prepare('SELECT * FROM actual_save_receipt WHERE request_id = ?').get(requestId) as ActualSaveReceiptRow | undefined;
  if (!row) return undefined;
  return {
    requestId: row.request_id,
    year: row.year,
    batchId: row.batch_id,
    result: JSON.parse(row.result_json) as Omit<ActualSaveResult, 'replayed'>,
    createdAt: row.created_at,
  };
}

export function assertSnapshotDateNotBeforeCurrent(db: DB, year: number, snapshotDate: string): void {
  const state = getYearState(db, year);
  if (state?.current_batch_id == null) return;
  const current = db.prepare('SELECT snapshot_date FROM actual_snapshot_batch WHERE id = ?')
    .get(state.current_batch_id) as { snapshot_date: string } | undefined;
  if (current && compareDate(snapshotDate, current.snapshot_date) < 0) {
    throw Errors.conflict(`截止日期不能早于当前最新截止日期 ${current.snapshot_date}(历史数据请使用历史补录)`);
  }
}

/**
 * 保存当前累计实际并生成全量快照(方案七.2,单事务,任一步失败全部回滚)。
 * 历史补录(history=true)不更新 actual_current(方案七.4)。
 * 携带 requestId 时(UX-11):事务内先查回执——同编号同内容直接返回原结果不重写;
 * 同编号不同内容拒绝;无回执走正常流程,回执与实际值/快照同事务落库,失败不残留。
 */
export function saveActual(db: DB, input: ActualSaveInput): ActualSaveResult {
  const { year, snapshotDate } = input;
  // 年度显式范围校验:isValidDate 的 UTC 往返拦不住 100-1899 年,不能依赖 CHECK 约束兜底成 500
  if (!Number.isSafeInteger(year) || year < 1900 || year > 9999) throw Errors.validation('年度必须是 1900-9999 的整数');
  if (!isValidDate(snapshotDate)) throw Errors.validation('截止日期格式必须为 YYYY-MM-DD');
  if (yearOfDate(snapshotDate) !== year) throw Errors.validation('截止日期必须属于所选年度');
  const requestId = input.requestId;
  if (requestId !== undefined) assertValidSaveRequestId(requestId);
  const requestHash = requestId !== undefined ? actualSaveRequestHash(input) : null;
  // 冻结状态只读校验;年度状态的创建在主事务内完成,保证失败全部回滚
  {
    const existing = getYearState(db, year);
    if (existing && existing.status !== 'open') {
      throw Errors.conflict(
        input.history
          ? `${year} 年度已冻结,禁止补录`
          : `${year} 年度已冻结,禁止更新实际数(如需修改请先重开年度)`,
      );
    }
  }

  // 重复 组织+科目 组合前置校验,避免普通模式静默覆盖/历史模式触发唯一约束 500
  const seenKeys = new Set<string>();
  for (const [i, e] of input.entries.entries()) {
    const key = `${e.orgId}:${e.accountId}`;
    if (seenKeys.has(key)) throw Errors.validation(`第 ${i + 1} 条:组织 ${e.orgId} 与科目 ${e.accountId} 的组合重复`);
    seenKeys.add(key);
  }

  const tree = currentTreeLeaves(db);
  const parsed: { orgId: number; accountId: number; amountCents: number; quantity: number | null; memo: string }[] = [];
  for (const [i, e] of input.entries.entries()) {
    if (!tree.leafOrgs.has(e.orgId)) throw Errors.validation(`第 ${i + 1} 条:组织 ${e.orgId} 不是当前树的叶子组织`);
    if (!tree.leafAccs.has(e.accountId)) throw Errors.validation(`第 ${i + 1} 条:科目 ${e.accountId} 不是当前树的叶子科目`);
    // 停用只影响新增引用;存量行允许继续修改(方案五.3)
    const existing = input.history
      ? undefined
      : db.prepare('SELECT 1 FROM actual_current WHERE year = ? AND org_id = ? AND account_id = ?').get(year, e.orgId, e.accountId);
    if (!existing) {
      if (!tree.activeOrgs.has(e.orgId)) throw Errors.validation(`第 ${i + 1} 条:组织 ${e.orgId} 已停用,不能新增引用`);
      if (!tree.activeAccs.has(e.accountId)) throw Errors.validation(`第 ${i + 1} 条:科目 ${e.accountId} 已停用,不能新增引用`);
    }
    const type = tree.typeOf.get(e.accountId)!;
    // 科目-组织业务适用范围校验(与前端展示口径一致):普通保存不允许落库无效组合;
    // 历史补录跳过——存量历史数据可能早于范围规则存在,补录以忠实还原为准
    if (!input.history) {
      const orgCode = tree.orgCodeOf.get(e.orgId);
      const accCode = tree.accCodeOf.get(e.accountId);
      if (orgCode && accCode && !isAccountVisibleForScope(accCode, new Set([orgCode]))) {
        throw Errors.validation(`第 ${i + 1} 条:科目 ${accCode} 不适用于组织 ${orgCode},不能录入该组织的实际数`);
      }
    }
    if (isQuantityType(type)) {
      if (e.quantity == null || !String(e.quantity).trim()) throw Errors.validation(`第 ${i + 1} 条:科目 ${e.accountId} 为数量型科目,数量不能为空`);
      parsed.push({ orgId: e.orgId, accountId: e.accountId, amountCents: 0, quantity: quantityStringToScaled(e.quantity), memo: e.memo ?? '' });
    } else {
      if (e.amount == null || !String(e.amount).trim()) throw Errors.validation(`第 ${i + 1} 条:科目 ${e.accountId} 为金额科目,金额不能为空`);
      parsed.push({ orgId: e.orgId, accountId: e.accountId, amountCents: displayToSignedCents(e.amount, type), quantity: null, memo: e.memo ?? '' });
    }
  }
  const isNonZero = (p: { amountCents: number; quantity: number | null }) => p.amountCents !== 0 || (p.quantity ?? 0) !== 0;

  // 汇总格备注校验:两侧 ID 必须在当前树内,且至少一侧非叶子
  // (叶子×叶子的备注属于 actual_current.memo,两处同写会造成双份真源)。
  // 批注不产生数值,聚合格没有单一组织口径,不做科目-组织适用范围判定。
  let parsedCellNotes: { orgId: number; accountId: number; memo: string }[] | null = null;
  if (input.cellNotes !== undefined) {
    if (!Array.isArray(input.cellNotes)) throw Errors.validation('cellNotes 必须是数组');
    if (input.history && input.cellNotes.length > 0) throw Errors.validation('历史补录不支持汇总格备注');
    const orgIds = new Set(tree.orgRows.map((r) => r.id));
    const accIds = new Set(tree.accRows.map((r) => r.id));
    const seenNotes = new Set<string>();
    parsedCellNotes = [];
    for (const [i, n] of input.cellNotes.entries()) {
      if (n == null || typeof n !== 'object') throw Errors.validation(`第 ${i + 1} 条汇总格备注必须是对象`);
      const orgId = Number(n.orgId);
      const accountId = Number(n.accountId);
      if (!Number.isSafeInteger(orgId) || orgId <= 0 || !Number.isSafeInteger(accountId) || accountId <= 0) {
        throw Errors.validation(`第 ${i + 1} 条汇总格备注的组织与科目 ID 必须是正整数`);
      }
      const key = `${orgId}:${accountId}`;
      if (seenNotes.has(key)) throw Errors.validation(`第 ${i + 1} 条汇总格备注重复:组织 ${orgId} × 科目 ${accountId}`);
      seenNotes.add(key);
      if (!orgIds.has(orgId)) throw Errors.validation(`第 ${i + 1} 条:组织 ${orgId} 不在当前组织树中`);
      if (!accIds.has(accountId)) throw Errors.validation(`第 ${i + 1} 条:科目 ${accountId} 不在当前科目树中`);
      if (tree.leafOrgs.has(orgId) && tree.leafAccs.has(accountId)) {
        throw Errors.validation(`第 ${i + 1} 条:叶子组织 × 叶子科目的备注请随明细 entries 保存,不属于汇总格备注`);
      }
      if (typeof n.memo !== 'string') throw Errors.validation(`第 ${i + 1} 条汇总格备注必须是字符串`);
      const memo = n.memo.trim();
      if (memo.length > 2000) throw Errors.validation(`第 ${i + 1} 条汇总格备注不能超过 2000 字符`);
      if (memo) parsedCellNotes.push({ orgId, accountId, memo });
    }
  }

  let saved = 0;
  let deleted = 0;
  let cellNotesSaved = 0;
  let cellNotesDeleted = 0;
  let batchId = 0;
  let replayedResult: Omit<ActualSaveResult, 'replayed'> | null = null;
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    // UX-11 回执检查在事务最前:同编号同内容的重试只读回执返回,不再复核基线、不重复写入;
    // 同编号不同内容说明客户端复用了请求编号,必须拒绝(409),防止误判为重试。
    if (requestId) {
      const existing = db.prepare('SELECT * FROM actual_save_receipt WHERE request_id = ?').get(requestId) as ActualSaveReceiptRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw Errors.conflict('该请求编号已提交过内容不同的保存,请生成新的请求编号后重新提交');
        }
        replayedResult = JSON.parse(existing.result_json) as Omit<ActualSaveResult, 'replayed'>;
        return;
      }
    }
    // 年度状态创建/冻结校验移入事务:任一步失败(含校验通过后的写入失败)全部回滚,不留空年度
    const state = ensureYearOpen(db, year);
    if (!input.history && input.mode === 'replace' && input.expectedCurrentBatchId !== undefined
      && state.current_batch_id !== input.expectedCurrentBatchId) {
      throw Errors.conflict('实际数已被其他操作更新，请刷新后重新编辑');
    }
    if (!input.history) assertSnapshotDateNotBeforeCurrent(db, year, snapshotDate);
    if (!input.history) {
      // 3. 更新 actual_current
      if (input.mode === 'replace') {
        const keepKeys = new Set(parsed.filter(isNonZero).map((p) => `${p.orgId}:${p.accountId}`));
        const olds = db.prepare('SELECT id, org_id, account_id FROM actual_current WHERE year = ?').all(year) as { id: number; org_id: number; account_id: number }[];
        if (olds.length > 0 && keepKeys.size === 0 && !input.allowEmptyReplace) {
          throw Errors.conflict('整包保存将清空该年度全部当前实际，必须显式二次确认');
        }
        const del = db.prepare('DELETE FROM actual_current WHERE id = ?');
        for (const o of olds) if (!keepKeys.has(`${o.org_id}:${o.account_id}`)) { del.run(o.id); deleted++; }
      }
      // memo:新值非空一律写入;新值为空时,clearBlankMemos=1(导入明确带空备注列)
      // 才清掉旧备注,否则保留既有备注。注释不能写在 SQL 模板串里(会被当成 SQL 词法错误),
      // 故上移到这里。条件按意图直译:非空覆盖 → clearBlankMemos 清 → 否则保留。
      const upsert = db.prepare(
        `INSERT INTO actual_current (year, org_id, account_id, cumulative_amount_cents, quantity, source, memo, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(year, org_id, account_id) DO UPDATE SET
           cumulative_amount_cents = excluded.cumulative_amount_cents,
           quantity = excluded.quantity,
           source = excluded.source,
           memo = CASE WHEN excluded.memo <> '' THEN excluded.memo WHEN ? = 1 THEN '' ELSE actual_current.memo END,
           updated_at = excluded.updated_at`
      );
      for (const p of parsed) {
        if (!isNonZero(p)) {
          const info = db.prepare('DELETE FROM actual_current WHERE year = ? AND org_id = ? AND account_id = ?').run(year, p.orgId, p.accountId);
          if (info.changes > 0) deleted++;
          continue;
        }
        upsert.run(year, p.orgId, p.accountId, p.amountCents, p.quantity, input.source, p.memo, now, input.clearBlankMemos ? 1 : 0);
        saved++;
      }
      // 汇总格备注与实际数同事务整包替换:未提交的旧备注删除,空备注在解析阶段已剔除。
      // 历史补录不写当前实际,同样不动汇总备注(校验阶段已拒绝非空 cellNotes)。
      if (parsedCellNotes !== null) {
        const keepNoteKeys = new Set(parsedCellNotes.map((p) => `${p.orgId}:${p.accountId}`));
        const oldNotes = db.prepare('SELECT id, org_id, account_id FROM actual_cell_note WHERE year = ?').all(year) as { id: number; org_id: number; account_id: number }[];
        const delNote = db.prepare('DELETE FROM actual_cell_note WHERE id = ?');
        for (const o of oldNotes) {
          if (!keepNoteKeys.has(`${o.org_id}:${o.account_id}`)) { delNote.run(o.id); cellNotesDeleted++; }
        }
        const upsertNote = db.prepare(
          `INSERT INTO actual_cell_note (year, org_id, account_id, memo, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(year, org_id, account_id) DO UPDATE SET
             memo = excluded.memo,
             updated_at = excluded.updated_at`
        );
        for (const p of parsedCellNotes) {
          upsertNote.run(year, p.orgId, p.accountId, p.memo, now);
          cellNotesSaved++;
        }
      }
    }
    // 4. 生成本次绑定树快照；历史增量补录只有在树口径一致时才可与同日快照合并。
    const orgSnap = createOrReuseSnapshot(db, 'org');
    const accSnap = createOrReuseSnapshot(db, 'account');
    // 5. 读取该年度全部当前非零实际。历史 Excel 按组织分文件导入时使用 upsert，
    // 与同日 active 历史快照合并；矩阵手工保存使用 replace，仍表示完整替换。
    let allEntries: { orgId: number; accountId: number; amountCents: number; quantity: number | null }[];
    if (input.history) {
      const merged = new Map<string, { orgId: number; accountId: number; amountCents: number; quantity: number | null }>();
      if (input.mode === 'upsert') {
        const previous = db.prepare(
          `SELECT id, org_tree_snapshot_id, account_tree_snapshot_id
           FROM actual_snapshot_batch
           WHERE year = ? AND snapshot_date = ? AND status = 'active' AND updates_current = 0
           ORDER BY revision DESC, id DESC LIMIT 1`,
        ).get(year, snapshotDate) as { id: number; org_tree_snapshot_id: number; account_tree_snapshot_id: number } | undefined;
        if (previous) {
          if (previous.org_tree_snapshot_id !== orgSnap || previous.account_tree_snapshot_id !== accSnap) {
            throw Errors.conflict('同日历史快照绑定的组织或科目树已变化，不能增量拼接；请改用完整历史矩阵保存');
          }
          const previousEntries = db.prepare(
            'SELECT org_id, account_id, cumulative_amount_cents, quantity FROM actual_snapshot_entry WHERE batch_id = ?',
          ).all(previous.id) as { org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null }[];
          for (const row of previousEntries) {
            merged.set(`${row.org_id}:${row.account_id}`, {
              orgId: row.org_id,
              accountId: row.account_id,
              amountCents: row.cumulative_amount_cents,
              quantity: row.quantity,
            });
          }
        }
      }
      for (const p of parsed) {
        const key = `${p.orgId}:${p.accountId}`;
        if (isNonZero(p)) merged.set(key, { orgId: p.orgId, accountId: p.accountId, amountCents: p.amountCents, quantity: p.quantity });
        else merged.delete(key);
      }
      allEntries = [...merged.values()];
    } else {
      const cur = db.prepare('SELECT org_id, account_id, cumulative_amount_cents, quantity FROM actual_current WHERE year = ?').all(year) as { org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null }[];
      allEntries = cur.map((r) => ({ orgId: r.org_id, accountId: r.account_id, amountCents: r.cumulative_amount_cents, quantity: r.quantity }));
    }
    // 6. 创建批次并全量写入
    // 同日修订号
    const maxRev = db
      .prepare('SELECT MAX(revision) AS r FROM actual_snapshot_batch WHERE year = ? AND snapshot_date = ?')
      .get(year, snapshotDate) as { r: number | null };
    const revision = (maxRev.r ?? 0) + 1;
    // 7. 同日同类别旧 active 快照标记 superseded:当前批次与历史补录互不替代
    db.prepare("UPDATE actual_snapshot_batch SET status = 'superseded' WHERE year = ? AND snapshot_date = ? AND status = 'active' AND updates_current = ?").run(year, snapshotDate, input.history ? 0 : 1);
    const info = db
      .prepare(
        `INSERT INTO actual_snapshot_batch (year, snapshot_date, revision, status, source, org_tree_snapshot_id, account_tree_snapshot_id, updates_current, note, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
      )
      .run(year, snapshotDate, revision, input.history ? 'history_import' : input.source, orgSnap, accSnap, input.history ? 0 : 1, input.note ?? '', now);
    batchId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO actual_snapshot_entry (batch_id, org_id, account_id, cumulative_amount_cents, quantity) VALUES (?, ?, ?, ?, ?)'
    );
    for (const e of allEntries) ins.run(batchId, e.orgId, e.accountId, e.amountCents, e.quantity);
    // 8. 更新年度当前快照
    if (!input.history) {
      db.prepare('UPDATE actual_year_state SET current_batch_id = ?, updated_at = ? WHERE year = ?').run(batchId, now, year);
    }
    // 8.5 UX-11 持久回执:与实际值/快照同事务写入——事务失败时回执一并回滚,不残留成功回执;
    // 回执长期保留以识别旧请求,不随缓存失效而允许再次执行。
    if (requestId) {
      db.prepare(
        'INSERT INTO actual_save_receipt (request_id, request_hash, year, batch_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(requestId, requestHash, year, batchId, JSON.stringify({ batchId, saved, deleted, cellNotesSaved, cellNotesDeleted }), now);
    }
    // 9. 写操作日志
    writeLog(db, input.history ? 'actual.history_import' : input.source === 'excel_import' ? 'actual.import' : 'actual.save', 'actual_year', year, {
      batchId,
      snapshotDate,
      entryCount: allEntries.length,
      saved,
      deleted,
      note: input.note,
      requestId,
    });
  });
  tx();
  // replayedResult 只在事务闭包内赋值,TS 流分析会把它收窄成 null,这里显式恢复声明类型
  if (replayedResult !== null) return { ...(replayedResult as Omit<ActualSaveResult, 'replayed'>), replayed: true };
  return { batchId, saved, deleted, cellNotesSaved, cellNotesDeleted, replayed: false };
}

/** 实际维护界面数据:当前树叶子 + 当前累计值 + 汇总格备注(非叶子单元格批注,不进快照) */
export function getActualMatrix(db: DB, year: number) {
  const tree = currentTreeLeaves(db);
  const state = getYearState(db, year);
  const rows = db.prepare('SELECT * FROM actual_current WHERE year = ?').all(year) as ActualCurrentRow[];
  const cellNoteRows = db.prepare('SELECT org_id, account_id, memo FROM actual_cell_note WHERE year = ?').all(year) as { org_id: number; account_id: number; memo: string }[];
  const currentBatch = state?.current_batch_id
    ? (db.prepare('SELECT * FROM actual_snapshot_batch WHERE id = ?').get(state.current_batch_id) as SnapshotBatchRow | undefined)
    : undefined;
  return {
    yearState: state ?? null,
    currentBatch: currentBatch ?? null,
    orgRows: tree.orgRows,
    accountRows: tree.accRows,
    leafOrgIds: [...tree.leafOrgs],
    leafAccountIds: [...tree.leafAccs],
    activeOrgIds: [...tree.activeOrgs],
    activeAccountIds: [...tree.activeAccs],
    financeOwnedCells: listFinanceOwnedCells(db),
    entries: rows.map((r) => ({
      orgId: r.org_id,
      accountId: r.account_id,
      amountCents: r.cumulative_amount_cents,
      amountDisplay: isQuantityType(tree.typeOf.get(r.account_id)) ? '' : centsToYuanString(r.cumulative_amount_cents * (tree.typeOf.get(r.account_id) === 'income' ? 1 : -1)),
      quantity: r.quantity != null ? scaledToQuantityString(r.quantity) : null,
      source: r.source,
      memo: r.memo,
      updatedAt: r.updated_at,
    })),
    cellNotes: cellNoteRows.map((r) => ({ orgId: r.org_id, accountId: r.account_id, memo: r.memo ?? '' })),
  };
}

export function listBatches(db: DB, year?: number): SnapshotBatchRow[] {
  const sql = year != null
    ? 'SELECT b.*, (SELECT COUNT(*) FROM actual_snapshot_entry e WHERE e.batch_id=b.id) AS entry_count FROM actual_snapshot_batch b WHERE year = ? ORDER BY snapshot_date DESC, revision DESC'
    : 'SELECT b.*, (SELECT COUNT(*) FROM actual_snapshot_entry e WHERE e.batch_id=b.id) AS entry_count FROM actual_snapshot_batch b ORDER BY snapshot_date DESC, revision DESC';
  return (year != null ? db.prepare(sql).all(year) : db.prepare(sql).all()) as SnapshotBatchRow[];
}

export function getBatch(db: DB, batchId: number): SnapshotBatchRow {
  const row = db.prepare('SELECT * FROM actual_snapshot_batch WHERE id = ?').get(batchId) as SnapshotBatchRow | undefined;
  if (!row) throw Errors.notFound('实际快照批次');
  return row;
}

export function getBatchEntries(db: DB, batchId: number): { orgId: number; accountId: number; amountCents: number; quantity: number | null }[] {
  const rows = db
    .prepare('SELECT org_id, account_id, cumulative_amount_cents, quantity FROM actual_snapshot_entry WHERE batch_id = ?')
    .all(batchId) as { org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null }[];
  return rows.map((r) => ({ orgId: r.org_id, accountId: r.account_id, amountCents: r.cumulative_amount_cents, quantity: r.quantity }));
}

/** 删除快照:仅允许删除 superseded 的历史修订(手动清理用) */
export function deleteSupersededBatch(db: DB, batchId: number): void {
  const batch = getBatch(db, batchId);
  if (batch.status !== 'superseded') throw Errors.conflict('只能删除已替代(superseded)的快照修订');
  const state = getYearState(db, batch.year);
  if (state?.final_batch_id === batchId) throw Errors.conflict('该快照是年度最终快照,不能删除');
  db.transaction(() => {
    const entryCount = (db.prepare('SELECT COUNT(*) AS count FROM actual_snapshot_entry WHERE batch_id = ?').get(batchId) as { count: number }).count;
    db.prepare('DELETE FROM actual_snapshot_entry WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM actual_snapshot_batch WHERE id = ?').run(batchId);
    writeLog(db, 'actual.snapshot.delete', 'actual_snapshot_batch', batchId, {
      year: batch.year,
      snapshotDate: batch.snapshot_date,
      revision: batch.revision,
      source: batch.source,
      updatesCurrent: batch.updates_current,
      previousStatus: batch.status,
      entryCount,
    });
  })();
}

/** 加载批次绑定的树(报表用) */
export function batchTrees(db: DB, batch: SnapshotBatchRow): { orgRows: TreeNodeRow[]; accRows: TreeNodeRow[] } {
  return { orgRows: loadSnapshotNodes(db, batch.org_tree_snapshot_id), accRows: loadSnapshotNodes(db, batch.account_tree_snapshot_id) };
}
