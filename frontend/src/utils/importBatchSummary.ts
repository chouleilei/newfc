/**
 * 导入批次业务摘要与结果追溯(方案《易用性与直觉化交互实施方案》§4.4/§4.9,任务 UX-19)。
 *
 * 纯函数模块,供导入批次列表(DataManage)、批次详情抽屉(ImportBatchDetailDrawer)、
 * 数字来源抽屉(EvidenceDrawer)共用同一套业务表达:
 * - 摘要:来源(标准模板/清洗/财务转换)、目标(预算版本/当前累计/历史补录)、年度、
 *   期间/截止日、动作计数(新增/覆盖/清零/不变/跳过),原始 JSON 只留在「技术详情」;
 * - 新批次(summary.unifiedPreview,UX-14 冻结的统一摘要)优先;旧批次回退识别 legacy
 *   摘要(financeConversionId / cleaning actions / versionId / years),识别失败返回
 *   recognized=false,由调用方回退到技术详情,不编造业务口径;
 * - 列表范围筛选(年度/类型/状态)与 URL 参数解析:非法值忽略并记录,不静默替换;
 * - 结果与更正路径:已提交批次的年度×截止日×快照结果行,以及撤销不可用时的
 *   更正路径说明(如「通过新的更正导入覆盖」)。
 */
import {
  IMPORT_BATCH_STATUS_LABEL,
  IMPORT_SOURCE_LABEL,
  type ImportBatchDetail,
  type ImportBatchStatus,
  type PreviewSource,
  type UnifiedPreviewSummary,
} from '../api/importBatch';

/* ============================== 业务摘要 ============================== */

export interface ImportBatchSummaryInput {
  kind: 'budget' | 'actual';
  history: boolean;
  /** 解析后的 summary_json(可能含 UX-14 冻结的 unifiedPreview)。 */
  summary: Record<string, unknown>;
  /** 预算目标版本名(列表由 /versions 映射,详情由 detail.target 提供);未知时回退编号。 */
  versionName?: string | null;
  /** 批次详情提供的目标(含版本名/期间);列表行为空。 */
  target?: ImportBatchDetail['target'];
}

