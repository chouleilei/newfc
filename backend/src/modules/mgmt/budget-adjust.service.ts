/**
 * 预算调整(AC-F14):针对当前采用的已锁经营预算的一个叶子单元格,提交 → 复核 → 生效。
 *
 * 生效在一个事务里完成:复制源版本为新草稿 → 写入调整后金额 → 锁定 → 设为当前版本(期望当前版本仍是源版本)。
 * 原版本不变;任何一步失败整笔回滚。复核需要 budget:finalize,提交人 ≠ 复核人。
 */
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { displayToSignedCents, signedCentsToDisplay } from '../../core/money';
import { computeLeafIds } from '../../core/tree';
import { isAccountVisibleForScope } from '../../core/accountScope';
import { writeLog } from '../audit/log';
import { notVisible, orgInScope } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import { loadSnapshotNodes } from '../tree/snapshot';
import { copyVersion, getVersion, lockVersion, setCurrentVersion } from '../budget/budget.service';
import type { MaBudgetAdjustmentCreate, MaBudgetAdjustmentDto, MaReviewRequest } from '../../contracts/mgmt';
import { assertOrgInScope, conflict, currentUserId, nowIso, orgName, scope } from './common';

interface AdjRow {
  id: number; source_version_id: number; org_id: number; account_id: number; before_cents: number; after_cents: number; reason: string;
  status: MaBudgetAdjustmentDto['status']; new_version_id: number | null; submitted_by_user_id: number | null; submitted_at: string;
  reviewed_by_user_id: number | null; reviewed_at: string | null; review_comment: string | null; exception_reason: string | null; self_review: number;
}

type MoneyType = 'income' | 'cost' | 'expense';

function accountOf(db: DB, id: number): { code: string; name: string; type: string } {
  return db.prepare('SELECT code, name, type FROM account WHERE id = ?').get(id) as { code: string; name: string; type: string };
}

function dto(db: DB, r: AdjRow): MaBudgetAdjustmentDto {
  const v = getVersion(db, r.source_version_id);
  const acc = accountOf(db, r.account_id);
  const type = acc.type as MoneyType;
  return {
    id: r.id, sourceVersionId: r.source_version_id, sourceVersionName: v.name, year: v.year, orgId: r.org_id, orgName: orgName(db, r.org_id),
    accountId: r.account_id, accountCode: acc.code, accountName: acc.name,
    beforeAmount: signedCentsToDisplay(r.before_cents, type), afterAmount: signedCentsToDisplay(r.after_cents, type),
    reason: r.reason, status: r.status, newVersionId: r.new_version_id, submittedByUserId: r.submitted_by_user_id, submittedAt: r.submitted_at,
    reviewedByUserId: r.reviewed_by_user_id, reviewedAt: r.reviewed_at, reviewComment: r.review_comment, exceptionReason: r.exception_reason, selfReview: r.self_review === 1,
  };
}

function getRow(db: DB, id: number): AdjRow {
  const r = db.prepare('SELECT * FROM ma_budget_adjustment WHERE id = ?').get(id) as AdjRow | undefined;
  if (!r || !orgInScope(scope(db), r.org_id)) throw notVisible('预算调整');
  return r;
}

function currentBudget(db: DB, versionId: number) {
  const v = getVersion(db, versionId);
  if (v.kind !== 'budget' || v.status !== 'locked' || v.is_current !== 1) {
    throw conflict('BUDGET_VERSION_NOT_CURRENT', '只能调整当前采用且已锁定的经营预算版本');
  }
  return v;
}

