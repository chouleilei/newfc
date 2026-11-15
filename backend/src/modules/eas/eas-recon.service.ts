/**
 * EAS 合同质保金、往来异常负余额与在建工程遗留对账服务（GAP-20 / AC-T15-02）。
 *
 * - 只读扫描当前激活批次的 eas_balance_line / eas_aux_line / eas_voucher_line；
 * - 全量使用 bigint 定点整数分运算（.safeIntegers(true)），零浮点误差；
 * - 核对备注只写入 V75 eas_recon_note 附加表并记录审计日志，绝不改动 EAS 原始导入行。
 */
import type { DB } from '../../db/connection';
import { centsToDecimalString } from '../../core/decimal';
import { currentAuth } from '../../core/request-context';
import { writeLog } from '../audit/log';
import { resolveEntity } from '../master/master.service';
import { currentOrgScope, notVisible, orgInScope, requirePermission } from '../security/scope';
import {
  EAS_CONTRACT_RECON_CATEGORIES,
  type EasContractReconCategory,
  type EasContractReconDto,
  type EasContractReconItemDto,
  type EasContractReconNoteRequest,
  type EasReconNoteDto,
  type EasReconNoteStatus,
} from '../../contracts/eas';

const nowIso = () => new Date().toISOString();

function assertVisibleOrg(db: DB, orgId: number): { id: number; name: string } {
  const org = db.prepare('SELECT id, name FROM org WHERE id = ?').get(orgId) as { id: number; name: string } | undefined;
  if (!org || !orgInScope(currentOrgScope(db), orgId)) throw notVisible('组织');
  return org;
}

