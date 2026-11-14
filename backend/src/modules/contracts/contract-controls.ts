import type { DB } from '../../db/connection';
import type { EvidenceKind } from '../../contracts/contract-legal-review';
import type { ContractRow } from './contract.service';
import { AppError } from '../../core/errors';
import { getSetting } from '../settings/business-settings';
import { hasPrefixMapSeeded } from './prefix-map.service';

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

export interface SixDimOrgResolution {
  signingOrgId: number;
  signingSubjectOrgId: number;
  legalEntityOrgId: number;
  historicalLegalEntityOrgId: number | null;
}

interface AncestorOrgRow {
  id: number;
  parent_id: number | null;
  org_kind: string;
  contract_prefix_code: string;
  depth: number;
}

function queryOrgChain(db: DB, orgId: number): AncestorOrgRow[] {
  return db.prepare(`WITH RECURSIVE ancestors(id, parent_id, org_kind, contract_prefix_code, depth) AS (
    SELECT id, parent_id, org_kind, contract_prefix_code, 0 FROM org WHERE id = ? UNION ALL
    SELECT o.id, o.parent_id, o.org_kind, o.contract_prefix_code, a.depth + 1 FROM org o JOIN ancestors a ON o.id = a.parent_id
  ) SELECT id, parent_id, org_kind, contract_prefix_code, depth FROM ancestors ORDER BY depth ASC`).all(orgId) as AncestorOrgRow[];
}

/**
 * 六维签约名义与历史承接法人推导：
 * - 显式指定 signingSubjectOrgId 时：若指向母公司/本部部门/直属非法人则绑定顶级母公司 LS；若指向独立子法人则绑定该子法人；
 * - closed_history 历史关停主体：冻结 historicalLegalEntityOrgId = signingOrgId，现行口径指向 successor_org_id / 上级存续法人；
 * - 本部部门(hq_dept)与直属非法人分支(direct_unit: JD/ZD/SX)固定归顶级母公司 LS；
 * - 分子公司以自身名义签约(secondary_unit 或前缀归属该子法人且未显式指定母公司签章)归该分子公司，以集团本级名义签约归顶级母公司。
 */
export function deriveContractSixDim(
  db: DB,
  params: {
    orgId: number;
    signingOrgId?: number | null;
    signingSubjectOrgId?: number | null;
    signingLevel?: string | null;
    prefixLegalEntityOrgId?: number | null;
    prefixSuccessorOrgId?: number | null;
  },
): SixDimOrgResolution {
  const chain = queryOrgChain(db, params.orgId);
  if (!chain.length) throw blocked('ORG_REQUIRED', '合同组织不存在');
  const root = chain[chain.length - 1];
  const org = chain[0];
  const signingOrgId = params.signingOrgId ?? org.id;
  const signingChain = signingOrgId === org.id ? chain : queryOrgChain(db, signingOrgId);
  const signingNode = signingChain[0] ?? org;

  if (signingNode.org_kind === 'closed_history') {
    const mapRow = db
      .prepare('SELECT legal_entity_org_id, successor_org_id FROM ct_prefix_org_map WHERE signing_org_id = ? ORDER BY id ASC LIMIT 1')
      .get(signingOrgId) as { legal_entity_org_id: number | null; successor_org_id: number | null } | undefined;
    const successor =
      params.prefixSuccessorOrgId ??
      mapRow?.successor_org_id ??
      params.prefixLegalEntityOrgId ??
      mapRow?.legal_entity_org_id ??
      signingChain.find((o) => o.org_kind === 'legal_entity')?.id ??
      root.id;
    return {
      signingOrgId,
      signingSubjectOrgId: signingOrgId,
      legalEntityOrgId: successor,
      historicalLegalEntityOrgId: signingOrgId,
    };
  }

  if (params.signingSubjectOrgId != null) {
    const subjChain = queryOrgChain(db, params.signingSubjectOrgId);
    if (!subjChain.length) throw blocked('ORG_REQUIRED', '对外签约名义组织不存在');
    const subj = subjChain[0];
    const legalId =
      subj.id === root.id || subj.org_kind === 'hq_dept' || subj.org_kind === 'direct_unit'
        ? root.id
        : (subjChain.find((o) => o.org_kind === 'legal_entity')?.id ?? root.id);
    return {
      signingOrgId,
      signingSubjectOrgId: subj.id,
      legalEntityOrgId: legalId,
      historicalLegalEntityOrgId: null,
    };
  }

  if (org.org_kind === 'hq_dept' || org.org_kind === 'direct_unit') {
    return {
      signingOrgId,
      signingSubjectOrgId: root.id,
      legalEntityOrgId: root.id,
      historicalLegalEntityOrgId: null,
    };
  }

  const declared = new Set(
    getSetting<string>(db, 'contract.legal_entity_org_ids')
      .split(',')
      .filter(Boolean)
      .map(Number),
  );
  const prefixSeeded = hasPrefixMapSeeded(db) || org.contract_prefix_code !== '';

  if (params.signingLevel === 'company') {
    // 若前缀明确归属某存续独立子法人且承办组织即该子法人（或其下属），绑定该子法人；否则以集团母公司名义归顶级法人
    if (
      prefixSeeded &&
      params.prefixLegalEntityOrgId != null &&
      params.prefixLegalEntityOrgId !== root.id &&
      chain.some((o) => o.id === params.prefixLegalEntityOrgId)
    ) {
      return {
        signingOrgId,
        signingSubjectOrgId: params.prefixLegalEntityOrgId,
        legalEntityOrgId: params.prefixLegalEntityOrgId,
        historicalLegalEntityOrgId: null,
      };
    }
    return {
      signingOrgId,
      signingSubjectOrgId: root.id,
      legalEntityOrgId: root.id,
      historicalLegalEntityOrgId: null,
    };
  }

  const nearestDeclared = chain.find((o) => declared.has(o.id))?.id;
  const nearestV73Legal = prefixSeeded ? chain.find((o) => o.org_kind === 'legal_entity')?.id : undefined;
  const resolvedLegal = nearestDeclared ?? nearestV73Legal ?? root.id;
  return {
    signingOrgId,
    signingSubjectOrgId: resolvedLegal,
    legalEntityOrgId: resolvedLegal,
    historicalLegalEntityOrgId: null,
  };
}

/** 公司名义签约归顶级法人；二级法人按管理员配置或 V73 法人树节点划界，存在已冻结法人时优先使用冻结值。 */
export function legalEntityOrgId(
  db: DB,
  orgId: number,
  signingLevel?: string,
  opts?: { signingSubjectOrgId?: number | null; frozenLegalEntityOrgId?: number | null },
): number {
  if (opts?.frozenLegalEntityOrgId != null && hasPrefixMapSeeded(db)) {
    return opts.frozenLegalEntityOrgId;
  }
  return deriveContractSixDim(db, {
    orgId,
    signingSubjectOrgId: opts?.signingSubjectOrgId ?? null,
    signingLevel: signingLevel ?? null,
  }).legalEntityOrgId;
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
