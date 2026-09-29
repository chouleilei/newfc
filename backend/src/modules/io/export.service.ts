import ExcelJS from 'exceljs';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { centsToYuanString, isQuantityType, scaledToQuantityString, RATIO_SCALE, safeIntegerAdd } from '../../core/money';
import { buildSheet, standardMeta } from './excel';
import { buildTree } from '../../core/tree';
import { listMetrics } from '../metric/metric.service';
import { getVersion } from '../budget/budget.service';
import { getBatch, getBatchEntries, batchTrees, listYearStates, getYearState } from '../actual/actual.service';
import {
  completionReport,
  historicalComparison,
  versionCompare,
  type CompletionInput,
  type UnbudgetedActual,
  type ActualReconciliation,
} from '../report/report.service';
import { structureReport, type StructureInput } from '../report/structure.service';
import { queryLogs } from '../audit/log';
import { loadSnapshotNodes } from '../tree/snapshot';

/** 导出内容组装(方案十二.2):预算明细、当前实际、完成情况、历年对比、版本对比、快照、日志。 */

// 数据区使用真正的 Excel 数值，才能直接求和、筛选和继续计算；N/A 仍保留为文本。
const Y = (cents: number) => Number(centsToYuanString(cents));
const Q = (scaled: number | null) => (scaled == null ? '' : Number(scaledToQuantityString(scaled)));
const R = (v: number | null) => (v == null ? 'N/A' : v);
const SIGN = (cents: number, type?: string) => centsToYuanString(type === 'income' ? cents : type === undefined ? cents : -cents);

function buildUnbudgetedActualSheet(
  wb: ExcelJS.Workbook,
  reportName: string,
  data: UnbudgetedActual,
  reconciliation: ActualReconciliation,
) {
  const rows = data.entries.map((entry) => [
    entry.orgCode,
    entry.orgName,
    entry.accountCode,
    entry.accountName,
    entry.accountType,
    Y(entry.amountCents),
    entry.accountType === 'income'
      ? Y(entry.amountCents)
      : entry.accountType === 'cost' || entry.accountType === 'expense'
        ? Y(-entry.amountCents)
        : '',
    Q(entry.quantity),
    entry.reason,
  ]);
  buildSheet(wb, '未预算实际', [
    { header: '实际组织编码' }, { header: '实际组织名称' },
    { header: '实际科目编码' }, { header: '实际科目名称' }, { header: '科目类型' },
    { header: '实际金额(元,利润方向)', numFmt: '#,##0.00' }, { header: '实际金额(元,业务正数)', numFmt: '#,##0.00' },
    { header: '实际数量', numFmt: '#,##0.0000' }, { header: '未预算原因' },
  ], rows, '未预算实际承接区', standardMeta('未预算实际承接区', {
    来源报表: reportName,
    明细条数: data.count,
    未预算实际净额_元: centsToYuanString(data.amountCents),
    来源实际净额_元: centsToYuanString(reconciliation.sourceActualCents),
    报表承接净额_元: centsToYuanString(reconciliation.displayedActualCents),
    对账差额_元: centsToYuanString(reconciliation.differenceCents),
    数据说明: '一条来源实际只会进入“预算叶子投影”或本承接区之一；本表保留原始实际组织×科目组合，不按预算树改名',
  }));
}

