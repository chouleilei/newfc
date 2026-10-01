/**
 * 计划执行模板解析(AC-F15)。三张表按工作表名识别,其余表忽略并列出。
 *
 * - 表头在前 20 行内定位(须同时有名称列与年度计划列);表头上方出现“YYYY年”时必须与上传年度一致。
 * - 金额单位:列头括注(万元/元)优先,其次表头上方“单位:万元/元”,缺省万元;万元按 ×10000 精确换算。
 * - 每个字段声明口径 measure;空单元格即缺失,不当 0;数值不可解析即报错。
 * - 行类型:名称含合计/小计/总计为 subtotal;序号为“一、”“(一)”等为 category;其余为 detail。
 * - 投资明细必须有项目编码;购置/运维明细无项目时按承办单位经主数据唯一解析组织。
 */
import type { RowError } from '../../core/errors';
import { formatScaled } from '../../core/decimal';
import { normalizeHeaderText, sheetTable, type ReadSheet } from '../io/table-reader';
import {
  amountCents, CellError, findHeader, headerKey, headerUnit, quantityScaled, ratioScaledCell, type AmountUnit, QUANTITY_SCALE,
} from '../io/cell-values';
import { PLAN_SHEET_LABELS, type PlanMeasure, type PlanSheetCode } from '../../contracts/plan-execution';

export type PlanValueType = 'amount' | 'quantity' | 'ratio' | 'text';
export interface FieldDef { key: string; label: string; aliases: readonly string[]; measure: PlanMeasure; type: PlanValueType }

const SHEET_ALIASES: Record<PlanSheetCode, readonly string[]> = {
  investment: ['固定资产投资计划', '投资计划'],
  purchase: ['固定资产购置计划', '购置计划'],
  maintenance: ['运行维护费', '运维费', '运行维护费计划'],
};

export const PLAN_ID_COLUMNS = {
  seq: ['序号'],
  projectCode: ['项目编码', '项目代码', '项目编号'],
  name: ['项目名称', '名称', '资产名称', '费用项目', '费用名称'],
  // 不收“单位”:购置表的“单位”是计量单位(台/套)
  orgName: ['承办单位', '责任单位', '实施单位'],
} as const;

export const PLAN_FIELDS: Record<PlanSheetCode, readonly FieldDef[]> = {
  investment: [
    { key: 'approved_budget', label: '批复概算', aliases: ['批复概算', '概算'], measure: 'total', type: 'amount' },
    { key: 'total_investment', label: '总投资', aliases: ['总投资', '项目总投资'], measure: 'total', type: 'amount' },
    { key: 'completed_investment', label: '开工累计已完成投资', aliases: ['开工累计已完成投资', '累计完成投资', '已完成投资'], measure: 'cumulative', type: 'amount' },
    { key: 'paid_cumulative', label: '累计已付款', aliases: ['累计已付款', '已付款'], measure: 'cumulative', type: 'amount' },
    { key: 'annual_plan', label: '本年计划投资', aliases: ['本年计划投资', '年度计划投资', '年度计划', '本年计划'], measure: 'annual_plan', type: 'amount' },
    { key: 'annual_actual', label: '本年实际完成投资', aliases: ['本年实际完成投资', '年度实际完成投资', '本年完成投资', '年度实际', '本年实际'], measure: 'annual_actual_ytd', type: 'amount' },
    { key: 'physical_progress', label: '形象进度', aliases: ['形象进度'], measure: 'snapshot', type: 'ratio' },
    { key: 'progress_note', label: '形象进度说明', aliases: ['形象进度说明', '进度说明'], measure: 'snapshot', type: 'text' },
  ],
  purchase: [
    { key: 'quantity', label: '数量', aliases: ['数量'], measure: 'total', type: 'quantity' },
    { key: 'unit_price', label: '单价', aliases: ['单价'], measure: 'total', type: 'amount' },
    { key: 'total_price', label: '合价', aliases: ['合价', '总价'], measure: 'total', type: 'amount' },
    { key: 'annual_plan', label: '年度计划', aliases: ['年度计划', '本年计划', '年度计划金额'], measure: 'annual_plan', type: 'amount' },
    { key: 'annual_actual', label: '年度实际', aliases: ['年度实际', '本年实际', '年度实际完成', '本年完成'], measure: 'annual_actual_ytd', type: 'amount' },
  ],
  maintenance: [
    { key: 'annual_plan', label: '年度计划', aliases: ['年度计划', '本年计划', '年度预算'], measure: 'annual_plan', type: 'amount' },
    { key: 'annual_actual', label: '年度实际', aliases: ['年度实际', '本年实际', '本年累计实际', '年度实际发生'], measure: 'annual_actual_ytd', type: 'amount' },
  ],
};

