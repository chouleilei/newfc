/**
 * 合同导入(AC-F04):预览 → 确认。规则见 specs/implementation.md T-4「合同导入」。
 *
 * - 预览落原件并记录 ct_import(逐行计划动作、逐行错误、计划哈希),不写合同。
 * - 已存在合同按规范化编号匹配:只更新名称、类型、签订日期,供应商仅在需求立项至合同起草阶段可更新;
 *   金额不一致记行错误(须走变更流程);导入累计已付记为 import_baseline 付款,已有正式付款时不能变更。
 * - 确认只能由预览人进行;按原件重算计划,与预览不一致返回 PREVIEW_STALE;有行错误拒绝;
 *   一个事务内完成全部写入,中途失败全部回滚、预览保持可重试;重复确认返回原结果。
 */
import crypto from 'crypto';
import type { DB } from '../../db/connection';
import { AppError, type RowError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, formatScaled, RATIO_SCALE } from '../../core/decimal';
import { assertFullScope, currentOrgScope, notVisible, orgInScope, type OrgScope } from '../security/scope';
import { storeFile, type ObjectStore } from '../files/object-store';
import { readTable } from '../io/table-reader';
import { amountCents, CellError, dateCell, findHeader, headerKey, headerUnit, ratioScaledCell } from '../io/cell-values';
import { resolveEntity } from '../master/master.service';
import type { ContractImportAction, ContractImportDto, ContractImportRowDto, ContractStage } from '../../contracts/project-contract';
import { normalizeContractNo, recordEvent } from './contract.service';

const nowIso = () => new Date().toISOString();
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
} as const;
type Col = keyof typeof COLUMNS;
const LABEL: Record<Col, string> = {
  contractNo: '合同编号', name: '合同名称', projectCode: '项目编码', supplier: '供应商', amount: '合同金额', paid: '已付款金额',
  signDate: '签订日期', contractType: '合同类型', org: '责任组织', capRatio: '付款上限比例',
};
const REQUIRED: Col[] = ['contractNo', 'name', 'amount'];
const EARLY: ContractStage[] = ['initiation', 'procurement', 'drafting'];
const MIN_SIGN_DATE = '1990-01-01';

interface PlanRow {
  row: number; contractNo: string; normalizedNo: string; name: string; contractType: string; orgId: number; projectId: number | null; supplierId: number | null;
  amount: bigint; paid: bigint; signDate: string | null; capRatio: bigint | null;
  action: ContractImportAction; contractId: number | null; contractVersion: number | null; changes: Record<string, [string | null, string | null]>;
}
interface ComputedPlan { rows: PlanRow[]; errors: RowError[]; rowCount: number; hash: string; display: ContractImportRowDto[] }

function maxSignDate(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

async function computePlan(db: DB, scope: OrgScope, content: Buffer, fileName: string): Promise<ComputedPlan> {
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
        const exPaid = ex.paid_cents as bigint;
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
      amount: amount === null ? null : centsToDecimalString(amount), paid: paid === null ? null : centsToDecimalString(paid), signDate, changes,
    });
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    rows.push({
      row: r.rowNo, contractNo, normalizedNo, name: v('name').slice(0, 200), contractType: v('contractType').slice(0, 50), orgId: orgId!, projectId, supplierId,
      amount: amount!, paid: paid!, signDate, capRatio, action: action!, contractId, contractVersion, changes,
    });
  }
  // 计划哈希:逐行动作 + 目标合同版本 + 写入值;库内合同变化或文件变化都会改变哈希
  const hash = crypto.createHash('sha256').update(JSON.stringify(rows, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))).update(JSON.stringify(errors)).digest('hex');
  return { rows, errors, rowCount: table.rows.length, hash, display };
}

interface ImportRow {
  id: number; file_object_id: number; file_sha256: string; file_name: string; row_count: number; error_count: number; plan_hash: string; plan_json: string;
  errors_json: string; status: 'previewed' | 'confirmed'; result_json: string | null; created_by_user_id: number | null; created_at: string; confirmed_at: string | null;
}

