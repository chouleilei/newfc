import crypto from 'node:crypto';
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth, type AuthContext } from '../../core/request-context';
import { addWorkingDays, todayUtcDate } from '../../core/workdays';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope } from '../security/scope';
import { getSetting, workingCalendar } from '../settings/business-settings';
import { procurementTier } from './legal-context';
import type { ContractRow } from './contract.service';
import {
  COUNTERSIGN_DEPT_LABELS,
  COUNTERSIGN_DEPTS,
  type BlockerDto,
  type ContractCountersignDecideRequest,
  type ContractCountersignDto,
  type CountersignDeptCode,
  type CountersignStatus,
} from '../../contracts/project-contract';

const nowIso = () => new Date().toISOString();
const todayIso = () => nowIso().slice(0, 10);

const DEPT_MATCH_KEYWORDS: Record<CountersignDeptCode, string[]> = {
  ANJI: ['anji', '安技', '安全生产', '安全技术'],
  JIANGUAN: ['jianguan', '建管', '工程建设', '重大项目'],
  DIAOXIN: ['diaoxin', '调信', '调度', '通信', '信息化'],
  QIGUAN: ['qiguan', '企管', '企业管理', '法务'],
  CAIWU: ['caiwu', '财务部', '计划财务'],
  JIESUAN: ['jiesuan', '结算中心', '财务结算', '资金结算'],
  JISHEN: ['jishen', '纪审', '纪检', '审计'],
};

const IT_KEYWORDS = ['信息化', '软件', '网络', '通信', '调度', '监控', '数字化', '系统开发', '运维平台'];

export interface CountersignSyncInput {
  force?: boolean;
  assignedReviewers?: Record<string, number | null>;
}