export async function exportBudgetDetail(db: DB, versionId: number): Promise<Buffer> {
  const v = getVersion(db, versionId);
  const orgRows = loadSnapshotNodes(db, v.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, v.account_tree_snapshot_id);
  const orgTree = buildTree(orgRows);
  const accTree = buildTree(accRows);
  const flatOrg: { code: string; name: string; path: string }[] = [];
  const flatAcc: { code: string; name: string; path: string; type?: string; unit?: string }[] = [];
  const walk = (nodes: ReturnType<typeof buildTree>, out: { code: string; name: string; path: string; type?: string; unit?: string }[]) => {
    for (const n of nodes) {
      out.push({ code: n.code, name: n.name, path: n.path, type: n.type, unit: n.unit });
      walk(n.children, out);
    }
  };
  walk(orgTree, flatOrg);
  walk(accTree, flatAcc);
  const orgById = new Map(flatOrg.map((o) => [o.code, o]));
  const accById = new Map(flatAcc.map((a) => [a.code, a]));
  const orgCodeById = new Map(orgRows.map((o) => [o.id, o.code] as const));
  const entries = db.prepare('SELECT org_id, account_id, amount_cents, quantity, formula, note FROM budget_entry WHERE version_id = ?').all(versionId) as { org_id: number; account_id: number; amount_cents: number; quantity: number | null; formula: string; note: string }[];
  const rows = entries.map((e) => {
    const org = orgById.get(orgCodeById.get(e.org_id) ?? '');
    const acc = accById.get(accRows.find((a) => a.id === e.account_id)?.code ?? '');
    return [
      org?.path ?? `id:${e.org_id}`,
      org?.code ?? '',
      acc?.code ?? '',
      acc?.name ?? '',
      acc?.type ?? '',
      isQuantityType(acc?.type) ? '' : Y(acc?.type === 'income' ? e.amount_cents : -e.amount_cents),
      Q(e.quantity),
      isQuantityType(acc?.type) ? (acc?.unit ?? '') : '',
      e.formula ?? '',
      e.note ?? '',
    ];
  });
  const wb = new ExcelJS.Workbook();
  const ws = buildSheet(wb, '预算编制明细', [
    { header: '组织路径' }, { header: '组织编码' }, { header: '科目编码' }, { header: '科目名称' }, { header: '科目类型' }, { header: '预算金额(元)', numFmt: '#,##0.00' }, { header: '预算数量', numFmt: '#,##0.0000' }, { header: '数量单位' }, { header: '计算公式' }, { header: '测算依据/附注' },
  ], rows, '预算编制明细', standardMeta('预算编制明细', {
    年度: v.year,
    预算版本: v.name,
    状态: v.status,
    组织口径: `版本绑定树快照 #${v.org_tree_snapshot_id}`,
    科目口径: `版本绑定树快照 #${v.account_tree_snapshot_id}`,
    数据说明: '仅叶子组织×叶子科目明细;成本费用金额为界面展示口径(正数);数量型科目填数量列;含公式与测算底稿附注',
  }));
  // 为有附注的金额/数量单元格添加 Excel 批注 Note
  entries.forEach((e, idx) => {
    if (e.note && e.note.trim()) {
      const rowNum = ws.reportLayout.dataStartRow + idx;
      const cell = ws.getRow(rowNum).getCell(e.quantity != null ? 7 : 6);
      cell.note = `【测算依据】\n${e.note}${e.formula ? `\n【公式】${e.formula}` : ''}`;
    }
  });
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export async function exportActualCurrent(db: DB, year: number): Promise<Buffer> {
  const rows = db.prepare('SELECT * FROM actual_current WHERE year = ? ORDER BY org_id, account_id').all(year) as { org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null; source: string; memo: string; updated_at: string }[];
  const orgRows = db.prepare('SELECT id, code, name FROM org').all() as { id: number; code: string; name: string }[];
  const accRows = db.prepare('SELECT id, code, name, type, unit FROM account').all() as { id: number; code: string; name: string; type: string; unit: string }[];
  const orgById = new Map(orgRows.map((o) => [o.id, o]));
  const accById = new Map(accRows.map((a) => [a.id, a]));
  const state = getYearState(db, year);
  const data = rows.map((r) => {
    const acc = accById.get(r.account_id);
    return [
      orgById.get(r.org_id)?.code ?? '',
      orgById.get(r.org_id)?.name ?? '',
      acc?.code ?? '',
      acc?.name ?? '',
      acc?.type ?? '',
      isQuantityType(acc?.type) ? '' : Y(acc?.type === 'income' ? r.cumulative_amount_cents : -r.cumulative_amount_cents),
      Q(r.quantity),
      isQuantityType(acc?.type) ? (acc?.unit ?? '') : '',
      r.source,
      r.memo,
      r.updated_at,
    ];
  });
  const wb = new ExcelJS.Workbook();
  buildSheet(wb, '当前累计实际', [
    { header: '组织编码' }, { header: '组织名称' }, { header: '科目编码' }, { header: '科目名称' }, { header: '科目类型' },
    { header: '累计实际(元)', numFmt: '#,##0.00' }, { header: '累计数量', numFmt: '#,##0.0000' }, { header: '数量单位' }, { header: '来源' }, { header: '备注' }, { header: '更新时间' },
  ], data, '当前累计实际', standardMeta('当前累计实际', {
    年度: year,
    年度状态: state?.status ?? 'open',
    实际截止日期: state?.current_batch_id ? getBatch(db, state.current_batch_id).snapshot_date : '无快照',
    组织口径: '当前组织树',
    科目口径: '当前科目树',
  }));
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

type CompletionExportOptions = Omit<CompletionInput, 'versionId'> & { forecastVersionId?: number | null };

export async function exportCompletion(
  db: DB,
  versionId: number,
  optionsOrBatch?: CompletionExportOptions | number | null,
): Promise<Buffer> {
  const options: CompletionExportOptions = typeof optionsOrBatch === 'number' || optionsOrBatch == null
    ? { batchId: optionsOrBatch ?? null }
    : optionsOrBatch;
  const version = getVersion(db, versionId);
  if (options.forecastVersionId != null) {
    const forecastVersion = getVersion(db, options.forecastVersionId);
    if (forecastVersion.kind !== 'forecast') throw Errors.validation('全年预测版本必须是预测版本');
    if (forecastVersion.year !== version.year) throw Errors.validation('全年预测版本与预算版本年度不一致');
  }
  // versionId 一律放在展开之后：options 由调用方传入，不允许用 `versionId` 键换掉
  // 已经校验过的版本(助手导出、界面导出都走这里)。
  const rep = completionReport(db, { ...options, versionId });
  const forecast = options.forecastVersionId != null
    ? completionReport(db, { ...options, versionId: options.forecastVersionId, batchId: options.batchId })
    : null;
  const forecastAccount = new Map(forecast?.byAccount.map((row) => [row.code, row]) ?? []);
  const forecastOrg = new Map(forecast?.byOrg.map((row) => [row.code, row]) ?? []);
  const forecastMetric = new Map(forecast?.metrics.map((row) => [row.code, row]) ?? []);
  const rows: unknown[][] = [];
  for (const a of rep.byAccount) {
    const f = forecastAccount.get(a.code);
    const quantity = isQuantityType(a.type);
    rows.push([
      '科目', a.code, a.name, a.type, a.level, a.isLeaf ? '叶子' : '汇总', a.unbudgeted ? '未预算承接' : '预算快照',
      quantity ? Q(a.cell.budgetQuantity) : Y(a.cell.budgetCents * (a.type === 'income' ? 1 : -1)),
      quantity ? Q(a.cell.actualQuantity) : Y(a.cell.actualCents * (a.type === 'income' ? 1 : -1)),
      f ? (quantity ? Q(f.cell.budgetQuantity) : Y(f.cell.budgetCents * (a.type === 'income' ? 1 : -1))) : '',
      quantity ? Q(a.cell.varianceQuantity) : Y(a.cell.varianceCents),
      f ? (quantity
        ? Q(safeIntegerAdd(f.cell.budgetQuantity, -a.cell.budgetQuantity, '预测较预算数量差异'))
        : Y(safeIntegerAdd(f.cell.budgetCents, -a.cell.budgetCents, '预测较预算金额差异'))) : '',
      R(a.cell.rate), R(a.cell.progressDeviation), a.cell.rateSpecial ?? '', quantity ? '业务量' : a.cell.favorable === 'favorable' ? '有利' : a.cell.favorable === 'unfavorable' ? '不利' : '无差异', a.unit,
    ]);
  }
  for (const o of rep.byOrg) {
    const f = forecastOrg.get(o.code);
    rows.push([
      '组织', o.code, o.name, '净额', o.level, o.isLeaf ? '叶子' : '汇总', o.unbudgeted ? '未预算承接' : '预算快照',
      Y(o.cell.budgetCents), Y(o.cell.actualCents), f ? Y(f.cell.budgetCents) : '', Y(o.cell.varianceCents), f ? Y(safeIntegerAdd(f.cell.budgetCents, -o.cell.budgetCents, '预测较预算组织差异')) : '',
      R(o.cell.rate), R(o.cell.progressDeviation), o.cell.rateSpecial ?? '', o.cell.favorable === 'favorable' ? '有利' : o.cell.favorable === 'unfavorable' ? '不利' : '无差异', '',
    ]);
  }
  for (const m of rep.metrics) {
    const f = forecastMetric.get(m.code);
    rows.push([
      '指标', m.code, m.name, m.displaySign === -1 ? '业务正数（存储为负）' : '利润方向', '', '', '',
      Y(m.cell.budgetCents * m.displaySign), Y(m.cell.actualCents * m.displaySign), f ? Y(f.cell.budgetCents * f.displaySign) : '', Y(m.cell.varianceCents), f ? Y(safeIntegerAdd(f.cell.budgetCents, -m.cell.budgetCents, '预测较预算指标差异')) : '',
      R(m.cell.rate), R(m.cell.progressDeviation), m.cell.rateSpecial ?? '', m.cell.favorable === 'favorable' ? '有利' : m.cell.favorable === 'unfavorable' ? '不利' : '无差异', '',
    ]);
  }
  // 比率指标:值列放比率本身(百分比为小数,如 0.2534;自然单位口径为原值),
  // 差异列放「实际-预算」的百分点差。完成率与进度偏差对比率无意义,留空。
  const forecastRatio = new Map(forecast?.ratioMetrics.map((row) => [row.code, row]) ?? []);
  for (const m of rep.ratioMetrics) {
    const f = forecastRatio.get(m.code);
    const asNumber = (scaled: number | null) => (scaled == null ? 'N/A' : scaled / RATIO_SCALE);
    rows.push([
      '比率指标', m.code, m.name,
      m.displayFormat === 'percent' ? '比率(百分比)' : `比率(${m.unit || '自然单位'})`,
      '', m.direction === 'higher_better' ? '越高越好' : '越低越好', '',
      asNumber(m.budget.scaled), asNumber(m.actual.scaled), f ? asNumber(f.budget.scaled) : '',
      asNumber(m.deltaScaled),
      f && f.budget.scaled != null && m.budget.scaled != null
        ? safeIntegerAdd(f.budget.scaled, -m.budget.scaled, '预测较预算比率差异') / RATIO_SCALE
        : '',
      '', '',
      m.budget.special === 'na_zero_denominator' || m.actual.special === 'na_zero_denominator' ? '分母为零' : '',
      m.favorable === 'favorable' ? '有利' : m.favorable === 'unfavorable' ? '不利' : '无差异',
      m.displayFormat === 'percent' ? '' : m.unit,
    ]);
  }
  const wb = new ExcelJS.Workbook();
  buildSheet(wb, '预算完成情况', [
    { header: '维度' }, { header: '编码' }, { header: '名称' }, { header: '类型' }, { header: '层级' }, { header: '节点性质' },
    { header: '承接口径' },
    { header: '年度预算(元/数量)', numFmt: '#,##0.00####' }, { header: '累计实际(元/数量)', numFmt: '#,##0.00####' }, { header: '全年预测(元/数量)', numFmt: '#,##0.00####' }, { header: '预算差异(实际-预算,利润方向)', numFmt: '#,##0.00####' }, { header: '预测较预算', numFmt: '#,##0.00####' },
    { header: '完成率', numFmt: '0.00%' }, { header: '进度偏差', numFmt: '0.00%' }, { header: '完成率特殊标记' }, { header: '有利/不利' }, { header: '数量单位' },
  ], rows, '预算完成情况表', standardMeta('预算完成情况表', {
    年度: rep.version.year,
    预算版本: rep.version.name,
    全年预测版本: forecast?.version.name ?? '未选择',
    预算表格: `${rep.scopeBasis.sheetName}(${rep.scopeBasis.sheetKey})`,
    组织范围: rep.scopeBasis.orgScopeId ?? '全部',
    科目范围: rep.scopeBasis.accountScopeId ?? '全部',
    汇总层级: rep.scopeBasis.summaryLevel ?? '全部',
    实际数据截至日期: rep.asOfDate ?? '无实际数据',
    时间进度: rep.timeProgressValue == null ? 'N/A' : `${(rep.timeProgressValue * 100).toFixed(2)}%(均匀自然日)`,
    实际口径: rep.actualSource,
    来源实际净额_元: centsToYuanString(rep.reconciliation.sourceActualCents),
    报表承接净额_元: centsToYuanString(rep.reconciliation.displayedActualCents),
    对账差额_元: centsToYuanString(rep.reconciliation.differenceCents),
    未预算实际条数: rep.unbudgetedActual.count,
    ...rep.treeBasis,
    数据说明: rep.notes.join(';'),
  }));
  buildUnbudgetedActualSheet(wb, '预算完成情况表', rep.unbudgetedActual, rep.reconciliation);
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export async function exportHistorical(db: DB): Promise<Buffer> {
  const comp = historicalComparison(db);
  const rows = comp.years.map((y) => [
    y.year,
    y.budgetVersionName ?? 'N/A',
    y.finalSnapshotDate ?? 'N/A',
    Y(y.totals.incomeBudget), Y(y.totals.incomeActual),
    // 历年页面采用业务金额展示：收入/成本/费用都显示正数，利润/差异保留利润方向。
    Y(-y.totals.costBudget), Y(-y.totals.costActual),
    Y(-y.totals.expenseBudget), Y(-y.totals.expenseActual),
    Y(y.totals.profitBudget), Y(y.totals.profitActual),
    Y(y.varianceProfit),
    R(y.rateIncome), R(y.rateProfit), R(y.yoyProfit), R(y.accuracyProfit),
  ]);
  const wb = new ExcelJS.Workbook();
  buildSheet(wb, '历年预实对比', [
    { header: '年度' }, { header: '预算版本' }, { header: '最终快照日期' },
    { header: '收入预算', numFmt: '#,##0.00' }, { header: '收入实际', numFmt: '#,##0.00' }, { header: '成本预算', numFmt: '#,##0.00' }, { header: '成本实际', numFmt: '#,##0.00' },
    { header: '费用预算', numFmt: '#,##0.00' }, { header: '费用实际', numFmt: '#,##0.00' }, { header: '利润预算', numFmt: '#,##0.00' }, { header: '利润实际', numFmt: '#,##0.00' },
    { header: '利润差异', numFmt: '#,##0.00' }, { header: '收入完成率', numFmt: '0.00%' }, { header: '利润完成率', numFmt: '0.00%' }, { header: '利润同比', numFmt: '0.00%' }, { header: '预算准确率', numFmt: '0.00%' },
  ], rows, '历年预实对比', standardMeta('历年预实对比', {
    展示口径: '收入、成本、费用为业务正数；利润与差异为带符号利润方向',
    数据说明: comp.notes.join(';'),
  }));
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export async function exportVersionCompare(db: DB, baseId: number, targetId: number): Promise<Buffer> {
  const cmp = versionCompare(db, baseId, targetId);
  const rows = cmp.leafChanges.map((c) => [
    c.orgCode, c.accountCode,
    Y(c.baseCents), Y(c.targetCents), Y(c.deltaCents),
    c.changeRate == null ? 'N/A(原值为零)' : c.changeRate,
  ]);
  const wb = new ExcelJS.Workbook();
  buildSheet(wb, '版本对比', [
    { header: '组织编码' }, { header: '科目编码' }, { header: `基准版本金额(${cmp.baseVersion.name})`, numFmt: '#,##0.00' },
    { header: `目标版本金额(${cmp.targetVersion.name})`, numFmt: '#,##0.00' }, { header: '变化额', numFmt: '#,##0.00' }, { header: '变化率', numFmt: '0.00%' },
  ], rows, '预算版本对比', standardMeta('预算版本对比', {
    年度: cmp.baseVersion.year,
    基准版本: cmp.baseVersion.name,
    目标版本: cmp.targetVersion.name,
    树口径: cmp.treeSame ? '两版本树快照一致' : '两版本结构口径不同(按稳定ID对齐,汇总使用目标版本树)',
    数据说明: cmp.notes.join(';'),
  }));
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export async function exportSnapshot(db: DB, batchId: number): Promise<Buffer> {
  const batch = getBatch(db, batchId);
  const ents = getBatchEntries(db, batchId);
  const trees = batchTrees(db, batch);
  const orgById = new Map(trees.orgRows.map((o) => [o.id, o]));
  const accById = new Map(trees.accRows.map((a) => [a.id, a]));
  const rows = ents.map((e) => {
    const acc = accById.get(e.accountId);
    const quantity = isQuantityType(acc?.type);
    return [
      orgById.get(e.orgId)?.code ?? `id:${e.orgId}`,
      accById.get(e.accountId)?.code ?? `id:${e.accountId}`,
      acc?.name ?? '',
      acc?.type ?? '',
      // 数量型科目金额恒为零,留空避免误读为有金额的 0.00
      quantity ? '' : Y(acc?.type === 'income' ? e.amountCents : -e.amountCents),
      Q(e.quantity),
      quantity ? ((acc as { unit?: string } | undefined)?.unit ?? '') : '',
    ];
  });
  const wb = new ExcelJS.Workbook();
  buildSheet(wb, '实际快照', [
    { header: '组织编码' }, { header: '科目编码' }, { header: '科目名称' }, { header: '科目类型' }, { header: '累计实际(元)', numFmt: '#,##0.00' }, { header: '累计数量', numFmt: '#,##0.0000' }, { header: '数量单位' },
  ], rows, '实际快照数据', standardMeta('实际快照数据', {
    年度: batch.year,
    实际截止日期: batch.snapshot_date,
    修订号: batch.revision,
    状态: batch.status,
    来源: batch.source,
    组织口径: `快照绑定树 #${batch.org_tree_snapshot_id}`,
    科目口径: `快照绑定树 #${batch.account_tree_snapshot_id}`,
  }));
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/* 导出与界面日志查询同一筛选口径(action/entityType),并拉满单页 200 上限;
   原来固定无筛选最近 200 条,用户按条件筛选后点导出得到的却是无筛选结果。 */
export async function exportLogs(db: DB, filter: { action?: string; entityType?: string } = {}): Promise<Buffer> {
  const { items, total } = queryLogs(db, { page: 1, pageSize: 200, action: filter.action, entityType: filter.entityType });
  const rows = items.map((l) => [l.id, l.created_at, l.action, l.entity_type, l.entity_id, l.detail_json]);
  const wb = new ExcelJS.Workbook();
  buildSheet(wb, '操作日志', [
    { header: 'ID' }, { header: '操作时间' }, { header: '操作类型' }, { header: '实体类型' }, { header: '实体标识' }, { header: '变更摘要' },
  ], rows, '操作日志', standardMeta('操作日志', { 数据说明: `最近 ${items.length} 条${total > items.length ? `(共 ${total} 条,导出受单页 200 上限)` : ''}` }));
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/** 结构占比表(共同比报表):占比列输出小数,差异列输出百分点差 */
export async function exportStructure(db: DB, input: StructureInput): Promise<Buffer> {
  const rep = structureReport(db, input);
  const asNumber = (scaled: number | null) => (scaled == null ? 'N/A' : scaled / RATIO_SCALE);
  const rows: unknown[][] = rep.rows.map((row) => [
    row.code, row.name, row.type, row.level, row.isLeaf ? '叶子' : '汇总',
    Y(row.budget.numeratorCents),
    Y(row.actual.numeratorCents),
    asNumber(row.budget.scaled),
    asNumber(row.actual.scaled),
    asNumber(row.deltaScaled),
    row.budget.special === 'na_zero_basis' ? '基准为零'
      : row.budget.special === 'na_negative_basis' ? '基准为负' : '',
    row.basisLabel,
  ]);
  const wb = new ExcelJS.Workbook();
  buildSheet(wb, '结构占比', [
    { header: '科目编码' }, { header: '科目名称' }, { header: '类型' }, { header: '层级' }, { header: '节点性质' },
    { header: '年度预算(元,业务读法)', numFmt: '#,##0.00' }, { header: '累计实际(元,业务读法)', numFmt: '#,##0.00' },
    { header: '预算占比', numFmt: '0.00%' }, { header: '实际占比', numFmt: '0.00%' }, { header: '结构差异(实际-预算)', numFmt: '0.00%' },
    { header: '占比特殊标记' }, { header: '占比基准' },
  ], rows, '结构占比表', standardMeta('结构占比表', {
    年度: rep.version.year,
    预算版本: rep.version.name,
    占比基准: `${rep.basis.mode === 'parent' ? '占直接上级' : rep.basis.mode === 'account' ? '占指定科目' : '占指定指标'}(${rep.basis.label})`,
    预算表格: `${rep.scopeBasis.sheetName}(${rep.scopeBasis.sheetKey})`,
    组织范围: rep.scopeBasis.orgScopeId ?? '全部',
    科目范围: rep.scopeBasis.accountScopeId ?? '全部',
    汇总层级: rep.scopeBasis.summaryLevel ?? '全部',
    实际数截至: rep.asOfDate ?? '无实际数据',
    实际数来源: rep.actualSource,
    树口径: `${rep.treeBasis.org};${rep.treeBasis.account}`,
    同上级子项守恒: rep.reconciliation.every((item) => item.amountReconciled)
      ? `全部通过(${rep.reconciliation.length} 组)`
      : `存在不平的上级节点,请核查:${rep.reconciliation.filter((i) => !i.amountReconciled).map((i) => i.parentCode).join(',')}`,
    来源实际净额_元: centsToYuanString(rep.actualReconciliation.sourceActualCents),
    报表承接净额_元: centsToYuanString(rep.actualReconciliation.displayedActualCents),
    对账差额_元: centsToYuanString(rep.actualReconciliation.differenceCents),
    未预算实际条数: rep.unbudgetedActual.count,
    数据说明: rep.notes.join(';'),
  }));
  buildUnbudgetedActualSheet(wb, '结构占比表', rep.unbudgetedActual, rep.actualReconciliation);
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export async function exportMetricList(db: DB): Promise<Buffer> {
  const metrics = listMetrics(db);
  const accById = new Map((db.prepare('SELECT id, code, name FROM account').all() as { id: number; code: string; name: string }[]).map((a) => [a.id, a]));
  const rows: unknown[][] = [];
  for (const m of metrics) {
    const sourceLabel = (t: (typeof m.terms)[number]) => {
      if (t.source_type === 'account') {
        const a = accById.get(t.source_account_id!);
        return `科目${a?.code ?? t.source_account_id}`;
      }
      return `指标${metrics.find((x) => x.id === t.source_metric_id)?.code ?? t.source_metric_id}`;
    };
    let formula: string;
    if (m.kind === 'ratio') {
      const side = (role: 'numerator' | 'denominator') => {
        const t = m.terms.find((x) => x.role === role);
        if (!t) return '(未配置)';
        return `${t.coefficient === -1 ? '-' : ''}${sourceLabel(t)}`;
      };
      formula = `${side('numerator')} ÷ ${side('denominator')}`;
    } else {
      formula = m.terms.map((t) => `${t.coefficient === -1 ? '-' : '+'} ${sourceLabel(t)}`).join(' ');
    }
    rows.push([
      m.code, m.name, m.display_order, m.status,
      m.kind === 'ratio' ? '比率' : '金额(线性)',
      m.kind === 'ratio' ? (m.direction === 'higher_better' ? '越高越好' : '越低越好') : '利润方向(越大越有利)',
      m.kind === 'ratio' ? (m.display_format === 'percent' ? '百分比' : m.unit || '自然单位') : '元',
      formula,
    ]);
  }
  const wb = new ExcelJS.Workbook();
  buildSheet(wb, '报表指标', [
    { header: '指标编码' }, { header: '指标名称' }, { header: '显示顺序' }, { header: '状态' },
    { header: '指标类型' }, { header: '有利方向' }, { header: '单位' }, { header: '公式' },
  ], rows, '报表指标', standardMeta('报表指标', {
    数据说明: '金额型指标为科目节点与其他指标的 ±1 线性组合(利润方向);比率型指标为分子 ÷ 分母,自带有利方向,不可跨组织加总',
  }));
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export { SIGN };
