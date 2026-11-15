import crypto from 'node:crypto';
import { currentAuth, type AuthContext } from '../../core/request-context';
import { assertOrgVisible } from '../security/scope';
import type { DB } from '../../db/connection';
import { LEGAL_PRE_REVIEW_EVIDENCE_KINDS, procurementTier } from '../../contracts/contract-legal-review';
import { getSetting } from '../settings/business-settings';
import {
  visibleContract,
  type ContractRow,
} from './contract.service';
export { procurementTier } from '../../contracts/contract-legal-review';

const DEFAULT_LEGAL_REVIEW_CATEGORIES =
  'goods_procurement,small_construction,construction,tech_service,general_service,important_special';

export function legalEnabled(db: DB, c: ContractRow): boolean {
  const configuredRaw = getSetting<string>(db, 'contract.legal_review_categories') || DEFAULT_LEGAL_REVIEW_CATEGORIES;
  const enabledCategories = new Set(
    configuredRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return (
    enabledCategories.has(c.legal_category) ||
    !!Number(c.is_important) ||
    !!db
      .prepare('SELECT 1 FROM ct_legal_run WHERE contract_id=? LIMIT 1')
      .get(c.id) ||
    !!db
      .prepare(
        "SELECT 1 FROM app_job WHERE kind='contract.legal_review' AND json_extract(input_json,'$.contractId')=? LIMIT 1",
      )
      .get(c.id)
  );
}
/** Signing records are completed after review; validate their chronology without changing the review snapshot. */
export function dateSequenceConflict(
  c: Pick<ContractRow, 'sign_date' | 'effective_date'> & Partial<Pick<ContractRow, 'procurement_start_date' | 'supplier_confirm_date'>>,
  text: string,
): boolean {
  if (c.procurement_start_date && c.supplier_confirm_date && c.procurement_start_date > c.supplier_confirm_date) return true;
  if (c.supplier_confirm_date && c.sign_date && c.supplier_confirm_date > c.sign_date) return true;
  if (c.procurement_start_date && c.sign_date && c.procurement_start_date > c.sign_date) return true;
  const dates = [c.sign_date, c.effective_date].filter((d): d is string => !!d);
  const compact = text.normalize('NFKC').replace(/\s+/g, '');
  for (const rx of [
    /(?:交付日期|完工日期|交货日期)[：:]?(\d{4})[-年](\d{1,2})[-月](\d{1,2})/,
    /验收日期[：:]?(\d{4})[-年](\d{1,2})[-月](\d{1,2})/,
    /质保到期[：:]?(\d{4})[-年](\d{1,2})[-月](\d{1,2})/,
  ]) {
    const m = compact.match(rx);
    if (m) dates.push(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  }
  return dates.some((d, i) => i > 0 && d < dates[i - 1]);
}
export function legalSigningDateConflict(db: DB, c: ContractRow): boolean {
  const parsed = db.prepare(`SELECT text_content FROM ct_doc_parse_cache WHERE file_sha256=(
    SELECT f.sha256 FROM ct_document d JOIN file_object f ON f.id=d.file_object_id
    WHERE d.contract_id=? AND d.doc_type='contract_text' AND d.withdrawn_at IS NULL ORDER BY d.id DESC LIMIT 1
  ) ORDER BY id DESC LIMIT 1`).get(c.id) as { text_content: string } | undefined;
  return dateSequenceConflict(c, parsed?.text_content ?? '');
}
export function legalSnapshot(
  db: DB,
  id: number,
  auth: AuthContext | undefined = currentAuth(),
) {
  const c = visibleContract(db, id);
  if (auth) assertOrgVisible(db, auth, c.org_id, '合同');
  const doc = db
    .prepare(
      "SELECT d.id,d.name,f.sha256,f.original_name FROM ct_document d JOIN file_object f ON f.id=d.file_object_id WHERE d.contract_id=? AND d.doc_type='contract_text' AND d.withdrawn_at IS NULL ORDER BY d.id DESC LIMIT 1",
    )
    .get(id) as
    | { id: number; name: string; sha256: string; original_name: string }
    | undefined;
  const preReviewPlaceholders = LEGAL_PRE_REVIEW_EVIDENCE_KINDS.map(() => '?').join(',');
  const evidence = db
    .prepare(
      `SELECT d.evidence_kind,f.sha256 FROM ct_document d JOIN file_object f ON f.id=d.file_object_id WHERE d.contract_id=? AND d.withdrawn_at IS NULL AND d.evidence_kind IN (${preReviewPlaceholders}) AND d.id=(SELECT MAX(x.id) FROM ct_document x WHERE x.contract_id=d.contract_id AND x.withdrawn_at IS NULL AND x.evidence_kind=d.evidence_kind) ORDER BY d.evidence_kind`,
    )
    .all(id, ...LEGAL_PRE_REVIEW_EVIDENCE_KINDS) as { evidence_kind: string; sha256: string }[];
  const signingAmount = BigInt(c.original_cents);
  const direction = c.direction ?? 'expense';
  const pricingMode = c.pricing_mode ?? 'lump_sum';
  const unitPriceDesc = c.unit_price_desc ?? '';
  const tierAmount = pricingMode === 'unit_price' && signingAmount === 0n && c.estimated_ceiling_cents != null
    ? BigInt(c.estimated_ceiling_cents)
    : signingAmount;
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        doc: doc?.sha256 ?? null,
        amount: signingAmount.toString(),
         ...(direction !== 'expense' ? { direction } : {}),
        ...(pricingMode !== 'lump_sum' ? { pricingMode, unitPriceDesc } : {}),
        category: c.legal_category,
        role: c.party_role,
        entity: c.signing_entity_level,
        procurement: Number(c.is_procurement),
        target: c.procurement_target,
        method: c.procurement_method,
        tier: procurementTier(
          !!Number(c.is_procurement),
          c.procurement_target,
          tierAmount,
          c.procurement_method,
        ),
        important: Number(c.is_important),
        org: c.org_id,
        project: c.project_id,
        supplier: c.supplier_id,
        no: c.contract_no,
        name: c.name,
        evidence,
      }),
    )
    .digest('hex');
  return { c, doc, evidence, fingerprint };
}
