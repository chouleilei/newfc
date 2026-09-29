import ExcelJS from 'exceljs';
import type { DB } from '../../db/connection';
import { Errors, type RowError } from '../../core/errors';
import { yuanStringToCents, quantityStringToScaled } from '../../core/money';
import { isValidDate, yearOfDate, compareDate } from '../../core/dates';
import { computeLeafIds } from '../../core/tree';
import type { TreeNodeRow } from '../../core/tree';
import { listRows } from '../actual/actual.helpers';
import { getYearState } from '../actual/actual.service';
import type { ActualEntryInput } from '../actual/actual.service';
import { listSheets, type PresetSheetDto } from '../sheet/sheet.service';
import { listMetrics, type MetricRow } from '../metric/metric.service';
import { isAccountVisibleForScope } from '../../core/accountScope';
import { getVersion } from '../budget/budget.service';
import { loadSnapshotNodes } from '../tree/snapshot';
import { assertSafeXlsx } from './xlsx-guard';
import { MAX_IMPORT_ERRORS, MAX_IMPORT_ROWS } from './import-limits';
import { importedAmountToYuan, normalizeImportedNumber, type ImportAmountUnit } from './import-values';

/** Excel 导入与导出(方案十二)。 */

function cappedImportErrors(errors: RowError[]): RowError[] {
  if (errors.length <= MAX_IMPORT_ERRORS) return errors;
  const omitted = errors.length - (MAX_IMPORT_ERRORS - 1);
  return [
    ...errors.slice(0, MAX_IMPORT_ERRORS - 1),
    { row: 0, field: 'file', message: `另有 ${omitted} 条错误未展示，请先修正上述问题后重新导入` },
  ];
}

export interface ProfitRowDef {
  kind: 'metric' | 'account';
  code: string;
  label: string;
  indent: number;
  bold: boolean;
}

export const PROFIT_ROWS: ProfitRowDef[] = [
  { kind: 'metric', code: 'P01', label: '一、营业总收入', indent: 0, bold: true },
  { kind: 'metric', code: 'P02', label: '二、营业总成本', indent: 0, bold: true },
  { kind: 'account', code: 'C1', label: '其中：营业成本', indent: 1, bold: false },
  { kind: 'account', code: 'C3', label: '税金及附加', indent: 2, bold: false },
  { kind: 'account', code: 'E1', label: '销售费用', indent: 2, bold: false },
  { kind: 'account', code: 'E2', label: '管理费用', indent: 2, bold: false },
  { kind: 'account', code: 'E3', label: '财务费用', indent: 2, bold: false },
  { kind: 'account', code: 'C4', label: '资产减值损失', indent: 2, bold: false },
  { kind: 'account', code: 'I2', label: '加：投资收益', indent: 1, bold: false },
  { kind: 'metric', code: 'P03', label: '三、营业利润', indent: 0, bold: true },
  { kind: 'account', code: 'I3', label: '加：营业外收入', indent: 1, bold: false },
  { kind: 'account', code: 'C5', label: '减：营业外支出', indent: 1, bold: false },
  { kind: 'metric', code: 'P04', label: '四、利润总额', indent: 0, bold: true },
  { kind: 'account', code: 'C6', label: '减：所得税费用', indent: 1, bold: false },
  { kind: 'metric', code: 'P05', label: '五、净利润', indent: 0, bold: true },
];

export const SHEET_METRIC_ROWS: Record<string, { metricCode: string; label: string; beforeRoot?: string }[]> = {
  master: [
    { metricCode: 'P07', label: '总收入', beforeRoot: 'I1' },
    { metricCode: 'P06', label: '总成本', beforeRoot: 'C1' },
    { metricCode: 'P04', label: '利润总额', beforeRoot: 'C6' },
    { metricCode: 'P05', label: '净利润' },
  ],
};

function headerInfo(sheet: ExcelJS.Worksheet, texts: string[]): Map<string, number> {
  const map = new Map<string, number>();
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    const text = String(cell.value ?? '').trim();
    if (texts.includes(text)) map.set(text, colNumber);
  });
  return map;
}

function cellText(row: ExcelJS.Row, col: number | undefined): string {
  if (col == null) return '';
  const v = row.getCell(col).value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) return '';
      // Excel 日期是无时区的日历值；ExcelJS 以 Date 承载时取 UTC 年月日，
      // 避免服务器时区将零点单元格偏移到前一天。
      const year = v.getUTCFullYear();
      const month = String(v.getUTCMonth() + 1).padStart(2, '0');
      const day = String(v.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    // 公式单元格取缓存计算结果;富文本取拼接文本;两者皆无(如 LibreOffice 保存的无缓存公式)视为未填,
    // 兜底 String(v) 会产出 "[object Object]" 污染错误提示
    if ('result' in (v as object)) return String((v as { result?: unknown }).result ?? '');
    if ('text' in (v as object)) return String((v as { text?: unknown }).text ?? '');
    if ('richText' in (v as object)) {
      return (v as { richText?: { text: string }[] }).richText?.map((t) => t.text).join('') ?? '';
    }
    return '';
  }
  return String(v).trim();
}

/** Excel 表头统一中英文括号/空白后再做精确匹配，避免靠“包含金额”猜列。 */
function normalizedHeader(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, '').replace(/[（]/g, '(').replace(/[）]/g, ')');
}

function registerColumn(columns: Map<string, number>, key: string, col: number, label: string): void {
  if (columns.has(key)) throw Errors.validation(`模板中“${label}”匹配到多个列，请删除重复列后重试`);
  columns.set(key, col);
}

function amountUnitFromHeader(header: string, names: string[]): ImportAmountUnit | null {
  const text = normalizedHeader(header);
  if (names.some((name) => text === `${name}(元)` || text === `${name}(元/数量)`)) return 'yuan';
  if (names.some((name) => text === `${name}(万元)` || text === `${name}(万元/数量)`)) return 'wan';
  return null;
}

/** 单元格是否为跨表引用公式(形如 '全部科目明细'!E8):模板在汇总/利润表 tab 上生成的取数链接,
 *  锁定不可编辑,其缓存值不构成填报数据——导入时必须跳过,否则与明细 tab 的手填行判为重复 */
function isCrossSheetFormulaCell(row: ExcelJS.Row, col: number | undefined): boolean {
  if (col == null) return false;
  const v = row.getCell(col).value;
  if (typeof v !== 'object' || v == null || !('formula' in (v as object))) return false;
  return /^\s*'/.test(String((v as { formula?: unknown }).formula ?? ''));
}

export interface ReportWorksheet extends ExcelJS.Worksheet {
  /** 报表布局位置，供批注、公式等导出增强使用，不再猜测固定元数据行数。 */
  reportLayout: { headerRowIndex: number; dataStartRow: number };
}

