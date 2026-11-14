/**
 * 合同导入(AC-F04 / AC-CLM-11):预览 → 确认。
 *
 * - 支持 standard_ledger、公司万元月报及纪巡财审 6 类模板自动识别。
 * - 预览落原件并记录 ct_import(import_kind、逐行计划动作、逐行错误、计划哈希),不写合同。
 * - 确认只能由预览人进行;按原件重算计划,与预览不一致返回 PREVIEW_STALE;有行错误拒绝;
 *   一个事务内完成全部写入,中途失败全部回滚、预览保持可重试;重复确认返回原结果。
 */
import crypto from 'crypto';
import path from 'path';
import ExcelJS from 'exceljs';
import type { DB } from '../../db/connection';
import { AppError, Errors, type RowError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, formatScaled, RATIO_SCALE } from '../../core/decimal';
import { assertFullScope, currentOrgScope, notVisible, orgInScope, type OrgScope } from '../security/scope';
import { storeFile, type ObjectStore } from '../files/object-store';
import { readTable, readWorkbookSheets } from '../io/table-reader';
import { amountCents, CellError, dateCell, findHeader, headerKey, headerUnit, ratioScaledCell } from '../io/cell-values';
import { resolveEntity } from '../master/master.service';
import {
  CONTRACT_CURRENCIES,
  CONTRACT_IMPORT_KINDS,
  CONTRACT_IMPORT_KIND_LABELS,
  type ContractImportAction,
  type ContractImportDto,
  type ContractImportKind,
  type ContractImportRowDto,
  type ContractStage,
  type LegacyReconciliationDto,
} from '../../contracts/project-contract';
import { normalizeContractNo, recordEvent } from './contract.service';
import {
  deriveLegalCategory, deriveProcurementTarget, hasHeaderSet, maxSignDate, MIN_SIGN_DATE,
  parseExchangeRateCell, parseMonthlyLedgerSheet, parseSupervisionBaseSheet, parseSupervisionChangeSheet, parseSupervisionExecSheets,
  type MonthlyPlanRow, type SupBasePlanRow, type SupChangePlanRow, type SupExecContractRow,
} from './contract-import-templates';
import { officialSheet, writeOfficialWorkbook } from './supervision-official-workbook';
import {
  commitLegacyMigrationPlan,
  computeLegacyMigrationPlan,
  type LegacyWorkbookInput,
} from './legacy-migration-pipeline';

const nowIso = () => new Date().toISOString();
const CURRENCY_SET = new Set<string>(CONTRACT_CURRENCIES);

export function assertContractMigratePrivilege(db: DB): void {
  const auth = currentAuth();
  if (auth) {
    const allowed =
      auth.permissions.has('contract:migrate') ||
      (auth.permissions.has('master:write') && auth.allOrgs);
    if (!allowed) {
      throw Errors.forbidden('历史容缺迁移需要专有权限 contract:migrate');
    }
  }
  const scope = currentOrgScope(db);
  if (!scope.all) {
    throw Errors.forbidden('历史容缺迁移需要全集团组织范围权限');
  }
}

const COLUMNS = {
  contractNo: ['合同编号', '合同编码', '合同号'],
  name: ['合同名称'],
  projectCode: ['项目编码', '项目代码', '项目编号'],
  supplier: ['供应商', '供应商名称', '乙方', '相对方'],
  amount: ['合同金额', '合同总额', '签约金额'],
  paid: ['已付款金额', '已付款', '累计已付款', '已付金额'],
  signDate: ['签订日期', '签约日期', '签署日期'],
  contractType: ['合同类型', '合同类别'],
  org: ['责任组织', '承办单位', '责任单位', '组织'],
  capRatio: ['付款上限比例', '付款比例上限', '最高付款比例'],
  currency: ['合同币种', '币种'],
  exchangeRate: ['参考汇率', '汇率'],
} as const;
type Col = keyof typeof COLUMNS;
const LABEL: Record<Col, string> = {
  contractNo: '合同编号', name: '合同名称', projectCode: '项目编码', supplier: '供应商', amount: '合同金额', paid: '已付款金额',
  signDate: '签订日期', contractType: '合同类型', org: '责任组织', capRatio: '付款上限比例',
  currency: '合同币种', exchangeRate: '参考汇率',
};
const REQUIRED: Col[] = ['contractNo', 'name', 'amount'];
const EARLY: ContractStage[] = ['initiation', 'procurement', 'drafting'];

interface PlanRow {
  row: number; contractNo: string; normalizedNo: string; name: string; contractType: string; orgId: number; projectId: number | null; supplierId: number | null;
  currency: string; exchangeRateScaled: bigint | null; amount: bigint; paid: bigint; signDate: string | null; capRatio: bigint | null;
  action: ContractImportAction; contractId: number | null; contractVersion: number | null; changes: Record<string, [string | null, string | null]>;
}
type PlanPayload =
  | { kind: 'standard_ledger'; rows: PlanRow[] }
  | { kind: 'monthly_ledger_wan'; rows: MonthlyPlanRow[] }
  | { kind: 'supervision_expense_base' | 'supervision_income_base'; rows: SupBasePlanRow[] }
  | { kind: 'supervision_expense_exec' | 'supervision_income_exec'; rows: SupExecContractRow[] }
  | { kind: 'supervision_expense_change' | 'supervision_income_change'; rows: SupChangePlanRow[] };

interface ComputedPlan { importKind: ContractImportKind; payload: PlanPayload; errors: RowError[]; rowCount: number; hash: string; display: ContractImportRowDto[] }

function hashPlan(kind: ContractImportKind, rows: unknown[], errors: RowError[]): string {
  const h = crypto.createHash('sha256');
  if (kind !== 'standard_ledger') h.update(kind);
  return h.update(JSON.stringify(rows, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))).update(JSON.stringify(errors)).digest('hex');
}

