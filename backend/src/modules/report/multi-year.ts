/**
 * 多年趋势同口径对比原语(AI 功能增强计划 §四.阶段五,确定性部分)。
 *
 * - 按编码对齐跨年数据(沿用编码索引以抗快照变化,组织/科目 id 跨年不复用);
 * - 同期批次选择沿用 anomaly.ts 的 SAME_PERIOD_TOLERANCE_DAYS=7「超窗如实跳过」语义;
 * - 可比性声明:每年哪些编码匹配上/新增/消失、哪年没有可比窗口;
 * - 组织过滤改为「按年求值、缺失如实声明」,修复「去年有、今年没有的组织被静默丢弃」;
 * - 维度下探:组织维度与科目维度(默认叶子)的跨年对比,供 annualReview 与图表消费。
 *
 * 所有金额保持整数分,数量保持 10^4 缩放整数;利润方向符号沿用 signOfType。
 */
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import type { TreeNodeRow } from '../../core/tree';
import { isQuantityType, safeIntegerAdd, signOfType } from '../../core/money';
import { resolveActualSource } from './report.service';
import { listBatches } from '../actual/actual.service';

export const SAME_PERIOD_TOLERANCE_DAYS = 7;
export const MAX_TREND_YEARS = 10;

/** MM-DD 折算成非闰年的年内第几天,只用于比较两个日期的窗口长度是否接近。 */
function dayOfYearFromMonthDay(monthDay: string, year?: number): number | null {
  const match = /^(\d{2})-(\d{2})$/.exec(monthDay);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  /* 非闰年累计表:2 月固定 28 天。跨「是否闰年」比较两个 MM-DD 时,
     把 >2/28 的日期统一加 1 天补偿——否则 2024(闰)的 03-01 与 2025(平)的 03-01
     会差出 1 天,gap 恰好 7 天时被误判成 8 天而跳过该年。 */
  const leapCompensation = month > 2 ? 1 : 0;
  return cumulative[month - 1] + day + leapCompensation;
}

/** 某年度最接近 asOfMonthDay 的 active 快照;超窗如实跳过(与 anomaly 同语义)。 */
export function samePeriodBatch(
  db: DB,
  year: number,
  asOfMonthDay: string,
): { batchId: number; snapshotDate: string; gapDays: number } | { batchId: null; reason: string } {
  const currentDay = dayOfYearFromMonthDay(asOfMonthDay);
  if (currentDay == null) return { batchId: null, reason: `无法解析截至日期 ${asOfMonthDay}` };
  const batches = (listBatches(db, year) as { id: number; snapshot_date: string; status: string }[])
    .filter((batch) => batch.status === 'active');
  let best: { batchId: number; gapDays: number; date: string } | null = null;
  for (const batch of batches) {
    const day = dayOfYearFromMonthDay(String(batch.snapshot_date).slice(5));
    if (day == null) continue;
    const gapDays = Math.abs(day - currentDay);
    if (!best || gapDays < best.gapDays) best = { batchId: batch.id, gapDays, date: batch.snapshot_date };
  }
  if (!best) return { batchId: null, reason: `${year} 年没有可用快照` };
  if (best.gapDays > SAME_PERIOD_TOLERANCE_DAYS) {
    return {
      batchId: null,
      reason: `${year} 年最接近的快照是 ${best.date},与目标窗口 ${asOfMonthDay} 相差 ${best.gapDays} 天,`
        + `累计窗口长度不可比(超过 ${SAME_PERIOD_TOLERANCE_DAYS} 天容差),已跳过该年`,
    };
  }
  return { batchId: best.batchId, snapshotDate: best.date, gapDays: best.gapDays };
}

/* ---------------- 单年取值(按编码聚合) ---------------- */

