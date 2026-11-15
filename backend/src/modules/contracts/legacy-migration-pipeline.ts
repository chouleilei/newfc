import crypto from 'crypto';
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { currentOrgScope } from '../security/scope';
import { centsToDecimalString } from '../../core/decimal';
import { MAX_IMPORT_ROWS, MAX_LEGACY_SHEETS } from '../io/import-limits';
import { normalizeHeaderText, readTable, readWorkbookSheets, type ReadSheet } from '../io/table-reader';
import { amountCents, CellError, dateCell, headerKey } from '../io/cell-values';
import { resolveEntity } from '../master/master.service';
import { listExternalBlockedPatterns } from '../org/org.service';
import type {
  ContractCurrencyLineDto,
  ContractDirection,
  ContractImportAction,
  ContractImportRowDto,
  ContractPricingMode,
  ContractReportCategory,
  ContractStage,
  ContractStatus,
  LegacyReconciliationDto,
} from '../../contracts/project-contract';
import type { LegalMetadata } from '../../contracts/contract-legal-review';
import { deriveLegalCategory, deriveProcurementTarget, maxSignDate, MIN_SIGN_DATE } from './contract-import-templates';
import { LABEL_TO_CATEGORY, LABEL_TO_PROCUREMENT } from './supervision-template-spec';
import { deriveContractSixDim } from './contract-controls';
import { matchContractPrefix, resolveCanonicalPrefixForOrg } from './prefix-map.service';

export const LEGACY_PIPELINE_VERSION = 'v73.1.0';

function assertMigrationAccess(db: DB): void {
  const auth = currentAuth();
  if ((auth && !(auth.permissions.has('contract:migrate') || (auth.permissions.has('master:write') && auth.allOrgs))) || !currentOrgScope(db).all) {
    throw new AppError('FORBIDDEN', '历史容缺迁移需要专有权限 contract:migrate 及全集团组织范围', 403);
  }
}

export interface LegacyWorkbookInput {
  inventoryId?: string;
  batchGroup?: '2026-09-zip' | 'historical-core' | 'historical-extra' | 'omission-evidence-2025-2026' | string;
  fileName: string;
  content: Buffer;
  defaultOrgId?: number | null;
  asOfDate?: string | null;
  shouldIngest?: boolean;
}

export interface StagedCurrencyLine {
  lineNo: number;
  currency: string;
  amountCents: bigint;
  amountRole: 'contract_original' | 'settlement_agreed' | 'change_delta';
}

export interface StagedSourceTrace {
  sourceFile: string;
  sourceFileSha256: string;
  sourceSheet: string;
  sourceRow: number;
  rawContractNo: string;
  rawAmountText: string;
  rawSignDate: string;
  asOfDate: string | null;
  isPrimary: boolean;
  conflictFlags: string[];
}

export interface StagedSettlementReversal {
  settlementDate: string;
  netPayableCents: bigint;
  reversalReason: string;
  importSourceRef: string;
  sourceTrace: StagedSourceTrace;
}

export interface StagedChangeEvent {
  deltaCents: bigint;
  reason: string;
  supplementNo: string | null;
  sourceTrace: StagedSourceTrace;
}

export interface StagedLegacyContract {
  key: string;
  action: ContractImportAction;
  existingContractId: number | null;
  existingContractVersion: number | null;
  contractNo: string;
  normalizedNo: string;
  cleanBaseNo: string;
  name: string;
  contractType: string;
  reportCategory: ContractReportCategory;
  legalCategory: LegalMetadata['legalCategory'];
  procurementTarget: LegalMetadata['procurementTarget'];
  procurementMethod: LegalMetadata['procurementMethod'];
  orgId: number;
  signingOrgId: number;
  signingSubjectOrgId: number;
  legalEntityOrgId: number;
  historicalLegalEntityOrgId: number | null;
  coManagedOrgId: number | null;
  supplierId: number | null;
  counterpartyNames: string;
  direction: ContractDirection;
  pricingMode: ContractPricingMode;
  unitPriceDesc: string;
  currency: string;
  currencyStructStatus: 'single' | 'structured_multi' | 'partial_unstructured';
  currencyLines: StagedCurrencyLine[];
  originalCents: bigint;
  paidBaselineCents: bigint;
  receivedBaselineCents: bigint;
  settledNetBaselineCents: bigint;
  legacySettledBaselineCents: bigint | null;
  legacyInvoicedBaselineCents: bigint | null;
  legacyRevenueBaselineCents: bigint | null;
  baselineAsOfDate: string | null;
  amountFactSource: 'confirmed_contract' | 'unit_price_open' | 'voucher_debit_clue' | 'unverified_forecast';
  clueVoucherDebitCents: bigint | null;
  signDate: string | null;
  rawSignDateText: string;
  rawAmountText: string;
  foreignAmountText: string;
  legacyRawNo: string;
  legacyPrefixCode: string;
  externalNoExempt: boolean;
  noExemptReason: string;
  undertakerDept: string;
  undertakerName: string;
  termConditionText: string;
  remark: string;
  stage: ContractStage;
  status: ContractStatus;
  missingFields: string[];
  duplicateConflictGroup: string;
  isInternalGroupTx: boolean;
  internalGroupAgreementKey: string;
  isReversal: boolean;
  syntheticNoFlag: boolean;
  batchRank: number;
  primarySortKey: string;
  traces: StagedSourceTrace[];
  settlementReversals: StagedSettlementReversal[];
  changeEvents: StagedChangeEvent[];
}

export interface LegacyPipelinePlan {
  pipelineVersion: string;
  planHash: string;
  contracts: StagedLegacyContract[];
  displayRows: ContractImportRowDto[];
  reconciliation: LegacyReconciliationDto;
  externalBlockedFiles: string[];
  warnings: string[];
  referenceCodeStats: {
    zipUniqueCodes: number;
    coreUniqueCodes: number;
    zipPlusCoreUniqueCodes: number;
    allHistoricalUniqueCodes: number;
    syntheticCount: number;
    omissionAndClueCount: number;
  };
}

const CURRENCY_CODE_MAP: Record<string, { code: string; name: string }> = {
  人民币: { code: 'CNY', name: '人民币' },
  RMB: { code: 'CNY', name: '人民币' },
  CNY: { code: 'CNY', name: '人民币' },
  基纳: { code: 'PGK', name: '基纳' },
  PGK: { code: 'PGK', name: '基纳' },
  美元: { code: 'USD', name: '美元' },
  美金: { code: 'USD', name: '美元' },
  USD: { code: 'USD', name: '美元' },
  欧元: { code: 'EUR', name: '欧元' },
  EUR: { code: 'EUR', name: '欧元' },
  英镑: { code: 'GBP', name: '英镑' },
  港币: { code: 'HKD', name: '港币' },
  日元: { code: 'JPY', name: '日元' },
};

function batchRankOf(group?: string): number {
  if (group === '2026-09-zip') return 1;
  if (group === 'historical-core') return 2;
  if (group === 'historical-extra') return 3;
  if (group === 'omission-evidence-2025-2026') return 4;
  return 2;
}

function cleanCell(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/_x000D_/gi, '').replace(/\r\n|\r/g, '\n').trim();
}

/** Step 1: 严格清洗合同编码，剔除模板占位符、合计、表末说明、科学计数法电话与纯日期数值。 */
export function strictCleanContractCode(raw: string): string {
  if (!raw) return '';
  let s = cleanCell(raw).normalize('NFKC').replace(/\s+/g, '');
  s = s.replace(/[—–－﹣~～]/g, '-').replace(/／/g, '/');
  s = s.replace(/^属于/u, '').replace(/合同$/u, '');
  if (!s || s.length < 5 || s.length > 64) return '';
  if (/^(例子|序号|合计|小计|累计|总计|本月|本年|往年|无合同|无|待定|暂无|合同编号|原合同编号|备注|营地)$/u.test(s)) return '';
  if (/(?:合计|小计|总计|年度之和)$/u.test(s)) return '';
  if (/20XX|XXXX|^XX[-/]/i.test(s)) return '';
  if (/^[1-9][、.．]/u.test(s)) return '';
  if (/^\d+(\.\d+)?E[+-]?\d+$/i.test(s)) return '';
  if (/^\d{4}[-/.]\d{1,2}([-/.]\d{1,2})?$/.test(s)) return '';
  if (/^\d+(\.\d+)?(万|元|%|年|月|日|个月|天)?$/u.test(s)) return '';
  const upper = s.toUpperCase();
  if (upper === 'LS-QT-01/2013-01' || upper === 'LS-JG-01/2014-01') return '';
  if (!/\d/.test(upper) || !/[A-Z\u4e00-\u9fa5]/.test(upper)) return '';
  return upper;
}

function isNoiseOrSummaryRow(cells: string[]): boolean {
  const nonEmpty = cells.map(cleanCell).filter(Boolean);
  if (nonEmpty.length === 0) return true;
  const first = nonEmpty[0].normalize('NFKC');
  if (first === '例子' || /^20XX年/i.test(first)) return true;
  if (/^注[:：\s]/u.test(first)) return true;
  if (/^(合计|小计|累计|总计|本年合计|本期合计|本年累计|年初余额|收入合同合计|支出合同合计|年度之和)/.test(first)) return true;
  if (nonEmpty.some((c) => /^(收入合同合计|支出合同合计|合计|总计|累计（年度之和）)$/.test(c.normalize('NFKC')))) return true;
  if (/^[1-9][、.．]\s*(本月|本表|备注|说明|填写|变更|结算|要求)/.test(first)) return true;
  if (/^(一|二|三|四|五|六|七|八|九|十|[（(][一二三四五六七八九十]+[)）])[、.\s]/.test(first) && nonEmpty.length <= 3) return true;
  if (nonEmpty.length === 1 && (/^\d{4}年/.test(first) || first === '往年合同' || first.includes('台账') || first.includes('台帐'))) return true;
  return false;
}