async function computeStandardPlan(db: DB, scope: OrgScope, content: Buffer, fileName: string): Promise<ComputedPlan> {
  const table = await readTable(content, fileName, undefined, {
    label: '合同台账表头(合同编号/合同名称/合同金额…)',
    isHeader: (cells) => { const keys = cells.map(headerKey); return REQUIRED.every((k) => COLUMNS[k].some((a) => keys.includes(a))); },
  });
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, a]) => [k, findHeader(table.headers, a)])) as Record<Col, string | null>;
  const unitOf = (h: string | null) => (h && headerUnit(h)) || 'yuan';
  const errors: RowError[] = [];
  const rows: PlanRow[] = [];
  const display: ContractImportRowDto[] = [];
  const seen = new Map<string, number>();
  const maxDate = maxSignDate();
  const projects = new Map((db.prepare('SELECT id, code, org_id, status FROM md_project').all() as { id: number; code: string; org_id: number; status: string }[]).map((p) => [p.code, p]));
  const orgNames = new Map((db.prepare('SELECT id, name FROM org').all() as { id: number; name: string }[]).map((o) => [o.id, o.name]));
  const supplierNames = new Map((db.prepare('SELECT id, name FROM md_supplier').all() as { id: number; name: string }[]).map((s) => [s.id, s.name]));
  if (table.rows.length === 0) errors.push({ row: 0, field: '文件', message: '没有数据行' });

  for (const r of table.rows) {
    const v = (k: Col) => (col[k] ? r.values[col[k]!] ?? '' : '');
    const rowErrors: RowError[] = [];
    const err = (k: Col, message: string) => rowErrors.push({ row: r.rowNo, field: LABEL[k], message });
    const cell = <T>(k: Col, fn: () => T): T | null => { try { return fn(); } catch (e) { if (e instanceof CellError) { err(k, e.message); return null; } throw e; } };
    for (const k of REQUIRED) if (!v(k)) err(k, `${LABEL[k]}不能为空`);
    const contractNo = v('contractNo').slice(0, 64);
    const normalizedNo = contractNo ? normalizeContractNo(contractNo) : '';
    if (normalizedNo) {
      if (seen.has(normalizedNo)) err('contractNo', `合同编号与第 ${seen.get(normalizedNo)} 行重复`);
      else seen.set(normalizedNo, r.rowNo);
    }
    const amount = v('amount') ? cell('amount', () => amountCents(v('amount'), unitOf(col.amount), '合同金额')) : null;
    if (amount !== null && amount <= 0n) err('amount', '合同金额必须大于 0');
    const paid = v('paid') ? cell('paid', () => amountCents(v('paid'), unitOf(col.paid), '已付款金额')) : 0n;
    if (paid !== null && paid < 0n) err('paid', '已付款金额不能为负');
    if (paid !== null && amount !== null && amount > 0n && paid > amount) err('paid', '已付款金额不能超过合同金额');
    const capRatio = v('capRatio') ? cell('capRatio', () => ratioScaledCell(v('capRatio'), '付款上限比例', { requirePercent: true })) : null;
    const signDate = v('signDate') ? cell('signDate', () => dateCell(v('signDate'), '签订日期')) : null;
    if (signDate && (signDate < MIN_SIGN_DATE || signDate > maxDate)) err('signDate', `签订日期 ${signDate} 不在 ${MIN_SIGN_DATE} 至 ${maxDate} 之间`);
    const currency = v('currency').trim() || '人民币';
    if (!CURRENCY_SET.has(currency)) err('currency', `合同币种「${currency}」不在官方枚举内`);
    const exchangeRateScaled = v('exchangeRate') ? cell('exchangeRate', () => parseExchangeRateCell(v('exchangeRate'))) : null;

    // 项目 → 组织;责任组织经主数据唯一解析(来源 contract),与项目归属一致
    let projectId: number | null = null;
    let orgId: number | null = null;
    if (v('projectCode')) {
      const p = projects.get(v('projectCode'));
      if (!p || !orgInScope(scope, p.org_id)) err('projectCode', `项目编码 ${v('projectCode')} 不存在或无权访问`);
      else if (p.status !== 'active') err('projectCode', `项目 ${v('projectCode')} 已停用`);
      else { projectId = p.id; orgId = p.org_id; }
    }
    if (v('org')) {
      const text = v('org');
      const res = resolveEntity(db, 'org', { code: text, name: text, sourceSystem: 'contract' });
      if (res.targetId === null || !orgInScope(scope, res.targetId)) {
        const cands = res.candidates.filter((c) => orgInScope(scope, c.id)).map((c) => c.name);
        err('org', res.matchedBy === 'ambiguous' && cands.length ? `责任组织“${text}”对应多个组织:${cands.join('、')}` : `责任组织“${text}”未匹配到组织`);
      } else if (orgId !== null && res.targetId !== orgId) err('org', `责任组织“${text}”与项目归属组织不一致`);
      else orgId = res.targetId;
    } else if (orgId === null && !rowErrors.some((e) => e.field === '项目编码')) err('org', '责任组织与项目编码至少填写一项');
    let supplierId: number | null = null;
    if (v('supplier')) {
      const res = resolveEntity(db, 'supplier', { code: v('supplier'), name: v('supplier'), sourceSystem: 'contract' });
      if (res.targetId === null) {
        err('supplier', res.matchedBy === 'ambiguous' ? `供应商“${v('supplier')}”对应多个:${res.candidates.map((c) => c.name).join('、')}` : `供应商“${v('supplier')}”未在主数据中找到`);
      } else supplierId = res.targetId;
    }

    let action: ContractImportAction | null = null;
    let contractId: number | null = null;
    let contractVersion: number | null = null;
    const changes: Record<string, [string | null, string | null]> = {};
    if (normalizedNo && !rowErrors.length) {
      const ex = db.prepare('SELECT * FROM ct_contract WHERE normalized_no = ?').safeIntegers(true).get(normalizedNo) as Record<string, unknown> | undefined;
      if (!ex) action = 'create';
      else if (!orgInScope(scope, Number(ex.org_id))) err('contractNo', `合同编号 ${contractNo} 已被其他组织使用`);
      else {
        contractId = Number(ex.id);
        contractVersion = Number(ex.version);
        const status = String(ex.status);
        const stage = String(ex.stage) as ContractStage;
        const current = (ex.original_cents as bigint) + (ex.approved_change_cents as bigint);
        if (Number(ex.org_id) !== orgId) err('org', '责任组织与已有合同不一致,不能通过导入修改');
        if ((projectId ?? null) !== (ex.project_id === null ? null : Number(ex.project_id))) err('projectCode', '项目与已有合同不一致,不能通过导入修改');
        if (amount !== null && amount !== current) err('amount', `合同金额 ${centsToDecimalString(amount)} 与已有合同当前金额 ${centsToDecimalString(current)} 不一致,须走变更流程`);
        const diff = (key: string, before: string | null, after: string | null) => { if (before !== after) changes[key] = [before, after]; };
        diff('name', String(ex.name), v('name'));
        if (v('contractType')) diff('contractType', String(ex.contract_type), v('contractType'));
        if (signDate) diff('signDate', (ex.sign_date as string | null) ?? null, signDate);
        const exSupplier = ex.supplier_id === null ? null : Number(ex.supplier_id);
        if (supplierId !== null && supplierId !== exSupplier) {
          if (!EARLY.includes(stage)) err('supplier', '合同起草之后不能通过导入更换供应商');
          else diff('supplier', exSupplier === null ? null : supplierNames.get(exSupplier) ?? null, supplierNames.get(supplierId) ?? null);
        }
        const exCap = ex.payment_cap_ratio_scaled === null ? null : formatScaled(ex.payment_cap_ratio_scaled as bigint, RATIO_SCALE);
        if (capRatio !== null) diff('paymentCapRatio', exCap, formatScaled(capRatio, RATIO_SCALE));
        if (exchangeRateScaled !== null && String(ex.exchange_rate_scaled ?? '') !== String(exchangeRateScaled)) {
          diff('exchangeRate', ex.exchange_rate_scaled == null ? null : formatScaled(ex.exchange_rate_scaled as bigint, RATIO_SCALE), formatScaled(exchangeRateScaled, RATIO_SCALE));
        }
        const exPaid = ex.paid_cents as bigint;
        if (paid !== null && paid !== exPaid && (ex.currency !== '人民币' || ex.direction !== 'expense')) err('paid', '标准台账已付款仅支持人民币支出合同；其他币种/收入须用对应执行明细模板');
        if (paid !== null && paid !== exPaid) {
          const normal = db.prepare("SELECT COUNT(*) AS n FROM ct_payment WHERE contract_id = ? AND kind = 'normal' AND status <> 'rejected'").get(contractId) as { n: number };
          if (normal.n) err('paid', '已有正式付款记录,不能通过导入修改已付款金额');
          else if (paid === 0n) err('paid', '不能通过导入把已付款金额改为 0');
          else diff('paid', centsToDecimalString(exPaid), centsToDecimalString(paid));
        }
        if (status !== 'active' && Object.keys(changes).length) err('contractNo', `合同已${status === 'closed' ? '关闭' : status === 'terminated' ? '终止' : '作废'},不能通过导入更新`);
        action = Object.keys(changes).length ? 'update' : 'unchanged';
      }
    }
    display.push({
      row: r.rowNo, contractNo, name: v('name'), action: rowErrors.length ? null : action, contractId, orgName: orgId ? orgNames.get(orgId) ?? null : null,
      projectCode: v('projectCode') || null, supplierName: supplierId ? supplierNames.get(supplierId) ?? null : null,
      amount: amount === null ? null : centsToDecimalString(amount), paid: paid === null ? null : centsToDecimalString(paid), signDate,
      direction: 'expense', currency, exchangeRate: exchangeRateScaled === null ? null : formatScaled(exchangeRateScaled, RATIO_SCALE),
      changes,
    });
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    rows.push({
      row: r.rowNo, contractNo, normalizedNo, name: v('name').slice(0, 200), contractType: v('contractType').slice(0, 50), orgId: orgId!, projectId, supplierId,
      currency, exchangeRateScaled, amount: amount!, paid: paid!, signDate, capRatio, action: action!, contractId, contractVersion, changes,
    });
  }
  // 计划哈希:逐行动作 + 目标合同版本 + 写入值;库内合同变化或文件变化都会改变哈希
  const hash = hashPlan('standard_ledger', rows, errors);
  return { importKind: 'standard_ledger', payload: { kind: 'standard_ledger', rows }, errors, rowCount: table.rows.length, hash, display };
}