export interface YearCaliberData {
  year: number;
  source: 'snapshot' | 'final' | 'current' | 'none';
  batchId: number | null;
  asOfDate: string | null;
  /** 科目编码 -> 带符号金额(分);编码->名称/类型取自该年快照 */
  amountByCode: Map<string, number>;
  quantityByCode: Map<string, number>;
  /** 组织编码 -> 带符号金额(分,全部科目合计) */
  amountByOrgCode: Map<string, number>;
  accountMeta: Map<string, { name: string; type: string }>;
  orgMeta: Map<string, { name: string }>;
}

/**
 * 单年实际按编码聚合。orgCodes 为过滤范围时按「该年自己的树」求值:
 * 去年有、今年没有的组织在该年如实计入/缺席,由可比性声明表达,不做静默丢弃。
 * accountCodes 同理:范围继承按编码跨年对齐,不按 id。
 */
export function yearCaliberData(
  db: DB,
  year: number,
  batchId: number | null,
  orgCodes: Set<string> | null,
  accountCodes: Set<string> | null = null,
): YearCaliberData {
  const source = resolveActualSource(db, year, batchId);
  const orgCodeById = new Map(source.orgRows.map((row) => [row.id, row.code]));
  const orgNameById = new Map(source.orgRows.map((row) => [row.id, row.name]));
  const accById = new Map(source.accRows.map((row) => [row.id, row]));
  const amountByCode = new Map<string, number>();
  const quantityByCode = new Map<string, number>();
  const amountByOrgCode = new Map<string, number>();
  const accountMeta = new Map<string, { name: string; type: string }>();
  const orgMeta = new Map<string, { name: string }>();
  for (const entry of source.entries) {
    const orgCode = orgCodeById.get(entry.orgId);
    if (orgCodes && (!orgCode || !orgCodes.has(orgCode))) continue;
    const acc = accById.get(entry.accountId);
    if (!acc || !orgCode) continue;
    if (accountCodes && !accountCodes.has(acc.code)) continue;
    const type = String(acc.type ?? '');
    accountMeta.set(acc.code, { name: acc.name, type });
    orgMeta.set(orgCode, { name: orgNameById.get(entry.orgId) ?? orgCode });
    if (isQuantityType(type)) {
      if (entry.quantity != null) quantityByCode.set(acc.code, safeIntegerAdd(quantityByCode.get(acc.code) ?? 0, entry.quantity, `${year} 年实际数量汇总`));
      continue;
    }
    amountByCode.set(acc.code, safeIntegerAdd(amountByCode.get(acc.code) ?? 0, entry.amountCents, `${year} 年实际汇总`));
    amountByOrgCode.set(orgCode, safeIntegerAdd(amountByOrgCode.get(orgCode) ?? 0, entry.amountCents, `${year} 年组织实际汇总`));
  }
  return { year, source: source.source, batchId: source.batchId, asOfDate: source.asOfDate, amountByCode, quantityByCode, amountByOrgCode, accountMeta, orgMeta };
}

/* ---------------- N 年同口径对比 ---------------- */

export interface TrendYearPoint {
  year: number;
  comparable: boolean;
  /** 实际取数的快照批次(供对账与 provenance) */
  batchId: number | null;
  /** 不可比时的确定性原因(无快照/超窗/无数据) */
  reason?: string;
  source: 'snapshot' | 'final' | 'current' | 'none';
  asOfDate: string | null;
  /** 该年出现的科目编码集合 */
  accountCodes: string[];
  orgCodes: string[];
}

export interface AccountTrendRow {
  code: string;
  name: string;
  type: string;
  /** year -> 展示口径值(金额按利润方向翻正,数量取缩放整数);不可比/未出现年份缺失 */
  values: Record<number, number>;
  /** 对比基准年(最早可比年)存在值时的逐年同比(仅相邻且上年有值时计算) */
  yoy: Record<number, number | null>;
}

export interface OrgTrendRow {
  code: string;
  name: string;
  values: Record<number, number>;
  yoy: Record<number, number | null>;
}

