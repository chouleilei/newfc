/** 正式历史公文 → 冻结附表输入。只编译显式材料，不读写业务库，不推测缺失金额。 */
import { z } from 'zod';
import { PLAN_SHEETS, type PlanAttachmentSummaryDto } from '../../contracts/plan-execution';
import { centsToDecimalString, parseDecimalToCents, parseScaled } from '../../core/decimal';
import type { ParsedDocument } from '../contracts/document-parser';

const entry = z.object({
  unit_code: z.string().trim().min(1).max(80), doc_filename: z.string().min(1),
  attachment_no: z.coerce.number().int().positive(), attachment_title: z.string().min(1),
  target_sheet_code: z.enum(PLAN_SHEETS), unit_of_measure: z.string().min(1),
  column_schema: z.string().min(1), leaf_row_count: z.coerce.number().int().positive(),
  reported_total_yuan: z.string(), recomputed_leaf_sum_yuan: z.string(),
  sub_entities: z.string().default(''), undertake_depts: z.string().default(''),
});
export type IssuanceSourceDocument = ParsedDocument & { sha256: string };

export function compileIssuanceSourceAttachments(raw: unknown, documents: Record<string, IssuanceSourceDocument>, unitMap?: Record<string, string | number>) {
  const entries = z.array(entry).min(1).max(200).parse(raw);
  const unitAttachments: Record<string, PlanAttachmentSummaryDto[]> = {};
  const unitMetrics: Record<string, Record<string,string>> = {};
  const sourceDocuments: { unitCode: string; sha256: string; tableCount: number }[] = [];
  const files = [...new Set(entries.map((e) => e.doc_filename))];
  for (const file of files) {
    const doc = Object.prototype.hasOwnProperty.call(documents, file) ? documents[file] : undefined;
    if (!doc || doc.status !== 'ok' || !/^[a-f0-9]{64}$/.test(doc.sha256)) throw new Error('正式公文缺失或解析未通过');
    const group = entries.filter((e) => e.doc_filename === file).sort((a,b) => a.attachment_no - b.attachment_no);
    const sourceUnit = group[0].unit_code;
    if (unitMap && !Object.prototype.hasOwnProperty.call(unitMap,sourceUnit)) throw new Error('下达单位缺少显式映射');
    const unit = String(unitMap ? z.union([z.string().min(1).max(80),z.number().int().positive()]).parse(unitMap[sourceUnit]) : sourceUnit);
    if (group.some((e) => e.unit_code !== sourceUnit) || Object.prototype.hasOwnProperty.call(unitAttachments, unit) || ['__proto__','constructor','prototype'].includes(unit)) throw new Error('公文与下达单位必须一一对应');
    const tables = new Map<number, Map<number, Map<number, string>>>();
    for (const p of doc.paragraphs) {
      if (!p.table || !p.row || !p.cell) continue;
      const rows = tables.get(p.table) ?? new Map<number, Map<number,string>>();
      const cells = rows.get(p.row) ?? new Map<number,string>();
      cells.set(p.cell, [cells.get(p.cell), p.text].filter(Boolean).join('\n'));
      rows.set(p.row, cells); tables.set(p.table, rows);
    }
    // LibreOffice 会合并跨页物理表，按逻辑顺序核对；数量不符时禁止猜测索引或补空表。
    const ordered = [...tables].sort(([a],[b]) => a-b);
    if (ordered.length !== group.length || group.some((e,i) => e.attachment_no !== i+1)) throw new Error('正式公文逻辑表数或附表编号与清单不一致');
    unitAttachments[unit] = group.map((e,index) => {
      const matrix = [...ordered[index][1]].sort(([a],[b]) => a-b).map(([,cells]) => Array.from({length:Math.max(...cells.keys())}, (_,i) => cells.get(i+1) ?? ''));
      const headers = e.column_schema.split('|');
      const isKpi = e.target_sheet_code === 'annual_kpi';
      const isProfit = e.target_sheet_code === 'profit_budget';
      const amountIndex = isKpi ? 3 : isProfit ? 1 : e.target_sheet_code === 'purchase' ? 5 : 2;
      const rows = matrix.filter((cells) => cells.some((c) => c.trim()) && !cells.some((c) => /^(序号|预算金额|批复计划)$/.test(c.trim()))).map((cells) => {
        const nameIndex = isProfit ? 0 : 1;
        return {
          seqNo: isProfit ? '' : cells[0] ?? '', itemName: cells[nameIndex] ?? '',
          unit: isKpi ? cells[2] ?? '' : e.unit_of_measure,
          amountOrValue: cells[amountIndex] ?? '', undertakeOrgName: null,
          note: cells.map((v,i) => v && ![nameIndex,amountIndex,...(isProfit ? [] : [0]),...(isKpi ? [2] : [])].includes(i) ? `${headers[i] ?? `源列${i+1}`}：${v}` : '').filter(Boolean).join('；'),
        };
      });
      if (!rows.length || !rows.some((r) => /\d/.test(r.amountOrValue))) throw new Error('正式附表无可核对的明细值');
      const issued = parseDecimalToCents(e.reported_total_yuan || e.recomputed_leaf_sum_yuan);
      const exact = parseDecimalToCents(e.recomputed_leaf_sum_yuan || e.reported_total_yuan);
      return { attachmentNo:e.attachment_no, title:e.attachment_title, sheetCode:e.target_sheet_code,
        unitOfMeasure:e.unit_of_measure, leafRowCount:e.leaf_row_count, exactTotalAmount:centsToDecimalString(exact),
        issuedTotalAmount:centsToDecimalString(issued), diffReasonCode: exact === issued ? '' : 'SOURCE_ISSUED_WITH_CROSS_REFERENCE',
        subEntities:e.sub_entities.split(';').filter(Boolean), undertakeDepts:e.undertake_depts.split(';').filter(Boolean), rows };
    });
    sourceDocuments.push({unitCode:unit,sha256:doc.sha256,tableCount:group.length});
    const attachments = unitAttachments[unit];
    const metric:Record<string,string> = {};
    const sheet = (code:string) => attachments.find((a)=>a.sheetCode===code);
    const amount = (row:PlanAttachmentSummaryDto['rows'][number]) => {
      const value=row.amountOrValue.replace(/\s+/g,'');
      if(!value || /^[-—]+$/.test(value) || !['元','万元'].includes(row.unit)) return undefined;
      return parseScaled(value,row.unit==='万元'?6:2);
    };
    const find = (code:string,pattern:RegExp) => {
      const values=(sheet(code)?.rows ?? []).filter((r)=>pattern.test(r.itemName.replace(/\s+/g,''))).map(amount).filter((v):v is bigint=>v!==undefined);
      if(values.length>1) throw new Error('正式附表核心指标同名不唯一');
      return values[0];
    };
    const set = (key:string,value:bigint|undefined) => { if(value!==undefined) metric[key]=centsToDecimalString(value); };
    const operating=find('profit_budget',/营业总收入/);
    set('operatingRevenue',operating);
    set('profitBeforeTax',find('profit_budget',/利润总额/));
    set('netProfit',find('profit_budget',/净利润/));
    const total=find('annual_kpi',/^总收入$/);
    set('totalRevenue',total ?? (operating===undefined?undefined:operating+(find('profit_budget',/营业外收入/) ?? 0n)));
    set('investmentTotal',find('annual_kpi',/^固定资产投资$/));
    for(const [code,key] of [['purchase','purchaseTotal'],['maintenance','maintenanceTotal'],['safety_input','safetyInputTotal']] as const) {
      const attachment=sheet(code); if(attachment) metric[key]=attachment.issuedTotalAmount;
    }
    if(!metric.investmentTotal && sheet('investment')) {
      const investment=sheet('investment')!;
      const includesPurchase=investment.diffReasonCode==='SOURCE_ISSUED_WITH_CROSS_REFERENCE';
      set('investmentTotal',parseDecimalToCents(investment.issuedTotalAmount)+
        (sheet('investment_tech_renovation')?parseDecimalToCents(sheet('investment_tech_renovation')!.issuedTotalAmount):0n)+
        (!includesPurchase && sheet('purchase')?parseDecimalToCents(sheet('purchase')!.issuedTotalAmount):0n));
    }
    const five=sheet('five_expenses');
    if(five) { metric.fiveExpensesExact=five.exactTotalAmount; metric.fiveExpensesIssued=five.issuedTotalAmount; }
    const other=find('mgmt_fee',/可控.*其他|其他.*可控/);
    if(other!==undefined && five) set('controllableMgmtFeeExact',other+parseDecimalToCents(five.exactTotalAmount));
    unitMetrics[unit]=metric;
  }
  return { unitAttachments, unitMetrics, sourceDocuments };
}