/** Step 3: 严格解析完整年月日；缺月日或畸形日期（如 2012.719、2024109、2022.11）一律返回 null 绝不虚构月日。 */
export function parseLegacySignDate(raw: string): { signDate: string | null; inferredYear: string | null } {
  const text = cleanCell(raw).normalize('NFKC');
  if (!text || text === '/' || text === '-' || text === '无') return { signDate: null, inferredYear: null };
  const maxD = maxSignDate();

  if (/^\d{5}(\.0+)?$/.test(text)) {
    const serial = Math.trunc(Number(text));
    if (serial >= 32874 && serial <= 60000) {
      const iso = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
      if (iso >= MIN_SIGN_DATE && iso <= maxD) return { signDate: iso, inferredYear: iso.slice(0, 4) };
    }
  }
  const m8 = text.match(/^((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\.0+)?$/);
  if (m8) {
    const cand = `${m8[1]}-${m8[2]}-${m8[3]}`;
    try {
      const valid = dateCell(cand, '签订日期');
      if (valid && valid >= MIN_SIGN_DATE && valid <= maxD) return { signDate: valid, inferredYear: m8[1] };
    } catch {
      return { signDate: null, inferredYear: m8[1] };
    }
  }
  const mFull = text.match(/^((?:19|20)\d{2})[-./年](\d{1,2})[-./月](\d{1,2})日?$/);
  if (mFull) {
    const mm = Number(mFull[2]);
    const dd = Number(mFull[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const cand = `${mFull[1]}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      try {
        const valid = dateCell(cand, '签订日期');
        if (valid && valid >= MIN_SIGN_DATE && valid <= maxD) return { signDate: valid, inferredYear: mFull[1] };
      } catch {
        return { signDate: null, inferredYear: mFull[1] };
      }
    }
  }
  const yrMatch = text.match(/((?:19|20)\d{2})/);
  return { signDate: null, inferredYear: yrMatch ? yrMatch[1] : null };
}

function inferYearFromCodeOrDate(code: string, rawDate: string): string {
  const { inferredYear } = parseLegacySignDate(rawDate);
  if (inferredYear) return inferredYear;
  const m = code.match(/(?:^|[/\-－])((?:199\d|20[0-2]\d))(?:[/\-－]|\d{2}|$)/);
  return m ? m[1] : '2024';
}

/** Step 2 & 3: 金额、非货币电量、单价描述与复合多币种解析（全 bigint 定点，禁浮点运算）。 */
export function parseLegacyAmountField(
  rawText: string,
  unit: 'yuan' | 'wan',
): {
  pricingMode: ContractPricingMode;
  originalCents: bigint;
  unitPriceDesc: string;
  currency: string;
  currencyStructStatus: 'single' | 'structured_multi' | 'partial_unstructured';
  currencyLines: StagedCurrencyLine[];
  foreignAmountText: string;
  amountFactSource: 'confirmed_contract' | 'unit_price_open';
  isReversalValue: boolean;
} {
  const text = cleanCell(rawText).normalize('NFKC');
  if (!text || text === '/' || text === '-' || text === '无' || /^(按实结算|据实结算|固定综合单价|固定单价|单价|框架协议|费率)/.test(text)) {
    return {
      pricingMode: 'unit_price',
      originalCents: 0n,
      unitPriceDesc: text && text !== '/' && text !== '-' ? text.slice(0, 500) : '按合同约定单价据实结算',
      currency: '人民币',
      currencyStructStatus: 'single',
      currencyLines: [],
      foreignAmountText: '',
      amountFactSource: 'unit_price_open',
      isReversalValue: false,
    };
  }

  if (/kWh|千瓦时|兆瓦|MW|度电/i.test(text) || /[元万元]\s*[/／]\s*[吨米项台套次人月年工日平方立]/u.test(text)) {
    return {
      pricingMode: 'unit_price',
      originalCents: 0n,
      unitPriceDesc: text.slice(0, 500),
      currency: '人民币',
      currencyStructStatus: 'single',
      currencyLines: [],
      foreignAmountText: '',
      amountFactSource: 'unit_price_open',
      isReversalValue: false,
    };
  }

  if (text.includes('+') && /[人民币美元欧元英镑港币日元基纳USD|EUR|PGK|CNY]/i.test(text)) {
    const segments = text.split('+').map((s) => s.trim()).filter(Boolean);
    const lines: StagedCurrencyLine[] = [];
    let allParsed = segments.length >= 2;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const m = seg.match(/^([A-Za-z\u4e00-\u9fa5]+)\s*([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*(万元|万|元)?$/);
      if (!m) {
        allParsed = false;
        break;
      }
      const curInfo = CURRENCY_CODE_MAP[m[1].toUpperCase()] ?? CURRENCY_CODE_MAP[m[1]];
      if (!curInfo) {
        allParsed = false;
        break;
      }
      const segUnit: 'yuan' | 'wan' = m[3] === '元' ? 'yuan' : m[3]?.startsWith('万') ? 'wan' : unit;
      try {
        const cents = amountCents(roundDecimalStringForUnit(m[2], segUnit), segUnit, '复合币种金额');
        if (cents === null || cents < 0n) {
          allParsed = false;
          break;
        }
        lines.push({
          lineNo: i + 1,
          currency: curInfo.code,
          amountCents: cents,
          amountRole: 'contract_original',
        });
      } catch {
        allParsed = false;
        break;
      }
    }
    if (allParsed && lines.length >= 2) {
      return {
        pricingMode: 'lump_sum',
        originalCents: 0n,
        unitPriceDesc: '',
        currency: '人民币',
        currencyStructStatus: 'structured_multi',
        currencyLines: lines,
        foreignAmountText: text.slice(0, 500),
        amountFactSource: 'confirmed_contract',
        isReversalValue: false,
      };
    }
    return {
      pricingMode: 'lump_sum',
      originalCents: 0n,
      unitPriceDesc: '',
      currency: '人民币',
      currencyStructStatus: 'partial_unstructured',
      currencyLines: [],
      foreignAmountText: text.slice(0, 500),
      amountFactSource: 'confirmed_contract',
      isReversalValue: false,
    };
  }

  const singleFx = text.match(/^(美元|美金|欧元|英镑|港币|日元|USD|EUR)\s*([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*(万元|万|元)?$/i);
  if (singleFx) {
    const curInfo = CURRENCY_CODE_MAP[singleFx[1].toUpperCase()] ?? CURRENCY_CODE_MAP[singleFx[1]] ?? { code: 'USD', name: '美元' };
    const fxUnit: 'yuan' | 'wan' = singleFx[3] === '元' ? 'yuan' : singleFx[3]?.startsWith('万') ? 'wan' : unit;
    try {
      const cents = amountCents(roundDecimalStringForUnit(singleFx[2], fxUnit), fxUnit, '外币金额') ?? 0n;
      return {
        pricingMode: 'lump_sum',
        originalCents: cents >= 0n ? cents : 0n,
        unitPriceDesc: '',
        currency: curInfo.name,
        currencyStructStatus: 'single',
        currencyLines: [],
        foreignAmountText: text.slice(0, 500),
        amountFactSource: 'confirmed_contract',
        isReversalValue: cents < 0n,
      };
    } catch {
      // fall through
    }
  }

  let explicitUnit = unit;
  let numericStr = text.replace(/,/g, '').replace(/^¥|^￥|^人民币/u, '').trim();
  if (numericStr.endsWith('万元') || numericStr.endsWith('万')) {
    explicitUnit = 'wan';
    numericStr = numericStr.replace(/(?:万元|万)$/u, '').trim();
  } else if (numericStr.endsWith('元')) {
    explicitUnit = 'yuan';
    numericStr = numericStr.replace(/元$/u, '').trim();
  }

  if (/^[+-]?\d+(?:\.\d+)?$/.test(numericStr)) {
    const rounded = roundDecimalStringForUnit(numericStr, explicitUnit);
    try {
      const cents = amountCents(rounded, explicitUnit, '合同金额') ?? 0n;
      return {
        pricingMode: 'lump_sum',
        originalCents: cents,
        unitPriceDesc: '',
        currency: '人民币',
        currencyStructStatus: 'single',
        currencyLines: [],
        foreignAmountText: '',
        amountFactSource: 'confirmed_contract',
        isReversalValue: cents < 0n,
      };
    } catch (e) {
      if (!(e instanceof CellError)) throw e;
    }
  }

  return {
    pricingMode: 'unit_price',
    originalCents: 0n,
    unitPriceDesc: text.slice(0, 500),
    currency: '人民币',
    currencyStructStatus: 'single',
    currencyLines: [],
    foreignAmountText: '',
    amountFactSource: 'unit_price_open',
    isReversalValue: false,
  };
}

/** 纯字符串定点四舍五入：yuan 保留 2 位小数，wan 保留 6 位小数（精确到分），零 Number 浮点。 */
function roundDecimalStringForUnit(numStr: string, unit: 'yuan' | 'wan'): string {
  const maxFrac = unit === 'wan' ? 6 : 2;
  const sign = numStr.startsWith('-') ? '-' : '';
  const unsigned = numStr.replace(/^[+-]/, '');
  const [intPartRaw, fracRaw = ''] = unsigned.split('.');
  const intPart = intPartRaw || '0';
  if (fracRaw.length <= maxFrac) return `${sign}${intPart}${fracRaw ? `.${fracRaw}` : ''}`;
  const keep = fracRaw.slice(0, maxFrac);
  const nextDigit = Number(fracRaw[maxFrac] ?? '0');
  let scaled = BigInt(intPart + keep);
  if (nextDigit >= 5) scaled += 1n;
  const padded = scaled.toString().padStart(maxFrac + 1, '0');
  const nextInt = padded.slice(0, padded.length - maxFrac);
  const nextFrac = padded.slice(padded.length - maxFrac);
  return `${sign}${nextInt}.${nextFrac}`;
}

function compactTitleKey(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[（()）【】[\]《》“”"'、，,。.\-\s_/]/g, '')
    .replace(/(有限责任公司|股份有限公司|有限公司|项目|工程|合同书|合同文件|委托合同|服务合同|采购合同|施工合同|协议书|协议|合同)/g, '')
    .toUpperCase();
}

function titleSimilarityScore(aName: string, bName: string, aCp: string, bCp: string): number {
  const ka = compactTitleKey(aName);
  const kb = compactTitleKey(bName);
  if (!ka || !kb) return 0;
  let score = 0;
  if (ka === kb) score += 100;
  else if (ka.length >= 4 && kb.length >= 4 && (ka.includes(kb) || kb.includes(ka))) score += 80;
  else {
    const grams = (s: string) => {
      const set = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      return set;
    };
    const ga = grams(ka);
    const gb = grams(kb);
    let inter = 0;
    for (const g of ga) if (gb.has(g)) inter++;
    const union = ga.size + gb.size - inter;
    if (union > 0) score += Math.round((inter / union) * 75);
  }
  const asciiA = ka.match(/[A-Z]{4,}/g) ?? [];
  const asciiB = new Set(kb.match(/[A-Z]{4,}/g) ?? []);
  if (asciiA.some((tok) => asciiB.has(tok))) {
    score += 30;
  }
  const ca = compactTitleKey(aCp);
  const cb = compactTitleKey(bCp);
  if (ca && cb && (ca === cb || ca.includes(cb) || cb.includes(ca))) {
    score += 25;
  }
  return score;
}

interface OrgMeta {
  id: number;
  code: string;
  name: string;
  org_kind: string;
  status: string;
  parent_id: number | null;
  report_full_name: string;
}

function buildOrgResolver(db: DB) {
  const allOrgs = db
    .prepare('SELECT id, code, name, org_kind, status, parent_id, report_full_name FROM org')
    .all() as OrgMeta[];
  const byId = new Map(allOrgs.map((o) => [o.id, o]));
  const byCode = new Map(allOrgs.map((o) => [o.code.toUpperCase(), o]));
  const rootOrg = allOrgs.find((o) => o.parent_id === null) ?? allOrgs[0];
  const hintCache = new Map<string, number>();
  const internalCpCache = new Map<string, OrgMeta | null>();

  const nearestLegalId = (orgId: number): number => {
    let cur = byId.get(orgId);
    while (cur) {
      if (cur.org_kind === 'legal_entity') return cur.id;
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
    }
    return rootOrg ? rootOrg.id : orgId;
  };

  const resolveByHints = (hints: (string | null | undefined)[], fallbackOrgId?: number | null): number => {
    const cacheKey = `${hints.map((h) => h ?? '').join('\x1f')}|${fallbackOrgId ?? ''}`;
    const cached = hintCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const save = (id: number) => {
      hintCache.set(cacheKey, id);
      return id;
    };
    for (const raw of hints) {
      const text = cleanCell(raw ?? '');
      if (!text) continue;
      const upper = text.replace(/（.*）|\(.*\)/g, '').trim().toUpperCase();
      if (byCode.has(upper)) return save(byCode.get(upper)!.id);
      const res = resolveEntity(db, 'org', { code: text, name: text, sourceSystem: 'contract', includeInactive: true });
      if (res.targetId !== null) return save(res.targetId);
      const cleaned = text.replace(/[0-9.（）()\s]/g, '').replace(/(总表|分表|合同台账|合同台帐|月报|公司|电站)$/g, '');
      if (cleaned.length >= 2) {
        const res2 = resolveEntity(db, 'org', { name: cleaned, includeInactive: true });
        if (res2.targetId !== null) return save(res2.targetId);
        const bySub = allOrgs.find((o) => o.name.includes(cleaned) || o.report_full_name.includes(cleaned));
        if (bySub) return save(bySub.id);
      }
    }
    if (fallbackOrgId != null && byId.has(fallbackOrgId)) return save(fallbackOrgId);
    return save(rootOrg ? rootOrg.id : 1);
  };

  const isInternalCounterparty = (counterparty: string): OrgMeta | null => {
    const text = cleanCell(counterparty);
    if (!text || text.length < 2) return null;
    if (internalCpCache.has(text)) return internalCpCache.get(text)!;
    const res = resolveEntity(db, 'org', { name: text, includeInactive: true });
    if (res.targetId !== null) {
      const hit = byId.get(res.targetId) ?? null;
      internalCpCache.set(text, hit);
      return hit;
    }
    const key = compactTitleKey(text);
    if (key.length < 2) {
      internalCpCache.set(text, null);
      return null;
    }
    const found =
      allOrgs.find((o) => {
        const ok = compactTitleKey(o.name);
        return ok.length >= 2 && (ok === key || (key.length >= 4 && (ok.includes(key) || key.includes(ok))));
      }) ?? null;
    internalCpCache.set(text, found);
    return found;
  };

  return { allOrgs, byId, byCode, rootOrg, nearestLegalId, resolveByHints, isInternalCounterparty };
}

function inferWorkbookAsOfDate(fileName: string, batchGroup?: string): string {
  const m = fileName.normalize('NFKC').match(/(20\d{2})[年.\-_]?(0?[1-9]|1[0-2])(?:月|$|\D)/);
  if (m) {
    const yr = Number(m[1]);
    const mo = Number(m[2]);
    const lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
    return `${yr}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  }
  if (batchGroup === '2026-09-zip') return '2026-08-31';
  return '2024-12-31';
}

type SheetKind =
  | 'main_ledger'
  | 'headerless_ledger'
  | 'monthly_summary'
  | 'settlement_sub'
  | 'change_sub'
  | 'codeless_exec_c09'
  | 'forecast_omission'
  | 'voucher_clue_m03'
  | 'skip_non_contract';

function classifySheet(sheet: ReadSheet, fileName: string): { kind: SheetKind; headerRowIdx: number; unit: 'yuan' | 'wan' } {
  const topRows = sheet.rows.slice(0, 8);
  const titleBlob = topRows.map((r) => r.cells.join(' ')).join(' ').normalize('NFKC');
  const defaultUnit: 'yuan' | 'wan' = /单位[:：]?\s*元|合同价[（(]元[)）]/.test(titleBlob) && !/万元/.test(titleBlob) ? 'yuan' : 'wan';
  const sName = sheet.name.normalize('NFKC');

  for (let i = 0; i < Math.min(sheet.rows.length, 10); i++) {
    const keys = sheet.rows[i].cells.map((c) => headerKey(normalizeHeaderText(c)));
    if (keys.includes('记账日期') && keys.includes('凭证字号') && keys.includes('摘要') && keys.includes('借方')) {
      return { kind: 'voucher_clue_m03', headerRowIdx: i, unit: 'yuan' };
    }
    if (keys.includes('本月新签') && keys.includes('本月执行完毕')) {
      return { kind: 'monthly_summary', headerRowIdx: i, unit: 'wan' };
    }
    if (/结算/.test(sName) && keys.some((k) => k.includes('结算金额') || k.includes('结算次数')) && keys.some((k) => k.includes('合同编号'))) {
      return { kind: 'settlement_sub', headerRowIdx: i, unit: 'wan' };
    }
    if (/变更|索赔|调差/.test(sName) && keys.some((k) => k.includes('变更') || k.includes('索赔') || k.includes('调差') || k.includes('金额')) && keys.some((k) => k.includes('合同编号'))) {
      return { kind: 'change_sub', headerRowIdx: i, unit: 'wan' };
    }
    if (keys.includes('中标单位') && keys.some((k) => k.includes('招标公告') || k.includes('代理机构'))) {
      return { kind: 'skip_non_contract', headerRowIdx: i, unit: 'wan' };
    }
    if (keys.some((k) => k.includes('项目名称')) && keys.some((k) => k.includes('合同信息') || k.includes('预计2025年度结算金额'))) {
      return { kind: 'forecast_omission', headerRowIdx: i, unit: 'wan' };
    }
    if (
      keys.includes('合同名称') &&
      !keys.some((k) => k.includes('合同编号') || k.includes('合同分类编号') || k.includes('对应合同编号')) &&
      keys.some((k) => k.includes('开票情况') || k.includes('收票情况'))
    ) {
      return { kind: 'codeless_exec_c09', headerRowIdx: i, unit: 'yuan' };
    }
    if (
      keys.some((k) => k === '合同编号' || k === '合同编码' || k === '合同号' || k === '合同分类编号' || k === '对应合同编号') &&
      keys.some((k) => k === '合同名称' || k === '项目名称')
    ) {
      const amtHeader = sheet.rows[i].cells.find((c) => /金额|总价|合同价|投资/.test(c)) ?? '';
      const unit: 'yuan' | 'wan' =
        /万元/.test(amtHeader)
          ? 'wan'
          : /[（(]元[)）]/.test(amtHeader)
            ? 'yuan'
            : fileName.includes('11.14') || fileName.includes('厂房工程')
              ? 'yuan'
              : defaultUnit;
      return { kind: 'main_ledger', headerRowIdx: i, unit };
    }
  }

  let codeHits = 0;
  for (const r of sheet.rows.slice(0, 15)) {
    if (r.cells.some((c) => strictCleanContractCode(c) !== '')) codeHits++;
  }
  if (codeHits >= 3) {
    const unit: 'yuan' | 'wan' = fileName.includes('厂房工程') ? 'yuan' : defaultUnit;
    return { kind: 'headerless_ledger', headerRowIdx: -1, unit };
  }

  return { kind: 'skip_non_contract', headerRowIdx: -1, unit: defaultUnit };
}

/**
 * 5步历史台账容缺清洗与四级消重纯计算引擎（不写库，供单簿/多簿预检与 CLI 共用）。
 */
export async function computeLegacyMigrationPlan(
  db: DB,
  workbooks: LegacyWorkbookInput[],
): Promise<LegacyPipelinePlan> {
  assertMigrationAccess(db);
  const blockedPatterns = listExternalBlockedPatterns(db);
  const orgHelper = buildOrgResolver(db);
  const warnings: string[] = [];
  const externalBlockedFiles: string[] = [];

  let totalSourceRows = 0;
  let filteredNoiseRows = 0;
  let foldedDuplicateRows = 0;
  let subEventRows = 0;

  const zipCodes = new Set<string>();
  const coreCodes = new Set<string>();
  const extraCodes = new Set<string>();

  interface RawExtractedMain {
    batchGroup: string;
    batchRank: number;
    fileName: string;
    fileSha256: string;
    sheetName: string;
    rowNo: number;
    asOfDate: string;
    defaultOrgId: number | null;
    rawCode: string;
    cleanCode: string;
    name: string;
    categoryText: string;
    rawAmount: string;
    unit: 'yuan' | 'wan';
    directionText: string;
    rawSignDate: string;
    termText: string;
    counterparty: string;
    procMethodText: string;
    deptText: string;
    undertaker: string;
    execStatusText: string;
    remark: string;
    paidRaw: string;
    invoicedRaw: string;
    revenueRaw: string;
    factSource: 'confirmed_contract' | 'unit_price_open' | 'voucher_debit_clue' | 'unverified_forecast';
    clueDebitCents: bigint | null;
  }

  interface RawSubEvent {
    kind: 'settlement' | 'change';
    batchRank: number;
    fileName: string;
    fileSha256: string;
    sheetName: string;
    rowNo: number;
    asOfDate: string;
    cleanCode: string;
    contractName: string;
    amountRaw: string;
    unit: 'yuan' | 'wan';
    reason: string;
  }

  const extractedMains: RawExtractedMain[] = [];
  const extractedCodeless: RawExtractedMain[] = [];
  const extractedSubEvents: RawSubEvent[] = [];

  for (const wb of workbooks) {
    const fileSha256 = crypto.createHash('sha256').update(wb.content).digest('hex');
    const asOfDate = wb.asOfDate ?? inferWorkbookAsOfDate(wb.fileName, wb.batchGroup);

    const blockedByFileName = blockedPatterns.names.find((n) => wb.fileName.normalize('NFKC').includes(n));
    if (blockedByFileName) {
      externalBlockedFiles.push(wb.fileName);
      warnings.push(`外部隔离台账「${wb.fileName}」命中禁止主体「${blockedByFileName}」，整簿 0 行入库`);
      if (wb.content.length > 0) {
        try {
          const extSheets = await readWorkbookSheets(wb.content, MAX_IMPORT_ROWS, MAX_LEGACY_SHEETS, { allowUncachedFormulas: true });
          for (const s of extSheets) {
            totalSourceRows += s.rows.length;
            filteredNoiseRows += s.rows.length;
          }
        } catch {
          // ignore unreadable blocked file
        }
      }
      continue;
    }

    if (wb.shouldIngest === false) continue;

    const ext = wb.fileName.toLowerCase();
    let sheets: ReadSheet[];
    if (ext.endsWith('.csv')) {
      const tbl = await readTable(wb.content, wb.fileName, MAX_IMPORT_ROWS, {
        isHeader: (cells) => cells.some((c) => c !== ''),
        allowDuplicateHeaders: true,
      });
      sheets = [
        {
          name: 'CSV',
          hidden: false,
          rows: [
            { rowNo: 1, cells: tbl.headers },
            ...tbl.rows.map((r) => ({ rowNo: r.rowNo, cells: tbl.headers.map((h) => r.values[h] ?? '') })),
          ],
        },
      ];
    } else {
      sheets = await readWorkbookSheets(wb.content, MAX_IMPORT_ROWS, MAX_LEGACY_SHEETS, {
        allowUncachedFormulas: true,
        warnings,
      });
    }

    const firstSheetTitle = sheets[0]?.rows.slice(0, 3).map((r) => r.cells.join(' ')).join(' ').normalize('NFKC') ?? '';
    const blockedByTitle = blockedPatterns.names.find((n) => firstSheetTitle.includes(n));
    if (blockedByTitle) {
      externalBlockedFiles.push(wb.fileName);
      warnings.push(`外部隔离台账「${wb.fileName}」表头命中禁止主体「${blockedByTitle}」，整簿 0 行入库`);
      for (const s of sheets) {
        totalSourceRows += s.rows.length;
        filteredNoiseRows += s.rows.length;
      }
      continue;
    }

    const rank = batchRankOf(wb.batchGroup);

    for (const sheet of sheets) {
      totalSourceRows += sheet.rows.length;
      const cls = classifySheet(sheet, wb.fileName);
      if (cls.kind === 'skip_non_contract') {
        filteredNoiseRows += sheet.rows.length;
        continue;
      }

      if (cls.kind === 'main_ledger') {
        const hdrCells = sheet.rows[cls.headerRowIdx].cells.map((c) => headerKey(normalizeHeaderText(c)));
        filteredNoiseRows += cls.headerRowIdx + 1;
        const findIdx = (aliases: string[]) => hdrCells.findIndex((h) => aliases.some((a) => h === a || h.includes(a)));
        const idxCode = findIdx(['合同编号', '合同编码', '合同号', '合同分类编号', '对应合同编号']);
        const idxName = findIdx(['合同名称', '项目名称']);
        const idxCat = findIdx(['类别', '合同类型', '业务分类']);
        const idxAmt = findIdx(['初始签订合同金额', '签约金额', '合同总价', '调整后合同价', '合同金额', '合同价', '建筑安装工程投资']);
        const idxDir = findIdx(['支出/收入', '收支方向']);
        const idxDate = findIdx(['签订日期', '签约日期', '合同签订时间', '签署日期']);
        const idxTerm = findIdx(['工期', '合同工期', '合同期限', '履约期限']);
        const idxCp = findIdx(['对方单位', '合同乙方', '承包人', '乙方', '供应商']);
        const idxProc = findIdx(['采购方式']);
        const idxDept = findIdx(['承办部门', '承办单位', '责任组织', '甲方']);
        const idxUser = findIdx(['承办人', '签约人']);
        const idxExec = findIdx(['执行情况']);
        const idxRemark = findIdx(['备注']);
        const idxPaid = findIdx(['已付款', '已付金额', '累计已付']);

        for (const r of sheet.rows.slice(cls.headerRowIdx + 1)) {
          if (isNoiseOrSummaryRow(r.cells)) {
            filteredNoiseRows++;
            continue;
          }
          const rawCode = idxCode >= 0 ? cleanCell(r.cells[idxCode]) : '';
          const name = idxName >= 0 ? cleanCell(r.cells[idxName]) : '';
          if (headerKey(rawCode) === '合同编号' || headerKey(name) === '合同名称') {
            filteredNoiseRows++;
            continue;
          }
          const cleanCode = strictCleanContractCode(rawCode);
          if (!cleanCode && (!name || /^(无合同|营地合同)$/.test(rawCode))) {
            filteredNoiseRows++;
            continue;
          }
          const rawAmt = idxAmt >= 0 ? cleanCell(r.cells[idxAmt]) : '';
          const baseItem: RawExtractedMain = {
            batchGroup: wb.batchGroup ?? 'historical-core',
            batchRank: rank,
            fileName: wb.fileName,
            fileSha256,
            sheetName: sheet.name,
            rowNo: r.rowNo,
            asOfDate,
            defaultOrgId: wb.defaultOrgId ?? null,
            rawCode,
            cleanCode,
            name: name || rawCode,
            categoryText: idxCat >= 0 ? cleanCell(r.cells[idxCat]) : '',
            rawAmount: rawAmt,
            unit: cls.unit,
            directionText: idxDir >= 0 ? cleanCell(r.cells[idxDir]) : '',
            rawSignDate: idxDate >= 0 ? cleanCell(r.cells[idxDate]) : '',
            termText: idxTerm >= 0 ? cleanCell(r.cells[idxTerm]) : '',
            counterparty: idxCp >= 0 ? cleanCell(r.cells[idxCp]) : '',
            procMethodText: idxProc >= 0 ? cleanCell(r.cells[idxProc]) : '',
            deptText: idxDept >= 0 ? cleanCell(r.cells[idxDept]) : '',
            undertaker: idxUser >= 0 ? cleanCell(r.cells[idxUser]) : '',
            execStatusText: idxExec >= 0 ? cleanCell(r.cells[idxExec]) : '',
            remark: idxRemark >= 0 ? cleanCell(r.cells[idxRemark]) : '',
            paidRaw: idxPaid >= 0 ? cleanCell(r.cells[idxPaid]) : '',
            invoicedRaw: '',
            revenueRaw: '',
            factSource: 'confirmed_contract',
            clueDebitCents: null,
          };
          if (cleanCode) {
            if (wb.batchGroup === '2026-09-zip') zipCodes.add(cleanCode);
            else if (wb.batchGroup === 'historical-core') coreCodes.add(cleanCode);
            else if (wb.batchGroup === 'historical-extra') extraCodes.add(cleanCode);
            extractedMains.push(baseItem);
          } else {
            extractedCodeless.push(baseItem);
          }
        }
      } else if (cls.kind === 'headerless_ledger') {
        for (const r of sheet.rows) {
          if (isNoiseOrSummaryRow(r.cells)) {
            filteredNoiseRows++;
            continue;
          }
          const codeColIdx = r.cells.findIndex((c) => strictCleanContractCode(c) !== '');
          if (codeColIdx < 0) {
            filteredNoiseRows++;
            continue;
          }
          const rawCode = cleanCell(r.cells[codeColIdx]);
          const cleanCode = strictCleanContractCode(rawCode);
          const afterCells = r.cells.slice(codeColIdx + 1).map(cleanCell);
          const name = afterCells.find((c) => c && !/^[+-]?\d+(\.\d+)?$/.test(c)) ?? cleanCode;
          const amtCell = afterCells.find((c) => /^[+-]?\d+(\.\d+)?$/.test(c.replace(/,/g, ''))) ?? '';
          if (wb.batchGroup === '2026-09-zip') zipCodes.add(cleanCode);
          else if (wb.batchGroup === 'historical-core') coreCodes.add(cleanCode);
          else if (wb.batchGroup === 'historical-extra') extraCodes.add(cleanCode);
          extractedMains.push({
            batchGroup: wb.batchGroup ?? 'historical-core',
            batchRank: rank,
            fileName: wb.fileName,
            fileSha256,
            sheetName: sheet.name,
            rowNo: r.rowNo,
            asOfDate,
            defaultOrgId: wb.defaultOrgId ?? null,
            rawCode,
            cleanCode,
            name,
            categoryText: '',
            rawAmount: amtCell,
            unit: cls.unit,
            directionText: '',
            rawSignDate: '',
            termText: '',
            counterparty: '',
            procMethodText: '',
            deptText: '',
            undertaker: '',
            execStatusText: '',
            remark: '',
            paidRaw: '',
            invoicedRaw: '',
            revenueRaw: '',
            factSource: 'confirmed_contract',
            clueDebitCents: null,
          });
        }
      } else if (cls.kind === 'monthly_summary') {
        filteredNoiseRows += cls.headerRowIdx + 1;
        for (const r of sheet.rows.slice(cls.headerRowIdx + 1)) {
          const code = strictCleanContractCode(r.cells[1] ?? '');
          const name = cleanCell(r.cells[2]);
          const amt = cleanCell(r.cells[3]);
          if (!code || !name) {
            filteredNoiseRows++;
            continue;
          }
          if (wb.batchGroup === '2026-09-zip') zipCodes.add(code);
          else if (wb.batchGroup === 'historical-core') coreCodes.add(code);
          else if (wb.batchGroup === 'historical-extra') extraCodes.add(code);
          extractedMains.push({
            batchGroup: wb.batchGroup ?? 'historical-core',
            batchRank: rank + 1,
            fileName: wb.fileName,
            fileSha256,
            sheetName: sheet.name,
            rowNo: r.rowNo,
            asOfDate,
            defaultOrgId: wb.defaultOrgId ?? null,
            rawCode: cleanCell(r.cells[1]),
            cleanCode: code,
            name,
            categoryText: '',
            rawAmount: amt,
            unit: 'wan',
            directionText: '',
            rawSignDate: '',
            termText: '',
            counterparty: '',
            procMethodText: '',
            deptText: '',
            undertaker: '',
            execStatusText: '',
            remark: '',
            paidRaw: '',
            invoicedRaw: '',
            revenueRaw: '',
            factSource: 'confirmed_contract',
            clueDebitCents: null,
          });
        }
      } else if (cls.kind === 'settlement_sub' || cls.kind === 'change_sub') {
        filteredNoiseRows += cls.headerRowIdx + 1;
        const hdr = sheet.rows[cls.headerRowIdx].cells.map((c) => headerKey(normalizeHeaderText(c)));
        const idxCode = hdr.findIndex((h) => h.includes('合同编号'));
        const idxName = hdr.findIndex((h) => h.includes('合同名称'));
        const idxAmt = cls.kind === 'settlement_sub'
          ? hdr.findIndex((h) => h.includes('结算金额'))
          : hdr.findIndex((h) => h.includes('变更金额'));
        for (const r of sheet.rows.slice(cls.headerRowIdx + 1)) {
          if (isNoiseOrSummaryRow(r.cells)) {
            filteredNoiseRows++;
            continue;
          }
          const code = strictCleanContractCode(r.cells[idxCode >= 0 ? idxCode : 1] ?? '');
          if (!code) {
            filteredNoiseRows++;
            continue;
          }
          if (wb.batchGroup === '2026-09-zip') zipCodes.add(code);
          else if (wb.batchGroup === 'historical-core') coreCodes.add(code);
          else if (wb.batchGroup === 'historical-extra') extraCodes.add(code);
          const amtRaw = cleanCell(r.cells[idxAmt >= 0 ? idxAmt : 4]);
          extractedSubEvents.push({
            kind: cls.kind === 'settlement_sub' ? 'settlement' : 'change',
            batchRank: rank,
            fileName: wb.fileName,
            fileSha256,
            sheetName: sheet.name,
            rowNo: r.rowNo,
            asOfDate,
            cleanCode: code,
            contractName: cleanCell(r.cells[idxName >= 0 ? idxName : 2]),
            amountRaw: amtRaw,
            unit: 'wan',
            reason: cleanCell(r.cells[r.cells.length - 1]) || '历史台账分表迁入',
          });
        }
      } else if (cls.kind === 'codeless_exec_c09') {
        let curDir: 'income' | 'expense' = 'income';
        const rows = sheet.rows;
        for (let idx = 0; idx < rows.length; idx++) {
          const r = rows[idx];
          const normCells = r.cells.map((c) => cleanCell(c).normalize('NFKC'));
          if (normCells.some((c) => c === '收票情况' || c === '付款情况' || c === '成本金额')) {
            curDir = 'expense';
            filteredNoiseRows++;
            continue;
          }
          if (normCells.some((c) => c === '开票情况' || c === '确认收入' || c === '回款情况')) {
            curDir = 'income';
            filteredNoiseRows++;
            continue;
          }
          if (normCells.some((c) => c.includes('收入合同合计'))) {
            const restHasExpenseTotal = rows.slice(idx + 1, idx + 6).some((nr) => nr.cells.some((c) => c.includes('支出合同合计')));
            if (restHasExpenseTotal) curDir = 'expense';
            filteredNoiseRows++;
            continue;
          }
          if (isNoiseOrSummaryRow(r.cells) || !/^\d+$/.test(normCells[0] ?? '') || !(normCells[1] ?? '')) {
            filteredNoiseRows++;
            continue;
          }
          extractedCodeless.push({
            batchGroup: wb.batchGroup ?? 'historical-core',
            batchRank: rank,
            fileName: wb.fileName,
            fileSha256,
            sheetName: sheet.name,
            rowNo: r.rowNo,
            asOfDate,
            defaultOrgId: wb.defaultOrgId ?? null,
            rawCode: '',
            cleanCode: '',
            name: normCells[1],
            categoryText: '',
            rawAmount: normCells[2] ?? '',
            unit: 'yuan',
            directionText: curDir === 'income' ? '收入' : '支出',
            rawSignDate: normCells[3] ?? '',
            termText: '',
            counterparty: normCells[4] ?? '',
            procMethodText: '',
            deptText: sheet.name,
            undertaker: '',
            execStatusText: '',
            remark: normCells[8] ?? '',
            invoicedRaw: normCells[5] ?? '',
            revenueRaw: curDir === 'income' ? (normCells[6] ?? '') : '',
            paidRaw: normCells[7] || (curDir === 'expense' && !normCells[7] ? (normCells[6] ?? '') : ''),
            factSource: 'confirmed_contract',
            clueDebitCents: null,
          });
        }
      } else if (cls.kind === 'forecast_omission') {
        filteredNoiseRows += cls.headerRowIdx + 1;
        let codeCol = 4;
        let nameCol = 5;
        let amtCol = 6;
        const subHdr = sheet.rows[cls.headerRowIdx + 1];
        let startIdx = cls.headerRowIdx + 1;
        if (subHdr && subHdr.cells.some((c) => cleanCell(c) === '编号')) {
          codeCol = subHdr.cells.findIndex((c) => cleanCell(c) === '编号');
          nameCol = subHdr.cells.findIndex((c) => cleanCell(c) === '名称');
          amtCol = subHdr.cells.findIndex((c) => cleanCell(c) === '金额');
          filteredNoiseRows++;
          startIdx++;
        } else {
          codeCol = -1;
        }
        for (const r of sheet.rows.slice(startIdx)) {
          if (isNoiseOrSummaryRow(r.cells)) {
            filteredNoiseRows++;
            continue;
          }
          if (codeCol >= 0) {
            const rawCode = cleanCell(r.cells[codeCol]);
            const cleanCode = strictCleanContractCode(rawCode);
            if (!cleanCode) {
              filteredNoiseRows++;
              continue;
            }
            extractedMains.push({
              batchGroup: 'omission-evidence-2025-2026',
              batchRank: 4,
              fileName: wb.fileName,
              fileSha256,
              sheetName: sheet.name,
              rowNo: r.rowNo,
              asOfDate,
              defaultOrgId: wb.defaultOrgId ?? null,
              rawCode,
              cleanCode,
              name: cleanCell(r.cells[nameCol]) || cleanCell(r.cells[1]) || cleanCode,
              categoryText: '',
              rawAmount: cleanCell(r.cells[amtCol]),
              unit: 'wan',
              directionText: '支出',
              rawSignDate: '',
              termText: '',
              counterparty: '',
              procMethodText: '',
              deptText: wb.fileName,
              undertaker: '',
              execStatusText: '',
              remark: '预测表漏登待补采要素',
              paidRaw: '',
              invoicedRaw: '',
              revenueRaw: '',
              factSource: 'unverified_forecast',
              clueDebitCents: null,
            });
          } else {
            const remarkBlob = r.cells.map(cleanCell).join(' ');
            const matches = remarkBlob.match(/[A-Z]{2,4}-[A-Z\u4e00-\u9fa5]{1,4}-\d+\/\d{4}-\d+/gi) ?? [];
            const firstMatch = matches[0] ?? '';
            if (!firstMatch) {
              filteredNoiseRows++;
              continue;
            }
            const cleanCode = strictCleanContractCode(firstMatch);
            if (!cleanCode) {
              filteredNoiseRows++;
              continue;
            }
            extractedMains.push({
              batchGroup: 'omission-evidence-2025-2026',
              batchRank: 4,
              fileName: wb.fileName,
              fileSha256,
              sheetName: sheet.name,
              rowNo: r.rowNo,
              asOfDate,
              defaultOrgId: wb.defaultOrgId ?? null,
              rawCode: firstMatch,
              cleanCode,
              name: cleanCell(r.cells[1]) || cleanCode,
              categoryText: '',
              rawAmount: cleanCell(r.cells[3]),
              unit: 'wan',
              directionText: '支出',
              rawSignDate: '',
              termText: '',
              counterparty: '',
              procMethodText: '',
              deptText: wb.fileName,
              undertaker: '',
              execStatusText: '',
              remark: remarkBlob.slice(0, 500),
              paidRaw: '',
              invoicedRaw: '',
              revenueRaw: '',
              factSource: 'unverified_forecast',
              clueDebitCents: null,
            });
          }
        }
      } else if (cls.kind === 'voucher_clue_m03') {
        filteredNoiseRows += cls.headerRowIdx + 1;
        for (const r of sheet.rows.slice(cls.headerRowIdx + 1)) {
          const summary = cleanCell(r.cells[4]);
          const companyText = cleanCell(r.cells[2]);
          const voucherNo = cleanCell(r.cells[3]);
          const debitRaw = cleanCell(r.cells[6]);
          const codeMatch = summary.normalize('NFKC').match(/([A-Z]{2,5}-[A-Z\u4e00-\u9fa5]{1,4}-\d+[/\-]\d{4}-\d+)/i);
          if (!codeMatch) {
            filteredNoiseRows++;
            continue;
          }
          const cleanCode = strictCleanContractCode(codeMatch[1]);
          if (!cleanCode) {
            filteredNoiseRows++;
            continue;
          }
          let debitCents: bigint | null = null;
          try {
            debitCents = debitRaw ? amountCents(roundDecimalStringForUnit(debitRaw.replace(/,/g, ''), 'yuan'), 'yuan', '借方发生额') : null;
          } catch {
            debitCents = null;
          }
          extractedMains.push({
            batchGroup: 'omission-evidence-2025-2026',
            batchRank: 4,
            fileName: wb.fileName,
            fileSha256,
            sheetName: sheet.name,
            rowNo: r.rowNo,
            asOfDate: cleanCell(r.cells[0]) || asOfDate,
            defaultOrgId: wb.defaultOrgId ?? null,
            rawCode: codeMatch[1],
            cleanCode,
            name: summary.replace(/[（(][^）)]*[）)]/g, '').trim() || summary,
            categoryText: '货物',
            rawAmount: '',
            unit: 'yuan',
            directionText: '支出',
            rawSignDate: '',
            termText: '',
            counterparty: '',
            procMethodText: '',
            deptText: companyText,
            undertaker: cleanCell(r.cells[5]),
            execStatusText: '',
            remark: `固定资产凭证线索 ${voucherNo}（凭证日期 ${cleanCell(r.cells[0])}，借方发生额 ${debitRaw} 元，待补采原合同核定总价与签署日）`,
            paidRaw: '',
            invoicedRaw: '',
            revenueRaw: '',
            factSource: 'voucher_debit_clue',
            clueDebitCents: debitCents,
          });
        }
      }
    }
  }

  extractedMains.sort((a, b) => {
    if (a.batchRank !== b.batchRank) return a.batchRank - b.batchRank;
    const ka = `${a.fileSha256}:${a.sheetName}:${String(a.rowNo).padStart(6, '0')}`;
    const kb = `${b.fileSha256}:${b.sheetName}:${String(b.rowNo).padStart(6, '0')}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  extractedCodeless.sort((a, b) => {
    const aC09 = !a.cleanCode && (a.invoicedRaw !== '' || a.revenueRaw !== '') ? 0 : 1;
    const bC09 = !b.cleanCode && (b.invoicedRaw !== '' || b.revenueRaw !== '') ? 0 : 1;
    if (aC09 !== bC09) return aC09 - bC09;
    if (a.batchRank !== b.batchRank) return a.batchRank - b.batchRank;
    const ka = `${a.fileSha256}:${a.sheetName}:${String(a.rowNo).padStart(6, '0')}`;
    const kb = `${b.fileSha256}:${b.sheetName}:${String(b.rowNo).padStart(6, '0')}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  extractedSubEvents.sort((a, b) => {
    if (a.batchRank !== b.batchRank) return a.batchRank - b.batchRank;
    const ka = `${a.fileSha256}:${a.sheetName}:${String(a.rowNo).padStart(6, '0')}`;
    const kb = `${b.fileSha256}:${b.sheetName}:${String(b.rowNo).padStart(6, '0')}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  function fileIsC09(r: RawExtractedMain): boolean {
    return !r.cleanCode && (r.invoicedRaw !== '' || r.revenueRaw !== '');
  }

  const prefixMatchCache = new Map<string, ReturnType<typeof matchContractPrefix>>();
  const cachedMatchPrefix = (rawNo: string) => {
    if (prefixMatchCache.has(rawNo)) return prefixMatchCache.get(rawNo)!;
    const m = matchContractPrefix(db, rawNo);
    prefixMatchCache.set(rawNo, m);
    return m;
  };
  const sixDimCache = new Map<string, ReturnType<typeof deriveContractSixDim>>();
  const cachedSixDim = (orgId: number, signingOrgId: number, prefixLegalId: number | null, prefixSuccessorId: number | null) => {
    const k = `${orgId}:${signingOrgId}:${prefixLegalId ?? ''}:${prefixSuccessorId ?? ''}`;
    if (sixDimCache.has(k)) return sixDimCache.get(k)!;
    const res = deriveContractSixDim(db, {
      orgId,
      signingOrgId,
      signingLevel: 'secondary_unit',
      prefixLegalEntityOrgId: prefixLegalId,
      prefixSuccessorOrgId: prefixSuccessorId,
    });
    sixDimCache.set(k, res);
    return res;
  };
  const supplierCache = new Map<string, number | null>();
  const cachedResolveSupplier = (cp: string): number | null => {
    const first = cp.split(/[,，/]/)[0].trim();
    if (!first) return null;
    if (supplierCache.has(first)) return supplierCache.get(first)!;
    const res = resolveEntity(db, 'supplier', { name: first, sourceSystem: 'contract', includeInactive: true });
    supplierCache.set(first, res.targetId);
    return res.targetId;
  };

  const buildStagedFromRaw = (r: RawExtractedMain, syntheticCode?: string): StagedLegacyContract => {
    const effectiveRawNo = syntheticCode ?? r.rawCode;
    const prefixMatch = syntheticCode ? null : cachedMatchPrefix(effectiveRawNo);
    const cleanBaseNo = syntheticCode
      ? syntheticCode
      : prefixMatch
        ? strictCleanContractCode(prefixMatch.cleanedContractNo) || r.cleanCode
        : r.cleanCode;

    const resolvedSheetOrgId = orgHelper.resolveByHints(
      [r.deptText, r.sheetName, r.fileName],
      r.defaultOrgId,
    );
    const internalCp = orgHelper.isInternalCounterparty(r.counterparty);
    const sheetLegalId = orgHelper.nearestLegalId(resolvedSheetOrgId);
    // 集团内部关联协议乙方视角（如子公司台账记录甲方 LS-* 合同且对方为母公司/兄弟单位）：本行归属本工作簿所在法人账套
    const isCounterpartyNumberedInternal =
      internalCp !== null &&
      prefixMatch?.row.legal_entity_org_id != null &&
      orgHelper.nearestLegalId(internalCp.id) === prefixMatch.row.legal_entity_org_id &&
      sheetLegalId !== prefixMatch.row.legal_entity_org_id;

    const prefixSigningId = isCounterpartyNumberedInternal ? null : (prefixMatch?.row.signing_org_id ?? null);
    const prefixLegalId = isCounterpartyNumberedInternal ? null : (prefixMatch?.row.legal_entity_org_id ?? null);
    const prefixSuccessorId = isCounterpartyNumberedInternal ? null : (prefixMatch?.row.successor_org_id ?? null);

    let orgId = prefixSigningId ?? resolvedSheetOrgId;
    const orgMeta = orgHelper.byId.get(orgId);
    const sixDim = cachedSixDim(orgId, prefixSigningId ?? resolvedSheetOrgId, prefixLegalId, prefixSuccessorId);
    if (orgMeta?.org_kind === 'closed_history' || orgMeta?.status === 'inactive') {
      orgId = sixDim.legalEntityOrgId;
    }

    let direction: ContractDirection = 'expense';
    if (r.directionText.includes('收入') || r.directionText === 'income') direction = 'income';
    else if (r.directionText.includes('支出') || r.directionText === 'expense') direction = 'expense';
    else if (prefixMatch?.hadRolePrefix || prefixMatch?.row.raw_prefix === 'CS-服务' || prefixMatch?.row.raw_prefix === 'MJ-服务' || prefixMatch?.row.raw_prefix === 'LCGS') {
      direction = 'income';
    }

    const amtParsed =
      r.factSource === 'voucher_debit_clue'
        ? {
            pricingMode: 'lump_sum' as ContractPricingMode,
            originalCents: 0n,
            unitPriceDesc: '',
            currency: '人民币',
            currencyStructStatus: 'single' as const,
            currencyLines: [],
            foreignAmountText: '',
            amountFactSource: 'voucher_debit_clue' as const,
            isReversalValue: false,
          }
        : parseLegacyAmountField(r.rawAmount, r.unit);

    const { signDate } = parseLegacySignDate(r.rawSignDate);
    const catText = r.categoryText;
    const reportCategory: ContractReportCategory =
      LABEL_TO_CATEGORY[catText] ??
      (catText.includes('工程') || catText.includes('施工') || catText.includes('土建') || catText.includes('建筑')
        ? 'engineering'
        : catText.includes('货') || catText.includes('购') || catText.includes('设备')
          ? 'goods'
          : catText.includes('服') || catText.includes('咨询') || catText.includes('监理') || catText.includes('设计')
            ? 'service'
            : 'other');
    const procMethod = LABEL_TO_PROCUREMENT[r.procMethodText] ?? null;

    let status: ContractStatus = 'active';
    let stage: ContractStage = signDate ? 'performance' : 'initiation';
    if (r.execStatusText.includes('完成') || r.execStatusText.includes('完结')) {
      status = 'closed';
      stage = 'closed';
    } else if (r.execStatusText.includes('中止')) {
      status = 'suspended';
    } else if (r.execStatusText.includes('终止') || r.execStatusText.includes('解除')) {
      status = 'terminated';
    }

    const resolvedSupplierId = r.counterparty ? cachedResolveSupplier(r.counterparty) : null;

    const parseOptYuan = (txt: string): bigint | null => {
      const t = cleanCell(txt).replace(/,/g, '');
      if (!t || !/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
      try {
        return amountCents(roundDecimalStringForUnit(t, 'yuan'), 'yuan', '基线金额');
      } catch {
        return null;
      }
    };
    const paidVal = r.paidRaw
      ? (r.unit === 'wan' && !fileIsC09(r)
          ? (() => {
              try {
                return amountCents(roundDecimalStringForUnit(r.paidRaw.replace(/,/g, ''), 'wan'), 'wan', '已付') ?? 0n;
              } catch {
                return 0n;
              }
            })()
          : (parseOptYuan(r.paidRaw) ?? 0n))
      : 0n;
    const invoicedVal = parseOptYuan(r.invoicedRaw);
    const revenueVal = parseOptYuan(r.revenueRaw);

    const missingFields: string[] = [];
    if (!signDate) missingFields.push('signDate');
    if (!r.counterparty) missingFields.push('counterpartyNames');
    if (r.factSource === 'voucher_debit_clue') missingFields.push('originalAmount', 'contractText');
    if (r.factSource === 'unverified_forecast') missingFields.push('verifiedContract');
    if (amtParsed.originalCents === -100n || r.rawAmount.trim() === '-1') missingFields.push('abnormalNegativePlaceholder');

    const isExternalNo = prefixMatch?.row.entity_status === 'external';
    const noExemptReason = syntheticCode
      ? 'synthetic_mig'
      : isExternalNo
        ? 'external_counterparty'
        : 'legacy_import';

    const trace: StagedSourceTrace = {
      sourceFile: r.fileName,
      sourceFileSha256: r.fileSha256,
      sourceSheet: r.sheetName,
      sourceRow: r.rowNo,
      rawContractNo: r.rawCode,
      rawAmountText: r.rawAmount,
      rawSignDate: r.rawSignDate,
      asOfDate: r.asOfDate,
      isPrimary: true,
      conflictFlags: [],
    };

    const isInternal = Boolean(prefixMatch?.hadRolePrefix || (internalCp && internalCp.id !== sixDim.legalEntityOrgId));

    return {
      key: `${sixDim.legalEntityOrgId}:${cleanBaseNo}`,
      action: 'create',
      existingContractId: null,
      existingContractVersion: null,
      contractNo: (syntheticCode ?? (prefixMatch?.cleanedContractNo || r.rawCode || cleanBaseNo)).slice(0, 64),
      normalizedNo: cleanBaseNo,
      cleanBaseNo,
      name: (r.name || cleanBaseNo).slice(0, 200),
      contractType: (catText || '历史存量').slice(0, 50),
      reportCategory,
      legalCategory: deriveLegalCategory(reportCategory),
      procurementTarget: deriveProcurementTarget(reportCategory),
      procurementMethod: procMethod,
      orgId,
      signingOrgId: sixDim.signingOrgId,
      signingSubjectOrgId: sixDim.signingSubjectOrgId,
      legalEntityOrgId: sixDim.legalEntityOrgId,
      historicalLegalEntityOrgId: sixDim.historicalLegalEntityOrgId,
      coManagedOrgId: resolvedSheetOrgId !== orgId && orgHelper.byId.get(resolvedSheetOrgId)?.status === 'active' ? resolvedSheetOrgId : null,
      supplierId: resolvedSupplierId,
      counterpartyNames: r.counterparty.slice(0, 1000),
      direction,
      pricingMode: amtParsed.pricingMode,
      unitPriceDesc: amtParsed.unitPriceDesc,
      currency: amtParsed.currency,
      currencyStructStatus: amtParsed.currencyStructStatus,
      currencyLines: amtParsed.currencyLines,
      originalCents: amtParsed.originalCents,
      paidBaselineCents: direction === 'expense' && paidVal > 0n ? paidVal : 0n,
      receivedBaselineCents: direction === 'income' && paidVal > 0n ? paidVal : 0n,
      settledNetBaselineCents: 0n,
      legacySettledBaselineCents: null,
      legacyInvoicedBaselineCents: invoicedVal,
      legacyRevenueBaselineCents: revenueVal,
      baselineAsOfDate: paidVal > 0n || invoicedVal !== null || revenueVal !== null ? r.asOfDate : null,
      amountFactSource: r.factSource !== 'confirmed_contract' ? r.factSource : amtParsed.amountFactSource,
      clueVoucherDebitCents: r.clueDebitCents,
      signDate,
      rawSignDateText: r.rawSignDate.slice(0, 100),
      rawAmountText: r.rawAmount.slice(0, 200),
      foreignAmountText: amtParsed.foreignAmountText,
      legacyRawNo: r.rawCode.slice(0, 100),
      legacyPrefixCode: prefixMatch?.row.raw_prefix ?? '',
      externalNoExempt: true,
      noExemptReason,
      undertakerDept: r.deptText.slice(0, 100),
      undertakerName: r.undertaker.slice(0, 100),
      termConditionText: r.termText.slice(0, 50),
      remark: r.remark.slice(0, 2000),
      stage,
      status,
      missingFields,
      duplicateConflictGroup: '',
      isInternalGroupTx: isInternal,
      internalGroupAgreementKey: isInternal ? cleanBaseNo : '',
      isReversal: amtParsed.isReversalValue,
      syntheticNoFlag: Boolean(syntheticCode),
      batchRank: r.batchRank,
      primarySortKey: `${r.batchRank}:${r.fileSha256}:${r.sheetName}:${String(r.rowNo).padStart(6, '0')}`,
      traces: [trace],
      settlementReversals: [],
      changeEvents: [],
    };
  };

  const groupByLegalAndCode = new Map<string, StagedLegacyContract[]>();
  const byCleanCodeAllLegals = new Map<string, StagedLegacyContract[]>();

  const isDistinctCollision = (existing: StagedLegacyContract, incoming: StagedLegacyContract): boolean => {
    if (incoming.amountFactSource === 'unverified_forecast' || incoming.amountFactSource === 'voucher_debit_clue') {
      return false;
    }
    if (existing.direction !== incoming.direction) {
      const sim = titleSimilarityScore(existing.name, incoming.name, existing.counterpartyNames, incoming.counterpartyNames);
      if (sim < 45) return true;
    }
    if (existing.counterpartyNames && incoming.counterpartyNames) {
      const sim = titleSimilarityScore(existing.name, incoming.name, existing.counterpartyNames, incoming.counterpartyNames);
      if (sim < 20 && compactTitleKey(existing.counterpartyNames) !== compactTitleKey(incoming.counterpartyNames)) {
        return true;
      }
    }
    return false;
  };

  const mergeComplementFields = (target: StagedLegacyContract, donor: StagedLegacyContract): void => {
    if (!target.signDate && donor.signDate) target.signDate = donor.signDate;
    if (!target.rawSignDateText && donor.rawSignDateText) target.rawSignDateText = donor.rawSignDateText;
    if (!target.counterpartyNames && donor.counterpartyNames) target.counterpartyNames = donor.counterpartyNames;
    if (!target.supplierId && donor.supplierId) target.supplierId = donor.supplierId;
    if (!target.undertakerName && donor.undertakerName) target.undertakerName = donor.undertakerName;
    if (!target.undertakerDept && donor.undertakerDept) target.undertakerDept = donor.undertakerDept;
    if (!target.procurementMethod && donor.procurementMethod) target.procurementMethod = donor.procurementMethod;
    if (!target.termConditionText && donor.termConditionText) target.termConditionText = donor.termConditionText;
    if (!target.remark && donor.remark) target.remark = donor.remark;
    if (target.originalCents === 0n && target.pricingMode === 'lump_sum' && donor.originalCents > 0n && donor.amountFactSource === 'confirmed_contract') {
      target.originalCents = donor.originalCents;
      target.rawAmountText = donor.rawAmountText;
    }
    if (target.paidBaselineCents === 0n && donor.paidBaselineCents > 0n) {
      target.paidBaselineCents = donor.paidBaselineCents;
      target.baselineAsOfDate = donor.baselineAsOfDate;
    }
    if (target.receivedBaselineCents === 0n && donor.receivedBaselineCents > 0n) {
      target.receivedBaselineCents = donor.receivedBaselineCents;
      target.baselineAsOfDate = donor.baselineAsOfDate;
    }
    target.missingFields = target.missingFields.filter((f) => {
      if (f === 'signDate' && target.signDate) return false;
      if (f === 'counterpartyNames' && target.counterpartyNames) return false;
      return true;
    });
    for (const tr of donor.traces) {
      target.traces.push({ ...tr, isPrimary: false });
    }
  };

  for (const raw of extractedMains) {
    const cand = buildStagedFromRaw(raw);

    if (cand.amountFactSource === 'unverified_forecast' || cand.amountFactSource === 'voucher_debit_clue') {
      const existingAny = byCleanCodeAllLegals.get(cand.cleanBaseNo);
      if (existingAny && existingAny.length > 0) {
        mergeComplementFields(existingAny[0], cand);
        foldedDuplicateRows++;
        continue;
      }
    }

    const bucketKey = `${cand.legalEntityOrgId}:${cand.cleanBaseNo}`;
    const existingBucket = groupByLegalAndCode.get(bucketKey);
    if (!existingBucket) {
      const otherLegalList = byCleanCodeAllLegals.get(cand.cleanBaseNo) ?? [];
      const sameDirCoRecord = otherLegalList.find((o) => o.direction === cand.direction && !cand.isInternalGroupTx && !o.isInternalGroupTx);
      if (sameDirCoRecord) {
        if (!sameDirCoRecord.coManagedOrgId && cand.orgId !== sameDirCoRecord.orgId) {
          sameDirCoRecord.coManagedOrgId = cand.orgId;
        }
        mergeComplementFields(sameDirCoRecord, cand);
        foldedDuplicateRows++;
        continue;
      }
      const oppositeRecord = otherLegalList.find((o) => o.direction !== cand.direction);
      if (oppositeRecord) {
        oppositeRecord.isInternalGroupTx = true;
        oppositeRecord.internalGroupAgreementKey = cand.cleanBaseNo;
        cand.isInternalGroupTx = true;
        cand.internalGroupAgreementKey = cand.cleanBaseNo;
      }
      groupByLegalAndCode.set(bucketKey, [cand]);
      otherLegalList.push(cand);
      byCleanCodeAllLegals.set(cand.cleanBaseNo, otherLegalList);
    } else {
      const matchTarget = existingBucket.find((ex) => !isDistinctCollision(ex, cand));
      if (matchTarget) {
        mergeComplementFields(matchTarget, cand);
        foldedDuplicateRows++;
      } else {
        const legalOrgCode = orgHelper.byId.get(cand.legalEntityOrgId)?.code ?? String(cand.legalEntityOrgId);
        const conflictGroup = `${legalOrgCode}:${cand.cleanBaseNo}`;
        existingBucket[0].duplicateConflictGroup = conflictGroup;
        existingBucket[0].traces[0].conflictFlags.push('DUPLICATE_NO_CONFLICT');
        const dupIdx = existingBucket.length + 1;
        cand.duplicateConflictGroup = conflictGroup;
        cand.normalizedNo = `${cand.cleanBaseNo}#DUP${dupIdx}`;
        cand.contractNo = `${cand.contractNo}#DUP${dupIdx}`.slice(0, 64);
        cand.key = `${cand.legalEntityOrgId}:${cand.normalizedNo}`;
        cand.traces[0].conflictFlags.push('DUPLICATE_NO_CONFLICT');
        existingBucket.push(cand);
        byCleanCodeAllLegals.get(cand.cleanBaseNo)?.push(cand);
      }
    }
  }

  const stagedList = () => [...groupByLegalAndCode.values()].flat();
  const seenCodelessFingerprints = new Map<string, StagedLegacyContract>();
  const migSeqByPrefixYear = new Map<string, number>();

  for (const raw of extractedCodeless) {
    const probe = buildStagedFromRaw(raw, 'PROBE-00000');
    const fp = `${probe.legalEntityOrgId}:${probe.direction}:${compactTitleKey(raw.name)}:${compactTitleKey(raw.counterparty)}:${probe.originalCents.toString()}`;
    if (seenCodelessFingerprints.has(fp)) {
      const prev = seenCodelessFingerprints.get(fp)!;
      prev.traces.push({ ...probe.traces[0], isPrimary: false, conflictFlags: ['SELF_TABLE_DUPLICATE'] });
      foldedDuplicateRows++;
      continue;
    }

    const candidates = stagedList().filter(
      (c) =>
        !c.syntheticNoFlag &&
        (c.legalEntityOrgId === probe.legalEntityOrgId || c.signingOrgId === probe.signingOrgId || c.coManagedOrgId === probe.signingOrgId) &&
        c.direction === probe.direction,
    );
    let best: StagedLegacyContract | null = null;
    let bestScore = 0;
    const rawYr = inferYearFromCodeOrDate('', raw.rawSignDate);
    const rawCpKey = compactTitleKey(raw.counterparty);
    const rawCpInternal = Boolean(orgHelper.isInternalCounterparty(raw.counterparty));
    for (const c of candidates) {
      let sc = titleSimilarityScore(raw.name, c.name, raw.counterparty, c.counterpartyNames);
      if (probe.originalCents > 0n && c.originalCents === probe.originalCents) sc += 30;
      if (!rawCpInternal && rawCpKey.length >= 4 && rawCpKey === compactTitleKey(c.counterpartyNames)) {
        const candYr = inferYearFromCodeOrDate(c.cleanBaseNo, c.rawSignDateText);
        if (rawYr === candYr) sc += 25;
      }
      if (sc > bestScore) {
        bestScore = sc;
        best = c;
      }
    }

    if (best && bestScore >= 55) {
      seenCodelessFingerprints.set(fp, best);
      if (probe.currencyLines.length > 0 && raw.name.includes('结算')) {
        const nextBase = best.currencyLines.filter((cl) => cl.amountRole === 'settlement_agreed').length;
        probe.currencyLines.forEach((cl, i) => {
          best!.currencyLines.push({
            lineNo: nextBase + i + 1,
            currency: cl.currency,
            amountCents: cl.amountCents,
            amountRole: 'settlement_agreed',
          });
        });
      }
      if (best.pricingMode === 'unit_price' && probe.originalCents > 0n) {
        best.legacySettledBaselineCents = probe.originalCents;
        best.baselineAsOfDate = raw.asOfDate;
      } else if (best.pricingMode === 'lump_sum' && probe.originalCents > 0n && best.originalCents !== probe.originalCents) {
        if (!best.missingFields.includes('amountCrossCheckSwap')) {
          best.missingFields.push('amountCrossCheckSwap');
        }
        probe.traces[0].conflictFlags.push(`AMOUNT_DIFF:${centsToDecimalString(probe.originalCents)}`);
      }
      if (probe.legacyInvoicedBaselineCents !== null) {
        best.legacyInvoicedBaselineCents = probe.legacyInvoicedBaselineCents;
        best.baselineAsOfDate = raw.asOfDate;
      }
      if (probe.legacyRevenueBaselineCents !== null) {
        best.legacyRevenueBaselineCents = probe.legacyRevenueBaselineCents;
        best.baselineAsOfDate = raw.asOfDate;
      }
      if (probe.receivedBaselineCents > 0n && best.receivedBaselineCents === 0n) {
        best.receivedBaselineCents = probe.receivedBaselineCents;
        best.baselineAsOfDate = raw.asOfDate;
      }
      if (probe.paidBaselineCents > 0n && best.paidBaselineCents === 0n) {
        best.paidBaselineCents = probe.paidBaselineCents;
        best.baselineAsOfDate = raw.asOfDate;
      }
      best.traces.push({ ...probe.traces[0], isPrimary: false });
      foldedDuplicateRows++;
      continue;
    }

    const signingMeta = orgHelper.byId.get(probe.signingOrgId);
    const migPrefix =
      signingMeta?.org_kind === 'closed_history' && signingMeta.code
        ? signingMeta.code.toUpperCase()
        : resolveCanonicalPrefixForOrg(db, probe.signingOrgId).canonicalPrefix;
    const yr = inferYearFromCodeOrDate('', raw.rawSignDate);
    const seqKey = `${migPrefix}-${yr}`;
    const nextSeq = (migSeqByPrefixYear.get(seqKey) ?? 0) + 1;
    migSeqByPrefixYear.set(seqKey, nextSeq);
    const migNo = `MIG-${migPrefix}-${yr}-${String(nextSeq).padStart(3, '0')}`;
    const migContract = buildStagedFromRaw(raw, migNo);
    seenCodelessFingerprints.set(fp, migContract);
    groupByLegalAndCode.set(migContract.key, [migContract]);
  }

  for (const ev of extractedSubEvents) {
    const targets = byCleanCodeAllLegals.get(ev.cleanCode);
    if (!targets || targets.length === 0) {
      filteredNoiseRows++;
      continue;
    }
    const target = targets[0];
    const trace: StagedSourceTrace = {
      sourceFile: ev.fileName,
      sourceFileSha256: ev.fileSha256,
      sourceSheet: ev.sheetName,
      sourceRow: ev.rowNo,
      rawContractNo: ev.cleanCode,
      rawAmountText: ev.amountRaw,
      rawSignDate: '',
      asOfDate: ev.asOfDate,
      isPrimary: false,
      conflictFlags: [],
    };
    let cents = 0n;
    const rawClean = ev.amountRaw.replace(/,/g, '').replace(/^\+/, '').trim();
    if (rawClean && /^[+-]?\d+(\.\d+)?$/.test(rawClean)) {
      try {
        cents = amountCents(roundDecimalStringForUnit(rawClean, ev.unit), ev.unit, '分表金额') ?? 0n;
      } catch {
        cents = 0n;
      }
    }
    if (ev.kind === 'settlement') {
      if (cents < 0n) {
        target.settlementReversals.push({
          settlementDate: ev.asOfDate,
          netPayableCents: cents,
          reversalReason: ev.reason || '历史结算负向红冲调整',
          importSourceRef: `${ev.fileName}#${ev.sheetName}:R${ev.rowNo}`,
          sourceTrace: trace,
        });
        target.isReversal = true;
      } else if (cents > 0n && target.legacySettledBaselineCents === null) {
        target.legacySettledBaselineCents = cents;
        target.baselineAsOfDate = ev.asOfDate;
      }
      target.traces.push(trace);
      subEventRows++;
    } else {
      if (cents !== 0n) {
        target.changeEvents.push({
          deltaCents: cents,
          reason: ev.reason || '历史变更分表迁入',
          supplementNo: null,
          sourceTrace: trace,
        });
      }
      target.traces.push(trace);
      subEventRows++;
    }
  }

  const allContracts = stagedList().sort((a, b) => (a.primarySortKey < b.primarySortKey ? -1 : a.primarySortKey > b.primarySortKey ? 1 : 0));
  const orgNames = new Map(orgHelper.allOrgs.map((o) => [o.id, o.name]));

  let mainContractRows = 0;
  let conflictAndClueRows = 0;
  const displayRows: ContractImportRowDto[] = [];

  allContracts.forEach((c, idx) => {
    const isConflictOrClue =
      c.normalizedNo.includes('#DUP') ||
      c.amountFactSource === 'voucher_debit_clue' ||
      c.amountFactSource === 'unverified_forecast';
    if (isConflictOrClue) conflictAndClueRows++;
    else mainContractRows++;

    const ex = db
      .prepare('SELECT id, version, name, sign_date, counterparty_names, legacy_settled_baseline_cents FROM ct_contract WHERE COALESCE(legal_entity_org_id, org_id) = ? AND normalized_no = ?')
      .safeIntegers(true)
      .get(c.legalEntityOrgId, c.normalizedNo) as
      | {
          id: bigint;
          version: bigint;
          name: string;
          sign_date: string | null;
          counterparty_names: string;
          legacy_settled_baseline_cents: bigint | null;
        }
      | undefined;
    const changes: Record<string, [string | null, string | null]> = {};
    if (!ex) {
      c.action = 'create';
      c.existingContractId = null;
      c.existingContractVersion = null;
    } else {
      c.existingContractId = Number(ex.id);
      c.existingContractVersion = Number(ex.version);
      if (!ex.sign_date && c.signDate) changes.signDate = [null, c.signDate];
      if (!ex.counterparty_names && c.counterpartyNames) changes.counterpartyNames = ['', c.counterpartyNames];
      if (ex.legacy_settled_baseline_cents === null && c.legacySettledBaselineCents !== null) {
        changes.legacySettledBaselineAmount = [null, centsToDecimalString(c.legacySettledBaselineCents)];
      }
      const hasPendingReversal = c.settlementReversals.some(
        (rev) => !db.prepare('SELECT 1 FROM ct_settlement WHERE contract_id = ? AND import_source_ref = ?').get(Number(ex.id), rev.importSourceRef),
      );
      const hasPendingChange = c.changeEvents.some((chg) => {
        const refTag = `${chg.sourceTrace.sourceFile}#${chg.sourceTrace.sourceSheet}:R${chg.sourceTrace.sourceRow}`;
        return !db.prepare("SELECT 1 FROM ct_change WHERE contract_id = ? AND origin = 'legacy_migration' AND change_matter = ?").get(Number(ex.id), refTag);
      });
      c.action = Object.keys(changes).length > 0 || hasPendingReversal || hasPendingChange ? 'update' : 'unchanged';
    }

    const currencyLineDtos: ContractCurrencyLineDto[] = c.currencyLines.map((cl) => ({
      lineNo: cl.lineNo,
      currency: cl.currency,
      amount: centsToDecimalString(cl.amountCents),
      amountRole: cl.amountRole,
      fxRate: null,
      fxRateDate: null,
      fxRateSource: '',
    }));

    const paidDisplay =
      c.direction === 'income'
        ? (c.receivedBaselineCents > 0n ? centsToDecimalString(c.receivedBaselineCents) : null)
        : (c.paidBaselineCents > 0n ? centsToDecimalString(c.paidBaselineCents) : null);

    displayRows.push({
      row: idx + 1,
      contractNo: c.contractNo,
      name: c.name,
      action: c.action,
      contractId: c.existingContractId,
      orgName: orgNames.get(c.orgId) ?? null,
      projectCode: null,
      supplierName: c.counterpartyNames || null,
      amount: c.pricingMode === 'unit_price' ? '0.00' : centsToDecimalString(c.originalCents),
      paid: paidDisplay,
      signDate: c.signDate,
      direction: c.direction,
      pricingMode: c.pricingMode,
      currency: c.currency,
      signingOrgId: c.signingOrgId,
      signingOrgName: orgNames.get(c.signingOrgId) ?? null,
      legalEntityOrgId: c.legalEntityOrgId,
      legalEntityOrgName: orgNames.get(c.legalEntityOrgId) ?? null,
      coManagedOrgName: c.coManagedOrgId ? (orgNames.get(c.coManagedOrgId) ?? null) : null,
      canonicalEntityCode: orgHelper.byId.get(c.legalEntityOrgId)?.code ?? '',
      legacyPrefixCode: c.legacyPrefixCode,
      legacyRawNo: c.legacyRawNo,
      noExemptReason: c.noExemptReason,
      rawAmountText: c.rawAmountText,
      rawSignDateText: c.rawSignDateText,
      foreignAmountText: c.foreignAmountText,
      missingFields: c.missingFields,
      isReversal: c.isReversal,
      syntheticNoFlag: c.syntheticNoFlag,
      duplicateConflictGroup: c.duplicateConflictGroup,
      isInternalGroupTx: c.isInternalGroupTx,
      amountFactSource: c.amountFactSource,
      currencyStructStatus: c.currencyStructStatus,
      currencyLines: currencyLineDtos,
      legacySettledBaselineAmount: c.legacySettledBaselineCents === null ? null : centsToDecimalString(c.legacySettledBaselineCents),
      detailSummary:
        c.currencyStructStatus !== 'single'
          ? `多币种: ${c.foreignAmountText}`
          : c.amountFactSource === 'voucher_debit_clue'
            ? `凭证借方线索: ${c.clueVoucherDebitCents ? centsToDecimalString(c.clueVoucherDebitCents) : '0.00'}`
            : c.pricingMode === 'unit_price'
              ? `单价: ${c.unitPriceDesc}`
              : '历史容缺清洗',
      changes,
    });
  });

  const reconciliation: LegacyReconciliationDto = {
    totalSourceRows,
    filteredNoiseRows,
    foldedDuplicateRows,
    mainContractRows,
    subEventRows,
    conflictAndClueRows,
    closed:
      totalSourceRows ===
      filteredNoiseRows + foldedDuplicateRows + mainContractRows + subEventRows + conflictAndClueRows,
  };

  const zipPlusCore = new Set([...zipCodes, ...coreCodes]);
  const allThree = new Set([...zipPlusCore, ...extraCodes]);
  const syntheticCount = allContracts.filter((c) => c.syntheticNoFlag).length;
  const omissionAndClueCount = allContracts.filter(
    (c) => c.amountFactSource === 'unverified_forecast' || c.amountFactSource === 'voucher_debit_clue',
  ).length;

  const planHash = crypto
    .createHash('sha256')
    .update(LEGACY_PIPELINE_VERSION)
    .update(
      JSON.stringify(
        allContracts.map((c) => ({
          k: c.key,
          a: c.action,
          id: c.existingContractId,
          v: c.existingContractVersion,
          o: c.originalCents.toString(),
          sb: c.legacySettledBaselineCents?.toString() ?? null,
          rev: c.settlementReversals.length,
          chg: c.changeEvents.length,
        })),
      ),
    )
    .digest('hex');

  return {
    pipelineVersion: LEGACY_PIPELINE_VERSION,
    planHash,
    contracts: allContracts,
    displayRows,
    reconciliation,
    externalBlockedFiles,
    warnings,
    referenceCodeStats: {
      zipUniqueCodes: zipCodes.size,
      coreUniqueCodes: coreCodes.size,
      zipPlusCoreUniqueCodes: zipPlusCore.size,
      allHistoricalUniqueCodes: allThree.size,
      syntheticCount,
      omissionAndClueCount,
    },
  };
}

/**
 * 在单个 BEGIN IMMEDIATE 短事务内原子提交历史容缺清洗结果。
 * 严格校验目标行 version 防并发覆盖（409 PREVIEW_STALE），写入 ct_legacy_source_trace 保障重跑幂等，任一行异常整批回滚。
 */
export function commitLegacyMigrationPlan(
  db: DB,
  plan: LegacyPipelinePlan,
  opts: { importId?: number | null; userId?: number | null } = {},
): { created: number; updated: number; unchanged: number; contractIds: number[]; writeLockMs: number } {
  assertMigrationAccess(db);
  if (!plan.reconciliation.closed) {
    throw new AppError('RECONCILIATION_UNCLOSED', '五维行去向对账未闭合，拒绝提交入库', 422, undefined, plan.reconciliation);
  }
  const now = new Date().toISOString();
  const userId = opts.userId ?? null;
  const importId = opts.importId ?? null;

  const tLockStart = Date.now();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const contractIds: number[] = [];

  db.transaction(() => {
    for (const c of plan.contracts) {
      const ex = db
        .prepare('SELECT id, version FROM ct_contract WHERE COALESCE(legal_entity_org_id, org_id) = ? AND normalized_no = ?')
        .get(c.legalEntityOrgId, c.normalizedNo) as { id: number; version: number } | undefined;
      if ((ex?.id ?? null) !== c.existingContractId || (ex?.version ?? null) !== c.existingContractVersion) {
        throw new AppError('PREVIEW_STALE', `合同 ${c.contractNo} 在预览后已发生并发变更，请重新预检`, 409);
      }
    }

    const insertContractStmt = db.prepare(`
      INSERT INTO ct_contract (
        contract_no, normalized_no, name, contract_type, report_category, legal_category, party_role,
        is_procurement, procurement_target, procurement_method,
        org_id, supplier_id, direction, pricing_mode, unit_price_desc, currency, original_cents,
        paid_cents, received_cents, settled_net_cents,
        sign_date, term_condition_text, counterparty_names, undertaker_dept, undertaker_name, remark,
        stage, status, source, import_id, created_by_user_id, created_at, updated_at,
        origin, migration_mode, duplicate_conflict_group, amount_fact_source, clue_voucher_debit_cents,
        legacy_settled_baseline_cents, legacy_invoiced_baseline_cents, legacy_revenue_baseline_cents, baseline_as_of_date,
        legacy_prefix_code, raw_amount_text, raw_sign_date_text, missing_fields_json,
        is_reversal, synthetic_no_flag, signing_org_id, signing_subject_org_id, legal_entity_org_id, historical_legal_entity_org_id,
        is_internal_group_tx, internal_group_agreement_key, co_managed_org_id,
        currency_struct_status, legacy_raw_no, external_no_exempt, no_exempt_reason, foreign_amount_text
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, 'import', ?, ?, ?, ?,
        'legacy_migration', 'legacy_tolerant', ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);

    const insertCurrencyLineStmt = db.prepare(`
      INSERT OR IGNORE INTO ct_contract_currency_line (
        contract_id, line_no, currency, amount_cents, amount_role, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertTraceStmt = db.prepare(`
      INSERT OR IGNORE INTO ct_legacy_source_trace (
        contract_id, import_id, source_file, source_file_sha256, source_sheet, source_row,
        pipeline_version, raw_contract_no, raw_amount_text, raw_sign_date, as_of_date, is_primary, conflict_flags, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const idsByAgreementKey = new Map<string, { id: number; direction: ContractDirection }[]>();

    for (const c of plan.contracts) {
      let cid: number;
      if (c.action === 'create') {
        const approvedChgSum = c.changeEvents.reduce((s, ch) => s + ch.deltaCents, 0n);
        cid = Number(
          insertContractStmt.run(
            c.contractNo,
            c.normalizedNo,
            c.name,
            c.contractType,
            c.reportCategory,
            c.legalCategory,
            c.direction === 'income' ? 'seller' : 'buyer',
            c.direction === 'expense' ? 1 : 0,
            c.procurementTarget,
            c.procurementMethod,
            c.orgId,
            c.supplierId,
            c.direction,
            c.pricingMode,
            c.unitPriceDesc,
            c.currency,
            c.originalCents,
            c.paidBaselineCents,
            c.receivedBaselineCents,
            c.settledNetBaselineCents,
            c.signDate,
            c.termConditionText,
            c.counterpartyNames,
            c.undertakerDept,
            c.undertakerName,
            c.remark,
            c.stage,
            c.status,
            importId,
            userId,
            now,
            now,
            c.duplicateConflictGroup,
            c.amountFactSource,
            c.clueVoucherDebitCents,
            c.legacySettledBaselineCents,
            c.legacyInvoicedBaselineCents,
            c.legacyRevenueBaselineCents,
            c.baselineAsOfDate,
            c.legacyPrefixCode,
            c.rawAmountText,
            c.rawSignDateText,
            JSON.stringify(c.missingFields),
            c.isReversal ? 1 : 0,
            c.syntheticNoFlag ? 1 : 0,
            c.signingOrgId,
            c.signingSubjectOrgId,
            c.legalEntityOrgId,
            c.historicalLegalEntityOrgId,
            c.isInternalGroupTx ? 1 : 0,
            c.internalGroupAgreementKey,
            c.coManagedOrgId,
            c.currencyStructStatus,
            c.legacyRawNo,
            c.externalNoExempt ? 1 : 0,
            c.noExemptReason,
            c.foreignAmountText,
          ).lastInsertRowid,
        );
        if (approvedChgSum !== 0n) {
          db.prepare('UPDATE ct_contract SET approved_change_cents = ? WHERE id = ?').run(approvedChgSum, cid);
        }
        if (c.paidBaselineCents > 0n) {
          db.prepare(
            `INSERT INTO ct_payment (
              contract_id, kind, node_name, currency, amount_cents, status, submitted_by_user_id, submitted_at,
              paid_date, paid_at, origin, is_reversal, as_of_date, import_source_ref
            ) VALUES (?, 'import_baseline', '历史台账截点累计已付', ?, ?, 'paid', ?, ?, ?, ?, 'legacy_migration', 0, ?, ?)`,
          ).run(
            cid,
            c.currency,
            c.paidBaselineCents,
            userId,
            now,
            c.baselineAsOfDate ?? now.slice(0, 10),
            now,
            c.baselineAsOfDate,
            `${c.traces[0].sourceFile}#${c.traces[0].sourceSheet}:R${c.traces[0].sourceRow}`,
          );
        }
        if (c.receivedBaselineCents > 0n) {
          db.prepare(
            `INSERT INTO ct_receipt (
              contract_id, kind, node_name, currency, amount_cents, status, submitted_by_user_id, submitted_at,
              received_date, received_at, origin, is_reversal, as_of_date, import_source_ref
            ) VALUES (?, 'import_baseline', '历史台账截点累计已收', ?, ?, 'received', ?, ?, ?, ?, 'legacy_migration', 0, ?, ?)`,
          ).run(
            cid,
            c.currency,
            c.receivedBaselineCents,
            userId,
            now,
            c.baselineAsOfDate ?? now.slice(0, 10),
            now,
            c.baselineAsOfDate,
            `${c.traces[0].sourceFile}#${c.traces[0].sourceSheet}:R${c.traces[0].sourceRow}`,
          );
        }
        for (const cl of c.currencyLines) {
          insertCurrencyLineStmt.run(cid, cl.lineNo, cl.currency, cl.amountCents, cl.amountRole, now);
        }
        created++;
      } else if (c.action === 'update') {
        cid = c.existingContractId!;
        db.prepare(
          `UPDATE ct_contract SET
            sign_date = COALESCE(sign_date, ?),
            counterparty_names = CASE WHEN counterparty_names = '' THEN ? ELSE counterparty_names END,
            legacy_settled_baseline_cents = COALESCE(legacy_settled_baseline_cents, ?),
            legacy_invoiced_baseline_cents = COALESCE(legacy_invoiced_baseline_cents, ?),
            legacy_revenue_baseline_cents = COALESCE(legacy_revenue_baseline_cents, ?),
            baseline_as_of_date = COALESCE(baseline_as_of_date, ?),
            version = version + 1,
            updated_at = ?
          WHERE id = ?`,
        ).run(
          c.signDate,
          c.counterpartyNames,
          c.legacySettledBaselineCents,
          c.legacyInvoicedBaselineCents,
          c.legacyRevenueBaselineCents,
          c.baselineAsOfDate,
          now,
          cid,
        );
        updated++;
      } else {
        cid = c.existingContractId!;
        unchanged++;
      }

      for (const rev of c.settlementReversals) {
        const existsRev = db
          .prepare('SELECT 1 FROM ct_settlement WHERE contract_id = ? AND import_source_ref = ?')
          .get(cid, rev.importSourceRef);
        if (!existsRev) {
          const nextPeriod = (
            db.prepare('SELECT COALESCE(MAX(period_no), 0) + 1 AS n FROM ct_settlement WHERE contract_id = ?').get(cid) as { n: number }
          ).n;
          db.prepare(
            `INSERT INTO ct_settlement (
              contract_id, period_no, settlement_kind, settlement_date,
              in_contract_cents, change_claim_cents, other_add_cents, gross_payable_cents,
              deduct_prepayment_cents, deduct_retention_cents, deduct_penalty_cents, total_deduct_cents,
              net_payable_cents, note, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
              origin, migration_mode, is_reversal, reversal_reason, import_source_ref
            ) VALUES (?, ?, 'progress', ?, ?, 0, 0, ?, 0, 0, 0, 0, ?, ?, 'approved', ?, ?, ?, ?, 'legacy_migration', 'legacy_tolerant', 1, ?, ?)`,
          ).run(
            cid,
            nextPeriod,
            rev.settlementDate,
            rev.netPayableCents,
            rev.netPayableCents,
            rev.netPayableCents,
            rev.reversalReason,
            userId,
            now,
            userId,
            now,
            rev.reversalReason,
            rev.importSourceRef,
          );
        }
      }

      for (const chg of c.changeEvents) {
        const refTag = `${chg.sourceTrace.sourceFile}#${chg.sourceTrace.sourceSheet}:R${chg.sourceTrace.sourceRow}`;
        const existsChg = db
          .prepare("SELECT 1 FROM ct_change WHERE contract_id = ? AND origin = 'legacy_migration' AND change_matter = ?")
          .get(cid, refTag);
        if (!existsChg) {
          db.prepare(
            `INSERT INTO ct_change (
              contract_id, org_root_id, change_kind, delta_cents, change_matter, reason, evidence_document_id,
              required_approval_tier, actual_approval_tier, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, origin
            ) VALUES (?, ?, 'change', ?, ?, ?, NULL, 'undertaker_unit', 'undertaker_unit', 'approved', ?, ?, ?, ?, 'legacy_migration')`,
          ).run(cid, c.legalEntityOrgId, chg.deltaCents, refTag, chg.reason, userId, now, userId, now);
        }
      }

      for (const tr of c.traces) {
        insertTraceStmt.run(
          cid,
          importId,
          tr.sourceFile,
          tr.sourceFileSha256,
          tr.sourceSheet,
          tr.sourceRow,
          plan.pipelineVersion,
          tr.rawContractNo,
          tr.rawAmountText,
          tr.rawSignDate,
          tr.asOfDate,
          tr.isPrimary ? 1 : 0,
          tr.conflictFlags.join(','),
          now,
        );
      }

      contractIds.push(cid);
      if (c.isInternalGroupTx && c.internalGroupAgreementKey) {
        const list = idsByAgreementKey.get(c.internalGroupAgreementKey) ?? [];
        list.push({ id: cid, direction: c.direction });
        idsByAgreementKey.set(c.internalGroupAgreementKey, list);
      }
    }

    for (const [, pair] of idsByAgreementKey) {
      const exp = pair.find((p) => p.direction === 'expense');
      const inc = pair.find((p) => p.direction === 'income');
      if (exp && inc && exp.id !== inc.id) {
        db.prepare('UPDATE ct_contract SET counterparty_contract_id = ? WHERE id = ?').run(inc.id, exp.id);
        db.prepare('UPDATE ct_contract SET counterparty_contract_id = ? WHERE id = ?').run(exp.id, inc.id);
      }
    }
  }).immediate();

  const writeLockMs = Date.now() - tLockStart;
  return { created, updated, unchanged, contractIds, writeLockMs };
}