export interface MultiYearTrendResult {
  baseYear: number;
  /** 横轴(可比年在前,不可比年带 reason 如实列出) */
  years: TrendYearPoint[];
  accounts: AccountTrendRow[];
  orgs: OrgTrendRow[];
  /** 本次实际生效的范围(继承自调用方,供叙述与图表如实声明口径) */
  scope: {
    baseBatchId: number | null;
    orgScopeId: number | null;
    accountScopeId: number | null;
    /** 解析后的编码过滤集合(null = 不过滤) */
    orgCodes: string[] | null;
    accountCodes: string[] | null;
  };
  comparability: {
    matchedAccountCodes: string[];
    addedAccountCodes: string[];
    removedAccountCodes: string[];
    matchedOrgCodes: string[];
    addedOrgCodes: string[];
    removedOrgCodes: string[];
    notes: string[];
  };
}

/** 范围节点 → 子树编码集合。按基准年实际数据绑定的树解析,跨年再按编码对齐。 */
function scopeCodes(rows: TreeNodeRow[], scopeId: number | null | undefined, label: string): Set<string> | null {
  if (scopeId == null) return null;
  if (!rows.some((row) => row.id === scopeId)) throw Errors.validation(`所选${label}范围节点 #${scopeId} 不在基准年实际数据绑定树中`);
  const children = new Map<number, TreeNodeRow[]>();
  for (const row of rows) {
    const list = children.get(row.parent_id ?? 0) ?? [];
    list.push(row);
    children.set(row.parent_id ?? 0, list);
  }
  const codes = new Set<string>();
  const stack = [scopeId];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = rows.find((row) => row.id === id);
    if (node) codes.add(node.code);
    for (const child of children.get(id) ?? []) stack.push(child.id);
  }
  return codes;
}

function intersectCodes(a: Set<string> | null, b: Set<string> | null): Set<string> | null {
  if (!a) return b;
  if (!b) return a;
  return new Set([...a].filter((code) => b.has(code)));
}

function parseYears(
  db: DB,
  baseYear: number,
  depth: number,
  orgCodes: Set<string> | null,
  accountCodes: Set<string> | null,
  baseBatchId: number | null,
): { points: TrendYearPoint[]; data: YearCaliberData[] } {
  const points: TrendYearPoint[] = [];
  const data: YearCaliberData[] = [];
  const base = resolveActualSource(db, baseYear, baseBatchId);
  const baseMonthDay = base.asOfDate ? base.asOfDate.slice(5) : null;
  for (let offset = depth - 1; offset >= 0; offset--) {
    const year = baseYear - offset;
    if (offset === 0) {
      const current = yearCaliberData(db, year, baseBatchId, orgCodes, accountCodes);
      data.push(current);
      points.push({
        year,
        comparable: current.source !== 'none',
        batchId: current.batchId,
        ...(current.source === 'none' ? { reason: `${year} 年没有实际数据` } : {}),
        source: current.source,
        asOfDate: current.asOfDate,
        accountCodes: [...current.amountByCode.keys(), ...current.quantityByCode.keys()],
        orgCodes: [...current.amountByOrgCode.keys()],
      });
      continue;
    }
    if (!baseMonthDay) {
      points.push({ year, comparable: false, batchId: null, reason: '基准年没有实际截至日期,无法定义同期窗口', source: 'none', asOfDate: null, accountCodes: [], orgCodes: [] });
      continue;
    }
    const pick = samePeriodBatch(db, year, baseMonthDay);
    if (pick.batchId == null) {
      points.push({ year, comparable: false, batchId: null, reason: pick.reason, source: 'none', asOfDate: null, accountCodes: [], orgCodes: [] });
      continue;
    }
    const current = yearCaliberData(db, year, pick.batchId, orgCodes, accountCodes);
    data.push(current);
    points.push({
      year,
      comparable: true,
      batchId: current.batchId,
      source: current.source,
      asOfDate: current.asOfDate,
      accountCodes: [...current.amountByCode.keys(), ...current.quantityByCode.keys()],
      orgCodes: [...current.amountByOrgCode.keys()],
    });
  }
  return { points, data };
}