function importDto(r: ImportRow, extra: Partial<ContractImportDto> = {}): ContractImportDto {
  const rows = JSON.parse(r.plan_json) as ContractImportRowDto[];
  const counts: Record<ContractImportAction, number> = { create: 0, update: 0, unchanged: 0 };
  for (const row of rows) if (row.action) counts[row.action]++;
  return {
    id: r.id, fileName: r.file_name, fileSha256: r.file_sha256, status: r.status, rowCount: r.row_count, errorCount: r.error_count, errors: JSON.parse(r.errors_json),
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

export async function previewContractImport(db: DB, store: ObjectStore, content: Buffer, fileName: string): Promise<ContractImportDto> {
  const plan = await computePlan(db, currentOrgScope(db), content, fileName);
  const file = storeFile(db, store, content, { originalName: fileName });
  const id = Number(db.prepare(`INSERT INTO ct_import (file_object_id, file_sha256, file_name, row_count, error_count, plan_hash, plan_json, errors_json, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(file.id, file.sha256, fileName.slice(0, 255), plan.rowCount, plan.errors.length, plan.hash, JSON.stringify(plan.display),
    JSON.stringify(plan.errors.slice(0, 500)), currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
  return importDto(importRow(db, id));
}

export function getContractImport(db: DB, id: number): ContractImportDto {
  return importDto(importRow(db, id));
}

export async function confirmContractImport(db: DB, store: ObjectStore, id: number, expectedPlanHash: string): Promise<ContractImportDto> {
  const auth = currentAuth();
  const imp = db.prepare('SELECT * FROM ct_import WHERE id = ?').get(id) as ImportRow | undefined;
  if (!imp) throw notVisible('合同导入预览');
  if (auth && imp.created_by_user_id !== auth.userId) throw new AppError('PREVIEW_OWNER_MISMATCH', '只能由预览人确认本次导入', 403);
  if (imp.status === 'confirmed') return importDto(imp, { replayed: true });
  if (imp.error_count > 0) throw new AppError('IMPORT_INVALID', `预览有 ${imp.error_count} 项行错误,不能确认;请修正文件后重新预览`, 422, JSON.parse(imp.errors_json));
  if (expectedPlanHash !== imp.plan_hash) throw new AppError('PREVIEW_STALE', '确认的预览与服务端记录不一致,请重新预览', 409);
  const f = db.prepare('SELECT sha256 FROM file_object WHERE id = ?').get(imp.file_object_id) as { sha256: string };
  const scope = currentOrgScope(db);
  // 长解析不在写事务里:先重算计划,事务内再核对哈希一致
  const plan = await computePlan(db, scope, store.read(f.sha256), imp.file_name);
  if (plan.errors.length) throw new AppError('IMPORT_INVALID', `重新校验发现 ${plan.errors.length} 项行错误,未写入任何数据`, 422, plan.errors.slice(0, 500));
  if (plan.hash !== imp.plan_hash) throw new AppError('PREVIEW_STALE', '预览后库内合同或主数据已变化,导入计划与预览不一致,请重新预览', 409);
  assertFullScope(scope, plan.rows.map((r) => r.orgId), '合同导入');
  db.transaction(() => {
    const fresh = db.prepare('SELECT status FROM ct_import WHERE id = ?').get(id) as { status: string };
    if (fresh.status === 'confirmed') return;
    // 事务内核对目标合同版本未变(计算计划与加写锁之间可能有并发写)
    for (const r of plan.rows) {
      const ex = db.prepare('SELECT id, version FROM ct_contract WHERE normalized_no = ?').get(r.normalizedNo) as { id: number; version: number } | undefined;
      if ((ex?.id ?? null) !== r.contractId || (ex?.version ?? null) !== r.contractVersion) throw new AppError('PREVIEW_STALE', `合同 ${r.contractNo} 在预览后发生变化,请重新预览`, 409);
    }
    const now = nowIso();
    const userId = auth?.userId ?? null;
    const ids: number[] = [];
    let created = 0; let updated = 0; let unchanged = 0;
    for (const r of plan.rows) {
      if (r.action === 'create') {
        const stage: ContractStage = r.signDate ? 'performance' : 'initiation';
        const cid = Number(db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id, original_cents, paid_cents,
          payment_cap_ratio_scaled, stage, sign_date, source, import_id, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)`).run(
          r.contractNo, r.normalizedNo, r.name, r.contractType, r.orgId, r.projectId, r.supplierId, r.amount, r.paid, r.capRatio, stage, r.signDate, id, userId, now, now).lastInsertRowid);
        if (r.paid > 0n) insertBaseline(db, cid, r.paid, now, userId);
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
        if (r.changes.paid) {
          sets.push('paid_cents = ?'); params.push(r.paid);
          const baseline = db.prepare("SELECT id FROM ct_payment WHERE contract_id = ? AND kind = 'import_baseline'").get(cid) as { id: number } | undefined;
          if (baseline) db.prepare('UPDATE ct_payment SET amount_cents = ? WHERE id = ?').run(r.paid, baseline.id);
          else insertBaseline(db, cid, r.paid, now, userId);
        }
        db.prepare(`UPDATE ct_contract SET ${sets.join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`).run(...params, now, cid);
        recordEvent(db, cid, 'import.update', { importId: id, row: r.row, changes: r.changes });
        ids.push(cid); updated++;
      } else unchanged++;
    }
    const result = { created, updated, unchanged, contractIds: ids };
    db.prepare("UPDATE ct_import SET status = 'confirmed', result_json = ?, confirmed_at = ? WHERE id = ? AND status = 'previewed'").run(JSON.stringify(result), now, id);
  }).immediate();
  return importDto(importRow(db, id));
}

function insertBaseline(db: DB, contractId: number, amount: bigint, now: string, userId: number | null): void {
  db.prepare(`INSERT INTO ct_payment (contract_id, kind, node_name, amount_cents, status, submitted_by_user_id, submitted_at, paid_date, paid_at)
    VALUES (?, 'import_baseline', '导入累计已付', ?, 'paid', ?, ?, ?, ?)`).run(contractId, amount, userId, now, now.slice(0, 10), now);
}