function buildSheet(wb: ExcelJS.Workbook, name: string, columns: Partial<ExcelJS.Column>[], rows: unknown[][], title: string, metaLines: string[]): ReportWorksheet {
  const sheet = wb.addWorksheet(name) as ReportWorksheet;
  const titleRow = sheet.addRow([title]);
  titleRow.font = { bold: true, size: 14 };
  for (const line of metaLines) sheet.addRow([line]);
  sheet.addRow([]);
  const headerRowIndex = sheet.rowCount + 1;
  // ExcelJS 在 columns 中看到 header 会回写第 1 行，覆盖上方已经生成的报表标题。
  // 列头由下方显式 headerRow 负责，这里只应用宽度/数字格式等列属性。
  columns.forEach((definition, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = definition.width ?? 22;
    if (definition.numFmt) column.numFmt = definition.numFmt;
  });
  const headerRow = sheet.getRow(headerRowIndex);
  columns.forEach((c, i) => { headerRow.getCell(i + 1).value = c.header as string; });
  headerRow.font = { bold: true };
  for (const r of rows) sheet.addRow(r);
  sheet.views = [{ state: 'frozen', ySplit: headerRowIndex }];
  sheet.reportLayout = { headerRowIndex, dataStartRow: headerRowIndex + 1 };
  return sheet;
}