/**
 * N 年同口径对比:baseYear 向前取 depth 年(含基准年),历史年取与基准年同期(±7 天)的快照;
 * 编码按年对齐,可比性声明列出新增/消失编码与不可比窗口。
 *
 * 范围继承(计划阶段五):orgScopeId / accountScopeId / baseBatchId 与 annualReview 等
 * 调用方的范围一致——范围节点先按基准年实际绑定的树解析成编码集合,再跨年按编码对齐,
 * 避免「报告主体按范围取数、趋势章节按全量取数」这种同一份报告内的口径不一致。
 */
export function multiYearTrend(db: DB, input: {
  baseYear: number;
  /** 含基准年在内的年数,默认 3,最大 MAX_TREND_YEARS */
  depth?: number;
  /** 组织编码过滤(可选);按各年自己的树求值,缺失如实声明 */
  orgCodes?: string[];
  /** 科目编码过滤(可选) */
  accountCodes?: string[];
  /** 基准年实际快照批次;缺省按年度状态自动选择 */
  baseBatchId?: number | null;
  /** 组织范围节点(子树),按基准年实际绑定树解析成编码集合 */
  orgScopeId?: number | null;
  /** 科目范围节点(子树),按基准年实际绑定树解析成编码集合 */
  accountScopeId?: number | null;
}): MultiYearTrendResult {
  const baseYear = Number(input.baseYear);
  if (!Number.isInteger(baseYear) || baseYear < 2000 || baseYear > 2100) throw Errors.validation('baseYear 必须是 2000-2100 的整数年');
  const depth = input.depth == null ? 3 : Number(input.depth);
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_TREND_YEARS) throw Errors.validation(`depth 必须是 1 到 ${MAX_TREND_YEARS} 的整数`);
  const baseBatchId = input.baseBatchId ?? null;
  const baseSource = resolveActualSource(db, baseYear, baseBatchId);
  const orgCodes = intersectCodes(
    input.orgCodes && input.orgCodes.length > 0 ? new Set(input.orgCodes) : null,
    scopeCodes(baseSource.orgRows, input.orgScopeId, '组织'),
  );
  const accountCodes = intersectCodes(
    input.accountCodes && input.accountCodes.length > 0 ? new Set(input.accountCodes) : null,
    scopeCodes(baseSource.accRows, input.accountScopeId, '科目'),
  );
  const { points, data } = parseYears(db, baseYear, depth, orgCodes, accountCodes, baseBatchId);

  const comparableYears = data.filter((item) => points.find((point) => point.year === item.year)?.comparable);
  const baseData = data.find((item) => item.year === baseYear);

  // 可比性声明:锚定最早可比年。新增 = 更晚可比年出现而最早年没有;
  // 消失 = 最早年有而更晚可比年都没有(去年有、今年没有的组织如实进 removed,不静默丢弃)。
  const anchor = comparableYears[0] as YearCaliberData | undefined;
  const anchorAccountCodes = new Set(anchor ? [...anchor.amountByCode.keys(), ...anchor.quantityByCode.keys()] : []);
  const anchorOrgCodes = new Set(anchor ? [...anchor.amountByOrgCode.keys()] : []);
  const laterAccountCodes = new Set<string>();
  const laterOrgCodes = new Set<string>();
  const allAccountCodes = new Set<string>();
  const allOrgCodes = new Set<string>();
  for (const item of comparableYears) {
    const accounts = [...item.amountByCode.keys(), ...item.quantityByCode.keys()];
    const orgs = [...item.amountByOrgCode.keys()];
    for (const code of accounts) allAccountCodes.add(code);
    for (const code of orgs) allOrgCodes.add(code);
    if (anchor && item.year === anchor.year) continue;
    for (const code of accounts) laterAccountCodes.add(code);
    for (const code of orgs) laterOrgCodes.add(code);
  }
  const accountDiff = {
    matched: [...anchorAccountCodes].filter((code) => laterAccountCodes.has(code)).sort(),
    added: [...laterAccountCodes].filter((code) => !anchorAccountCodes.has(code)).sort(),
    removed: [...anchorAccountCodes].filter((code) => !laterAccountCodes.has(code)).sort(),
  };
  const orgDiff = {
    matched: [...anchorOrgCodes].filter((code) => laterOrgCodes.has(code)).sort(),
    added: [...laterOrgCodes].filter((code) => !anchorOrgCodes.has(code)).sort(),
    removed: [...anchorOrgCodes].filter((code) => !laterOrgCodes.has(code)).sort(),
  };
  // 维度下探:科目行(明细按编码取值,天然是叶子级;编码对齐跨年抗快照变化)
  const accountRows: AccountTrendRow[] = [];
  for (const code of [...allAccountCodes].sort()) {
    const firstYear = comparableYears.find((item) => item.accountMeta.has(code));
    const meta = firstYear?.accountMeta.get(code);
    if (!meta) continue;
    const values: Record<number, number> = {};
    const yoy: Record<number, number | null> = {};
    let previousYear: number | null = null;
    for (const item of comparableYears) {
      const isQuantity = isQuantityType(meta.type);
      const raw = isQuantity ? item.quantityByCode.get(code) : item.amountByCode.get(code);
      if (raw == null) continue;
      const display = isQuantity ? raw : raw * signOfType(meta.type as Parameters<typeof signOfType>[0]);
      values[item.year] = display;
      yoy[item.year] = previousYear != null && item.year === previousYear + 1 && values[previousYear] !== 0
        ? (display - values[previousYear]) / Math.abs(values[previousYear])
        : null;
      previousYear = item.year;
    }
    accountRows.push({ code, name: meta.name, type: meta.type, values, yoy });
  }

  const orgRows: OrgTrendRow[] = [];
  for (const code of [...allOrgCodes].sort()) {
    const firstYear = comparableYears.find((item) => item.orgMeta.has(code));
    const meta = firstYear?.orgMeta.get(code);
    if (!meta) continue;
    const values: Record<number, number> = {};
    const yoy: Record<number, number | null> = {};
    let previousYear: number | null = null;
    for (const item of comparableYears) {
      const raw = item.amountByOrgCode.get(code);
      if (raw == null) continue;
      // 组织维度合计保留利润方向(收入-成本-费用),与综合口径一致
      values[item.year] = raw;
      yoy[item.year] = previousYear != null && item.year === previousYear + 1 && values[previousYear] !== 0
        ? (raw - values[previousYear]) / Math.abs(values[previousYear])
        : null;
      previousYear = item.year;
    }
    orgRows.push({ code, name: meta.name, values, yoy });
  }

  return {
    baseYear,
    years: points,
    accounts: accountRows,
    orgs: orgRows,
    scope: {
      baseBatchId,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
      orgCodes: orgCodes ? [...orgCodes].sort() : null,
      accountCodes: accountCodes ? [...accountCodes].sort() : null,
    },
    comparability: {
      matchedAccountCodes: accountDiff.matched,
      addedAccountCodes: accountDiff.added,
      removedAccountCodes: accountDiff.removed,
      matchedOrgCodes: orgDiff.matched,
      addedOrgCodes: orgDiff.added,
      removedOrgCodes: orgDiff.removed,
      notes: [
        `历史年一律取与基准年同期(${SAME_PERIOD_TOLERANCE_DAYS} 天容差)的 active 快照;超窗年份如实跳过并在 years 中声明`,
        '跨年按编码对齐;编码新增/消失见 added/removed 清单,不做静默丢弃',
        '组织过滤按各年自己的树求值:某年不存在范围内组织时该年该编码无值,不等同于 0',
        '组织/科目范围与基准年批次继承自调用方;范围节点按基准年实际绑定树解析成编码集合后跨年对齐',
      ],
    },
  };
}