export interface ImportBatchBusinessSummary {
  /** false 表示摘要结构不可识别,调用方应回退展示技术详情原文。 */
  recognized: boolean;
  source: PreviewSource | null;
  sourceLabel: string;
  /** 目标:预算版本名 / 更新当前实际 / 补录历史快照。 */
  targetLabel: string;
  /** 年度,如「2026 年」「2025、2026 年」;预算取版本年度。 */
  yearsLabel: string | null;
  /** 期间/截止日(实际数按 年度×截止日 分组);预算批次为 null。 */
  periodsLabel: string | null;
  /** 动作计数,如「新增 3 · 覆盖 2 · 清零 1 · 不变 10 · 跳过 0」;无计数时为 null。 */
  actionsLabel: string | null;
  /** 总条数,如「共 120 条」。 */
  countLabel: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function formatYears(years: number[]): string | null {
  const uniq = [...new Set(years)].sort((a, b) => a - b);
  if (uniq.length === 0) return null;
  return uniq.length === 1 ? `${uniq[0]} 年` : `${uniq.join('、')} 年`;
}

function formatPeriods(periods: { year: number; snapshotDate: string; entryCount: number }[]): string | null {
  if (periods.length === 0) return null;
  return periods
    .map((p) => `${p.year} 年截止 ${p.snapshotDate}(${p.entryCount} 条)`)
    .join(';');
}

/** 统一动作计数文案:零值项省略,仅在有任一计数时返回。 */
function formatActionCounts(a: {
  insert?: number; overwrite?: number; clear?: number; unchanged?: number;
  noteChange?: number; excluded?: number; skipped?: number;
}): string | null {
  const parts: string[] = [];
  if (a.insert) parts.push(`新增 ${a.insert}`);
  if (a.overwrite) parts.push(`覆盖 ${a.overwrite}`);
  if (a.clear) parts.push(`清零 ${a.clear}`);
  if (a.unchanged) parts.push(`不变 ${a.unchanged}`);
  if (a.noteChange) parts.push(`备注变更 ${a.noteChange}`);
  if (a.skipped) parts.push(`跳过 ${a.skipped}`);
  if (a.excluded) parts.push(`排除 ${a.excluded}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function targetLabelOf(input: ImportBatchSummaryInput): string {
  if (input.kind === 'budget') {
    const name = input.versionName ?? input.target?.versionName;
    const id = input.target?.versionId ?? num(input.summary.versionId);
    return `${name ?? (id != null ? `版本 #${id}` : '预算版本')}（预算版本）`;
  }
  return input.history ? '补录历史快照（不更新当前累计）' : '更新当前实际';
}

/**
 * 批次摘要转业务摘要。识别顺序:
 * 1. UX-14 冻结的统一摘要 summary.unifiedPreview(新批次,最完整);
 * 2. legacy 摘要:financeConversionId(财务转换)→ actions 对象(清洗)→ versionId(预算标准)→ years(实际标准);
 * 3. 均不识别时 recognized=false。
 */
export function summarizeImportBatch(input: ImportBatchSummaryInput): ImportBatchBusinessSummary {
  const base: ImportBatchBusinessSummary = {
    recognized: false,
    source: null,
    sourceLabel: '未知来源',
    targetLabel: targetLabelOf(input),
    yearsLabel: null,
    periodsLabel: null,
    actionsLabel: null,
    countLabel: null,
  };
  const summary = input.summary;

  const unified = summary.unifiedPreview;
  if (isRecord(unified)) {
    const preview = unified as unknown as UnifiedPreviewSummary;
    const target = preview.target ?? {};
    const years = Array.isArray(target.years) && target.years.length > 0
      ? (target.years as number[])
      : [
          ...(typeof target.year === 'number' ? [target.year] : []),
          ...(Array.isArray(preview.periods) ? preview.periods.map((p) => p.year) : []),
        ];
    return {
      ...base,
      recognized: true,
      source: preview.source ?? null,
      sourceLabel: preview.source ? IMPORT_SOURCE_LABEL[preview.source] : base.sourceLabel,
      targetLabel: input.kind === 'budget'
        ? `${input.versionName ?? target.versionName ?? (target.versionId != null ? `版本 #${target.versionId}` : '预算版本')}（预算版本）`
        : base.targetLabel,
      yearsLabel: formatYears(years),
      periodsLabel: formatPeriods(Array.isArray(preview.periods) ? preview.periods : []),
      actionsLabel: formatActionCounts(preview.actions ?? {}),
      countLabel: null,
    };
  }

  if (typeof summary.financeConversionId === 'number') {
    const count = num(summary.count);
    return {
      ...base,
      recognized: true,
      source: 'finance',
      sourceLabel: IMPORT_SOURCE_LABEL.finance,
      actionsLabel: formatActionCounts({
        insert: num(summary.added) ?? undefined,
        overwrite: num(summary.modified) ?? undefined,
        clear: num(summary.cleared) ?? undefined,
      }),
      countLabel: count != null ? `共 ${count} 条` : null,
    };
  }

  if (isRecord(summary.actions)) {
    const a = summary.actions;
    const counts = isRecord(summary.counts) ? summary.counts : null;
    // 清洗摘要 counts = { selected, effective, excluded, errors, warnings, unresolved }:展示生效行数
    const effective = counts ? num(counts.effective) : null;
    return {
      ...base,
      recognized: true,
      source: 'cleaning',
      sourceLabel: IMPORT_SOURCE_LABEL.cleaning,
      actionsLabel: formatActionCounts({
        insert: num(a.insert) ?? undefined,
        overwrite: num(a.overwrite) ?? undefined,
        clear: num(a.clear) ?? undefined,
        unchanged: num(a.unchanged) ?? undefined,
        excluded: num(a.excluded) ?? undefined,
        skipped: num(a.skipped) ?? undefined,
      }),
      countLabel: effective != null ? `共 ${effective} 条生效` : null,
    };
  }

  if (Array.isArray(summary.years)) {
    const years = (summary.years as unknown[]).filter((y): y is number => typeof y === 'number');
    const count = num(summary.count);
    return {
      ...base,
      recognized: true,
      source: 'standard',
      sourceLabel: IMPORT_SOURCE_LABEL.standard,
      yearsLabel: formatYears(years),
      countLabel: count != null ? `共 ${count} 条` : null,
    };
  }

  if (typeof summary.versionId === 'number') {
    const count = num(summary.count);
    return {
      ...base,
      recognized: true,
      source: 'standard',
      sourceLabel: IMPORT_SOURCE_LABEL.standard,
      yearsLabel: input.target?.year != null ? `${input.target.year} 年` : null,
      countLabel: count != null ? `共 ${count} 条` : null,
    };
  }

  return base;
}

/** 批次涉及的年度集合(列表筛选用):统一摘要/legacy years/版本年度映射。 */
export function yearsOfImportBatch(
  input: Pick<ImportBatchSummaryInput, 'kind' | 'summary' | 'target'>,
  versionYearById?: Map<number, number>,
): number[] {
  const summary = input.summary;
  const unified = summary.unifiedPreview;
  if (isRecord(unified)) {
    const preview = unified as unknown as UnifiedPreviewSummary;
    const target = preview.target ?? {};
    const years = new Set<number>();
    if (typeof target.year === 'number') years.add(target.year);
    if (Array.isArray(target.years)) for (const y of target.years) if (typeof y === 'number') years.add(y);
    if (Array.isArray(preview.periods)) for (const p of preview.periods) if (typeof p.year === 'number') years.add(p.year);
    if (years.size > 0) return [...years];
  }
  if (Array.isArray(summary.years)) {
    const years = (summary.years as unknown[]).filter((y): y is number => typeof y === 'number');
    if (years.length > 0) return years;
  }
  const versionId = input.target?.versionId ?? num(summary.versionId);
  if (input.kind === 'budget' && versionId != null) {
    const year = input.target?.year ?? versionYearById?.get(versionId);
    if (year != null) return [year];
  }
  return [];
}

/* ============================== 范围筛选(年度/类型/状态,URL 承接) ============================== */

/** 类型筛选:actual_history 是「实际数 + 历史补录」的组合,不是后端 kind。 */
export type ImportBatchKindFilter = 'budget' | 'actual' | 'actual_history';

export interface ImportBatchFilter {
  year?: number;
  kind?: ImportBatchKindFilter;
  status?: ImportBatchStatus;
}

export const IMPORT_BATCH_KIND_FILTER_LABEL: Record<ImportBatchKindFilter, string> = {
  budget: '预算版本',
  actual: '实际数(更新当前累计)',
  actual_history: '实际数(历史补录)',
};

const STATUS_VALUES: readonly ImportBatchStatus[] = ['pending', 'committed', 'rolled_back', 'cancelled'];

/**
 * 解析导入批次列表的 URL 筛选参数(year/kind/status)。
 * 非法值不进入筛选并记录原因,绝不静默替换为其他范围(与 UX-02 约定一致)。
 */
export function parseImportBatchFilters(search: string | URLSearchParams): { filter: ImportBatchFilter; issues: string[] } {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const filter: ImportBatchFilter = {};
  const issues: string[] = [];

  const rawYear = params.get('year');
  if (rawYear != null && rawYear !== '') {
    if (/^\d{4}$/.test(rawYear) && Number(rawYear) >= 1900 && Number(rawYear) <= 2100) {
      filter.year = Number(rawYear);
    } else {
      issues.push(`年度「${rawYear}」不是有效的四位年份,该筛选已忽略`);
    }
  }

  const rawKind = params.get('kind');
  if (rawKind != null && rawKind !== '') {
    if (rawKind === 'budget' || rawKind === 'actual' || rawKind === 'actual_history') {
      filter.kind = rawKind;
    } else {
      issues.push(`类型「${rawKind}」无效(仅支持 budget / actual / actual_history),该筛选已忽略`);
    }
  }

  const rawStatus = params.get('status');
  if (rawStatus != null && rawStatus !== '') {
    if ((STATUS_VALUES as readonly string[]).includes(rawStatus)) {
      filter.status = rawStatus as ImportBatchStatus;
    } else {
      issues.push(`状态「${rawStatus}」无效(仅支持 ${STATUS_VALUES.join(' / ')}),该筛选已忽略`);
    }
  }

  return { filter, issues };
}

/** 判断批次行是否命中筛选(年度集合由 yearsOfImportBatch 给出;无年度信息时年度筛选不命中)。 */
export function importBatchMatchesFilter(
  row: { kind: 'budget' | 'actual'; history: boolean; status: ImportBatchStatus; years: number[] },
  filter: ImportBatchFilter,
): boolean {
  if (filter.kind != null) {
    if (filter.kind === 'budget' && row.kind !== 'budget') return false;
    if (filter.kind === 'actual' && (row.kind !== 'actual' || row.history)) return false;
    if (filter.kind === 'actual_history' && (row.kind !== 'actual' || !row.history)) return false;
  }
  if (filter.status != null && row.status !== filter.status) return false;
  if (filter.year != null && !row.years.includes(filter.year)) return false;
  return true;
}

/* ============================== 结果与更正路径 ============================== */

/**
 * 已提交/已撤销批次的结果业务行(纯函数):
 * 实际数按 年度×截止日×快照批次 分组;预算给出版本写入条数。结果缺失返回空数组。
 */
export function describeImportResult(detail: Pick<ImportBatchDetail, 'kind' | 'result' | 'target'>): string[] {
  const result = detail.result;
  if (!isRecord(result)) return [];
  if (detail.kind === 'actual') {
    const groups = Array.isArray(result.results) ? result.results : [];
    const lines: string[] = [];
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const year = num(group.year);
      const date = typeof group.snapshotDate === 'string' ? group.snapshotDate : null;
      const count = num(group.count);
      const batchId = num(group.batchId);
      if (year == null) continue;
      lines.push(
        `${year} 年${date ? `(截止 ${date})` : ''}:写入 ${count ?? '?'} 条${batchId != null ? `,生成快照批次 #${batchId}` : ''}`,
      );
    }
    if (lines.length > 0) return lines;
    const count = num(result.count);
    return count != null ? [`共写入 ${count} 条`] : [];
  }
  const count = num(result.count);
  const versionName = detail.target.versionName ?? (detail.target.versionId != null ? `版本 #${detail.target.versionId}` : null);
  return count != null
    ? [`已写入${versionName ? `「${versionName}」` : '预算版本'}明细 ${count} 条`]
    : [];
}

/**
 * 撤销不可用时的更正路径(4.9「导入不可撤销 → 查看后续操作和更正路径」):
 * 撤销按钮绝不伪装可用;不可用时展示服务端原因 + 该类型批次对应的更正路径。
 */
export function rollbackCorrectionAdvice(detail: Pick<ImportBatchDetail, 'kind' | 'history'>): string {
  if (detail.kind === 'actual') {
    return detail.history
      ? '更正路径：历史补录不更新当前累计；如需修正，在「实际录入与快照」以补录历史快照任务按同一截止日提交正确数据，或在年度关闭前管理快照。'
      : '更正路径：通过新的更正导入或「实际录入与快照」手工录入覆盖当前累计；更正后会生成新的快照批次，原批次保留在审计记录中。';
  }
  return '更正路径：在对应预算草稿中直接修改后保存，或重新导入正确文件；已锁定版本请复制为新草稿修订。';
}