export function standardMeta(reportName: string, extra: Record<string, string | number | null | undefined>): string[] {
  const lines = [
    `报表名称: ${reportName}`,
    `生成时间: ${new Date().toISOString()}`,
    `金额单位: 元(两位小数);符号口径: 收入为正,成本费用界面展示为正数、报表差异为带符号利润方向`,
  ];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`);
  return lines;
}

/* ============ 实际数导入 ============ */

export interface ActualTemplateOptions {
  years?: number[];
  cutoff?: string;
  orgIds?: number[];
  orgCodes?: string[];
  sheetKeys?: string[];
  year?: number;
  orgId?: number;
  orgCode?: string;
  sheetKey?: string;
}

export interface ParsedActualRow {
  rowNumber: number;
  sheetName?: string;
  year?: number;
  snapshotDate?: string;
  orgCode: string;
  accountCode: string;
  amountText: string;
  quantityText: string;
  memo: string;
}

export interface ActualImportParseResult {
  ok: boolean;
  errors: RowError[];
  rows: ParsedActualRow[];
  years: number[];
  dates: string[];
}

export interface ResolvedActualBatch {
  year: number;
  snapshotDate: string;
  entries: ActualEntryInput[];
  /** 与 entries 同序的源行位置(解析全部成功时一一对应),供统一预览明细追溯源行 */
  sourceRows: ParsedActualRow[];
}

export interface ResolvedActualImportResult {
  batches: ResolvedActualBatch[];
  year: number;
  snapshotDate: string;
  entries: ActualEntryInput[];
}

const ACTUAL_COLUMNS = ['年度', '截止日期', '组织编码', '科目编码', '累计金额', '累计数量', '备注'];

interface SheetRowItem {
  kind: 'account' | 'metric';
  code: string;
  name: string;
  type: string;
  unit?: string;
  indent: number;
  isLeaf: boolean;
  bold?: boolean;
  parentCode?: string | null;
  directChildCodes?: string[];
  metricTerms?: { code: string; coefficient: number }[];
}

function typeLabel(type: string, unit?: string): string {
  const map: Record<string, string> = {
    income: '收入 / 万元',
    cost: '成本 / 万元',
    expense: '费用 / 万元',
    quantity: `数量 / ${unit || '万度'}`,
    metric: '指标 / 万元',
  };
  return map[type] ?? (unit ? `科目 / ${unit}` : '科目 / 万元');
}

function buildSheetRows(
  sheetKey: string,
  accRows: (TreeNodeRow & { type?: string; unit?: string })[],
  metrics: MetricRow[],
  dbSheets: PresetSheetDto[],
  scopeLeafOrgCodes?: Set<string>
): SheetRowItem[] {
  const accByCode = new Map(accRows.map((a) => [a.code, a]));
  const accById = new Map(accRows.map((a) => [a.id, a]));
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const childrenMap = new Map<number, number[]>();
  accRows.forEach((r) => {
    if (r.parent_id != null) {
      childrenMap.set(r.parent_id, [...(childrenMap.get(r.parent_id) ?? []), r.id]);
    }
  });

  if (sheetKey === 'profit') {
    const out: SheetRowItem[] = [];
    for (const pr of PROFIT_ROWS) {
      if (pr.kind === 'metric') {
        const m = metricByCode.get(pr.code);
        const terms: { code: string; coefficient: number }[] = [];
        if (m) {
          for (const t of m.terms) {
            if (t.source_type === 'account' && t.source_account_id != null) {
              const a = accById.get(t.source_account_id);
              if (a) terms.push({ code: a.code, coefficient: t.coefficient });
            } else if (t.source_type === 'metric' && t.source_metric_id != null) {
              const sm = metricById.get(t.source_metric_id);
              if (sm) terms.push({ code: sm.code, coefficient: t.coefficient });
            }
          }
        }
        out.push({
          kind: 'metric',
          code: pr.code,
          name: pr.label,
          type: 'metric',
          unit: '万元',
          indent: pr.indent,
          isLeaf: false,
          bold: pr.bold,
          metricTerms: terms,
        });
      } else {
        const a = accByCode.get(pr.code);
        out.push({
          kind: 'account',
          code: pr.code,
          name: a ? a.name : pr.label,
          type: a?.type ?? 'expense',
          unit: a?.unit ?? '万元',
          indent: pr.indent,
          isLeaf: false,
          bold: pr.bold,
        });
      }
    }
    return out;
  }

  const treeRootCodes = accRows.filter((r) => r.parent_id == null).map((r) => r.code);
  const foundSheet = dbSheets.find((s) => s.code === sheetKey);
  const rootCodes = sheetKey === 'all' || sheetKey === 'overview'
    ? treeRootCodes
    : (foundSheet?.rootCodes ?? treeRootCodes);
  const collapsed = new Set(
    sheetKey === 'overview'
      ? treeRootCodes
      : (sheetKey === 'all' ? [] : (foundSheet?.collapsedCodes ?? []))
  );
  const metricDefs = sheetKey === 'overview' || sheetKey === 'all'
    ? []
    : (SHEET_METRIC_ROWS[sheetKey] ?? []);

  const out: SheetRowItem[] = [];
  const pushMetric = (def: { metricCode: string; label: string }) => {
    const m = metricByCode.get(def.metricCode);
    if (!m) return;
    const terms: { code: string; coefficient: number }[] = [];
    for (const t of m.terms) {
      if (t.source_type === 'account' && t.source_account_id != null) {
        const a = accById.get(t.source_account_id);
        if (a) terms.push({ code: a.code, coefficient: t.coefficient });
      } else if (t.source_type === 'metric' && t.source_metric_id != null) {
        const sm = metricById.get(t.source_metric_id);
        if (sm) terms.push({ code: sm.code, coefficient: t.coefficient });
      }
    }
    out.push({
      kind: 'metric',
      code: m.code,
      name: m.name,
      type: 'metric',
      unit: '万元',
      indent: 0,
      isLeaf: false,
      bold: true,
      metricTerms: terms,
    });
  };

  const walk = (id: number, depth: number, parentCode: string | null) => {
    const a = accById.get(id);
    if (!a) return;
    // 组织范围业务适用性过滤: 如果科目不适用于当前组织范围，跳过该分支
    if (scopeLeafOrgCodes && !isAccountVisibleForScope(a.code, scopeLeafOrgCodes)) return;

    const rawKids = childrenMap.get(id) ?? [];
    const kids = rawKids.filter((kidId) => {
      const kid = accById.get(kidId);
      return kid ? (scopeLeafOrgCodes ? isAccountVisibleForScope(kid.code, scopeLeafOrgCodes) : true) : true;
    });

    const isCollapsed = collapsed.has(a.code);
    // 叶子判定必须用结构子级(rawKids):范围过滤只影响展示,若用过滤后的子级,
    // 子级全被隐藏的汇总科目会被误标为可填报叶子,导入时被"非叶子科目"校验拒绝
    const isLeaf = rawKids.length === 0;
    const directChildCodes = kids.map((kidId) => accById.get(kidId)?.code).filter(Boolean) as string[];

    out.push({
      kind: 'account',
      code: a.code,
      name: a.name,
      type: a.type ?? 'expense',
      unit: a.unit,
      indent: depth,
      isLeaf: isLeaf && !isCollapsed,
      bold: !isLeaf,
      parentCode,
      directChildCodes: isCollapsed ? [] : directChildCodes,
    });

    if (!isCollapsed) {
      kids.forEach((k) => walk(k, depth + 1, a.code));
    }
  };

  for (const code of rootCodes) {
    if (scopeLeafOrgCodes && !isAccountVisibleForScope(code, scopeLeafOrgCodes)) continue;
    for (const def of metricDefs.filter((x) => x.beforeRoot === code)) pushMetric(def);
    const root = accByCode.get(code);
    if (root) walk(root.id, 0, null);
  }
  for (const def of metricDefs.filter((x) => !x.beforeRoot)) pushMetric(def);

  return out;
}

function buildStructuredActualSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  meta: { year: number; snapshotDate: string; orgCode: string; orgName: string },
  rows: SheetRowItem[],
  /** 取数链接目标(全部科目明细 tab):本表无可见叶子行时,汇总/指标公式引用明细 tab 的对应单元格 */
  linkSource?: { name: string; rowByCode: Map<string, number> }
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(sheetName);

  // 1. Meta Block (Rows 1-5)
  const titleRow = ws.addRow([`【历史实际数填报表】${sheetName}`]);
  titleRow.font = { bold: true, size: 14, color: { argb: 'FF1F497D' } };
  titleRow.height = 26;

  const r2 = ws.addRow([`填报年度: ${meta.year}        截止日期: ${meta.snapshotDate}`]);
  r2.font = { size: 10, color: { argb: 'FF333333' } };

  const r3 = ws.addRow([`预算组织: [${meta.orgCode}] ${meta.orgName}`]);
  r3.font = { size: 10, color: { argb: 'FF333333' } };

  const r4 = ws.addRow([`金额单位: 万元 (录入自动按万元换算)        数量单位: 详见科目`]);
  r4.font = { size: 10, color: { argb: 'FF333333' } };

  const r5 = ws.addRow([`填报说明: 浅绿色单元格为可填报区域；汇总行与指标行包含自动计算公式并已锁定保护。`]);
  r5.font = { size: 10, color: { argb: 'FF2E7D32' }, italic: true };

  ws.addRow([]); // Row 6 empty

  // 2. Table Header (Row 7)
  const headerRowIndex = 7;
  const headerRow = ws.getRow(headerRowIndex);
  const columns = [
    { header: '序号', width: 8 },
    { header: '科目/指标编码', width: 18 },
    { header: '科目/指标名称', width: 38 },
    { header: '类别/单位', width: 16 },
    { header: '累计实际数(万元/数量)', width: 24 },
    { header: '备注', width: 32 },
  ];
  columns.forEach((c, i) => {
    headerRow.getCell(i + 1).value = c.header;
    ws.getColumn(i + 1).width = c.width;
  });
  headerRow.height = 24;
  headerRow.font = { bold: true, size: 10 };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F2F5' } };

  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
  };

  for (let c = 1; c <= 6; c++) {
    headerRow.getCell(c).border = thinBorder;
  }

  // 3. Map Row Numbers for Formulas
  const rowNumByCode = new Map<string, number>();
  rows.forEach((item, i) => {
    rowNumByCode.set(item.code, 8 + i);
  });

  // 4. Data Rows (Starting Row 8)
  rows.forEach((item, i) => {
    const r = 8 + i;
    const row = ws.getRow(r);
    row.height = 20;

    const cellA = row.getCell(1);
    const cellB = row.getCell(2);
    const cellC = row.getCell(3);
    const cellD = row.getCell(4);
    const cellE = row.getCell(5);
    const cellF = row.getCell(6);

    cellA.value = i + 1;
    cellA.alignment = { horizontal: 'center', vertical: 'middle' };

    cellB.value = item.code;
    cellB.alignment = { horizontal: 'center', vertical: 'middle' };

    cellC.value = `${'  '.repeat(item.indent)}${item.name}`;
    cellC.alignment = { horizontal: 'left', vertical: 'middle' };

    cellD.value = typeLabel(item.type, item.unit);
    cellD.alignment = { horizontal: 'center', vertical: 'middle' };

    const isSummaryOrMetric = !item.isLeaf || item.type === 'metric';
    const isBold = item.bold || isSummaryOrMetric;

    [cellA, cellB, cellC, cellD, cellE, cellF].forEach((c) => {
      c.border = thinBorder;
      c.font = { size: 10, bold: isBold };
      c.protection = { locked: true };
    });

    // Editable or Formula in Col E
    if (item.isLeaf && item.type !== 'metric') {
      cellE.protection = { locked: false };
      cellE.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBF8F2' } };
      cellE.alignment = { horizontal: 'right', vertical: 'middle' };
      cellE.numFmt = item.type === 'quantity' ? '#,##0.0000' : '#,##0.00';
      cellF.protection = { locked: false };
    } else if (!item.isLeaf && item.type !== 'metric') {
      cellE.protection = { locked: true };
      cellE.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
      cellE.alignment = { horizontal: 'right', vertical: 'middle' };
      cellE.numFmt = '#,##0.00';

      // Build SUM formula from direct children; 无可见子行时回退到明细 tab 取数链接
      if (item.directChildCodes && item.directChildCodes.length > 0) {
        const childRowNums = item.directChildCodes
          .map((c) => rowNumByCode.get(c))
          .filter((x): x is number => x != null);

        if (childRowNums.length > 0) {
          const minR = Math.min(...childRowNums);
          const maxR = Math.max(...childRowNums);
          if (maxR - minR + 1 === childRowNums.length) {
            cellE.value = { formula: `SUM(E${minR}:E${maxR})` };
          } else {
            cellE.value = { formula: `SUM(${childRowNums.map((n) => `E${n}`).join(',')})` };
          }
        }
      } else if (linkSource) {
        const linkRow = linkSource.rowByCode.get(item.code);
        if (linkRow != null) cellE.value = { formula: `'${linkSource.name}'!E${linkRow}` };
      }
    } else if (item.type === 'metric') {
      cellE.protection = { locked: true };
      cellE.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F7FF' } };
      cellE.alignment = { horizontal: 'right', vertical: 'middle' };
      cellE.numFmt = '#,##0.00';

      // Special formulas for Profit Sheet
      // 按行布局判定(首行为 P01 指标)而非 tab 名:多组织导出时 tab 名是组织名,不含"利润表"字样
      const isProfitLayout = rows[0]?.kind === 'metric' && rows[0]?.code === 'P01';
      if (isProfitLayout) {
        if (item.code === 'P01') {
          // 营业总收入 = 明细 tab 的 I1(营业收入)汇总行
          const rI1 = linkSource?.rowByCode.get('I1');
          if (linkSource && rI1 != null) {
            cellE.value = { formula: `'${linkSource.name}'!E${rI1}` };
          }
        } else if (item.code === 'P02') {
          const rC1 = rowNumByCode.get('C1') ?? 10;
          const rC4 = rowNumByCode.get('C4') ?? 15;
          cellE.value = { formula: `SUM(E${rC1}:E${rC4})` };
        } else if (item.code === 'P03') {
          const rP01 = rowNumByCode.get('P01') ?? 8;
          const rP02 = rowNumByCode.get('P02') ?? 9;
          const rI2 = rowNumByCode.get('I2') ?? 16;
          cellE.value = { formula: `E${rP01}-E${rP02}+E${rI2}` };
        } else if (item.code === 'P04') {
          const rP03 = rowNumByCode.get('P03') ?? 17;
          const rI3 = rowNumByCode.get('I3') ?? 18;
          const rC5 = rowNumByCode.get('C5') ?? 19;
          cellE.value = { formula: `E${rP03}+E${rI3}-E${rC5}` };
        } else if (item.code === 'P05') {
          const rP04 = rowNumByCode.get('P04') ?? 20;
          const rC6 = rowNumByCode.get('C6') ?? 21;
          cellE.value = { formula: `E${rP04}-E${rC6}` };
        }
      } else if (item.metricTerms && item.metricTerms.length > 0) {
        let expr = '';
        for (const t of item.metricTerms) {
          const targetR = rowNumByCode.get(t.code);
          if (targetR != null) {
            expr += (t.coefficient === 1 ? (expr ? `+E${targetR}` : `E${targetR}`) : `-E${targetR}`);
          }
        }
        if (expr) cellE.value = { formula: expr };
      }
    }
  });

  ws.views = [{ state: 'frozen', ySplit: 7 }];
  ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertRows: false,
    insertColumns: false,
    deleteRows: false,
    deleteColumns: false,
    sort: false,
    autoFilter: false,
  });

  return ws;
}

function sanitizeSheetName(name: string, used: Set<string>): string {
  let s = name.replace(/[\\/*?:[\]]/g, '_').trim().slice(0, 31);
  if (!s) s = 'Sheet';
  if (!used.has(s)) {
    used.add(s);
    return s;
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${s.slice(0, 27)}_${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return s;
}

/** 实际数导入模板(支持多组织、多年度、多预设表 Tab 导出及 Sheet2 编码参照表) */
export async function actualImportTemplateBuffer(db?: DB, options?: ActualTemplateOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  if (!db) {
    const ws = wb.addWorksheet('实际数导入');
    ws.columns = [
      { header: '年度', width: 10 },
      { header: '截止日期', width: 14 },
      { header: '组织编码', width: 18 },
      { header: '科目编码', width: 18 },
      { header: '累计金额(元)', width: 18 },
      { header: '累计数量', width: 16 },
      { header: '备注', width: 36 },
    ];
    ws.getRow(1).font = { bold: true };
    const currentYear = new Date().getFullYear();
    ws.addRow([currentYear, `${currentYear}-06-30`, 'LS_JY', 'I1101', '1000000.00', '', '示例:江垭电站 上网电量收入(单位:元,导入前请删除或覆盖)']);
    ws.addRow([currentYear, `${currentYear}-06-30`, 'LS_JY', 'Q101', '', '2500.5000', '示例:江垭电站 上网电量(单位:万度,导入前请删除或覆盖)']);
    return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
  }

  const currentYear = new Date().getFullYear();
  const years = options?.years?.length ? options.years : [options?.year ?? currentYear];
  const cutoff = options?.cutoff || `${years[0]}-06-30`;
  const sheetKeys = options?.sheetKeys?.length ? options.sheetKeys : [options?.sheetKey || 'profit'];

  const orgRows = listRows(db, 'org');
  const leafOrgIds = computeLeafIds(orgRows);
  const accRows = listRows(db, 'account') as (TreeNodeRow & { type?: string; unit?: string })[];
  const metrics = listMetrics(db);
  const dbSheets = listSheets(db);

  // 解析目标末级组织列表
  let targetOrgs: typeof orgRows = [];
  const orgIndexChildren = new Map<number, number[]>();
  orgRows.forEach((r) => { if (r.parent_id != null) orgIndexChildren.set(r.parent_id, [...(orgIndexChildren.get(r.parent_id) ?? []), r.id]); });
  const collectLeaves = (id: number): number[] => {
    const kids = orgIndexChildren.get(id) ?? [];
    return kids.length ? kids.flatMap(collectLeaves) : [id];
  };

  if (options?.orgIds?.length) {
    const leafSet = new Set<number>();
    for (const oid of options.orgIds) {
      collectLeaves(oid).forEach((lid) => leafSet.add(lid));
    }
    targetOrgs = orgRows.filter((o) => leafSet.has(o.id));
  } else if (options?.orgId != null) {
    const leafSet = new Set(collectLeaves(options.orgId));
    targetOrgs = orgRows.filter((o) => leafSet.has(o.id));
  } else if (options?.orgCodes?.length) {
    targetOrgs = orgRows.filter((o) => options.orgCodes!.includes(o.code) && leafOrgIds.has(o.id));
  } else if (options?.orgCode) {
    targetOrgs = orgRows.filter((o) => o.code === options.orgCode && leafOrgIds.has(o.id));
  }

  if (targetOrgs.length === 0) {
    targetOrgs = orgRows.filter((o) => leafOrgIds.has(o.id));
    if (targetOrgs.length === 0) {
      throw Errors.validation('数据库中还没有可填报的末级组织,请先在组织管理中建立组织树');
    }
  }

  const sheetNameMap: Record<string, string> = {
    profit: '利润表',
    overview: '一级汇总',
    all: '全部科目明细',
  };
  const usedSheetNames = new Set<string>();

  const isSingleCombination = years.length === 1 && targetOrgs.length === 1 && sheetKeys.length === 1;

  for (const year of years) {
    for (const org of targetOrgs) {
      for (const sKey of sheetKeys) {
        const preset = dbSheets.find((s) => s.code === sKey);
        const reportName = preset ? preset.name : (sheetNameMap[sKey] || '实际数填报');

        let rawTabName = '';
        if (isSingleCombination) {
          rawTabName = reportName;
        } else if (years.length === 1 && sheetKeys.length === 1) {
          rawTabName = org.name;
        } else if (targetOrgs.length === 1 && sheetKeys.length === 1) {
          rawTabName = `${year}年-${reportName}`;
        } else if (years.length === 1) {
          rawTabName = `${org.name.slice(0, 8)}-${reportName.slice(0, 8)}`;
        } else {
          rawTabName = `${year}-${org.name.slice(0, 6)}-${reportName.slice(0, 6)}`;
        }

        const tabName = sanitizeSheetName(rawTabName, usedSheetNames);
        const snapshotDate = cutoff.includes('-') && cutoff.length === 10 ? `${year}-${cutoff.slice(5)}` : `${year}-06-30`;
        const meta = {
          year,
          snapshotDate,
          orgCode: org.code,
          orgName: org.name,
        };

        const orgLeafIds = collectLeaves(org.id);
        const orgLeafCodes = new Set(
          orgLeafIds.map((lid) => orgRows.find((o) => o.id === lid)?.code).filter(Boolean) as string[]
        );
        const rows = buildSheetRows(sKey, accRows, metrics, dbSheets, orgLeafCodes);
        // 本表无可编辑叶子行(利润表/一级汇总,或组织范围过滤隐藏了全部明细行),
        // 或存在无可见直接子行的折叠汇总科目(如收入成本表的 I11/I12/C12/E2,其明细在专属表中)时,
        // 自动附加该组织的"全部科目明细" tab 供填报,并将这些行的公式链接到该 tab——
        // 否则折叠行在单表导出时永远空白,上级 SUM 与指标行显示低估的 0,展示误导
        const hasEditableLeaf = rows.some((r) => r.kind === 'account' && r.isLeaf);
        const hasOrphanSummary = rows.some(
          (r) => r.kind === 'account' && !r.isLeaf && !(r.directChildCodes && r.directChildCodes.length > 0)
        );
        if (!hasEditableLeaf || hasOrphanSummary) {
          const allRows = buildSheetRows('all', accRows, metrics, dbSheets, orgLeafCodes);
          const allTab = sanitizeSheetName(
            isSingleCombination ? '全部科目明细' : `${org.name.slice(0, 8)}-全部科目明细`,
            usedSheetNames
          );
          const rowByCode = new Map<string, number>();
          allRows.forEach((item, i) => rowByCode.set(item.code, 8 + i));
          buildStructuredActualSheet(wb, tabName, meta, rows, { name: allTab, rowByCode });
          buildStructuredActualSheet(wb, allTab, meta, allRows);
        } else {
          buildStructuredActualSheet(wb, tabName, meta, rows);
        }
      }
    }
  }

  appendReferenceSheets(wb, db);

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

function isFlatTemplate(sheet: ExcelJS.Worksheet): boolean {
  if (!sheet) return false;
  const headerRow = sheet.getRow(1);
  const texts = new Set<string>();
  headerRow.eachCell((cell) => {
    texts.add(String(cell.value ?? '').trim());
  });
  return texts.has('年度') && texts.has('截止日期') && texts.has('组织编码') && texts.has('科目编码');
}

function parseFlatActualImport(sheet: ExcelJS.Worksheet): ActualImportParseResult {
  const colMap = new Map<string, number>();
  let amountUnit: ImportAmountUnit | null = null;
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    const text = normalizedHeader(cell.value);
    if (text === '年度') registerColumn(colMap, '年度', colNumber, '年度');
    else if (text === '截止日期') registerColumn(colMap, '截止日期', colNumber, '截止日期');
    else if (text === '组织编码') registerColumn(colMap, '组织编码', colNumber, '组织编码');
    else if (text === '科目编码') registerColumn(colMap, '科目编码', colNumber, '科目编码');
    else {
      const unit = amountUnitFromHeader(text, ['累计金额']);
      if (unit) {
        registerColumn(colMap, '累计金额', colNumber, '累计金额');
        amountUnit = unit;
      } else if (text === '累计金额') {
        throw Errors.validation('金额列表头必须明确标注“累计金额(元)”或“累计金额(万元)”，请使用系统模板');
      } else if (text === '累计数量') registerColumn(colMap, '累计数量', colNumber, '累计数量');
      else if (text === '备注') registerColumn(colMap, '备注', colNumber, '备注');
    }
  });

  for (const col of ['年度', '截止日期', '组织编码', '科目编码']) {
    if (!colMap.has(col)) throw Errors.validation(`模板缺少必填列: ${col},请使用系统生成的标准模板`);
  }
  if (!colMap.has('累计金额') && !colMap.has('累计数量')) {
    throw Errors.validation('模板缺少金额或数量列,请使用系统生成的标准模板');
  }

  const errors: RowError[] = [];
  const rows: ParsedActualRow[] = [];
  const seenCombo = new Map<string, number>();
  const years = new Set<number>();
  const dates = new Set<string>();
  let dataRowCount = 0;

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const orgCode = cellText(row, colMap.get('组织编码'));
    const accountCode = cellText(row, colMap.get('科目编码'));
    const yearText = cellText(row, colMap.get('年度'));
    const dateText = cellText(row, colMap.get('截止日期'));
    const rawAmountText = cellText(row, colMap.get('累计金额'));
    let amountText = '';
    try { amountText = amountUnit ? importedAmountToYuan(rawAmountText, amountUnit) : ''; } catch {
      amountText = normalizeImportedNumber(rawAmountText);
    }
    const quantityText = normalizeImportedNumber(cellText(row, colMap.get('累计数量')));
    const memo = cellText(row, colMap.get('备注'));
    const isEmpty = !orgCode && !accountCode && !amountText && !quantityText && !yearText && !dateText;
    if (isEmpty) return;
    dataRowCount++;
    const excelRow = rowNumber;
    if (!yearText) errors.push({ row: excelRow, field: '年度', message: '年度不能为空' });
    else if (!/^\d{4}$/.test(yearText)) errors.push({ row: excelRow, field: '年度', message: `年度格式不正确: ${yearText}` });
    else years.add(Number(yearText));
    if (!dateText) errors.push({ row: excelRow, field: '截止日期', message: '截止日期不能为空' });
    else if (!isValidDate(dateText)) errors.push({ row: excelRow, field: '截止日期', message: `截止日期格式必须为 YYYY-MM-DD: ${dateText}` });
    else {
      dates.add(dateText);
      if (/^\d{4}$/.test(yearText) && yearOfDate(dateText) !== Number(yearText)) {
        errors.push({ row: excelRow, field: '截止日期', message: `截止日期 ${dateText} 与年度 ${yearText} 不一致` });
      }
    }
    if (!orgCode) errors.push({ row: excelRow, field: 'orgCode', message: '组织编码不能为空' });
    if (!accountCode) errors.push({ row: excelRow, field: 'accountCode', message: '科目编码不能为空' });
    if (!amountText && !quantityText) errors.push({ row: excelRow, field: 'amount', message: '累计金额与累计数量至少填一项' });
    if (rawAmountText && rawAmountText !== '-') {
      try { yuanStringToCents(amountText); } catch {
        errors.push({ row: excelRow, field: 'amount', message: `金额格式不正确: ${rawAmountText}(请核对表头单位，最多两位小数)` });
      }
    }
    if (quantityText) {
      try { quantityStringToScaled(quantityText); } catch {
        errors.push({ row: excelRow, field: 'quantity', message: `数量格式不正确: ${quantityText}(最多四位小数)` });
      }
    }
    if (orgCode && accountCode) {
      const combo = `${orgCode}::${accountCode}::${dateText}::${yearText}`;
      if (seenCombo.has(combo)) {
        errors.push({ row: excelRow, field: 'orgCode', message: `与第 ${seenCombo.get(combo)} 行重复(同年度同日期同组织科目组合)` });
      } else seenCombo.set(combo, excelRow);
    }
    rows.push({
      rowNumber: excelRow,
      sheetName: sheet.name,
      year: yearText ? Number(yearText) : undefined,
      snapshotDate: dateText,
      orgCode,
      accountCode,
      amountText,
      quantityText,
      memo,
    });
  });

  if (dataRowCount === 0) errors.push({ row: 0, field: 'file', message: '文件中没有数据行' });
  if (dataRowCount > MAX_IMPORT_ROWS) errors.push({ row: 0, field: 'file', message: `单文件不超过 ${MAX_IMPORT_ROWS} 行,当前 ${dataRowCount} 行` });
  return { ok: errors.length === 0, errors: cappedImportErrors(errors), rows, years: [...years], dates: [...dates] };
}

function parseStructuredActualImport(workbook: ExcelJS.Workbook, db?: DB): ActualImportParseResult {
  const errors: RowError[] = [];
  const rows: ParsedActualRow[] = [];
  const seenCombo = new Map<string, number>();
  const years = new Set<number>();
  const dates = new Set<string>();

  const accRows = db ? listRows(db, 'account') : [];
  const leafAccIds = db ? computeLeafIds(accRows) : new Set<number>();
  const accByCode = new Map(accRows.map((a) => [a.code, a]));

  for (const sheet of workbook.worksheets) {
    if (sheet.name.includes('参照') || sheet.name.includes('字典') || sheet.name.includes('reference')) continue;

    let sheetYear: number | undefined;
    let sheetDate: string | undefined;
    let sheetOrgCode: string | undefined;

    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      row.eachCell((cell) => {
        const str = String(cell.value ?? '').trim();
        const yMatch = str.match(/(?:年度|填报年度)\s*[:：]?\s*(\d{4})/);
        if (yMatch) sheetYear = Number(yMatch[1]);
        const dMatch = str.match(/(?:截止日期)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/);
        if (dMatch) sheetDate = dMatch[1];
        const oMatch = str.match(/(?:预算组织编码|预算组织|组织编码)\s*[:：]?\s*\[?([A-Za-z0-9_]+)\]?/);
        if (oMatch) sheetOrgCode = oMatch[1];
      });
    }

    let headerRowIndex = -1;
    let codeCol = -1;
    let valCol = -1;
    let memoCol = -1;
    let typeCol = -1;
    let amountUnit: ImportAmountUnit | null = null;

    for (let r = 1; r <= Math.min(15, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      const codeMatches: number[] = [];
      const valueMatches: { col: number; unit: ImportAmountUnit }[] = [];
      let hasAmbiguousValueHeader = false;
      row.eachCell((cell, colNumber) => {
        const text = normalizedHeader(cell.value);
        if (text === '科目/指标编码' || text === '科目编码') codeMatches.push(colNumber);
        const unit = amountUnitFromHeader(text, ['累计实际数', '累计金额']);
        if (unit) valueMatches.push({ col: colNumber, unit });
        else if (/累计实际数|累计金额/.test(text)) hasAmbiguousValueHeader = true;
        if (text === '类别/单位' || text === '科目类型') typeCol = colNumber;
        if (text === '备注') memoCol = colNumber;
      });
      if (codeMatches.length > 1 || valueMatches.length > 1) {
        throw Errors.validation(`工作表 ${sheet.name} 的科目编码或累计实际数匹配到多个列，请删除重复列`);
      }
      if (codeMatches.length === 1 && valueMatches.length === 1) {
        codeCol = codeMatches[0];
        valCol = valueMatches[0].col;
        amountUnit = valueMatches[0].unit;
        headerRowIndex = r;
        break;
      }
      if (codeMatches.length === 1) {
        if (hasAmbiguousValueHeader) throw Errors.validation(`工作表 ${sheet.name} 的累计实际数列表头必须明确标注“(元/数量)”或“(万元/数量)”`);
      }
    }

    if (headerRowIndex === -1 || codeCol === -1 || valCol === -1) continue;

    if (sheetYear) years.add(sheetYear);
    if (sheetDate) dates.add(sheetDate);

    for (let r = headerRowIndex + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const code = cellText(row, codeCol);
      const val = cellText(row, valCol);
      const memo = memoCol !== -1 ? cellText(row, memoCol) : '';
      if (!code) continue;

      // 指标行按模板的类别列识别，不再用 P 前缀猜测，以免丢弃合法的 P 前缀科目。
      if (typeCol !== -1 && normalizedHeader(cellText(row, typeCol)).startsWith('指标/')) continue;

      // 跨表取数链接行(利润表/一级汇总 tab 的锁定单元格)不计入填报数据:
      // 其缓存计算值来自"全部科目明细" tab 的手填行,重复计入会与手填行判为重复而拒绝导入
      if (isCrossSheetFormulaCell(row, valCol)) continue;

      if (db) {
        const acc = accByCode.get(code);
        if (!acc) {
          // 未知编码(手误/已删除科目)且填了数值:必须报行错误,静默跳过会让预览/确认以缺行数"成功"
          if (val !== '' && val !== '-') {
            errors.push({ row: r, field: 'accountCode', message: `科目编码不存在: ${code}` });
          }
          continue;
        }
        if (!leafAccIds.has(acc.id)) continue; // 已识别的汇总/公式行正常跳过
      }

      if (val === '' || val === '-') continue;

      const excelRow = r;
      if (!sheetYear) errors.push({ row: excelRow, field: '年度', message: `工作表 ${sheet.name} 未能识别填报年度` });
      if (!sheetDate) errors.push({ row: excelRow, field: '截止日期', message: `工作表 ${sheet.name} 未能识别截止日期` });
      if (!sheetOrgCode) errors.push({ row: excelRow, field: 'orgCode', message: `工作表 ${sheet.name} 未能识别预算组织编码` });

      let amountText = '';
      let quantityText = '';

      const acc = accByCode.get(code);
      if (acc?.type === 'quantity') {
        quantityText = val;
        try { quantityStringToScaled(quantityText); } catch {
          errors.push({ row: excelRow, field: 'quantity', message: `数量格式不正确: ${quantityText}(最多四位小数)` });
        }
      } else {
        try { amountText = importedAmountToYuan(val, amountUnit!); } catch {
          errors.push({ row: excelRow, field: 'amount', message: `金额格式不正确: ${val}(请核对表头单位)` });
        }
        if (amountText) {
          try { yuanStringToCents(amountText); } catch {
            errors.push({ row: excelRow, field: 'amount', message: `金额格式不正确: ${val}` });
          }
        }
      }

      if (sheetOrgCode && code && sheetDate && sheetYear) {
        const combo = `${sheetOrgCode}::${code}::${sheetDate}::${sheetYear}`;
        if (seenCombo.has(combo)) {
          errors.push({ row: excelRow, field: 'accountCode', message: `与第 ${seenCombo.get(combo)} 行重复(同组织科目组合)` });
        } else {
          seenCombo.set(combo, excelRow);
          rows.push({
            rowNumber: excelRow,
            sheetName: sheet.name,
            year: sheetYear,
            snapshotDate: sheetDate,
            orgCode: sheetOrgCode,
            accountCode: code,
            amountText,
            quantityText,
            memo,
          });
        }
      }
    }
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ row: 0, field: 'file', message: '文件中没有检测到可导入的末级科目数据行' });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    errors.push({ row: 0, field: 'file', message: `单文件不超过 ${MAX_IMPORT_ROWS} 行,当前 ${rows.length} 行` });
  }

  return { ok: errors.length === 0, errors: cappedImportErrors(errors), rows, years: [...years], dates: [...dates] };
}

/** 解析实际数导入文件:支持双模(传统扁平清单与结构化排版填报表) */
export async function parseActualImport(buffer: Buffer, db?: DB): Promise<ActualImportParseResult> {
  await assertSafeXlsx(buffer, MAX_IMPORT_ROWS);
  const wb = new ExcelJS.Workbook();
  let workbook: ExcelJS.Workbook;
  try {
    workbook = await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw Errors.validation('无法解析 Excel 文件,请使用系统生成的标准模板(.xlsx)');
  }
  if (!workbook.worksheets.length) throw Errors.validation('Excel 文件没有工作表');

  const firstSheet = workbook.getWorksheet('实际数导入') || workbook.worksheets[0];
  if (isFlatTemplate(firstSheet)) {
    return parseFlatActualImport(firstSheet);
  }

  return parseStructuredActualImport(workbook, db);
}

/** 校验通过后将编码映射为 ID 并复用业务校验(支持多批次多年度) */
export function resolveActualImport(
  db: DB,
  parsed: ActualImportParseResult,
  history = false
): ResolvedActualImportResult {
  if (!parsed.ok) throw Errors.importValidation('导入文件存在错误', parsed.errors);
  if (parsed.rows.length === 0) throw Errors.validation('导入文件中没有数据行');

  const orgRows = listRows(db, 'org');
  const accRows = listRows(db, 'account');
  const leafOrgs = computeLeafIds(orgRows);
  const leafAccs = computeLeafIds(accRows);
  const orgByCode = new Map(orgRows.map((r) => [r.code, r]));
  const accByCode = new Map(accRows.map((r) => [r.code, r]));
  const errors: RowError[] = [];

  const currentYear = new Date().getFullYear();
  const groups = new Map<string, { year: number; snapshotDate: string; rows: ParsedActualRow[] }>();
  for (const r of parsed.rows) {
    const y = r.year ?? parsed.years[0];
    const d = r.snapshotDate ?? parsed.dates[0];
    if (!y || !d) continue;
    const k = `${y}::${d}`;
    if (!groups.has(k)) groups.set(k, { year: y, snapshotDate: d, rows: [] });
    groups.get(k)!.rows.push(r);
  }

  const batches: ResolvedActualBatch[] = [];

  for (const group of groups.values()) {
    const { year, snapshotDate } = group;
    const state = getYearState(db, year);
    if (state && state.status !== 'open') errors.push({ row: 0, field: 'year', message: `${year} 年度已冻结,禁止导入` });
    // 历史补录必须显式声明,不再按"往年即历史"隐式推断(重开年度修正需普通模式更新当前累计)
    const isHist = history;
    if (!isHist && state?.current_batch_id != null) {
      const cur = db.prepare('SELECT snapshot_date FROM actual_snapshot_batch WHERE id = ?').get(state.current_batch_id) as { snapshot_date: string } | undefined;
      if (cur && compareDate(snapshotDate, cur.snapshot_date) < 0) {
        errors.push({ row: 0, field: 'snapshotDate', message: `截止日期不能早于当前最新截止日期 ${cur.snapshot_date}(历史数据请使用历史补录)` });
      }
    }

    const batchEntries: ActualEntryInput[] = [];
    for (const r of group.rows) {
      const excelRow = r.rowNumber;
      const org = orgByCode.get(r.orgCode);
      if (!org) { errors.push({ row: excelRow, field: 'orgCode', message: `组织编码不存在: ${r.orgCode}` }); continue; }
      if (!leafOrgs.has(org.id)) errors.push({ row: excelRow, field: 'orgCode', message: `组织 ${r.orgCode} 不是叶子组织` });
      const acc = accByCode.get(r.accountCode);
      if (!acc) { errors.push({ row: excelRow, field: 'accountCode', message: `科目编码不存在: ${r.accountCode}` }); continue; }
      if (!leafAccs.has(acc.id)) errors.push({ row: excelRow, field: 'accountCode', message: `科目 ${r.accountCode} 不是叶子科目` });
      if (!isAccountVisibleForScope(acc.code, new Set([org.code]))) {
        errors.push({ row: excelRow, field: 'orgCode', message: `科目 ${acc.code} 不适用于组织 ${org.code},不能导入该组织的实际数` });
        continue;
      }
      batchEntries.push({ orgId: org.id, accountId: acc.id, amount: r.amountText || undefined, quantity: r.quantityText || undefined, memo: r.memo });
    }
    batches.push({ year, snapshotDate, entries: batchEntries, sourceRows: group.rows });
  }

  if (errors.length > 0) throw Errors.importValidation('导入文件存在错误', cappedImportErrors(errors));

  const firstBatch = batches[0] ?? { year: parsed.years[0] ?? currentYear, snapshotDate: parsed.dates[0] ?? `${currentYear}-06-30`, entries: [] };
  return {
    batches,
    year: firstBatch.year,
    snapshotDate: firstBatch.snapshotDate,
    entries: batches.flatMap((b) => b.entries),
  };
}

/* ============ 预算导入(草稿版本) ============ */

const BUDGET_COLUMNS = ['组织编码', '科目编码', '金额', '数量', '备注'];

/** 预算导入模板(附带真实组织/科目编码示例与 Sheet2 编码参照表) */
export function budgetImportTemplateBuffer(db?: DB): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('预算导入');
  ws.columns = [
    { header: '组织编码', width: 18 },
    { header: '科目编码', width: 18 },
    { header: '金额(元)', width: 18 },
    { header: '数量', width: 16 },
    { header: '备注', width: 36 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow(['LS_JY', 'I1101', '1000000.00', '', '示例:江垭电站 上网电量收入(单位:元,导入前请删除或覆盖)']);
  ws.addRow(['LS_JY', 'Q101', '', '2500.5000', '示例:江垭电站 上网电量(单位:万度,导入前请删除或覆盖)']);

  if (db) {
    appendReferenceSheets(wb, db);
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/** 为模板追加「组织参照」和「科目参照」工作表 */
function appendReferenceSheets(wb: ExcelJS.Workbook, db: DB) {
  const orgRows = listRows(db, 'org');
  const accRows = listRows(db, 'account');
  const leafOrgIds = computeLeafIds(orgRows);
  const leafAccIds = computeLeafIds(accRows);

  // 组织参照表
  const orgWs = wb.addWorksheet('组织编码参照');
  orgWs.columns = [
    { header: '组织编码', width: 18 },
    { header: '组织名称', width: 28 },
    { header: '节点类型', width: 14 },
    { header: '状态', width: 10 },
  ];
  orgWs.getRow(1).font = { bold: true };
  for (const o of orgRows) {
    const isLeaf = leafOrgIds.has(o.id);
    orgWs.addRow([o.code, o.name, isLeaf ? '末级组织(可填报)' : '汇总组织', o.status === 'active' ? '启用' : '停用']);
  }

  // 科目参照表
  const accWs = wb.addWorksheet('科目编码参照');
  accWs.columns = [
    { header: '科目编码', width: 18 },
    { header: '科目名称', width: 36 },
    { header: '科目类型', width: 14 },
    { header: '计量单位', width: 14 },
    { header: '节点类型', width: 14 },
    { header: '状态', width: 10 },
  ];
  accWs.getRow(1).font = { bold: true };
  const typeMap: Record<string, string> = { income: '收入', cost: '成本', expense: '费用', quantity: '数量指标' };
  for (const a of accRows) {
    const isLeaf = leafAccIds.has(a.id);
    accWs.addRow([
      a.code,
      a.name,
      typeMap[a.type ?? ''] ?? a.type ?? '未知',
      a.unit ?? (a.type === 'quantity' ? '-' : '元'),
      isLeaf ? '末级科目(可填报)' : '汇总科目',
      a.status === 'active' ? '启用' : '停用',
    ]);
  }
}

export interface ParsedBudgetRow {
  /** 源 Excel 行号(可追溯时由解析器填写;既有调用方构造的行可缺省) */
  rowNumber?: number;
  orgCode: string;
  accountCode: string;
  amountText: string;
  quantityText: string;
  formula: string;
  memo: string;
}

export async function parseBudgetImport(buffer: Buffer): Promise<{ ok: boolean; errors: RowError[]; rows: ParsedBudgetRow[] }> {
  await assertSafeXlsx(buffer, MAX_IMPORT_ROWS);
  const wb = new ExcelJS.Workbook();
  let workbook: ExcelJS.Workbook;
  try {
    workbook = await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw Errors.validation('无法解析 Excel 文件,请使用系统生成的标准模板(.xlsx)');
  }
  const sheet = workbook.getWorksheet('预算导入') || workbook.worksheets[0];
  if (!sheet) throw Errors.validation('Excel 文件没有工作表');
  
  const colMap = new Map<string, number>();
  let amountUnit: ImportAmountUnit | null = null;
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    const text = normalizedHeader(cell.value);
    if (text === '组织编码') registerColumn(colMap, '组织编码', colNumber, '组织编码');
    else if (text === '科目编码') registerColumn(colMap, '科目编码', colNumber, '科目编码');
    else {
      const unit = amountUnitFromHeader(text, ['金额', '预算金额']);
      if (unit) {
        registerColumn(colMap, '金额', colNumber, '金额');
        amountUnit = unit;
      } else if (text === '金额' || text === '预算金额') {
        throw Errors.validation('金额列表头必须明确标注“金额(元)”或“金额(万元)”，请使用系统模板');
      } else if (text === '数量' || text === '预算数量') registerColumn(colMap, '数量', colNumber, '数量');
      else if (text === '计算公式' || text === '公式') registerColumn(colMap, '计算公式', colNumber, '计算公式');
      else if (text === '备注' || text === '附注' || text === '测算依据/附注') registerColumn(colMap, '备注', colNumber, '备注');
    }
  });

  for (const col of ['组织编码', '科目编码']) {
    if (!colMap.has(col)) throw Errors.validation(`模板缺少必填列: ${col},请使用系统生成的标准模板`);
  }
  if (!colMap.has('金额') && !colMap.has('数量')) {
    throw Errors.validation('模板缺少金额或数量列,请使用系统生成的标准模板');
  }

  const errors: RowError[] = [];
  const rows: ParsedBudgetRow[] = [];
  const seen = new Map<string, number>();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const orgCode = cellText(row, colMap.get('组织编码'));
    const accountCode = cellText(row, colMap.get('科目编码'));
    const rawAmountText = cellText(row, colMap.get('金额'));
    let amountText = '';
    try { amountText = amountUnit ? importedAmountToYuan(rawAmountText, amountUnit) : ''; } catch {
      amountText = normalizeImportedNumber(rawAmountText);
    }
    const quantityText = normalizeImportedNumber(cellText(row, colMap.get('数量')));
    const formula = cellText(row, colMap.get('计算公式'));
    const memo = cellText(row, colMap.get('备注'));
    if (!orgCode && !accountCode && !amountText && !quantityText) return;
    if (rows.length >= MAX_IMPORT_ROWS) { errors.push({ row: rowNumber, field: 'file', message: `单文件不超过 ${MAX_IMPORT_ROWS} 行` }); return; }
    if (!orgCode) errors.push({ row: rowNumber, field: 'orgCode', message: '组织编码不能为空' });
    if (!accountCode) errors.push({ row: rowNumber, field: 'accountCode', message: '科目编码不能为空' });
    if (!amountText && !quantityText) errors.push({ row: rowNumber, field: 'amount', message: '金额与数量至少填一项' });
    if (amountText) {
      try { yuanStringToCents(amountText); } catch { errors.push({ row: rowNumber, field: 'amount', message: `金额格式不正确: ${amountText}` }); }
    }
    if (quantityText) {
      try { quantityStringToScaled(quantityText); } catch { errors.push({ row: rowNumber, field: 'quantity', message: `数量格式不正确: ${quantityText}(最多四位小数)` }); }
    }
    const combo = `${orgCode}::${accountCode}`;
    if (seen.has(combo)) errors.push({ row: rowNumber, field: 'orgCode', message: `与第 ${seen.get(combo)} 行重复` });
    else seen.set(combo, rowNumber);
    rows.push({ rowNumber, orgCode, accountCode, amountText, quantityText, formula, memo });
  });
  if (rows.length === 0) errors.push({ row: 0, field: 'file', message: '文件中没有数据行' });
  return { ok: errors.length === 0, errors: cappedImportErrors(errors), rows };
}

/** 预算导入解析为明细：编码必须按目标版本绑定的不可变树快照解析。 */
export function resolveBudgetImport(db: DB, versionId: number, parsed: { ok: boolean; errors: RowError[]; rows: ParsedBudgetRow[] }): { orgId: number; accountId: number; amount?: string; quantity?: string; formula?: string; note?: string }[] {
  if (!parsed.ok) throw Errors.importValidation('导入文件存在错误', parsed.errors);
  const version = getVersion(db, versionId);
  if (version.status !== 'draft') throw Errors.conflict('只有草稿预算版本可导入明细');
  const orgRows = loadSnapshotNodes(db, version.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, version.account_tree_snapshot_id);
  const orgByCode = new Map(orgRows.map((r) => [r.code, r] as const));
  const accByCode = new Map(accRows.map((r) => [r.code, r] as const));
  // 与实际数导入预览同口径:叶子校验放在预览期。只在确认期报错会造成「预览成功、确认必败」,
  // 且每次失败确认都留下一条 pending 导入批次占用库内原件 blob。
  const leafOrgs = computeLeafIds(orgRows);
  const leafAccs = computeLeafIds(accRows);
  const errors: RowError[] = [];
  const entries: { orgId: number; accountId: number; amount?: string; quantity?: string; formula?: string; note?: string }[] = [];
  parsed.rows.forEach((r, i) => {
    const rowNo = i + 2;
    const org = orgByCode.get(r.orgCode);
    const acc = accByCode.get(r.accountCode);
    if (!org) { errors.push({ row: rowNo, field: 'orgCode', message: `组织编码不存在于目标版本绑定快照: ${r.orgCode}` }); return; }
    if (!acc) { errors.push({ row: rowNo, field: 'accountCode', message: `科目编码不存在于目标版本绑定快照: ${r.accountCode}` }); return; }
    if (!leafOrgs.has(org.id)) { errors.push({ row: rowNo, field: 'orgCode', message: `组织 ${r.orgCode} 不是叶子组织,明细行必须使用末级组织` }); return; }
    if (!leafAccs.has(acc.id)) { errors.push({ row: rowNo, field: 'accountCode', message: `科目 ${r.accountCode} 不是叶子科目,明细行必须使用末级科目` }); return; }
    // 科目-组织适用范围与保存/前端口径一致,导入期就给出可定位的行错误
    if (!isAccountVisibleForScope(acc.code, new Set([org.code]))) {
      errors.push({ row: rowNo, field: 'orgCode', message: `科目 ${acc.code} 不适用于组织 ${org.code},不能编制该组织的预算` });
      return;
    }
    entries.push({
      orgId: org.id,
      accountId: acc.id,
      amount: r.amountText || undefined,
      quantity: r.quantityText || undefined,
      formula: r.formula || undefined,
      note: r.memo || undefined,
    });
  });
  if (errors.length) throw Errors.importValidation('导入文件存在错误', cappedImportErrors(errors));
  return entries;
}

/* ============ 导出 ============ */

export { buildSheet };