export interface ParsedPlanFact { fieldKey: string; measure: PlanMeasure; valueType: PlanValueType; amount: bigint | null; scaled: bigint | null; text: string | null; sourceCell: string }
export interface ParsedPlanItem {
  sheetCode: PlanSheetCode; rowNo: number; seqNo: string; itemName: string; itemType: 'detail' | 'category' | 'subtotal'; path: string;
  projectCode: string; orgText: string; facts: ParsedPlanFact[];
}
export interface ParsedPlanSheet { code: PlanSheetCode; sourceName: string; unit: AmountUnit; items: ParsedPlanItem[] }
export interface ParsedPlanWorkbook { sheets: ParsedPlanSheet[]; ignoredSheets: string[]; errors: RowError[] }

function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const CATEGORY_SEQ = /^([一二三四五六七八九十百]+[、.．]?|[（(][一二三四五六七八九十]+[）)])$/;
const SUBTOTAL_NAME = /(合计|小计|总计)/;

export function sheetCodeOf(name: string): PlanSheetCode | null {
  const key = name.replace(/\s+/g, '');
  for (const [code, aliases] of Object.entries(SHEET_ALIASES) as [PlanSheetCode, readonly string[]][]) {
    if (aliases.some((a) => key === a || key.includes(a))) return code;
  }
  return null;
}

/** 设置页维护的导入字段别名:表 → 字段 key(含标识列 seq/projectCode/name/orgName)→ 追加别名。 */
export type PlanExtraAliases = Partial<Record<PlanSheetCode, Readonly<Record<string, readonly string[]>>>>;
const withExtra = (aliases: readonly string[], extra: readonly string[] | undefined) => (extra?.length ? [...new Set([...aliases, ...extra])] : aliases);