function periodEndDate(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function daysBetween(fromDate: string, toDate: string): number {
  const t0 = Date.parse(`${fromDate}T00:00:00Z`);
  const t1 = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return 0;
  return Math.floor((t1 - t0) / 86_400_000);
}

const absBigInt = (v: bigint): bigint => (v < 0n ? -v : v);

interface RawBalanceLine {
  id: number;
  account_code: string;
  account_name: string;
  begin_debit_cents: bigint;
  begin_credit_cents: bigint;
  debit_cents: bigint;
  credit_cents: bigint;
  end_debit_cents: bigint;
  end_credit_cents: bigint;
  project_code: string | null;
  project_name: string | null;
  supplier_name: string | null;
}

interface RawAuxLine {
  id: number;
  aux_type: string;
  aux_code: string;
  aux_name: string;
  account_code: string;
  account_name: string;
  begin_cents: bigint;
  debit_cents: bigint;
  credit_cents: bigint;
  end_cents: bigint;
  supplier_name: string | null;
}

interface WarrantyContractRow {
  contract_id: number;
  contract_no: string;
  contract_name: string;
  project_id: number | null;
  supplier_id: number | null;
  counterparty_name: string | null;
  end_date: string | null;
  retention_cents: bigint;
  inspection_date: string | null;
  inspection_conclusion: 'passed' | 'rectifying' | null;
  released_payment_id: number | null;
}

interface NoteRow {
  id: number;
  org_id: number;
  period: string;
  category: EasContractReconCategory;
  target_key: string;
  recon_status: EasReconNoteStatus;
  voucher_ref: string;
  note: string;
  updated_by_user_id: number | null;
  updated_at: string;
}

const userName = (db: DB, userId: number | null): string | null =>
  userId === null
    ? null
    : ((db.prepare('SELECT display_name FROM app_user WHERE id = ?').get(userId) as { display_name: string } | undefined)?.display_name ?? `#${userId}`);

export function listEasContractRecon(
  db: DB,
  q: { orgId: number; period: string; category?: EasContractReconCategory; unresolvedOnly?: boolean }
): EasContractReconDto {
  if (currentAuth()) requirePermission(currentAuth(), 'eas:read');
  const org = assertVisibleOrg(db, q.orgId);
  const pEnd = periodEndDate(q.period);
  const scope = currentOrgScope(db);
  const projectVisible = (id: number) => {
    const row = db.prepare('SELECT org_id FROM md_project WHERE id = ?').get(id) as { org_id: number } | undefined;
    return Boolean(row && orgInScope(scope, row.org_id));
  };
  const resolveProject = (input: Parameters<typeof resolveEntity>[2]) => {
    const match = resolveEntity(db, 'project', input);
    return match.targetId !== null && !projectVisible(match.targetId) ? null : match;
  };

  const activeBatches = db.prepare(
    `SELECT id, data_type FROM eas_batch WHERE org_id = ? AND period = ? AND status = 'active' AND is_current = 1`
  ).all(q.orgId, q.period) as { id: number; data_type: 'voucher' | 'balance' | 'auxiliary' }[];
  const batchByType = new Map(activeBatches.map((b) => [b.data_type, b.id]));
  const balBatchId = batchByType.get('balance') ?? null;
  const auxBatchId = batchByType.get('auxiliary') ?? null;
  const vouBatchId = batchByType.get('voucher') ?? null;

  const balanceLines: RawBalanceLine[] = balBatchId === null
    ? []
    : (db.prepare('SELECT * FROM eas_balance_line WHERE batch_id = ? ORDER BY source_row, id').safeIntegers(true).all(balBatchId) as Record<string, unknown>[]).map((r) => ({
        id: Number(r.id),
        account_code: String(r.account_code),
        account_name: String(r.account_name),
        begin_debit_cents: BigInt(r.begin_debit_cents as bigint),
        begin_credit_cents: BigInt(r.begin_credit_cents as bigint),
        debit_cents: BigInt(r.debit_cents as bigint),
        credit_cents: BigInt(r.credit_cents as bigint),
        end_debit_cents: BigInt(r.end_debit_cents as bigint),
        end_credit_cents: BigInt(r.end_credit_cents as bigint),
        project_code: (r.project_code as string | null) ?? null,
        project_name: (r.project_name as string | null) ?? null,
        supplier_name: (r.supplier_name as string | null) ?? null,
      }));

  const auxLines: RawAuxLine[] = auxBatchId === null
    ? []
    : (db.prepare('SELECT * FROM eas_aux_line WHERE batch_id = ? ORDER BY source_row, id').safeIntegers(true).all(auxBatchId) as Record<string, unknown>[]).map((r) => ({
        id: Number(r.id),
        aux_type: String(r.aux_type),
        aux_code: String(r.aux_code),
        aux_name: String(r.aux_name),
        account_code: String(r.account_code),
        account_name: String(r.account_name),
        begin_cents: BigInt(r.begin_cents as bigint),
        debit_cents: BigInt(r.debit_cents as bigint),
        credit_cents: BigInt(r.credit_cents as bigint),
        end_cents: BigInt(r.end_cents as bigint),
        supplier_name: (r.supplier_name as string | null) ?? null,
      }));

  const voucherRefsByAccount = new Map<string, string[]>();
  if (vouBatchId !== null) {
    const vRows = db.prepare('SELECT account_code, voucher_no FROM eas_voucher_line WHERE batch_id = ? ORDER BY source_row, id').all(vouBatchId) as { account_code: string; voucher_no: string }[];
    for (const v of vRows) {
      const list = voucherRefsByAccount.get(v.account_code) ?? [];
      if (!list.includes(v.voucher_no) && list.length < 5) list.push(v.voucher_no);
      voucherRefsByAccount.set(v.account_code, list);
    }
  }

  const notesMap = new Map<string, NoteRow>();
  for (const n of db.prepare('SELECT * FROM eas_recon_note WHERE org_id = ? AND period = ?').all(q.orgId, q.period) as NoteRow[]) {
    notesMap.set(n.target_key, n);
  }

  const rawItems: { item: EasContractReconItemDto; absCents: bigint }[] = [];
  const seenKeys = new Set<string>();

  const pushItem = (
    base: Omit<EasContractReconItemDto, 'reconStatus' | 'voucherRef' | 'note' | 'noteUpdatedByName' | 'noteUpdatedAt'>,
    absCents: bigint
  ) => {
    if (seenKeys.has(base.targetKey)) return;
    seenKeys.add(base.targetKey);
    const saved = notesMap.get(base.targetKey);
    rawItems.push({
      absCents,
      item: {
        ...base,
        reconStatus: saved?.recon_status ?? 'pending',
        voucherRef: saved?.voucher_ref ?? (base.voucherRefs[0] ?? ''),
        note: saved?.note ?? '',
        noteUpdatedByName: saved ? userName(db, saved.updated_by_user_id) : null,
        noteUpdatedAt: saved?.updated_at ?? null,
      },
    });
  };

  /* ---------- 1. warranty_2241_overdue：应付质保金 2241* 到期签证逾 30 天未清 ---------- */
  const warrantyContracts = (db.prepare(
    `SELECT c.id AS contract_id, c.contract_no, c.name AS contract_name, c.project_id, c.supplier_id,
            COALESCE(NULLIF(c.counterparty_names, ''), s.name) AS counterparty_name,
            w.end_date, w.retention_cents, w.inspection_date, w.inspection_conclusion, w.released_payment_id
     FROM ct_warranty w
     JOIN ct_contract c ON c.id = w.contract_id
     LEFT JOIN md_supplier s ON s.id = c.supplier_id
     WHERE c.org_id = ?`
  ).safeIntegers(true).all(q.orgId) as Record<string, unknown>[]).map((r) => ({
    contract_id: Number(r.contract_id),
    contract_no: String(r.contract_no),
    contract_name: String(r.contract_name),
    project_id: r.project_id == null || !projectVisible(Number(r.project_id)) ? null : Number(r.project_id),
    supplier_id: r.supplier_id == null ? null : Number(r.supplier_id),
    counterparty_name: (r.counterparty_name as string | null) ?? null,
    end_date: (r.end_date as string | null) ?? null,
    retention_cents: BigInt(r.retention_cents as bigint),
    inspection_date: (r.inspection_date as string | null) ?? null,
    inspection_conclusion: (r.inspection_conclusion as 'passed' | 'rectifying' | null) ?? null,
    released_payment_id: r.released_payment_id == null ? null : Number(r.released_payment_id),
  })) as WarrantyContractRow[];

  const overdueWarranties = warrantyContracts.flatMap((w) => {
    const anchor = w.inspection_date || w.end_date;
    const overdueByVisa = w.inspection_conclusion === 'passed' && anchor ? daysBetween(anchor, pEnd) : null;
    const releasedStillOnBook = w.released_payment_id !== null && (!w.end_date || w.end_date <= pEnd);
    if ((overdueByVisa !== null && overdueByVisa > 30) || releasedStillOnBook) {
      return [{ w, overdueDays: overdueByVisa !== null ? overdueByVisa : (anchor ? Math.max(0, daysBetween(anchor, pEnd)) : null), anchor, releasedStillOnBook }];
    }
    return [];
  });

  const isWarrantyAccount = (code: string, name: string) =>
    code.startsWith('2241') || /质保金|质量保证金/.test(name);

  const warrantyLines = balanceLines
    .filter((l) => isWarrantyAccount(l.account_code, l.account_name) && l.end_credit_cents - l.end_debit_cents > 0n)
    .map((l) => ({
      accountCode: l.account_code,
      accountName: l.account_name,
      projectCode: l.project_code,
      projectName: l.project_name,
      supplierName: l.supplier_name,
      netCreditCents: l.end_credit_cents - l.end_debit_cents,
    }));

  for (const a of auxLines) {
    if (!isWarrantyAccount(a.account_code, a.account_name) || a.end_cents <= 0n) continue;
    const isSup = /供应商|客商|往来|supplier/i.test(a.aux_type);
    const isPrj = /项目|工程|project/i.test(a.aux_type);
    warrantyLines.push({
      accountCode: a.account_code,
      accountName: a.account_name,
      projectCode: isPrj ? a.aux_code : null,
      projectName: isPrj ? a.aux_name : null,
      supplierName: a.supplier_name ?? (isSup ? a.aux_name : null),
      netCreditCents: a.end_cents,
    });
  }

  for (const wl of warrantyLines) {
    const supRes = wl.supplierName
      ? resolveEntity(db, 'supplier', { name: wl.supplierName, sourceSystem: 'eas', asOf: pEnd, includeInactive: true })
      : null;
    const prjRes = wl.projectCode || wl.projectName
      ? resolveProject({ code: wl.projectCode ?? undefined, name: wl.projectName ?? undefined, sourceSystem: 'eas', asOf: pEnd, includeInactive: true })
      : null;

    const matchedList = overdueWarranties.filter(({ w }) => {
      const hasSupplier = Boolean(wl.supplierName);
      const hasProject = Boolean(wl.projectCode || wl.projectName);
      const supplierMatches = (supRes?.targetId && w.supplier_id === supRes.targetId) ||
        (wl.supplierName && w.counterparty_name === wl.supplierName);
      const projectMatches = prjRes?.targetId && w.project_id === prjRes.targetId;
      // 不能仅凭单位科目总余额给所有到期合同分摊相同金额，也不能忽略已明确的项目/客商冲突。
      return (hasSupplier || hasProject) && (!hasSupplier || supplierMatches) && (!hasProject || projectMatches);
    });

    for (const { w, overdueDays, anchor, releasedStillOnBook } of matchedList) {
      const projectRow = w.project_id
        ? (db.prepare('SELECT id, code, name FROM md_project WHERE id = ?').get(w.project_id) as { id: number; code: string; name: string } | undefined)
        : undefined;
      const reason = releasedStillOnBook
        ? `合同已登记质保金释放付款单（#${w.released_payment_id}），但 EAS 科目 ${wl.accountCode} 期末仍挂贷方余额 ${centsToDecimalString(wl.netCreditCents)} 元`
        : `合同质保验收合格（${anchor ?? '-'}）距期末已逾 ${overdueDays} 天（>30天），EAS 科目 ${wl.accountCode} 仍挂账 ${centsToDecimalString(wl.netCreditCents)} 元未核销`;
      pushItem(
        {
          targetKey: `2241:CT-${w.contract_id}:${wl.accountCode}`,
          category: 'warranty_2241_overdue',
          accountCode: wl.accountCode,
          accountName: wl.accountName,
          projectCode: wl.projectCode ?? projectRow?.code ?? null,
          projectName: wl.projectName ?? projectRow?.name ?? null,
          projectId: w.project_id,
          supplierName: wl.supplierName ?? w.counterparty_name ?? null,
          supplierId: w.supplier_id,
          contractId: w.contract_id,
          contractNo: w.contract_no,
          contractName: w.contract_name,
          bookBalance: centsToDecimalString(wl.netCreditCents),
          statusSummary: releasedStillOnBook
            ? '质保期满已释放付款单·账面未清'
            : `质保验收通过（${anchor ?? '-'}）·超期 ${overdueDays ?? 0} 天`,
          overdueDays,
          anomalyReason: reason,
          voucherRefs: voucherRefsByAccount.get(wl.accountCode) ?? [],
        },
        wl.netCreditCents,
      );
    }
  }

  /* ---------- 2. supplier_negative_balance：应付/质保金或预付/其他应收往来异常负余额 ---------- */
  interface NegCandidate {
    accountCode: string;
    accountName: string;
    supplierCode: string | null;
    supplierName: string;
    projectCode: string | null;
    projectName: string | null;
    signedNetCents: bigint;
  }
  const negCandidates: NegCandidate[] = [];
  for (const l of balanceLines) {
    const isLiability = l.account_code.startsWith('2202') || l.account_code.startsWith('2241');
    const isAsset = l.account_code.startsWith('1123') || l.account_code.startsWith('122103');
    if (!isLiability && !isAsset) continue;
    const net = isLiability ? l.end_credit_cents - l.end_debit_cents : l.end_debit_cents - l.end_credit_cents;
    if (net < 0n) {
      negCandidates.push({
        accountCode: l.account_code,
        accountName: l.account_name,
        supplierCode: null,
        supplierName: l.supplier_name || '未标注客商',
        projectCode: l.project_code,
        projectName: l.project_name,
        signedNetCents: net,
      });
    }
  }
  for (const a of auxLines) {
    const isLiability = a.account_code.startsWith('2202') || a.account_code.startsWith('2241');
    const isAsset = a.account_code.startsWith('1123') || a.account_code.startsWith('122103');
    if ((!isLiability && !isAsset) || a.end_cents >= 0n) continue;
    negCandidates.push({
      accountCode: a.account_code,
      accountName: a.account_name,
      supplierCode: a.aux_code || null,
      supplierName: a.supplier_name || a.aux_name || a.aux_code,
      projectCode: null,
      projectName: null,
      signedNetCents: a.end_cents,
    });
  }

  for (const nc of negCandidates) {
    const supRes = resolveEntity(db, 'supplier', {
      code: nc.supplierCode ?? undefined,
      name: nc.supplierName,
      sourceSystem: 'eas',
      asOf: pEnd,
      includeInactive: true,
    });
    const linkedCt = supRes.targetId
      ? (db.prepare('SELECT id, contract_no, name, project_id FROM ct_contract WHERE org_id = ? AND supplier_id = ? ORDER BY id DESC LIMIT 1')
          .get(q.orgId, supRes.targetId) as { id: number; contract_no: string; name: string; project_id: number | null } | undefined)
      : (db.prepare('SELECT id, contract_no, name, project_id FROM ct_contract WHERE org_id = ? AND counterparty_names = ? ORDER BY id DESC LIMIT 1')
          .get(q.orgId, nc.supplierName) as { id: number; contract_no: string; name: string; project_id: number | null } | undefined);
    const supKey = nc.supplierCode || (supRes.targetCode ? supRes.targetCode : nc.supplierName);
    pushItem(
      {
        targetKey: `neg:${nc.accountCode}:${supKey}`,
        category: 'supplier_negative_balance',
        accountCode: nc.accountCode,
        accountName: nc.accountName,
        projectCode: nc.projectCode,
        projectName: nc.projectName,
        projectId: linkedCt?.project_id && projectVisible(linkedCt.project_id) ? linkedCt.project_id : null,
        supplierName: nc.supplierName,
        supplierId: supRes.targetId ?? null,
        contractId: linkedCt?.id ?? null,
        contractNo: linkedCt?.contract_no ?? null,
        contractName: linkedCt?.name ?? null,
        bookBalance: centsToDecimalString(nc.signedNetCents),
        statusSummary: '往来余额方向倒挂（负余额）',
        overdueDays: null,
        anomalyReason: `科目 ${nc.accountCode}（${nc.accountName}）客商「${nc.supplierName}」期末呈异常负余额 ${centsToDecimalString(nc.signedNetCents)} 元，需核查重分类、未达发票或重复付款`,
        voucherRefs: voucherRefsByAccount.get(nc.accountCode) ?? [],
      },
      absBigInt(nc.signedNetCents),
    );
  }

  /* ---------- 3. cip_1604_legacy：在建工程 1604* 已竣工决算或长期静止未转固遗留 ---------- */
  interface CipCandidate {
    accountCode: string;
    accountName: string;
    projectCode: string | null;
    projectName: string | null;
    beginDebitNet: bigint;
    debitCents: bigint;
    creditCents: bigint;
    endDebitNet: bigint;
  }
  const cipCandidates: CipCandidate[] = [];
  const bal1604 = balanceLines.filter((l) => l.account_code.startsWith('1604') && l.end_debit_cents - l.end_credit_cents > 0n);
  const aux1604 = auxLines.filter((a) => a.account_code.startsWith('1604') && a.end_cents > 0n);

  if (aux1604.length > 0 && bal1604.every((l) => !l.project_code && !l.project_name)) {
    for (const a of aux1604) {
      cipCandidates.push({
        accountCode: a.account_code,
        accountName: a.account_name,
        projectCode: a.aux_code || null,
        projectName: a.aux_name || null,
        beginDebitNet: a.begin_cents,
        debitCents: a.debit_cents,
        creditCents: a.credit_cents,
        endDebitNet: a.end_cents,
      });
    }
  } else {
    for (const l of bal1604) {
      cipCandidates.push({
        accountCode: l.account_code,
        accountName: l.account_name,
        projectCode: l.project_code,
        projectName: l.project_name,
        beginDebitNet: l.begin_debit_cents - l.begin_credit_cents,
        debitCents: l.debit_cents,
        creditCents: l.credit_cents,
        endDebitNet: l.end_debit_cents - l.end_credit_cents,
      });
    }
  }

  for (const cip of cipCandidates) {
    const prjRes = cip.projectCode || cip.projectName
      ? resolveProject({
          code: cip.projectCode ?? undefined,
          name: cip.projectName ?? undefined,
          sourceSystem: 'eas',
          asOf: pEnd,
          includeInactive: true,
        })
      : null;
    const mdProjectId = prjRes?.targetId ?? null;
    const icRow = mdProjectId !== null
      ? (db.prepare('SELECT id, status FROM ic_project WHERE md_project_id = ? AND org_id = ?').get(mdProjectId, q.orgId) as { id: number; status: 'active' | 'archived' } | undefined)
      : undefined;
    const settledVer = icRow
      ? (db.prepare(
          `SELECT version_type, name, approval_date FROM ic_version
           WHERE project_id = ? AND version_type IN ('settlement','final_account') AND status = 'confirmed'
           ORDER BY CASE WHEN version_type = 'final_account' THEN 0 ELSE 1 END, id DESC LIMIT 1`
        ).get(icRow.id) as { version_type: 'settlement' | 'final_account'; name: string; approval_date: string | null } | undefined)
      : undefined;

    const isCompletedProject = Boolean(settledVer) || icRow?.status === 'archived';
    const isStagnantLegacy = cip.beginDebitNet > 0n && cip.debitCents === 0n && cip.creditCents === 0n;
    if (!isCompletedProject && !isStagnantLegacy) continue;

    const linkedCt = mdProjectId !== null
      ? (db.prepare('SELECT id, contract_no, name FROM ct_contract WHERE org_id = ? AND project_id = ? ORDER BY id DESC LIMIT 1')
          .get(q.orgId, mdProjectId) as { id: number; contract_no: string; name: string } | undefined)
      : undefined;
    const prjKey = cip.projectCode || prjRes?.targetCode || cip.projectName || 'UNMAPPED';
    const overdueDays = settledVer?.approval_date ? Math.max(0, daysBetween(settledVer.approval_date, pEnd)) : null;
    const statusSummary = settledVer
      ? `${settledVer.version_type === 'final_account' ? '已竣工决算确认' : '已工程结算确认'}（${settledVer.name}）`
      : icRow?.status === 'archived'
        ? '投控项目已归档结项'
        : '期初挂账且本期零发生（长期静止遗留）';
    const reason = isCompletedProject
      ? `工程已达${statusSummary}状态，但 EAS 在建工程科目 ${cip.accountCode} 期末仍留存余额 ${centsToDecimalString(cip.endDebitNet)} 元未完成转固/核销`
      : `EAS 在建工程科目 ${cip.accountCode}（${cip.projectCode ?? cip.projectName ?? '未关联工程码'}）期初及期末挂账 ${centsToDecimalString(cip.endDebitNet)} 元且本期零发生额，需核实历史遗留转固或清理依据`;

    pushItem(
      {
        targetKey: `1604:${prjKey}:${cip.accountCode}`,
        category: 'cip_1604_legacy',
        accountCode: cip.accountCode,
        accountName: cip.accountName,
        projectCode: cip.projectCode ?? prjRes?.targetCode ?? null,
        projectName: cip.projectName ?? prjRes?.targetName ?? null,
        projectId: mdProjectId,
        supplierName: null,
        supplierId: null,
        contractId: linkedCt?.id ?? null,
        contractNo: linkedCt?.contract_no ?? null,
        contractName: linkedCt?.name ?? null,
        bookBalance: centsToDecimalString(cip.endDebitNet),
        statusSummary,
        overdueDays,
        anomalyReason: reason,
        voucherRefs: voucherRefsByAccount.get(cip.accountCode) ?? [],
      },
      cip.endDebitNet,
    );
  }

  // 汇总统计（基于全部分类，筛选不影响顶部三分类统计概览或可按过滤后返回列表）
  const byCategory = Object.fromEntries(
    EAS_CONTRACT_RECON_CATEGORIES.map((cat) => {
      const catRows = rawItems.filter((r) => r.item.category === cat);
      const sumAbs = catRows.reduce((s, r) => s + r.absCents, 0n);
      return [cat, { count: catRows.length, totalAbsAmount: centsToDecimalString(sumAbs) }];
    })
  ) as EasContractReconDto['summary']['byCategory'];

  const unresolvedCount = rawItems.filter(
    (r) => r.item.reconStatus !== 'resolved' && r.item.reconStatus !== 'explained_normal'
  ).length;

  const filtered = rawItems
    .filter((r) => (!q.category || r.item.category === q.category))
    .filter((r) => (!q.unresolvedOnly || (r.item.reconStatus !== 'resolved' && r.item.reconStatus !== 'explained_normal')))
    .map((r) => r.item);

  return {
    orgId: org.id,
    orgName: org.name,
    period: q.period,
    hasActiveBalanceBatch: balBatchId !== null || auxBatchId !== null,
    summary: {
      totalCount: rawItems.length,
      unresolvedCount,
      byCategory,
    },
    items: filtered,
  };
}

export function upsertEasContractReconNote(db: DB, input: EasContractReconNoteRequest): EasReconNoteDto {
  if (currentAuth()) requirePermission(currentAuth(), 'eas:import');
  assertVisibleOrg(db, input.orgId);
  const userId = currentAuth()?.userId ?? null;
  const now = nowIso();

  const row = db.transaction(() => {
    db.prepare(
      `INSERT INTO eas_recon_note (
         org_id, period, category, target_key, recon_status, voucher_ref, note, updated_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, period, target_key) DO UPDATE SET
         category = excluded.category,
         recon_status = excluded.recon_status,
         voucher_ref = excluded.voucher_ref,
         note = excluded.note,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`
    ).run(
      input.orgId, input.period, input.category, input.targetKey,
      input.reconStatus, input.voucherRef, input.note, userId, now, now,
    );
    const saved = db.prepare(
      'SELECT * FROM eas_recon_note WHERE org_id = ? AND period = ? AND target_key = ?'
    ).get(input.orgId, input.period, input.targetKey) as NoteRow;
    writeLog(db, 'eas.contract_recon.note', 'eas_recon_note', saved.id, {
      orgId: input.orgId,
      period: input.period,
      category: input.category,
      targetKey: input.targetKey,
      reconStatus: input.reconStatus,
      voucherRef: input.voucherRef,
    });
    return saved;
  }).immediate();

  return {
    id: row.id,
    orgId: row.org_id,
    period: row.period,
    category: row.category,
    targetKey: row.target_key,
    reconStatus: row.recon_status,
    voucherRef: row.voucher_ref,
    note: row.note,
    updatedByName: userName(db, row.updated_by_user_id),
    updatedAt: row.updated_at,
  };
}
