import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import type {
  ContractNextNoDto,
  ContractPrefixMapCreateRequest,
  ContractPrefixMapDto,
  ContractPrefixMapPatchRequest,
  PrefixEntityStatus,
  PrefixKind,
} from '../../contracts/contract-lifecycle';
import type { LegalCategory } from '../../contracts/contract-legal-review';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);

export const ALLOWED_YY_CODES = ['JG', 'SG', 'SJ', 'CW', 'TH', 'XF', 'QT'] as const;
export type ContractYyCode = (typeof ALLOWED_YY_CODES)[number];

export interface PrefixMapRow {
  id: number;
  raw_prefix: string;
  canonical_prefix: string;
  legal_entity_org_id: number | null;
  signing_org_id: number | null;
  successor_org_id: number | null;
  effective_from: string | null;
  effective_to: string | null;
  parent_canonical_prefix: string;
  entity_status: PrefixEntityStatus;
  allow_new_contract: number;
  prefix_kind: PrefixKind;
  sample_contract_no: string;
  occurrence_count: number;
  note: string;
  created_at: string;
  updated_at: string;
  legal_entity_org_name?: string | null;
  signing_org_name?: string | null;
  successor_org_name?: string | null;
}

function toDto(r: PrefixMapRow): ContractPrefixMapDto {
  return {
    id: r.id,
    rawPrefix: r.raw_prefix,
    canonicalPrefix: r.canonical_prefix,
    legalEntityOrgId: r.legal_entity_org_id,
    legalEntityOrgName: r.legal_entity_org_name ?? null,
    signingOrgId: r.signing_org_id,
    signingOrgName: r.signing_org_name ?? null,
    successorOrgId: r.successor_org_id,
    successorOrgName: r.successor_org_name ?? null,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    parentCanonicalPrefix: r.parent_canonical_prefix,
    entityStatus: r.entity_status,
    allowNewContract: r.allow_new_contract === 1,
    prefixKind: r.prefix_kind,
    sampleContractNo: r.sample_contract_no,
    occurrenceCount: r.occurrence_count,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const BASE_SELECT = `
  SELECT m.*,
    le.name AS legal_entity_org_name,
    so.name AS signing_org_name,
    su.name AS successor_org_name
  FROM ct_prefix_org_map m
  LEFT JOIN org le ON le.id = m.legal_entity_org_id
  LEFT JOIN org so ON so.id = m.signing_org_id
  LEFT JOIN org su ON su.id = m.successor_org_id
`;

export function listPrefixMaps(
  db: DB,
  filter: { keyword?: string; entityStatus?: PrefixEntityStatus; allowNewOnly?: boolean } = {},
): ContractPrefixMapDto[] {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (filter.entityStatus) {
    where.push('m.entity_status = ?');
    params.push(filter.entityStatus);
  }
  if (filter.allowNewOnly) {
    where.push('m.allow_new_contract = 1');
  }
  if (filter.keyword?.trim()) {
    const kw = `%${filter.keyword.trim().replace(/[%_]/g, '')}%`;
    where.push('(m.raw_prefix LIKE ? OR m.canonical_prefix LIKE ? OR COALESCE(le.name, \'\') LIKE ? OR COALESCE(so.name, \'\') LIKE ? OR m.note LIKE ?)');
    params.push(kw, kw, kw, kw, kw);
  }
  const rows = db
    .prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.allow_new_contract DESC, m.occurrence_count DESC, m.id ASC`)
    .all(...params) as PrefixMapRow[];
  return rows.map(toDto);
}

function assertOrgRef(db: DB, orgId: number | null | undefined, label: string, requireLegal = false): number | null {
  if (orgId == null) return null;
  const row = db.prepare('SELECT id, org_kind FROM org WHERE id = ?').get(orgId) as { id: number; org_kind: string } | undefined;
  if (!row) throw Errors.validation(`${label}组织不存在`);
  if (requireLegal && row.org_kind !== 'legal_entity') {
    throw Errors.validation(`${label}必须选择独立法人（legal_entity）`);
  }
  return row.id;
}

export function createPrefixMap(db: DB, input: ContractPrefixMapCreateRequest): ContractPrefixMapDto {
  const rawPrefix = input.rawPrefix.normalize('NFKC').trim().toUpperCase();
  const canonicalPrefix = input.canonicalPrefix.normalize('NFKC').trim().toUpperCase();
  if (db.prepare('SELECT 1 FROM ct_prefix_org_map WHERE raw_prefix = ?').get(rawPrefix)) {
    throw conflict('PREFIX_MAP_EXISTS', `实账前缀 ${rawPrefix} 已存在`);
  }
  const legalId = assertOrgRef(db, input.legalEntityOrgId, '法定法人主体', true);
  if (!['external', 'ignore'].includes(input.entityStatus) && legalId === null) {
    throw Errors.validation('非外部/忽略类前缀必须指定法定法人主体');
  }
  if (['external', 'ignore', 'closed_history', 'inherited_child'].includes(input.entityStatus) && input.allowNewContract) {
    throw Errors.validation(`主体状态为 ${input.entityStatus} 的前缀不允许开启新签`);
  }
  const signingId = assertOrgRef(db, input.signingOrgId, '实际签约主体');
  const successorId = assertOrgRef(
    db,
    input.successorOrgId ?? (input.entityStatus === 'closed_history' ? legalId : null),
    '现行承接法人',
    true,
  );
  const now = nowIso();
  const id = Number(
    db
      .prepare(
        `INSERT INTO ct_prefix_org_map (
          raw_prefix, canonical_prefix, legal_entity_org_id, signing_org_id, successor_org_id,
          effective_from, effective_to, parent_canonical_prefix, entity_status, allow_new_contract,
          prefix_kind, sample_contract_no, occurrence_count, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rawPrefix,
        canonicalPrefix,
        legalId,
        signingId,
        successorId,
        input.effectiveFrom ?? null,
        input.effectiveTo ?? null,
        (input.parentCanonicalPrefix ?? '').trim().toUpperCase(),
        input.entityStatus,
        input.allowNewContract ? 1 : 0,
        input.prefixKind,
        input.sampleContractNo ?? '',
        input.occurrenceCount ?? 0,
        input.note ?? '',
        now,
        now,
      ).lastInsertRowid,
  );
  writeLog(db, 'contract.prefix_map.create', 'ct_prefix_org_map', id, { rawPrefix, canonicalPrefix, entityStatus: input.entityStatus });
  const created = db.prepare(`${BASE_SELECT} WHERE m.id = ?`).get(id) as PrefixMapRow;
  return toDto(created);
}

export function patchPrefixMap(db: DB, id: number, input: ContractPrefixMapPatchRequest): ContractPrefixMapDto {
  const cur = db.prepare('SELECT * FROM ct_prefix_org_map WHERE id = ?').get(id) as PrefixMapRow | undefined;
  if (!cur) throw new AppError('NOT_FOUND', '前缀映射不存在', 404);
  const rawPrefix = input.rawPrefix !== undefined ? input.rawPrefix.normalize('NFKC').trim().toUpperCase() : cur.raw_prefix;
  if (rawPrefix !== cur.raw_prefix && db.prepare('SELECT 1 FROM ct_prefix_org_map WHERE raw_prefix = ? AND id <> ?').get(rawPrefix, id)) {
    throw conflict('PREFIX_MAP_EXISTS', `实账前缀 ${rawPrefix} 已存在`);
  }
  const canonicalPrefix = input.canonicalPrefix !== undefined ? input.canonicalPrefix.normalize('NFKC').trim().toUpperCase() : cur.canonical_prefix;
  const entityStatus = input.entityStatus ?? cur.entity_status;
  const allowNew = input.allowNewContract !== undefined ? input.allowNewContract : cur.allow_new_contract === 1;
  const legalId = input.legalEntityOrgId !== undefined
    ? assertOrgRef(db, input.legalEntityOrgId, '法定法人主体', true)
    : cur.legal_entity_org_id;
  if (!['external', 'ignore'].includes(entityStatus) && legalId === null) {
    throw Errors.validation('非外部/忽略类前缀必须指定法定法人主体');
  }
  if (['external', 'ignore', 'closed_history', 'inherited_child'].includes(entityStatus) && allowNew) {
    throw Errors.validation(`主体状态为 ${entityStatus} 的前缀不允许开启新签`);
  }
  const signingId = input.signingOrgId !== undefined ? assertOrgRef(db, input.signingOrgId, '实际签约主体') : cur.signing_org_id;
  const successorId = input.successorOrgId !== undefined
    ? assertOrgRef(db, input.successorOrgId, '现行承接法人', true)
    : cur.successor_org_id;
  const now = nowIso();
  db.prepare(
    `UPDATE ct_prefix_org_map SET
      raw_prefix = ?, canonical_prefix = ?, legal_entity_org_id = ?, signing_org_id = ?, successor_org_id = ?,
      effective_from = ?, effective_to = ?, parent_canonical_prefix = ?, entity_status = ?, allow_new_contract = ?,
      prefix_kind = ?, sample_contract_no = ?, occurrence_count = ?, note = ?, updated_at = ?
    WHERE id = ?`,
  ).run(
    rawPrefix,
    canonicalPrefix,
    legalId,
    signingId,
    successorId,
    input.effectiveFrom !== undefined ? input.effectiveFrom : cur.effective_from,
    input.effectiveTo !== undefined ? input.effectiveTo : cur.effective_to,
    input.parentCanonicalPrefix !== undefined ? input.parentCanonicalPrefix.trim().toUpperCase() : cur.parent_canonical_prefix,
    entityStatus,
    allowNew ? 1 : 0,
    input.prefixKind ?? cur.prefix_kind,
    input.sampleContractNo !== undefined ? input.sampleContractNo : cur.sample_contract_no,
    input.occurrenceCount !== undefined ? input.occurrenceCount : cur.occurrence_count,
    input.note !== undefined ? input.note : cur.note,
    now,
    id,
  );
  writeLog(db, 'contract.prefix_map.update', 'ct_prefix_org_map', id, { rawPrefix, canonicalPrefix, entityStatus, allowNew });
  const updated = db.prepare(`${BASE_SELECT} WHERE m.id = ?`).get(id) as PrefixMapRow;
  return toDto(updated);
}

/** 动态读取允许新签的规范前缀集合；若库未初始化前缀字典则返回空数组。 */
export function getAllowedNewContractPrefixes(db: DB): string[] {
  const rows = db
    .prepare('SELECT raw_prefix FROM ct_prefix_org_map WHERE allow_new_contract = 1 ORDER BY length(raw_prefix) DESC, raw_prefix ASC')
    .all() as { raw_prefix: string }[];
  return rows.map((r) => r.raw_prefix);
}

export function hasPrefixMapSeeded(db: DB): boolean {
  return !!db.prepare('SELECT 1 FROM ct_prefix_org_map LIMIT 1').get();
}

export interface PrefixMatchResult {
  row: PrefixMapRow;
  matchedToken: string;
  cleanedContractNo: string;
  hadRolePrefix: boolean;
}

/**
 * 按 P1(外部冲突抢占/长前缀) -> P2(角色/笔误清洗) -> P3(内部长前缀优先) 匹配合同编号前缀。
 */
export function matchContractPrefix(db: DB, rawContractNo: string): PrefixMatchResult | null {
  const all = db.prepare('SELECT * FROM ct_prefix_org_map').all() as PrefixMapRow[];
  if (!all.length) return null;
  let cleaned = rawContractNo.normalize('NFKC').replace(/\s+/g, '').trim();
  if (!cleaned) return null;
  cleaned = cleaned.replace(/合同$/u, '');
  const upper = cleaned.toUpperCase();
  const hadRolePrefix = upper.startsWith('乙方');

  // 展开带斜杠的多前缀配置（如 HTC/CTC、NKY/NYK、SZ/GJ/HY）并按长度降序排列
  const candidates: { token: string; row: PrefixMapRow }[] = [];
  for (const row of all) {
    if (row.entity_status === 'ignore') continue;
    const rp = row.raw_prefix.normalize('NFKC').toUpperCase();
    if (rp.includes('/') && !rp.includes('(')) {
      for (const part of rp.split('/').map((s) => s.trim()).filter(Boolean)) {
        candidates.push({ token: part, row });
      }
    } else {
      candidates.push({ token: rp, row });
    }
    if (rp === 'CS-服务') {
      candidates.push({ token: 'CG-服务', row });
    }
  }
  candidates.sort((a, b) => {
    if (b.token.length !== a.token.length) return b.token.length - a.token.length;
    const aExt = a.row.entity_status === 'external' ? 1 : 0;
    const bExt = b.row.entity_status === 'external' ? 1 : 0;
    return bExt - aExt;
  });

  const matchAgainst = (target: string): { token: string; row: PrefixMapRow } | null => {
    for (const c of candidates) {
      if (!target.startsWith(c.token)) continue;
      const nextCh = target.slice(c.token.length, c.token.length + 1);
      // 字母前缀须在边界（连字符/斜杠/数字/中文/括号/末尾）截断，避免 LJD 被 LJ 误吞或 CS 吞并其他英文词
      if (/^[A-Z]+$/.test(c.token) && nextCh && /^[A-Z]$/.test(nextCh)) {
        // 特例：SGHN0000... / CMHNLD... / HTC4308... 外部电采/运营商编码允许直接接字母或数字
        if (c.row.entity_status !== 'external') continue;
      }
      return c;
    }
    return null;
  };

  const direct = matchAgainst(upper);
  if (direct) {
    const strippedNo = direct.row.prefix_kind === 'role_prefix'
      ? cleaned.replace(/^乙方/u, '')
      : direct.row.raw_prefix === '属于CJ'
        ? cleaned.replace(/^属于/u, '')
        : cleaned;
    return { row: direct.row, matchedToken: direct.token, cleanedContractNo: strippedNo, hadRolePrefix };
  }

  // 剥离前置「属于」「乙方」后再匹配
  const stripped = upper.replace(/^(属于|乙方)/u, '');
  if (stripped !== upper) {
    const afterStrip = matchAgainst(stripped);
    if (afterStrip) {
      return {
        row: afterStrip.row,
        matchedToken: afterStrip.token,
        cleanedContractNo: cleaned.replace(/^(属于|乙方)/u, ''),
        hadRolePrefix,
      };
    }
  }

  // 结构化识别银行保函、电子卖场及单见外部编号（不硬编码机构名称）
  const extGuarantee = all.find((r) => r.raw_prefix === '银行保函');
  if (extGuarantee && /^\d{6,}.*保.*字/u.test(upper)) {
    return { row: extGuarantee, matchedToken: '银行保函', cleanedContractNo: cleaned, hadRolePrefix: false };
  }
  const extEmall = all.find((r) => r.raw_prefix === '政采电采');
  if (extEmall && /电采[【[\](（]\d{4}/u.test(upper)) {
    return { row: extEmall, matchedToken: '政采电采', cleanedContractNo: cleaned, hadRolePrefix: false };
  }
  const extOther = all.find((r) => r.raw_prefix === '其他外部号');
  if (extOther && /[0-9]/.test(upper) && upper.length >= 5) {
    return { row: extOther, matchedToken: '其他外部号', cleanedContractNo: cleaned, hadRolePrefix: false };
  }
  return null;
}

export function deriveYyCode(params: {
  category?: string | null;
  legalCategory?: LegalCategory | null;
  direction?: 'expense' | 'income' | null;
  contractType?: string | null;
}): ContractYyCode {
  const explicit = (params.category ?? '').trim().toUpperCase();
  if ((ALLOWED_YY_CODES as readonly string[]).includes(explicit)) return explicit as ContractYyCode;
  if (params.direction === 'income' || params.legalCategory === 'income_sales') return 'XF';
  if (params.legalCategory === 'construction' || params.legalCategory === 'small_construction') return 'JG';
  if (params.legalCategory === 'goods_procurement' || params.legalCategory === 'tech_service' || params.legalCategory === 'general_service') return 'SG';
  const ct = (params.contractType ?? '').trim();
  if (ct.includes('审计')) return 'SJ';
  if (ct.includes('财务') || ct.includes('融资') || ct.includes('借款')) return 'CW';
  if (ct.includes('投资') || ct.includes('合作') || ct.includes('股权')) return 'TH';
  if (ct.includes('销售') || ct.includes('收入')) return 'XF';
  if (ct.includes('工程') || ct.includes('施工') || ct.includes('基建')) return 'JG';
  if (ct.includes('生产') || ct.includes('采购') || ct.includes('物资') || ct.includes('服务')) return 'SG';
  return 'QT';
}

interface OrgChainNode {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  org_kind: 'legal_entity' | 'hq_dept' | 'direct_unit' | 'closed_history';
  status: string;
  contract_prefix_code: string;
  is_direct_station: number;
}

function loadOrgChain(db: DB, orgId: number): OrgChainNode[] {
  return db
    .prepare(
      `WITH RECURSIVE ancestors(id, parent_id, code, name, org_kind, status, contract_prefix_code, is_direct_station, depth) AS (
        SELECT id, parent_id, code, name, org_kind, status, contract_prefix_code, is_direct_station, 0 FROM org WHERE id = ?
        UNION ALL
        SELECT o.id, o.parent_id, o.code, o.name, o.org_kind, o.status, o.contract_prefix_code, o.is_direct_station, a.depth + 1
        FROM org o JOIN ancestors a ON o.id = a.parent_id
      ) SELECT id, parent_id, code, name, org_kind, status, contract_prefix_code, is_direct_station FROM ancestors ORDER BY depth ASC`,
    )
    .all(orgId) as OrgChainNode[];
}

/** 解析组织对应的规范取号前缀（未单设简码的子法人沿用上级母公司规范码）。 */
export function resolveCanonicalPrefixForOrg(db: DB, orgId: number): {
  canonicalPrefix: string;
  org: OrgChainNode;
  rootOrg: OrgChainNode;
  nearestLegalOrg: OrgChainNode;
} {
  const chain = loadOrgChain(db, orgId);
  if (!chain.length) throw Errors.validation('组织不存在');
  const org = chain[0];
  const rootOrg = chain[chain.length - 1];
  const nearestLegalOrg = chain.find((o) => o.org_kind === 'legal_entity') ?? rootOrg;

  for (const node of chain) {
    if (node.contract_prefix_code) {
      const mapped = db
        .prepare('SELECT canonical_prefix FROM ct_prefix_org_map WHERE raw_prefix = ?')
        .get(node.contract_prefix_code.toUpperCase()) as { canonical_prefix: string } | undefined;
      return {
        canonicalPrefix: mapped?.canonical_prefix ?? node.contract_prefix_code.toUpperCase(),
        org,
        rootOrg,
        nearestLegalOrg,
      };
    }
    const bySigning = db
      .prepare("SELECT canonical_prefix FROM ct_prefix_org_map WHERE signing_org_id = ? AND entity_status NOT IN ('external','ignore') ORDER BY allow_new_contract DESC, id ASC LIMIT 1")
      .get(node.id) as { canonical_prefix: string } | undefined;
    if (bySigning) {
      return { canonicalPrefix: bySigning.canonical_prefix, org, rootOrg, nearestLegalOrg };
    }
  }
  return { canonicalPrefix: (org.code || rootOrg.code || 'HT').toUpperCase(), org, rootOrg, nearestLegalOrg };
}

/**
 * 生成下一建议合同编号（2026 合同管理规程附件3：XX-YY-序号/年份-流水号）。
 * 统筹部门代办（coManagedOrgId）时向被统筹单位取号。
 */
export function suggestNextContractNo(
  db: DB,
  params: {
    orgId: number;
    coManagedOrgId?: number | null;
    signingSubjectOrgId?: number | null;
    signingEntityLevel?: 'company' | 'secondary_unit';
    category?: string | null;
    legalCategory?: LegalCategory | null;
    direction?: 'expense' | 'income' | null;
    year?: number;
  },
): ContractNextNoDto {
  const numberingOrgId = params.coManagedOrgId ?? params.orgId;
  const { canonicalPrefix, org, rootOrg, nearestLegalOrg } = resolveCanonicalPrefixForOrg(db, numberingOrgId);
  if (org.org_kind === 'closed_history' || org.status !== 'active') {
    throw conflict('CONTRACT_ORG_CLOSED_HISTORY', '历史关停/吸收注销主体禁止新签合同');
  }
  const yyCode = deriveYyCode({
    category: params.category,
    legalCategory: params.legalCategory,
    direction: params.direction,
  });
  const year = params.year ?? Number(new Date().toISOString().slice(0, 4));

  // 同编号主体 + 同 YY 序号承接上年度递增；本年度流水号每年从 001 起递增
  const existingNos = db
    .prepare('SELECT contract_no FROM ct_contract WHERE contract_no LIKE ? AND status <> \'voided\'')
    .all(`${canonicalPrefix}%`) as { contract_no: string }[];
  let maxCategorySeq = 0;
  let maxYearSerial = 0;
  const escapedPrefix = canonicalPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fullRx = new RegExp(`^${escapedPrefix}[-－/]([A-Z]{2})[-－](\\d+)(?:[（(]补\\d+[）)])?[/／-](\\d{4})[-－](\\d+)`, 'i');
  for (const row of existingNos) {
    const norm = row.contract_no.normalize('NFKC').trim().toUpperCase();
    const m = norm.match(fullRx);
    if (!m) continue;
    const [, yy, catSeqStr, yrStr, serialStr] = m;
    if (yy === yyCode) {
      const catSeq = Number(catSeqStr);
      if (Number.isInteger(catSeq) && catSeq > maxCategorySeq) maxCategorySeq = catSeq;
    }
    if (Number(yrStr) === year) {
      const ser = Number(serialStr);
      if (Number.isInteger(ser) && ser > maxYearSerial) maxYearSerial = ser;
    }
  }
  const nextCatSeq = String(maxCategorySeq + 1).padStart(3, '0');
  const nextYearSerial = String(maxYearSerial + 1).padStart(3, '0');
  const suggestedNo = `${canonicalPrefix}-${yyCode}-${nextCatSeq}/${year}-${nextYearSerial}`;

  // 推导法定法人主体：直属分支/本部部门固定归集团母公司；独立子法人按对外签约名义决定
  let legalOrg = nearestLegalOrg;
  if (params.signingSubjectOrgId) {
    const subjChain = loadOrgChain(db, params.signingSubjectOrgId);
    if (subjChain.length) legalOrg = subjChain.find((o) => o.org_kind === 'legal_entity') ?? rootOrg;
  } else if (org.org_kind === 'hq_dept' || org.org_kind === 'direct_unit') {
    legalOrg = rootOrg;
  } else if (params.signingEntityLevel === 'company' && !hasPrefixMapSeeded(db)) {
    legalOrg = rootOrg;
  }

  return {
    suggestedNo,
    canonicalPrefix,
    yyCode,
    legalEntityOrgId: legalOrg.id,
    legalEntityOrgName: legalOrg.name,
    signingOrgId: org.id,
    signingOrgName: org.name,
    isDirectStation: org.is_direct_station === 1,
    orgKind: org.org_kind,
  };
}

/**
 * 新签常规合同（migration_mode='normal' 且 external_no_exempt=0）编号前缀与结构校验。
 * 仅当 ct_prefix_org_map 已初始化数据时启用前缀白名单强校验，保持空配置单测夹具向后兼容。
 */
export function validateNewContractNoWithPrefixMap(
  db: DB,
  params: {
    contractNo: string;
    orgId: number;
    coManagedOrgId?: number | null;
    externalNoExempt?: boolean;
    projectId?: number | null;
  },
): { canonicalPrefix: string | null; prefixRow: PrefixMapRow | null } {
  if (params.externalNoExempt || !hasPrefixMapSeeded(db)) {
    return { canonicalPrefix: null, prefixRow: null };
  }
  const normNo = params.contractNo.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  const allowedRows = db
    .prepare('SELECT * FROM ct_prefix_org_map WHERE allow_new_contract = 1 ORDER BY length(raw_prefix) DESC')
    .all() as PrefixMapRow[];

  // 检查是否命中已禁用/历史/外部前缀（如 GD、QD、DXS、SGC、BH、外部码）
  const match = matchContractPrefix(db, normNo);
  if (match && match.row.allow_new_contract === 0) {
    if (match.row.entity_status === 'external') {
      throw conflict('CONTRACT_PREFIX_EXTERNAL', `编号前缀「${match.row.raw_prefix}」属于外部相对方编码，若采用对方编号请勾选外部编号豁免`);
    }
    throw conflict(
      'CONTRACT_PREFIX_NOT_ALLOWED',
      `编号前缀「${match.row.raw_prefix}」不允许用于新签合同，请沿用规范代码「${match.row.canonical_prefix}」`,
    );
  }

  // 建设项目允许以项目编码作为前缀（附件3 第四条）
  if (params.projectId) {
    const proj = db.prepare('SELECT code FROM md_project WHERE id = ?').get(params.projectId) as { code: string } | undefined;
    if (proj?.code) {
      const projCode = proj.code.normalize('NFKC').toUpperCase();
      if (normNo.startsWith(`${projCode}-`) || normNo.startsWith(`${projCode}－`)) {
        return { canonicalPrefix: projCode, prefixRow: null };
      }
    }
  }

  const hitAllowed = allowedRows.find((r) => {
    const rp = r.raw_prefix.toUpperCase();
    return normNo.startsWith(`${rp}-`) || normNo.startsWith(`${rp}－`) || normNo.startsWith(`${rp}/`);
  });
  if (!hitAllowed) {
    throw Errors.validation(
      `合同编号「${params.contractNo}」未使用允许的新签规范前缀（${allowedRows.map((r) => r.raw_prefix).join('/')}）`,
    );
  }

  // 校验所选前缀属于承办组织（或被统筹代办组织）的规范前缀（本部 LS 同时允许 CJ）
  const targetOrgId = params.coManagedOrgId ?? params.orgId;
  const { canonicalPrefix: orgCanonical, org, rootOrg } = resolveCanonicalPrefixForOrg(db, targetOrgId);
  if (org.contract_prefix_code || org.org_kind !== 'legal_entity' || org.id === rootOrg.id) {
    const okForOrg =
      hitAllowed.canonical_prefix === orgCanonical ||
      (orgCanonical === rootOrg.contract_prefix_code && hitAllowed.canonical_prefix === rootOrg.contract_prefix_code);
    if (!okForOrg && orgCanonical) {
      throw conflict(
        'CONTRACT_PREFIX_ORG_MISMATCH',
        `编号前缀「${hitAllowed.raw_prefix}」与组织规范代码「${orgCanonical}」不一致（统筹代办请指定被统筹单位）`,
      );
    }
  }

  // 校验标准格式 XX-YY-序号(补X)/年份-流水号
  const escaped = hitAllowed.raw_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const formatRx = new RegExp(
    `^${escaped}[-－/](?:JG|SG|SJ|CW|TH|XF|QT)[-－]\\d+(?:[（(]补\\d+[）)])?[/／]\\d{4}[-－]\\d+$`,
  );
  if (!formatRx.test(normNo)) {
    throw Errors.validation(
      `合同编号「${params.contractNo}」不符合「XX-YY-序号（补X）/年份-流水号」规范格式`,
    );
  }
  return { canonicalPrefix: hitAllowed.canonical_prefix, prefixRow: hitAllowed };
}
