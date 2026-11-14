import type { DB } from '../../db/connection';
import type { EvidenceKind } from '../../contracts/contract-legal-review';
import type { ContractRow } from './contract.service';
import { AppError } from '../../core/errors';
import { getSetting } from '../settings/business-settings';

const blocked = (code: string, message: string) => new AppError(code, message, 409);

/** 指定用途的依据同时核验合同归属与分类，不能把任意附件当作审批凭据。 */
export function requireEvidence(db: DB, contractId: number, documentId: number | null | undefined, kinds: EvidenceKind[], changeId: number | null = null): number {
  const d = documentId ? db.prepare('SELECT id, evidence_kind, change_id FROM ct_document WHERE id = ? AND contract_id = ?').get(documentId, contractId) as { id: number; evidence_kind: EvidenceKind; change_id: number | null } | undefined : undefined;
  if (!d || !kinds.includes(d.evidence_kind) || (d.change_id !== null && d.change_id !== changeId)) throw blocked('EVIDENCE_REQUIRED', `须选择本合同对应分类的依据附件（${kinds.join(' / ')}）`);
  return d.id;
}

export function contractHasWarranty(db: DB, c: Pick<ContractRow, 'id' | 'has_warranty' | 'warranty_months' | 'warranty_retention_ratio_scaled'>): boolean {
  return !!c.has_warranty || (c.warranty_months ?? 0) > 0 || BigInt(c.warranty_retention_ratio_scaled ?? 0n) > 0n ||
    !!db.prepare(`SELECT 1 FROM ct_warranty WHERE contract_id = ? UNION ALL
      SELECT 1 FROM ct_settlement WHERE contract_id = ? AND status = 'approved' AND deduct_retention_cents > 0 LIMIT 1`).get(c.id, c.id);
}

export function assertWarrantyReleased(db: DB, contractId: number, asOf = new Date().toISOString().slice(0, 10)): void {
  const w = db.prepare('SELECT start_date, end_date, inspection_date, inspection_conclusion, visa_document_id, reviewed_at, defect_records_json FROM ct_warranty WHERE contract_id = ?').get(contractId) as {
    start_date: string | null; end_date: string | null; inspection_date: string | null;
    inspection_conclusion: string | null; visa_document_id: number | null; reviewed_at: string | null; defect_records_json: string;
  } | undefined;
  if (!w || !w.start_date || !w.end_date || !w.inspection_date || w.inspection_conclusion !== 'passed' || !w.reviewed_at) {
    throw blocked('WARRANTY_VISA_REQUIRED', '须登记完整质保起止日期、期满验收通过及复核签证记录');
  }
  if (w.start_date > w.end_date || w.end_date > asOf || w.inspection_date < w.end_date || w.inspection_date > asOf) {
    throw blocked('WARRANTY_NOT_EXPIRED', '质保尚未到期，或验收日期早于期满/晚于实际日期');
  }
  if ((JSON.parse(w.defect_records_json) as { resolved: boolean }[]).some(d => !d.resolved)) throw blocked('WARRANTY_DEFECTS_OPEN', '质保缺陷尚未全部处理');
  requireEvidence(db, contractId, w.visa_document_id, ['warranty_release_visa']);
}

/** 公司名义签约归顶级法人；二级法人按管理员明确配置的祖先节点划界，未配置时从严归顶级。 */
export function legalEntityOrgId(db: DB, orgId: number, signingLevel?: string): number {
  const chain = db.prepare(`WITH RECURSIVE ancestors(id, parent_id, depth) AS (
    SELECT id, parent_id, 0 FROM org WHERE id = ? UNION ALL
    SELECT o.id, o.parent_id, a.depth + 1 FROM org o JOIN ancestors a ON o.id = a.parent_id
  ) SELECT id FROM ancestors ORDER BY depth`).all(orgId) as { id: number }[];
  if (!chain.length) throw blocked('ORG_REQUIRED', '合同组织不存在');
  const declared = new Set(getSetting<string>(db, 'contract.legal_entity_org_ids').split(',').filter(Boolean).map(Number));
  return (signingLevel === 'company' ? undefined : chain.find(o => declared.has(o.id))?.id) ?? chain[chain.length - 1].id;
}

export function orgReportPath(db: DB, orgId: number): string {
  const rows = db.prepare(`WITH RECURSIVE ancestors(id, parent_id, name, report_full_name, depth) AS (
    SELECT id, parent_id, name, report_full_name, 0 FROM org WHERE id = ? UNION ALL
    SELECT o.id, o.parent_id, o.name, o.report_full_name, a.depth + 1 FROM org o JOIN ancestors a ON o.id = a.parent_id
  ) SELECT name, report_full_name FROM ancestors ORDER BY depth DESC`).all(orgId) as { name: string; report_full_name: string | null }[];
  let path = '';
  for (const r of rows) path = r.report_full_name?.trim() || [path, r.name].filter(Boolean).join('/');
  return path;
}

export function reportPeriod(period?: string): string {
  if (period === undefined) return new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError('VALIDATION_FAILED', '期间须为有效 YYYY-MM 月份', 400);
  return period;
}