async function computePlan(db: DB, scope: OrgScope, content: Buffer, fileName: string, defaultOrgId?: number | null): Promise<ComputedPlan> {
  const ext = path.extname(fileName).toLowerCase();
  if (!['.xlsx', '.xls'].includes(ext)) {
    return computeStandardPlan(db, scope, content, fileName);
  }
  const sheets = await readWorkbookSheets(content);
  const visible = sheets.filter((s) => !s.hidden);
  const monthlySheet = visible.find((s) => s.name === '02_合同台账总表' || hasHeaderSet(s, ['合同编号', '合同名称', '初始签订合同金额']));
  if (monthlySheet) {
    const p = parseMonthlyLedgerSheet(db, scope, monthlySheet, defaultOrgId, visible);
    return { importKind: 'monthly_ledger_wan', payload: { kind: 'monthly_ledger_wan', rows: p.rows }, errors: p.errors, rowCount: p.rowCount, hash: hashPlan('monthly_ledger_wan', p.rows, p.errors), display: p.display };
  }
  const expBase = visible.find((s) => hasHeaderSet(s, ['合同编号', '合同名称', '计价方式', '合同币种', '资金来源']));
  if (expBase) {
    const p = parseSupervisionBaseSheet(db, scope, expBase, 'expense', defaultOrgId);
    return { importKind: 'supervision_expense_base', payload: { kind: 'supervision_expense_base', rows: p.rows }, errors: p.errors, rowCount: p.rowCount, hash: hashPlan('supervision_expense_base', p.rows, p.errors), display: p.display };
  }
  const incBase = visible.find((s) => hasHeaderSet(s, ['合同编号', '合同名称', '计价方式', '合同币种']) && (hasHeaderSet(s, ['合同取得方式']) || hasHeaderSet(s, ['是否进行业主资信调查'])));
  if (incBase) {
    const p = parseSupervisionBaseSheet(db, scope, incBase, 'income', defaultOrgId);
    return { importKind: 'supervision_income_base', payload: { kind: 'supervision_income_base', rows: p.rows }, errors: p.errors, rowCount: p.rowCount, hash: hashPlan('supervision_income_base', p.rows, p.errors), display: p.display };
  }
  const expExec = visible.find((s) => hasHeaderSet(s, ['合同编号', '合同名称', '合同执行状态']) && (hasHeaderSet(s, ['是否按照约定提交成果']) || hasHeaderSet(s, ['是否最终验收']) || s.name.includes('支出')));
  if (expExec) {
    const p = parseSupervisionExecSheets(db, scope, visible, 'expense');
    return { importKind: 'supervision_expense_exec', payload: { kind: 'supervision_expense_exec', rows: p.rows }, errors: p.errors, rowCount: p.rowCount, hash: hashPlan('supervision_expense_exec', p.rows, p.errors), display: p.display };
  }
  const incExec = visible.find((s) => hasHeaderSet(s, ['合同编号', '合同名称', '合同执行状态']) && (hasHeaderSet(s, ['是否验收']) || s.name.includes('收入')));
  if (incExec) {
    const p = parseSupervisionExecSheets(db, scope, visible, 'income');
    return { importKind: 'supervision_income_exec', payload: { kind: 'supervision_income_exec', rows: p.rows }, errors: p.errors, rowCount: p.rowCount, hash: hashPlan('supervision_income_exec', p.rows, p.errors), display: p.display };
  }
  const expChange = visible.find((s) => hasHeaderSet(s, ['原合同编号', '变动类型', '变更补充协议编号']) && (hasHeaderSet(s, ['变更决策方式']) || s.name.includes('支出')));
  if (expChange) {
    const p = parseSupervisionChangeSheet(db, scope, expChange, 'expense');
    return { importKind: 'supervision_expense_change', payload: { kind: 'supervision_expense_change', rows: p.rows }, errors: p.errors, rowCount: p.rowCount, hash: hashPlan('supervision_expense_change', p.rows, p.errors), display: p.display };
  }
  const incChange = visible.find((s) => hasHeaderSet(s, ['原合同编号', '变动类型', '变更补充协议编号']));
  if (incChange) {
    const p = parseSupervisionChangeSheet(db, scope, incChange, 'income');
    return { importKind: 'supervision_income_change', payload: { kind: 'supervision_income_change', rows: p.rows }, errors: p.errors, rowCount: p.rowCount, hash: hashPlan('supervision_income_change', p.rows, p.errors), display: p.display };
  }
  return computeStandardPlan(db, scope, content, fileName);
}

