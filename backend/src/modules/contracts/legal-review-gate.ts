import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { legalSnapshot, legalSigningDateConflict } from './legal-context';
import { readPolicies, selectLegalTemplate } from './legal-catalog.service';
export function legalRunCurrent(
  db: DB,
  run: any,
  fingerprint: string,
): boolean {
  if (!run || run.context_fingerprint !== fingerprint) return false;
  const text = db
    .prepare(
      "SELECT MAX(id) AS id FROM ct_document WHERE contract_id=? AND doc_type='contract_text'",
    )
    .get(run.contract_id) as { id: number | null };
  if (text.id !== run.document_id) return false;
  const latest = db
    .prepare('SELECT MAX(id) AS id FROM ct_legal_run WHERE contract_id=?')
    .get(run.contract_id) as { id: number };
  if (latest.id !== run.id) return false;
  const policies = readPolicies(db).filter(
    (p) =>
      p.status === 'active' &&
      p.effectiveFrom <= new Date().toISOString().slice(0, 10),
  );
  const current = policies.filter(
    (p) => !policies.some((q) => q.code === p.code && q.version > p.version),
  );
  const refs = JSON.parse(run.policy_refs_json) as { id: number }[];
  if (
    current.length !== refs.length ||
    current.some((p) => !refs.some((r) => r.id === p.id))
  )
    return false;
  const contract = db
    .prepare('SELECT legal_category FROM ct_contract WHERE id=?')
    .get(run.contract_id) as { legal_category: string } | undefined;
  const selected = contract ? selectLegalTemplate(db, contract.legal_category) : null;
  if (
    (selected?.id ?? null) !== run.template_id ||
    (selected?.approvalStatus ?? null) !== run.template_approval_status
  )
    return false;
  return true;
}
export function currentLegalRun(db: DB, id: number) {
  const s = legalSnapshot(db, id);
  const run = db
    .prepare(
      'SELECT * FROM ct_legal_run WHERE contract_id=? ORDER BY id DESC LIMIT 1',
    )
    .get(id) as any;
  return { snapshot: s, run, current: legalRunCurrent(db, run, s.fingerprint) };
}
export function assertLegalDecision(
  db: DB,
  id: number,
  documentId: number,
  approve: boolean,
  comment?: string,
) {
  const { snapshot, run, current } = currentLegalRun(db, id);
  if (!approve) {
    const historical = db
      .prepare(
        'SELECT id FROM ct_legal_run WHERE contract_id=? AND document_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(id, documentId) as { id: number } | undefined;
    return { runId: historical?.id ?? null, override: false };
  }
  if (
    !current ||
    !run ||
    run.document_id !== documentId ||
    snapshot.doc?.id !== documentId
  )
    throw new AppError(
      'LEGAL_REVIEW_STALE',
      '法审缺失或已失效，请重新运行法审',
      409,
    );
  let override = false;
  if (approve) {
    if (legalSigningDateConflict(db, snapshot.c))
      throw new AppError('LEGAL_REVIEW_BLOCKED', '签订、生效及履行日期顺序冲突，请先更正日期', 409);
    const blocking = db
      .prepare(
        'SELECT 1 FROM ct_legal_finding WHERE run_id=? AND blocking=1 LIMIT 1',
      )
      .get(run.id);
    if (blocking || run.verdict === 'revise')
      throw new AppError(
        'LEGAL_REVIEW_BLOCKED',
        '存在必须修改或补充的事项，请退回后重新法审',
        409,
      );
    if (run.verdict !== 'pass' || run.risk_level === 'high') {
      if (!comment?.trim())
        throw new AppError(
          'LEGAL_REVIEW_COMMENT_REQUIRED',
          '请展开原文核验并填写人工审查说明',
          400,
        );
      override = true;
    }
  }
  return { runId: run.id as number, override };
}