export function submitBudgetAdjustment(db: DB, input: MaBudgetAdjustmentCreate): MaBudgetAdjustmentDto {
  assertOrgInScope(db, input.orgId);
  const id = db.transaction(() => {
    const v = currentBudget(db, input.versionId);
    const orgRows = loadSnapshotNodes(db, v.org_tree_snapshot_id);
    const accRows = loadSnapshotNodes(db, v.account_tree_snapshot_id);
    if (!computeLeafIds(orgRows).has(input.orgId)) throw Errors.validation('只能调整预算版本组织树中的叶子组织');
    if (!computeLeafIds(accRows).has(input.accountId)) throw Errors.validation('只能调整预算版本科目树中的叶子科目');
    const acc = accRows.find((a) => a.id === input.accountId)!;
    const org = orgRows.find((o) => o.id === input.orgId)!;
    if (!acc.type || acc.type === 'quantity') throw Errors.validation('数量科目不能做金额调整');
    if (!isAccountVisibleForScope(acc.code, new Set([org.code]))) throw Errors.validation(`科目 ${acc.code} 不适用于组织 ${org.code}`);
    const before = (db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id = ? AND org_id = ? AND account_id = ?').get(v.id, input.orgId, input.accountId) as { amount_cents: number } | undefined)?.amount_cents ?? 0;
    const after = displayToSignedCents(input.amount, acc.type as MoneyType);
    if (after === before) throw Errors.validation('调整后金额与当前金额相同');
    if (db.prepare("SELECT 1 FROM ma_budget_adjustment WHERE source_version_id = ? AND org_id = ? AND account_id = ? AND status = 'pending'").get(v.id, input.orgId, input.accountId)) {
      throw conflict('MGMT_ADJUSTMENT_PENDING', '该单元格已有待复核的预算调整');
    }
    const info = db.prepare(`INSERT INTO ma_budget_adjustment (source_version_id, org_id, account_id, before_cents, after_cents, reason, submitted_by_user_id, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(v.id, input.orgId, input.accountId, before, after, input.reason, currentUserId(), nowIso());
    const newId = Number(info.lastInsertRowid);
    writeLog(db, 'mgmt.budget_adjustment.submit', 'ma_budget_adjustment', newId, { versionId: v.id, orgId: input.orgId, accountId: input.accountId, beforeCents: before, afterCents: after, reason: input.reason });
    return newId;
  }).immediate();
  return dto(db, getRow(db, id));
}

export function getBudgetAdjustment(db: DB, id: number): MaBudgetAdjustmentDto {
  return dto(db, getRow(db, id));
}

export function listBudgetAdjustments(db: DB, q: { status?: string } = {}): MaBudgetAdjustmentDto[] {
  const s = scope(db);
  const rows = (q.status
    ? db.prepare('SELECT * FROM ma_budget_adjustment WHERE status = ? ORDER BY id DESC LIMIT 500').all(q.status)
    : db.prepare('SELECT * FROM ma_budget_adjustment ORDER BY id DESC LIMIT 500').all()) as AdjRow[];
  return rows.filter((r) => orgInScope(s, r.org_id)).map((r) => dto(db, r));
}

export function reviewBudgetAdjustment(db: DB, id: number, input: MaReviewRequest): MaBudgetAdjustmentDto {
  db.transaction(() => {
    const r = getRow(db, id);
    if (r.status !== 'pending') throw conflict('MGMT_ALREADY_REVIEWED', '该预算调整已处理,不能重复复核');
    const { selfReview } = assertDistinctReviewer(db, currentAuth(), r.submitted_by_user_id, input.exceptionReason, '预算调整');
    const now = nowIso();
    let newVersionId: number | null = null;
    if (input.action === 'approve') {
      const src = currentBudget(db, r.source_version_id);
      const draft = copyVersion(db, src.id, `${src.name}-调整${id}`, `预算调整 #${id}:${r.reason}`);
      newVersionId = draft.id;
      db.prepare(`INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, quantity, formula, note, updated_at) VALUES (?, ?, ?, ?, NULL, '', ?, ?)
        ON CONFLICT(version_id, org_id, account_id) DO UPDATE SET amount_cents = excluded.amount_cents, formula = '', updated_at = excluded.updated_at`)
        .run(draft.id, r.org_id, r.account_id, r.after_cents, `预算调整 #${id}`, now);
      db.prepare('UPDATE budget_version SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, draft.id);
      const bumped = getVersion(db, draft.id);
      lockVersion(db, draft.id, { expectedRevision: bumped.revision });
      setCurrentVersion(db, draft.id, { expectedCurrentVersionId: src.id });
    }
    db.prepare(`UPDATE ma_budget_adjustment SET status = ?, new_version_id = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ? WHERE id = ?`)
      .run(input.action === 'approve' ? 'effective' : 'rejected', newVersionId, currentUserId(), now, input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, id);
    writeLog(db, 'mgmt.budget_adjustment.review', 'ma_budget_adjustment', id, { action: input.action, newVersionId, selfReview, exceptionReason: input.exceptionReason, comment: input.comment });
  }).immediate();
  return dto(db, getRow(db, id));
}