interface ImportRow {
  id: number;
  import_kind: ContractImportKind | 'legacy_batch_upsert';
  import_mode?: 'standard' | 'legacy_tolerant';
  pipeline_version?: string;
  reconciliation_json?: string | null;
  file_object_id: number; file_sha256: string; file_name: string; row_count: number; error_count: number; plan_hash: string; plan_json: string;
  errors_json: string; status: 'previewed' | 'confirmed'; result_json: string | null; created_by_user_id: number | null; created_at: string; confirmed_at: string | null;
}

interface StoredLegacyFileRef {
  fileObjectId: number;
  sha256: string;
  fileName: string;
  defaultOrgId?: number | null;
  batchGroup?: string;
  asOfDate?: string | null;
}

function parsePlanJson(planJson: string): {
  rows: ContractImportRowDto[];
  defaultOrgId?: number | null;
  fileRefs?: StoredLegacyFileRef[];
} {
  const parsed = JSON.parse(planJson);
  if (Array.isArray(parsed)) return { rows: parsed as ContractImportRowDto[] };
  return {
    rows: (parsed.rows ?? []) as ContractImportRowDto[],
    defaultOrgId: parsed.defaultOrgId ?? null,
    fileRefs: Array.isArray(parsed.fileRefs) ? (parsed.fileRefs as StoredLegacyFileRef[]) : undefined,
  };
}

function importDto(r: ImportRow, extra: Partial<ContractImportDto> = {}): ContractImportDto {
  const { rows } = parsePlanJson(r.plan_json);
  const counts: Record<ContractImportAction, number> = { create: 0, update: 0, unchanged: 0 };
  let missingFieldCount = 0;
  let syntheticNoCount = 0;
  let reversalCount = 0;
  for (const row of rows) {
    if (row.action) counts[row.action]++;
    if (row.missingFields && row.missingFields.length > 0) missingFieldCount++;
    if (row.syntheticNoFlag) syntheticNoCount++;
    if (row.isReversal) reversalCount++;
  }
  const reconciliation: LegacyReconciliationDto | null = r.reconciliation_json
    ? (JSON.parse(r.reconciliation_json) as LegacyReconciliationDto)
    : null;
  const isIncome =
    r.import_kind === 'supervision_income_base' ||
    r.import_kind === 'supervision_income_exec' ||
    r.import_kind === 'supervision_income_change' ||
    (rows.length > 0 && rows.every((x) => x.direction === 'income'));
  return {
    id: r.id,
    importKind: r.import_kind,
    importMode: r.import_mode ?? 'standard',
    paidOrReceivedLabel: isIncome ? '已收金额' : '已付金额',
    missingFieldCount,
    syntheticNoCount,
    reversalCount,
    duplicateSkippedCount: reconciliation ? reconciliation.foldedDuplicateRows : 0,
    reconciliation,
    fileName: r.file_name, fileSha256: r.file_sha256, status: r.status, rowCount: r.row_count, errorCount: r.error_count, errors: JSON.parse(r.errors_json),
    rows, counts, planHash: r.plan_hash, createdAt: r.created_at, confirmedAt: r.confirmed_at, result: r.result_json ? JSON.parse(r.result_json) : null, ...extra,
  };
}

function importRow(db: DB, id: number): ImportRow {
  const r = db.prepare('SELECT * FROM ct_import WHERE id = ?').get(id) as ImportRow | undefined;
  const auth = currentAuth();
  // 预览记录只对预览人可见(含逐行错误与组织名);其他人一律 404
  if (!r || (auth && r.created_by_user_id !== auth.userId)) throw notVisible('合同导入预览');
  return r;
}

export interface PreviewImportOptions {
  importMode?: 'standard' | 'legacy_tolerant';
  extraFiles?: { buffer: Buffer; fileName: string; batchGroup?: string; asOfDate?: string | null }[];
  batchGroup?: string;
  asOfDate?: string | null;
}