export function computeCountersignFingerprint(db: DB, c: ContractRow): string {
  const latestDoc = db.prepare(
    `SELECT f.sha256
     FROM ct_document d
     JOIN file_object f ON f.id = d.file_object_id
     WHERE d.contract_id = ? AND d.doc_type = 'contract_text' AND d.withdrawn_at IS NULL
     ORDER BY d.id DESC LIMIT 1`,
  ).get(c.id) as { sha256: string } | undefined;

  const proc = c.procurement_record_id
    ? (db.prepare(
        'SELECT procurement_method, procurement_tier, estimated_cents FROM ct_procurement_record WHERE id = ?',
      ).safeIntegers(true).get(c.procurement_record_id) as
        | { procurement_method: string | null; procurement_tier: string | null; estimated_cents: bigint | null }
        | undefined)
    : undefined;

  const payload = JSON.stringify({
    direction: c.direction,
    pricingMode: c.pricing_mode,
    originalCents: String(c.original_cents),
    estimatedCeilingCents: c.estimated_ceiling_cents === null ? null : String(c.estimated_ceiling_cents),
    currency: c.currency,
    paymentCapRatioScaled: c.payment_cap_ratio_scaled === null ? null : String(c.payment_cap_ratio_scaled),
    supplierId: c.supplier_id,
    counterpartyNames: c.counterparty_names.trim(),
    procurementTarget: c.procurement_target,
    procurementMethod: proc?.procurement_method ?? c.procurement_method,
    procurementTier: proc?.procurement_tier ?? c.procurement_tier,
    procEstimatedCents: proc?.estimated_cents == null ? null : String(proc.estimated_cents),
    budgetType: c.budget_type,
    isImportant: Number(c.is_important),
    isTripleMajor: Number(c.is_triple_major),
    docSha256: latestDoc?.sha256 ?? '',
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function parseExplicitDepts(raw: string): Set<CountersignDeptCode> {
  const out = new Set<CountersignDeptCode>();
  if (!raw.trim()) return out;
  const lower = raw.toLowerCase();
  for (const code of COUNTERSIGN_DEPTS) {
    if (lower.includes(code.toLowerCase())) {
      out.add(code);
      continue;
    }
    for (const kw of DEPT_MATCH_KEYWORDS[code]) {
      if (lower.includes(kw.toLowerCase())) {
        out.add(code);
        break;
      }
    }
  }
  return out;
}

export function deriveRequiredCountersignDepts(
  _db: DB,
  c: ContractRow,
  opts: { fallbackDefault?: boolean } = {},
): { deptCode: CountersignDeptCode; deptName: string; triggerReason: string }[] {
  const reasons = new Map<CountersignDeptCode, string[]>();
  const add = (code: CountersignDeptCode, reason: string) => {
    const list = reasons.get(code) ?? [];
    if (!list.includes(reason)) list.push(reason);
    reasons.set(code, list);
  };

  const current = BigInt(c.original_cents) + BigInt(c.approved_change_cents);
  const effectiveAmt = c.pricing_mode === 'unit_price' && current === 0n && c.estimated_ceiling_cents != null
    ? BigInt(c.estimated_ceiling_cents)
    : current;
  const tier = procurementTier(!!c.is_procurement, c.procurement_target, effectiveAmt, c.procurement_method);

  if (
    c.report_category === 'engineering' ||
    c.procurement_target === 'construction' ||
    c.legal_category === 'construction' ||
    c.legal_category === 'small_construction' ||
    c.legal_category === 'tech_service'
  ) {
    add('ANJI', '工程施工/检修或技术服务安全技术归口审查');
  }
  if (
    c.budget_type === 'single_listed' &&
    c.project_id !== null &&
    (c.procurement_target === 'construction' || effectiveAmt >= 100_000_000n)
  ) {
    add('JIANGUAN', '基建投资或百万级工程建管归口审查');
  }
  const combinedText = `${c.name} ${c.contract_type} ${c.summary_text}`;
  if (IT_KEYWORDS.some((kw) => combinedText.includes(kw))) {
    add('DIAOXIN', '涉调度通信/信息化系统专项审查');
  }
  if (
    Number(c.is_important) === 1 ||
    Number(c.is_triple_major) === 1 ||
    tier === 'tier_1' ||
    ['construction', 'small_construction', 'goods_procurement', 'tech_service', 'important_special'].includes(c.legal_category)
  ) {
    add('QIGUAN', '合同归口与合法合规性审查');
  }
  if (
    c.direction === 'income' ||
    c.budget_type === 'lump_sum_pool' ||
    effectiveAmt >= 50_000_000n ||
    Number(c.is_important) === 1
  ) {
    add('CAIWU', '年度预算/包干总额度及税务条款审查');
  }
  if (
    c.direction === 'income' ||
    c.currency !== '人民币' ||
    c.farmer_wage_account.trim() !== ''
  ) {
    add('JIESUAN', '资金结算账户、外币汇率或农民工工资专户审查');
  }
  if (Number(c.is_triple_major) === 1 || Number(c.is_emergency) === 1 || tier === 'tier_1') {
    add('JISHEN', '一级采购/三重一大/应急项目纪检审计监督审查');
  }

  for (const explicit of parseExplicitDepts(c.related_mgmt_depts)) {
    add(explicit, '合同登记指定关联职能部门会签');
  }

  if (reasons.size === 0 && opts.fallbackDefault) {
    add('QIGUAN', '合同归口管理基础会签');
    add('CAIWU', '预算与财务结算基础会签');
  }

  return COUNTERSIGN_DEPTS.filter((code) => reasons.has(code)).map((code) => ({
    deptCode: code,
    deptName: COUNTERSIGN_DEPT_LABELS[code],
    triggerReason: reasons.get(code)!.join('；'),
  }));
}

function orgMatchesDept(orgCode: string | null, orgName: string, deptCode: string): boolean {
  const codeNorm = (orgCode ?? '').trim().toLowerCase();
  const nameNorm = orgName.trim().toLowerCase();
  const upper = deptCode.toUpperCase() as CountersignDeptCode;
  const kws = DEPT_MATCH_KEYWORDS[upper];
  if (!kws) {
    return codeNorm === deptCode.toLowerCase() || nameNorm.includes(deptCode.toLowerCase());
  }
  if (codeNorm === deptCode.toLowerCase() || codeNorm.endsWith(`-${deptCode.toLowerCase()}`) || codeNorm.endsWith(`_${deptCode.toLowerCase()}`)) {
    return true;
  }
  // Avoid matching "财务结算中心" as "财务部": check JIESUAN first
  if (upper === 'CAIWU' && (nameNorm.includes('结算中心') || nameNorm.includes('财务结算'))) {
    return false;
  }
  return kws.some((kw) => codeNorm.includes(kw.toLowerCase()) || nameNorm.includes(kw.toLowerCase()));
}

/**
 * 严格校验当前登录用户是否属于目标职能会签部门组织节点，或等于受权指派审查人。
 * 严禁任意持 contract:review 的其他部门账号跨部门代签意见。
 */
export function canUserDecideCountersign(
  db: DB,
  auth: AuthContext | undefined,
  row: { dept_code: string; assigned_reviewer_user_id: number | null },
): boolean {
  if (!auth || !auth.permissions.has('contract:review')) return false;
  if (row.assigned_reviewer_user_id !== null && auth.userId === Number(row.assigned_reviewer_user_id)) {
    return true;
  }
  const userOrgs = db.prepare(
    `SELECT o.id, o.code, o.name
     FROM app_user_org_scope s
     JOIN org o ON o.id = s.org_id
     WHERE s.user_id = ? AND o.status = 'active'`,
  ).all(auth.userId) as { id: number; code: string | null; name: string }[];
  return userOrgs.some((o) => orgMatchesDept(o.code, o.name, row.dept_code));
}

function shouldAutoGenerateCountersigns(db: DB, c: ContractRow, force?: boolean): boolean {
  if (force) return true;
  const existing = db.prepare('SELECT 1 FROM ct_countersign WHERE contract_id = ? LIMIT 1').get(c.id);
  if (existing) return true;
  if (c.origin === 'legacy_migration' || c.migration_mode === 'legacy_tolerant') return false;
  const hqDeptCount = (
    db.prepare("SELECT COUNT(*) AS n FROM org WHERE org_kind = 'hq_dept' AND status = 'active'").get() as { n: number }
  ).n;
  return hqDeptCount > 0;
}

function computeDueDate(db: DB, baseDate: string): string | null {
  const dueDays = Number(getSetting<number>(db, 'contract.countersign_due_days') ?? 0);
  if (!dueDays || dueDays <= 0) return null;
  return addWorkingDays(baseDate, dueDays, workingCalendar(db));
}

export function syncContractCountersigns(
  db: DB,
  contract: ContractRow,
  opts: CountersignSyncInput = {},
): ContractCountersignDto[] {
  if (!shouldAutoGenerateCountersigns(db, contract, opts.force)) {
    return listContractCountersigns(db, contract.id);
  }

  const fingerprint = computeCountersignFingerprint(db, contract);
  const depts = deriveRequiredCountersignDepts(db, contract, { fallbackDefault: !!opts.force });
  if (depts.length === 0) return listContractCountersigns(db, contract.id);

  const now = nowIso();
  const dueDate = computeDueDate(db, todayIso());

  db.transaction(() => {
    const maxRoundRow = db.prepare(
      'SELECT COALESCE(MAX(round_no), 0) AS max_round FROM ct_countersign WHERE contract_id = ?',
    ).get(contract.id) as { max_round: number };
    let targetRound = maxRoundRow.max_round;

    if (targetRound === 0) {
      targetRound = 1;
    } else {
      const latestRows = db.prepare(
        'SELECT id, dept_code, doc_fingerprint, status, assigned_reviewer_user_id FROM ct_countersign WHERE contract_id = ? AND round_no = ?',
      ).all(contract.id, targetRound) as {
        id: number;
        dept_code: string;
        doc_fingerprint: string;
        status: CountersignStatus;
        assigned_reviewer_user_id: number | null;
      }[];
      const prevFp = latestRows[0]?.doc_fingerprint ?? '';
      const hasDecided = latestRows.some((r) => r.status === 'approved' || r.status === 'returned' || r.status === 'waived');
      if (prevFp !== fingerprint && hasDecided) {
        // 指纹发生实质变更且已有会签记录：旧轮次全部置 superseded，开启 round_no + 1
        db.prepare(
          "UPDATE ct_countersign SET status = 'superseded', updated_at = ? WHERE contract_id = ? AND round_no = ? AND status <> 'superseded'",
        ).run(now, contract.id, targetRound);
        const prevAssign = new Map(latestRows.map((r) => [r.dept_code, r.assigned_reviewer_user_id]));
        targetRound += 1;
        for (const d of depts) {
          const assigned = opts.assignedReviewers?.[d.deptCode] !== undefined
            ? opts.assignedReviewers[d.deptCode]
            : (prevAssign.get(d.deptCode) ?? null);
          db.prepare(
            `INSERT INTO ct_countersign (
              contract_id, round_no, doc_fingerprint, dept_code, dept_name, trigger_reason,
              assigned_reviewer_user_id, due_date, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          ).run(contract.id, targetRound, fingerprint, d.deptCode, d.deptName, d.triggerReason, assigned, dueDate, now, now);
        }
        return;
      }
      // 尚未有任何部门出结论时，原地刷新待签轮次的指纹与新增部门
      db.prepare(
        'UPDATE ct_countersign SET doc_fingerprint = ?, due_date = COALESCE(due_date, ?), updated_at = ? WHERE contract_id = ? AND round_no = ?',
      ).run(fingerprint, dueDate, now, contract.id, targetRound);
    }

    for (const d of depts) {
      const assigned = opts.assignedReviewers?.[d.deptCode] ?? null;
      const existing = db.prepare(
        'SELECT id, assigned_reviewer_user_id FROM ct_countersign WHERE contract_id = ? AND round_no = ? AND dept_code = ?',
      ).get(contract.id, targetRound, d.deptCode) as { id: number; assigned_reviewer_user_id: number | null } | undefined;
      if (!existing) {
        db.prepare(
          `INSERT INTO ct_countersign (
            contract_id, round_no, doc_fingerprint, dept_code, dept_name, trigger_reason,
            assigned_reviewer_user_id, due_date, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(contract.id, targetRound, fingerprint, d.deptCode, d.deptName, d.triggerReason, assigned, dueDate, now, now);
      } else if (opts.assignedReviewers && opts.assignedReviewers[d.deptCode] !== undefined) {
        db.prepare(
          'UPDATE ct_countersign SET assigned_reviewer_user_id = ?, trigger_reason = ?, updated_at = ? WHERE id = ?',
        ).run(opts.assignedReviewers[d.deptCode], d.triggerReason, now, existing.id);
      }
    }
  })();

  return listContractCountersigns(db, contract.id);
}

export function listContractCountersigns(db: DB, contractId: number): ContractCountersignDto[] {
  const auth = currentAuth();
  const today = todayUtcDate();
  const rows = db.prepare(
    `SELECT cs.*, COALESCE(ua.display_name, ua.username) AS assigned_name
     FROM ct_countersign cs
     LEFT JOIN app_user ua ON ua.id = cs.assigned_reviewer_user_id
     WHERE cs.contract_id = ?
     ORDER BY cs.round_no DESC, cs.id ASC`,
  ).all(contractId) as {
    id: number;
    contract_id: number;
    round_no: number;
    doc_fingerprint: string;
    dept_code: string;
    dept_name: string;
    trigger_reason: string;
    assigned_reviewer_user_id: number | null;
    assigned_name: string | null;
    reviewer_user_id: number | null;
    reviewer_name: string;
    due_date: string | null;
    status: CountersignStatus;
    opinion: string;
    decided_at: string | null;
    created_at: string;
    updated_at: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    contractId: r.contract_id,
    roundNo: r.round_no,
    docFingerprint: r.doc_fingerprint,
    deptCode: r.dept_code,
    deptName: r.dept_name,
    triggerReason: r.trigger_reason,
    assignedReviewerUserId: r.assigned_reviewer_user_id,
    assignedReviewerName: r.assigned_name,
    reviewerUserId: r.reviewer_user_id,
    reviewerName: r.reviewer_name,
    dueDate: r.due_date,
    overdue: r.status === 'pending' && !!r.due_date && r.due_date < today,
    canDecide: r.status === 'pending' && canUserDecideCountersign(db, auth, r),
    status: r.status,
    opinion: r.opinion,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function computeCountersignBlockers(db: DB, c: ContractRow): BlockerDto[] {
  const maxRoundRow = db.prepare(
    'SELECT COALESCE(MAX(round_no), 0) AS max_round FROM ct_countersign WHERE contract_id = ?',
  ).get(c.id) as { max_round: number };
  if (maxRoundRow.max_round === 0) {
    const hqDeptCount = (
      db.prepare("SELECT COUNT(*) AS n FROM org WHERE org_kind = 'hq_dept' AND status = 'active'").get() as { n: number }
    ).n;
    if (hqDeptCount > 0 && c.origin !== 'legacy_migration' && c.migration_mode !== 'legacy_tolerant' && c.related_mgmt_depts.trim() !== '') {
      return [{ code: 'COUNTERSIGN_PENDING', message: '合同已登记关联管理部门，请先发起并完成多部门结构化会签' }];
    }
    return [];
  }
  const currentFp = computeCountersignFingerprint(db, c);
  const rows = db.prepare(
    'SELECT dept_code, dept_name, doc_fingerprint, status FROM ct_countersign WHERE contract_id = ? AND round_no = ? ORDER BY id ASC',
  ).all(c.id, maxRoundRow.max_round) as {
    dept_code: string;
    dept_name: string;
    doc_fingerprint: string;
    status: CountersignStatus;
  }[];
  if (!rows.length) return [];
  if (rows.some((r) => r.doc_fingerprint !== currentFp)) {
    return [{ code: 'COUNTERSIGN_OUTDATED', message: '合同核心要素或正文已在会签后变更，须开启新一轮部门重签' }];
  }
  const returned = rows.filter((r) => r.status === 'returned');
  if (returned.length) {
    return [{ code: 'COUNTERSIGN_RETURNED', message: `部门会签已退回修改：${returned.map((r) => r.dept_name).join('、')}` }];
  }
  const pending = rows.filter((r) => r.status !== 'approved' && r.status !== 'waived');
  if (pending.length) {
    return [{ code: 'COUNTERSIGN_PENDING', message: `尚有 ${pending.length} 个职能部门未完成会签：${pending.map((r) => r.dept_name).join('、')}` }];
  }
  return [];
}

export function decideContractCountersign(
  db: DB,
  contractRow: ContractRow,
  countersignId: number,
  input: ContractCountersignDecideRequest,
): ContractCountersignDto[] {
  const scope = currentOrgScope(db);
  const auth = currentAuth();
  if (!auth || !auth.permissions.has('contract:review')) {
    throw Errors.forbidden('需要合同复核权限 (contract:review)');
  }
  const cs = db.prepare('SELECT * FROM ct_countersign WHERE id = ? AND contract_id = ?').get(
    countersignId,
    contractRow.id,
  ) as {
    id: number;
    contract_id: number;
    round_no: number;
    doc_fingerprint: string;
    dept_code: string;
    dept_name: string;
    assigned_reviewer_user_id: number | null;
    status: CountersignStatus;
  } | undefined;
  if (!cs) throw notVisible('部门会签记录');

  // 允许合同所属单位在范围内，或当前用户正是该职能会签部门审查人/受权指派人
  const isDeptReviewer = canUserDecideCountersign(db, auth, cs);
  if (!isDeptReviewer && !orgInScope(scope, contractRow.org_id)) {
    throw notVisible('合同');
  }
  if (!isDeptReviewer) {
    throw new AppError(
      'COUNTERSIGN_DEPT_FORBIDDEN',
      `仅「${cs.dept_name}」组织成员或受权指派审查人可签署本部门会签意见`,
      403,
    );
  }
  if (contractRow.status !== 'active') {
    throw new AppError('CONTRACT_STATE', '只有进行中的合同可签署会签意见', 409);
  }
  if (cs.status !== 'pending') {
    throw new AppError('COUNTERSIGN_STATE', '该轮部门会签已处理或已失效，不能重复签署', 409);
  }
  const currentFp = computeCountersignFingerprint(db, contractRow);
  if (cs.doc_fingerprint !== currentFp) {
    syncContractCountersigns(db, contractRow, { force: true });
    throw new AppError('COUNTERSIGN_OUTDATED', '合同金额、关键要素或正文已变更，已自动生成新轮次会签，请刷新后在新轮次签署', 409);
  }

  const userRow = db.prepare('SELECT COALESCE(display_name, username) AS name FROM app_user WHERE id = ?').get(auth.userId) as
    | { name: string }
    | undefined;
  const reviewerName = userRow?.name ?? auth.username;
  const now = nowIso();

  db.transaction(() => {
    db.prepare(
      `UPDATE ct_countersign
       SET status = ?, opinion = ?, reviewer_user_id = ?, reviewer_name = ?,
           trigger_reason = COALESCE(NULLIF(?, ''), trigger_reason),
           decided_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.decision, input.opinion.trim(), auth.userId, reviewerName, input.triggerReason?.trim() ?? '', now, now, cs.id);

    db.prepare('UPDATE ct_contract SET version = version + 1, updated_at = ? WHERE id = ?').run(now, contractRow.id);
    db.prepare(
      'INSERT INTO ct_event (contract_id, event_type, from_stage, to_stage, detail_json, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      contractRow.id,
      'countersign.decide',
      contractRow.stage,
      contractRow.stage,
      JSON.stringify({
        countersignId: cs.id,
        roundNo: cs.round_no,
        deptCode: cs.dept_code,
        deptName: cs.dept_name,
        decision: input.decision,
        opinion: input.opinion.trim(),
      }),
      auth.userId,
      now,
    );
    writeLog(db, 'contract.countersign.decide', 'ct_contract', contractRow.id, {
      countersignId: cs.id,
      roundNo: cs.round_no,
      deptCode: cs.dept_code,
      decision: input.decision,
    });
  }).immediate();

  return listContractCountersigns(db, contractRow.id);
}
