import type { DB } from '../src/db/connection';
import { readPolicies, selectLegalTemplate } from '../src/modules/contracts/legal-catalog.service';
import { legalSnapshot } from '../src/modules/contracts/legal-context';
import { saveBusinessSettings } from '../src/modules/settings/business-settings';

/** 既有正向场景的外部审批摘录。缺字段反例单独使用原始请求。 */
export const SIGNATORIES = { ourSignatoryName: '测试法人', ourSignatoryTitle: '法定代表人', ourSignatoryIsLegalRep: true, counterpartySignatoryIsLegalRep: true };
export const PAYMENT_APPROVAL = { approvalTier: 'finance_vp', approverName: '财务副总', approverTitle: '分管财务副总经理' };
export const CHANGE_GOVERNANCE = { changeMatter: '合同条款调整', decisionMethod: 'approval', finalApproverName: '总经理', finalApproverTitle: '总经理', actualApprovalTier: 'management_board' };
export function seedNetAssets(db: DB) {
  const orgs = db.prepare('SELECT id FROM org WHERE parent_id IS NULL').all() as { id: number }[];
  saveBusinessSettings(db, { 'contract.prior_year_net_assets': JSON.stringify(orgs.flatMap(o => [2025, 2026, 2027].map(year => ({ orgId: o.id, year, amount: '10000000000.00' })))) });
}

export function seedCurrentLegalRun(db: DB, contractId: number): number {
  const snap = legalSnapshot(db, contractId);
  if (!snap.doc) throw new Error('missing contract_text document for seedCurrentLegalRun');
  const today = new Date().toISOString().slice(0, 10);
  const allActive = readPolicies(db).filter((p) => p.status === 'active' && p.effectiveFrom <= today);
  const currentPolicies = allActive.filter((p) => !allActive.some((q) => q.code === p.code && q.version > p.version));
  const tpl = selectLegalTemplate(db, snap.c.legal_category);
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO ct_legal_run (
          contract_id, document_id, document_sha256, contract_version, context_fingerprint, policy_refs_json,
          template_id, template_approval_status, parse_channel, parse_status, model_status, verdict, risk_level,
          summary_json, elements_json, stats_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'docx_native', 'ok', 'ok', 'pass', 'low', '[]', '{}', '{}', ?)`,
      )
      .run(
        contractId,
        snap.doc.id,
        snap.doc.sha256,
        snap.c.version,
        snap.fingerprint,
        JSON.stringify(currentPolicies.map((p) => ({ id: p.id, code: p.code, version: p.version }))),
        tpl?.id ?? null,
        tpl?.approvalStatus ?? null,
        now,
      ).lastInsertRowid,
  );
}