export async function previewContractImport(
  db: DB,
  store: ObjectStore,
  content: Buffer,
  fileName: string,
  defaultOrgId?: number | null,
  opts: PreviewImportOptions = {},
): Promise<ContractImportDto> {
  const importMode = opts.importMode ?? 'standard';
  if (importMode === 'legacy_tolerant') {
    assertContractMigratePrivilege(db);
    const allFiles = [
      { buffer: content, fileName, batchGroup: opts.batchGroup, asOfDate: opts.asOfDate },
      ...(opts.extraFiles ?? []),
    ];
    const fileRefs: StoredLegacyFileRef[] = [];
    const workbooks: LegacyWorkbookInput[] = [];
    for (const f of allFiles) {
      const stored = storeFile(db, store, f.buffer, { originalName: f.fileName });
      fileRefs.push({
        fileObjectId: stored.id,
        sha256: stored.sha256,
        fileName: f.fileName,
        defaultOrgId: defaultOrgId ?? null,
        batchGroup: f.batchGroup,
        asOfDate: f.asOfDate ?? null,
      });
      workbooks.push({
        fileName: f.fileName,
        content: f.buffer,
        defaultOrgId: defaultOrgId ?? null,
        batchGroup: f.batchGroup,
        asOfDate: f.asOfDate ?? null,
      });
    }
    const legacyPlan = await computeLegacyMigrationPlan(db, workbooks);
    const displayFileName =
      allFiles.length === 1 ? fileName.slice(0, 255) : `${fileName} 等 ${allFiles.length} 份历史台账`.slice(0, 255);
    const serializedPlan = JSON.stringify({
      defaultOrgId: defaultOrgId ?? null,
      fileRefs,
      rows: legacyPlan.displayRows,
    });
    const id = Number(
      db
        .prepare(
          `INSERT INTO ct_import (
            import_kind, import_mode, pipeline_version, reconciliation_json,
            file_object_id, file_sha256, file_name, row_count, error_count, plan_hash, plan_json, errors_json, created_by_user_id, created_at
          ) VALUES ('legacy_batch_upsert', 'legacy_tolerant', ?, ?, ?, ?, ?, ?, 0, ?, ?, '[]', ?, ?)`,
        )
        .run(
          legacyPlan.pipelineVersion,
          JSON.stringify(legacyPlan.reconciliation),
          fileRefs[0].fileObjectId,
          fileRefs[0].sha256,
          displayFileName,
          legacyPlan.displayRows.length,
          legacyPlan.planHash,
          serializedPlan,
          currentAuth()?.userId ?? null,
          nowIso(),
        ).lastInsertRowid,
    );
    return importDto(importRow(db, id));
  }

  const scope = currentOrgScope(db);
  if (defaultOrgId != null && !orgInScope(scope, defaultOrgId)) throw notVisible('组织');
  const plan = await computePlan(db, scope, content, fileName, defaultOrgId);
  const file = storeFile(db, store, content, { originalName: fileName });
  const serializedPlan = defaultOrgId != null ? JSON.stringify({ defaultOrgId, rows: plan.display }) : JSON.stringify(plan.display);
  const id = Number(db.prepare(`INSERT INTO ct_import (import_kind, import_mode, file_object_id, file_sha256, file_name, row_count, error_count, plan_hash, plan_json, errors_json, created_by_user_id, created_at)
    VALUES (?, 'standard', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.importKind, file.id, file.sha256, fileName.slice(0, 255), plan.rowCount, plan.errors.length, plan.hash, serializedPlan,
    JSON.stringify(plan.errors.slice(0, 500)), currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
  return importDto(importRow(db, id));
}

export function getContractImport(db: DB, id: number): ContractImportDto {
  return importDto(importRow(db, id));
}

export function listContractImports(
  db: DB,
  filter: { importMode?: 'standard' | 'legacy_tolerant'; status?: 'previewed' | 'confirmed'; limit?: number } = {},
): ContractImportDto[] {
  const auth = currentAuth();
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (auth && !auth.allOrgs) {
    where.push('created_by_user_id = ?');
    params.push(auth.userId);
  }
  if (filter.importMode) {
    where.push('import_mode = ?');
    params.push(filter.importMode);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = db
    .prepare(`SELECT * FROM ct_import WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as ImportRow[];
  return rows.map((r) => importDto(r));
}

export async function generateContractImportTemplate(
  kind: ContractImportKind,
): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  if (!(CONTRACT_IMPORT_KINDS as readonly string[]).includes(kind)) {
    throw Errors.validation(`不支持的合同导入模板类型: ${String(kind)}`);
  }
  const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (kind === 'standard_ledger') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('标准合同台账');
    ws.addRow(['合同编号', '合同名称', '责任组织', '项目编码', '供应商', '合同金额(元)', '已付款金额(元)', '签订日期', '合同类型', '付款上限比例', '合同币种', '参考汇率']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return { fileName: '标准合同台账导入模板.xlsx', contentType, content: buf };
  }
  if (kind === 'monthly_ledger_wan') {
    const wb = new ExcelJS.Workbook();
    const wsMain = wb.addWorksheet('02_合同台账总表');
    wsMain.addRow(['序号', '类别', '合同编号', '合同名称', '年度计划项目名称', '初始签订合同金额', '支出/收入', '签订日期', '工期', '对方单位名称', '采购方式', '承办部门', '承办人', '执行情况', '备注', '币种', '参考汇率']);
    const wsSettle = wb.addWorksheet('03_结算动态分表');
    wsSettle.addRow(['序号', '合同编号', '合同名称', '初始签订合同金额', '累计结算金额', '累计已付金额', '备注']);
    const wsChange = wb.addWorksheet('04_变更动态分表');
    wsChange.addRow(['序号', '合同编号', '合同名称', '累计变更金额', '备注']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return { fileName: '公司月报合同台账导入模板.xlsx', contentType, content: buf };
  }

  const wb = new ExcelJS.Workbook();
  if (kind === 'supervision_expense_base') officialSheet(wb, '支出合同基本信息');
  else if (kind === 'supervision_expense_exec') {
    officialSheet(wb, '支出合同执行信息');
    officialSheet(wb, '实际支付时间与金额');
  } else if (kind === 'supervision_expense_change') officialSheet(wb, '支出合同变更');
  else if (kind === 'supervision_income_base') officialSheet(wb, '收入合同基本信息');
  else if (kind === 'supervision_income_exec') {
    officialSheet(wb, '收入合同执行信息');
    officialSheet(wb, '实际收款时间与金额');
  } else if (kind === 'supervision_income_change') officialSheet(wb, '收入合同变更');

  const buf = await writeOfficialWorkbook(wb);
  return { fileName: `${CONTRACT_IMPORT_KIND_LABELS[kind]}模板.xlsx`, contentType, content: buf };
}

export async function confirmContractImport(db: DB, store: ObjectStore, id: number, expectedPlanHash: string): Promise<ContractImportDto> {
  const auth = currentAuth();
  const imp = db.prepare('SELECT * FROM ct_import WHERE id = ?').get(id) as ImportRow | undefined;
  if (!imp) throw notVisible('合同导入预览');
  if (auth && imp.created_by_user_id !== auth.userId) throw new AppError('PREVIEW_OWNER_MISMATCH', '只能由预览人确认本次导入', 403);
  if (imp.status === 'confirmed') return importDto(imp, { replayed: true });
  if (imp.error_count > 0) throw new AppError('IMPORT_INVALID', `预览有 ${imp.error_count} 项行错误,不能确认;请修正文件后重新预览`, 422, JSON.parse(imp.errors_json));
  if (expectedPlanHash !== imp.plan_hash) throw new AppError('PREVIEW_STALE', '确认的预览与服务端记录不一致,请重新预览', 409);

  if (imp.import_mode === 'legacy_tolerant' || imp.import_kind === 'legacy_batch_upsert') {
    assertContractMigratePrivilege(db);
    const { defaultOrgId, fileRefs } = parsePlanJson(imp.plan_json);
    const refs: StoredLegacyFileRef[] = fileRefs && fileRefs.length > 0
      ? fileRefs
      : [{ fileObjectId: imp.file_object_id, sha256: imp.file_sha256, fileName: imp.file_name, defaultOrgId }];
    const workbooks: LegacyWorkbookInput[] = refs.map((ref) => ({
      fileName: ref.fileName,
      content: store.read(ref.sha256),
      defaultOrgId: ref.defaultOrgId ?? defaultOrgId ?? null,
      batchGroup: ref.batchGroup,
      asOfDate: ref.asOfDate ?? null,
    }));
    const recomputed = await computeLegacyMigrationPlan(db, workbooks);
    if (recomputed.planHash !== imp.plan_hash) {
      throw new AppError('PREVIEW_STALE', '预览后库内合同或主数据已发生变化,请重新执行多簿预检', 409);
    }
    db.transaction(() => {
      const fresh = db.prepare('SELECT status FROM ct_import WHERE id = ?').get(id) as { status: string };
      if (fresh.status === 'confirmed') return;
      const res = commitLegacyMigrationPlan(db, recomputed, { importId: id, userId: auth?.userId ?? null });
      const now = nowIso();
      db.prepare(
        "UPDATE ct_import SET status = 'confirmed', result_json = ?, reconciliation_json = ?, confirmed_at = ? WHERE id = ? AND status = 'previewed'",
      ).run(
        JSON.stringify({ created: res.created, updated: res.updated, unchanged: res.unchanged, contractIds: res.contractIds }),
        JSON.stringify(recomputed.reconciliation),
        now,
        id,
      );
    }).immediate();
    return importDto(importRow(db, id));
  }

  const f = db.prepare('SELECT sha256 FROM file_object WHERE id = ?').get(imp.file_object_id) as { sha256: string };
  const scope = currentOrgScope(db);
  const { defaultOrgId } = parsePlanJson(imp.plan_json);
  // 长解析不在写事务里:先重算计划,事务内再核对哈希一致
  const plan = await computePlan(db, scope, store.read(f.sha256), imp.file_name, defaultOrgId);
  if (plan.errors.length) throw new AppError('IMPORT_INVALID', `重新校验发现 ${plan.errors.length} 项行错误,未写入任何数据`, 422, plan.errors.slice(0, 500));
  if (plan.hash !== imp.plan_hash) throw new AppError('PREVIEW_STALE', '预览后库内合同或主数据已变化,导入计划与预览不一致,请重新预览', 409);
  assertFullScope(scope, plan.payload.rows.map((r) => r.orgId), '合同导入');
  db.transaction(() => {
    const fresh = db.prepare('SELECT status FROM ct_import WHERE id = ?').get(id) as { status: string };
    if (fresh.status === 'confirmed') return;
    // 事务内核对目标合同版本未变(计算计划与加写锁之间可能有并发写)
    for (const r of plan.payload.rows) {
      const ex = db.prepare('SELECT id, version FROM ct_contract WHERE normalized_no = ?').get(r.normalizedNo) as { id: number; version: number } | undefined;
      if ((ex?.id ?? null) !== r.contractId || (ex?.version ?? null) !== r.contractVersion) throw new AppError('PREVIEW_STALE', `合同 ${r.contractNo} 在预览后发生变化,请重新预览`, 409);
    }
    const now = nowIso();
    const userId = auth?.userId ?? null;
    const ids: number[] = [];
    let created = 0; let updated = 0; let unchanged = 0;
    if (plan.payload.kind === 'standard_ledger') {
      for (const r of plan.payload.rows) {
        if (r.action === 'create') {
          const stage: ContractStage = r.signDate ? 'performance' : 'initiation';
          const cid = Number(db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id, original_cents, paid_cents,
            payment_cap_ratio_scaled, currency, exchange_rate_scaled, stage, sign_date, source, origin, import_id, created_by_user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', 'standard_import', ?, ?, ?, ?)`).run(
            r.contractNo, r.normalizedNo, r.name, r.contractType, r.orgId, r.projectId, r.supplierId, r.amount, r.paid, r.capRatio, r.currency, r.exchangeRateScaled, stage, r.signDate, id, userId, now, now).lastInsertRowid);
          if (r.paid > 0n) insertBaseline(db, cid, r.paid, now, userId, r.currency);
          recordEvent(db, cid, 'import.create', { importId: id, row: r.row, amount: centsToDecimalString(r.amount), paid: centsToDecimalString(r.paid) }, { to: stage });
          ids.push(cid); created++;
        } else if (r.action === 'update') {
          const cid = r.contractId!;
          const sets = ['name = ?'];
          const params: unknown[] = [r.name];
          if (r.changes.contractType) { sets.push('contract_type = ?'); params.push(r.contractType); }
          if (r.changes.signDate) { sets.push('sign_date = ?'); params.push(r.signDate); }
          if (r.changes.supplier) { sets.push('supplier_id = ?'); params.push(r.supplierId); }
          if (r.changes.paymentCapRatio) { sets.push('payment_cap_ratio_scaled = ?'); params.push(r.capRatio); }
          if (r.changes.exchangeRate) { sets.push('exchange_rate_scaled = ?'); params.push(r.exchangeRateScaled); }
          if (r.changes.paid) {
            sets.push('paid_cents = ?'); params.push(r.paid);
            const baseline = db.prepare("SELECT id FROM ct_payment WHERE contract_id = ? AND kind = 'import_baseline'").get(cid) as { id: number } | undefined;
            if (baseline) db.prepare('UPDATE ct_payment SET amount_cents = ? WHERE id = ?').run(r.paid, baseline.id);
            else insertBaseline(db, cid, r.paid, now, userId, r.currency);
          }
          db.prepare(`UPDATE ct_contract SET ${sets.join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`).run(...params, now, cid);
          recordEvent(db, cid, 'import.update', { importId: id, row: r.row, changes: r.changes });
          ids.push(cid); updated++;
        } else unchanged++;
      }
    } else if (plan.payload.kind === 'monthly_ledger_wan') {
      const docCache = new Map<number, number>();
      for (const r of plan.payload.rows) {
        if (r.action === 'create') {
          const paidCents = r.direction === 'expense' ? r.subPaidOrReceivedCents : 0n;
          const recCents = r.direction === 'income' ? r.subPaidOrReceivedCents : 0n;
          const cid = Number(db.prepare(`INSERT INTO ct_contract (
            contract_no, normalized_no, name, contract_type, report_category, legal_category, party_role, procurement_target, procurement_method,
            org_id, supplier_id, direction, pricing_mode, unit_price_desc, currency, exchange_rate_scaled,
            original_cents, approved_change_cents, settled_gross_cents, settled_net_cents, paid_cents, received_cents,
            sign_date, term_condition_text,
            counterparty_names, undertaker_dept, undertaker_name, remark, stage, status, source, origin, import_id, created_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', 'standard_import', ?, ?, ?, ?)`).run(
            r.contractNo, r.normalizedNo, r.name, r.contractType, r.reportCategory, deriveLegalCategory(r.reportCategory),
            r.direction === 'income' ? 'seller' : 'buyer', deriveProcurementTarget(r.reportCategory), r.procurementMethod,
            r.orgId, r.supplierId, r.direction, r.pricingMode, r.unitPriceDesc, r.currency, r.exchangeRateScaled,
            r.originalCents, r.subChangeDeltaCents, r.subSettledCents >= 0n ? r.subSettledCents : 0n, r.subSettledCents >= 0n ? r.subSettledCents : 0n, paidCents, recCents,
            r.signDate, r.termConditionText,
            r.counterpartyNames, r.undertakerDept, r.undertakerName, r.remark, r.targetStage, r.targetStatus, id, userId, now, now,
          ).lastInsertRowid);
          if (r.subChangeDeltaCents !== 0n) {
            let docId = docCache.get(cid);
            if (!docId) {
              docId = Number(db.prepare(`INSERT INTO ct_document (contract_id, doc_type, evidence_kind, file_object_id, name, uploaded_by_user_id, uploaded_at)
                VALUES (?, 'change', 'change_agreement', ?, ?, ?, ?)`).run(cid, imp.file_object_id, `月报变更分表(${imp.file_name})`.slice(0, 200), userId, now).lastInsertRowid);
              docCache.set(cid, docId);
            }
            db.prepare(`INSERT INTO ct_change (
              contract_id, org_root_id, change_kind, delta_cents, change_matter, reason, evidence_document_id,
              required_approval_tier, actual_approval_tier, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, origin
            ) VALUES (?, ?, 'change', ?, '月报变更分表基线', '月报变更分表导入', ?, 'undertaker_unit', 'undertaker_unit', 'approved', ?, ?, ?, ?, 'standard_import')`).run(
              cid, r.orgId, r.subChangeDeltaCents, docId, userId, now, userId, now,
            );
          }
          if (r.subPaidOrReceivedCents > 0n) {
            if (r.direction === 'expense') insertBaseline(db, cid, r.subPaidOrReceivedCents, now, userId, r.currency);
            else {
              db.prepare(`INSERT INTO ct_receipt (contract_id, kind, node_name, currency, amount_cents, status, submitted_by_user_id, submitted_at, received_date, received_by_user_id, received_at, origin)
                VALUES (?, 'import_baseline', '导入累计已收', ?, ?, 'received', ?, ?, ?, ?, ?, 'standard_import')`).run(
                cid, r.currency, r.subPaidOrReceivedCents, userId, now, r.signDate ?? now.slice(0, 10), userId, now,
              );
            }
          }
          recordEvent(db, cid, 'import.create', { importId: id, importKind: 'monthly_ledger_wan', row: r.row }, { to: r.targetStage });
          ids.push(cid); created++;
        } else if (r.action === 'update') {
          const cid = r.contractId!;
          db.prepare(`UPDATE ct_contract SET name = ?, sign_date = COALESCE(?, sign_date), undertaker_name = COALESCE(NULLIF(?, ''), undertaker_name),
            undertaker_dept = COALESCE(NULLIF(?, ''), undertaker_dept), counterparty_names = COALESCE(NULLIF(?, ''), counterparty_names),
            exchange_rate_scaled = COALESCE(?, exchange_rate_scaled),
            version = version + 1, updated_at = ? WHERE id = ?`).run(r.name, r.signDate, r.undertakerName, r.undertakerDept, r.counterpartyNames, r.exchangeRateScaled, now, cid);
          recordEvent(db, cid, 'import.update', { importId: id, importKind: 'monthly_ledger_wan', row: r.row, changes: r.changes });
          ids.push(cid); updated++;
        } else unchanged++;
      }
    } else if (plan.payload.kind === 'supervision_expense_base' || plan.payload.kind === 'supervision_income_base') {
      for (const r of plan.payload.rows) {
        if (r.action === 'create') {
          const stage: ContractStage = r.signDate ? 'performance' : 'initiation';
          const cid = Number(db.prepare(`INSERT INTO ct_contract (
            contract_no, normalized_no, name, contract_type, report_category, legal_category, party_role,
            is_procurement, procurement_target, procurement_method, procurement_method_other,
            org_id, supplier_id, direction, pricing_mode, unit_price_desc, currency, exchange_rate_scaled, original_cents,
            counterparty_names, summary_text, remark, funding_source, funding_source_detail, source_income_contract_id,
            entrust_reason, is_triple_major, decision_method, decision_method_other, meeting_type, meeting_type_other,
            final_approver_name, final_approver_title, is_gov_procurement, procurement_plan_text,
            procurement_start_date, supplier_confirm_date, response_docs_complete, credit_checked,
            undertaker_name, dept_reviewer_name, related_mgmt_depts, related_mgmt_reviewers, unit_approver_name, unit_approver_title,
            acquisition_method, acquisition_method_other, tender_body_type, consortium_members,
            sign_date, term_type, term_start_date, term_end_date, term_condition_text,
            our_signatory_name, our_signatory_title, our_signatory_is_legal_rep, counterparty_signatory_is_legal_rep,
            stage, status, source, origin, import_id, created_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'import', 'standard_import', ?, ?, ?, ?)`).run(
            r.contractNo, r.normalizedNo, r.name, r.contractType, r.reportCategory, deriveLegalCategory(r.reportCategory),
            r.direction === 'income' ? 'seller' : 'buyer',
            r.direction === 'expense' ? 1 : 0, deriveProcurementTarget(r.reportCategory), r.procurementMethod, r.procurementMethodOther,
            r.orgId, r.supplierId, r.direction, r.pricingMode, r.unitPriceDesc, r.currency, r.exchangeRateScaled, r.originalCents,
            r.counterpartyNames, r.summaryText, r.remark, r.fundingSource, r.fundingSourceDetail, r.sourceIncomeContractId,
            r.entrustReason, r.isTripleMajor ? 1 : 0, r.decisionMethod, r.decisionMethodOther, r.meetingType, r.meetingTypeOther,
            r.finalApproverName, r.finalApproverTitle, r.isGovProcurement ? 1 : 0, r.procurementPlanText,
            r.procurementStartDate, r.supplierConfirmDate, r.responseDocsComplete === null ? null : (r.responseDocsComplete ? 1 : 0),
            r.creditChecked === null ? null : (r.creditChecked ? 1 : 0),
            r.undertakerName, r.deptReviewerName, r.relatedMgmtDepts, r.relatedMgmtReviewers, r.unitApproverName, r.unitApproverTitle,
            r.acquisitionMethod, r.acquisitionMethodOther, r.tenderBodyType, r.consortiumMembers,
            r.signDate, r.termType, r.termStartDate, r.termEndDate, r.termConditionText,
            r.ourSignatoryName, r.ourSignatoryTitle, r.ourSignatoryIsLegalRep === null ? null : (r.ourSignatoryIsLegalRep ? 1 : 0),
            r.counterpartySignatoryIsLegalRep === null ? null : (r.counterpartySignatoryIsLegalRep ? 1 : 0),
            stage, id, userId, now, now,
          ).lastInsertRowid);
          recordEvent(db, cid, 'import.create', { importId: id, importKind: plan.payload.kind, row: r.row }, { to: stage });
          ids.push(cid); created++;
        } else if (r.action === 'update') {
          const cid = r.contractId!;
          db.prepare(`UPDATE ct_contract SET name = ?, sign_date = COALESCE(?, sign_date),
            summary_text = COALESCE(NULLIF(?, ''), summary_text), undertaker_name = COALESCE(NULLIF(?, ''), undertaker_name),
            exchange_rate_scaled = COALESCE(?, exchange_rate_scaled),
            version = version + 1, updated_at = ? WHERE id = ?`).run(r.name, r.signDate, r.summaryText, r.undertakerName, r.exchangeRateScaled, now, cid);
          recordEvent(db, cid, 'import.update', { importId: id, importKind: plan.payload.kind, row: r.row, changes: r.changes });
          ids.push(cid); updated++;
        } else unchanged++;
      }
    } else if (plan.payload.kind === 'supervision_expense_exec' || plan.payload.kind === 'supervision_income_exec') {
      const isExpense = plan.payload.kind === 'supervision_expense_exec';
      for (const r of plan.payload.rows) {
        if (r.action === 'unchanged') { unchanged++; continue; }
        const cid = r.contractId!;
        const currency = (db.prepare('SELECT currency FROM ct_contract WHERE id = ?').get(cid) as { currency: string }).currency;
        if (r.txns.some(t => t.currency !== currency)) throw new AppError('CONTRACT_CURRENCY_MISMATCH', '导入收付款币种与合同不一致', 409);
        if (r.txns.length > 0) {
          if (isExpense) {
            db.prepare("DELETE FROM ct_payment WHERE contract_id = ? AND kind = 'import_baseline'").run(cid);
            for (const t of r.txns) {
              insertBaselineWithDate(db, cid, t.amountCents, `实付-${t.occurredDate}`, t.occurredDate, t.currency, t.approverName, t.approverTitle, now, userId);
            }
            const totalPaid = (db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_payment WHERE contract_id = ? AND status = 'paid'").safeIntegers(true).get(cid) as { s: bigint }).s;
            db.prepare('UPDATE ct_contract SET paid_cents = ? WHERE id = ?').run(totalPaid, cid);
          } else {
            db.prepare("DELETE FROM ct_receipt WHERE contract_id = ? AND kind = 'import_baseline'").run(cid);
            for (const t of r.txns) {
              db.prepare(`INSERT INTO ct_receipt (contract_id, kind, node_name, currency, amount_cents, status, submitted_by_user_id, submitted_at, received_date, received_by_user_id, received_at)
                VALUES (?, 'import_baseline', ?, ?, ?, 'received', ?, ?, ?, ?, ?)`).run(
                cid, `实收-${t.occurredDate}`, t.currency, t.amountCents, userId, now, t.occurredDate, userId, now,
              );
            }
            const totalRec = (db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_receipt WHERE contract_id = ? AND status = 'received'").safeIntegers(true).get(cid) as { s: bigint }).s;
            db.prepare('UPDATE ct_contract SET received_cents = ? WHERE id = ?').run(totalRec, cid);
          }
        }
        db.prepare(`UPDATE ct_contract SET status = ?, stage = ?, deliverable_submitted = COALESCE(?, deliverable_submitted),
          final_accepted = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(
          r.targetStatus, r.targetStage,
          r.deliverableSubmitted === null ? null : (r.deliverableSubmitted ? 1 : 0),
          r.finalAccepted ? 1 : 0, now, cid,
        );
        recordEvent(db, cid, 'import.exec', { importId: id, importKind: plan.payload.kind, txnCount: r.txns.length, targetStatus: r.targetStatus });
        ids.push(cid); updated++;
      }
    } else if (plan.payload.kind === 'supervision_expense_change' || plan.payload.kind === 'supervision_income_change') {
      const docCache = new Map<number, number>();
      for (const r of plan.payload.rows) {
        if (r.action === 'unchanged') { unchanged++; continue; }
        const cid = r.contractId!;
        let docId = docCache.get(cid);
        if (!docId) {
          docId = Number(db.prepare(`INSERT INTO ct_document (contract_id, doc_type, evidence_kind, file_object_id, name, uploaded_by_user_id, uploaded_at)
            VALUES (?, 'change', 'change_agreement', ?, ?, ?, ?)`).run(cid, imp.file_object_id, `导入变更台账(${imp.file_name})`.slice(0, 200), userId, now).lastInsertRowid);
          docCache.set(cid, docId);
        }
        db.prepare(`INSERT INTO ct_change (
          contract_id, org_root_id, change_kind, delta_cents, change_matter, reason, evidence_document_id,
          decision_method, meeting_type, final_approver_name, required_approval_tier, actual_approval_tier,
          supplement_no, normalized_supplement_no, has_dispute, status, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, 'standard_import')`).run(
          cid, r.orgId, r.changeKind, r.deltaCents, r.changeMatter, r.reason, docId,
          r.decisionMethod, r.meetingType, r.finalApproverName, r.requiredApprovalTier, r.actualApprovalTier,
          r.supplementNo, r.normalizedSupplementNo, r.hasDispute ? 1 : 0, userId, now, userId, now,
        );
        if (r.deltaCents !== 0n) {
          db.prepare('UPDATE ct_contract SET approved_change_cents = approved_change_cents + ? WHERE id = ?').run(r.deltaCents, cid);
        }
        if (r.flagNegativeTotalWarning) {
          const curMissing = db.prepare('SELECT missing_fields_json FROM ct_contract WHERE id = ?').get(cid) as { missing_fields_json: string } | undefined;
          const arr: string[] = curMissing?.missing_fields_json ? JSON.parse(curMissing.missing_fields_json) : [];
          if (!arr.includes('变更后总价临时为负待核销')) {
            arr.push('变更后总价临时为负待核销');
            db.prepare('UPDATE ct_contract SET missing_fields_json = ? WHERE id = ?').run(JSON.stringify(arr), cid);
          }
        }
        if (r.changeKind === 'suspend') {
          db.prepare("UPDATE ct_contract SET status = 'suspended', status_reason = ?, version = version + 1, updated_at = ? WHERE id = ?").run(r.reason, now, cid);
        } else if (r.changeKind === 'terminate') {
          db.prepare("UPDATE ct_contract SET status = 'terminated', status_reason = ?, version = version + 1, updated_at = ? WHERE id = ?").run(r.reason, now, cid);
        } else {
          db.prepare('UPDATE ct_contract SET version = version + 1, updated_at = ? WHERE id = ?').run(now, cid);
        }
        recordEvent(db, cid, 'import.change', { importId: id, importKind: plan.payload.kind, changeKind: r.changeKind, delta: centsToDecimalString(r.deltaCents), supplementNo: r.supplementNo, hasDispute: r.hasDispute });
        ids.push(cid); updated++;
      }
    }
    const result = { created, updated, unchanged, contractIds: ids };
    db.prepare("UPDATE ct_import SET status = 'confirmed', result_json = ?, confirmed_at = ? WHERE id = ? AND status = 'previewed'").run(JSON.stringify(result), now, id);
  }).immediate();
  return importDto(importRow(db, id));
}

function insertBaseline(db: DB, contractId: number, amount: bigint, now: string, userId: number | null, currency = '人民币'): void {
  insertBaselineWithDate(db, contractId, amount, '导入累计已付', now.slice(0, 10), currency, '', '', now, userId);
}

function insertBaselineWithDate(
  db: DB, contractId: number, amount: bigint, nodeName: string, paidDate: string, currency: string,
  approverName: string, approverTitle: string, now: string, userId: number | null,
): void {
  db.prepare(`INSERT INTO ct_payment (contract_id, kind, node_name, currency, amount_cents, approver_name, approver_title, status, submitted_by_user_id, submitted_at, paid_date, paid_at, origin)
    VALUES (?, 'import_baseline', ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, 'standard_import')`).run(
    contractId, nodeName, currency, amount, approverName, approverTitle, userId, now, paidDate, now,
  );
}