export function parsePlanWorkbook(sheets: ReadSheet[], year: number, extraAliases: PlanExtraAliases = {}): ParsedPlanWorkbook {
  const errors: RowError[] = [];
  const out: ParsedPlanSheet[] = [];
  const ignored: string[] = [];
  const seen = new Set<PlanSheetCode>();
  for (const sheet of sheets) {
    const code = sheetCodeOf(sheet.name);
    if (!code || seen.has(code)) { ignored.push(sheet.name); continue; }
    seen.add(code);
    const label = PLAN_SHEET_LABELS[code];
    const extra = extraAliases[code] ?? {};
    const fields = PLAN_FIELDS[code].map((f) => ({ ...f, aliases: withExtra(f.aliases, extra[f.key]) }));
    const idColumns = Object.fromEntries(Object.entries(PLAN_ID_COLUMNS).map(([k, a]) => [k, withExtra(a, extra[k])])) as Record<keyof typeof PLAN_ID_COLUMNS, readonly string[]>;
    const annualPlan = fields.find((f) => f.key === 'annual_plan')!;
    let table;
    try {
      table = sheetTable(sheet, {
        label: `${label}表头(名称列与年度计划列)`,
        isHeader: (cells) => {
          const keys = cells.map(headerKey);
          return idColumns.name.some((a) => keys.includes(a)) && annualPlan.aliases.some((a) => keys.includes(a));
        },
      });
    } catch (e) {
      errors.push({ row: 0, field: label, message: (e as Error).message });
      continue;
    }
    const headerRowNo = table.headerRowNo!;
    const above = sheet.rows.filter((r) => r.rowNo < headerRowNo).flatMap((r) => r.cells).join(' ');
    const yearHit = /(\d{4})\s*年/.exec(above);
    if (yearHit && Number(yearHit[1]) !== year) {
      errors.push({ row: yearHit ? headerRowNo : 0, field: label, message: `表头年度 ${yearHit[1]} 与上传年度 ${year} 不一致` });
      continue;
    }
    const sheetUnit: AmountUnit = /单位[:：]?\s*元/.test(above) && !/单位[:：]?\s*万元/.test(above) ? 'yuan' : 'wan';
    // 原始表头 → 列序号(用于来源单元格)
    const headerRow = sheet.rows.find((r) => r.rowNo === headerRowNo)!;
    const colIndex = new Map(headerRow.cells.map((c, i) => [normalizeHeaderText(c), i] as const));
    const idCol = Object.fromEntries(Object.entries(idColumns).map(([k, a]) => [k, findHeader(table.headers, a)])) as Record<keyof typeof PLAN_ID_COLUMNS, string | null>;
    const fieldCols = fields.map((f) => ({ def: f, header: findHeader(table.headers, f.aliases) })).filter((f) => f.header);
    if (code === 'investment' && !idCol.projectCode) errors.push({ row: headerRowNo, field: label, message: '缺少“项目编码”列' });
    const items: ParsedPlanItem[] = [];
    const categories: string[] = [];
    for (const r of table.rows) {
      const v = (h: string | null) => (h ? r.values[h] ?? '' : '');
      const name = v(idCol.name);
      const seqNo = v(idCol.seq);
      const rowErr = (field: string, message: string) => errors.push({ row: r.rowNo, field: `${label}·${field}`, message });
      if (!name) {
        if (fieldCols.some((f) => v(f.header)) || v(idCol.projectCode)) rowErr('名称', '名称为空');
        continue;
      }
      const itemType: ParsedPlanItem['itemType'] = SUBTOTAL_NAME.test(name) ? 'subtotal' : CATEGORY_SEQ.test(seqNo) ? 'category' : 'detail';
      if (itemType === 'category') {
        if (/^[（(]/.test(seqNo)) categories.splice(1); else categories.length = 0;
        categories.push(name);
      }
      const facts: ParsedPlanFact[] = [];
      for (const { def, header } of fieldCols) {
        const text = v(header);
        if (text === '') continue;
        const sourceCell = `${label}!${columnLetter(colIndex.get(normalizeHeaderText(header!)) ?? 0)}${r.rowNo}`;
        try {
          if (def.type === 'amount') {
            const unit = headerUnit(header!) ?? sheetUnit;
            const amount = amountCents(text, unit, def.label);
            if (amount !== null) facts.push({ fieldKey: def.key, measure: def.measure, valueType: 'amount', amount, scaled: null, text: null, sourceCell });
          } else if (def.type === 'quantity') {
            const q = quantityScaled(text, def.label);
            if (q !== null) facts.push({ fieldKey: def.key, measure: def.measure, valueType: 'quantity', amount: null, scaled: q, text: null, sourceCell });
          } else if (def.type === 'ratio') {
            const ratio = ratioScaledCell(text, def.label);
            if (ratio !== null) facts.push({ fieldKey: def.key, measure: def.measure, valueType: 'ratio', amount: null, scaled: ratio, text: null, sourceCell });
          } else {
            facts.push({ fieldKey: def.key, measure: def.measure, valueType: 'text', amount: null, scaled: null, text: text.slice(0, 500), sourceCell });
          }
        } catch (e) {
          if (e instanceof CellError) rowErr(def.label, e.message); else throw e;
        }
      }
      const projectCode = v(idCol.projectCode);
      if (itemType === 'detail' && code === 'investment' && !projectCode) rowErr('项目编码', '投资明细行缺项目编码');
      if (itemType === 'detail' && code !== 'investment' && !projectCode && !v(idCol.orgName)) rowErr('承办单位', '明细行缺承办单位(或项目编码)');
      items.push({
        sheetCode: code, rowNo: r.rowNo, seqNo: seqNo.slice(0, 20), itemName: name.slice(0, 200), itemType,
        path: itemType === 'category' ? categories.slice(0, -1).join('/') : categories.join('/'), projectCode, orgText: v(idCol.orgName), facts,
      });
    }
    out.push({ code, sourceName: sheet.name, unit: sheetUnit, items });
  }
  if (out.length === 0 && errors.length === 0) {
    errors.push({ row: 0, field: '工作簿', message: `未找到计划执行工作表(${Object.values(PLAN_SHEET_LABELS).join('、')})` });
  }
  return { sheets: out, ignoredSheets: ignored, errors };
}

export function factValueText(f: { valueType: PlanValueType; amount: bigint | null; scaled: bigint | null; text: string | null }): string {
  if (f.valueType === 'amount') return formatScaled(f.amount!, 2);
  if (f.valueType === 'quantity') return formatScaled(f.scaled!, QUANTITY_SCALE, false);
  if (f.valueType === 'ratio') return formatScaled(f.scaled!, 6);
  return f.text ?? '';
}

export function fieldLabel(sheet: PlanSheetCode, key: string): string {
  return PLAN_FIELDS[sheet].find((f) => f.key === key)?.label ?? key;
}
