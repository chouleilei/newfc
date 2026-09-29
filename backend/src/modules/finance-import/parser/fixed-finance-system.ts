import ExcelJS from 'exceljs';
import { Errors } from '../../../core/errors';
import { wanStringToYuanString, yuanStringToCents } from '../../../core/money';
import type { FinanceAdapter, FinanceParseContext } from './adapter';
import type { JournalVerificationResult, NormalizedFinanceRow, NormalizedProfitRow } from '../finance.types';
import { assertSafeXlsx } from '../../io/xlsx-guard';

const BALANCE_DEFAULTS = {
  bookCode: ['账套编码','公司编码'], orgCode: ['组织编码','核算组织编码'], orgName: ['组织名称','核算组织名称'],
  accountCode: ['科目编码','财务科目编码'], accountName: ['科目名称','财务科目名称'],
  debit: ['本年累计借方','累计借方'], credit: ['本年累计贷方','累计贷方'], year: ['年度'], snapshotDate: ['截止日期'],
};
const PROFIT_DEFAULTS = { item: ['项目','报表项目'], amount: ['本年累计金额','本年累计','累计金额'], year: ['年度'], snapshotDate: ['截止日期'] };
const JOURNAL_DEFAULTS = {
  company: ['公司','公司名称','组织名称'], postingDate: ['记账日期'], period: ['期间','会计期间'], status: ['状态','记账状态'],
  accountCode: ['科目编码','科目代码'], accountName: ['科目名称'], currency: ['币别','币种'], debit: ['借方','借方金额'], credit: ['贷方','贷方金额'],
};

function text(cell: ExcelJS.Cell, requiredFormulaValue = true): string {
  const value = cell.value;
  if (value == null) return '';
  if (typeof value === 'object') {
    if ('formula' in value) {
      if ((value as ExcelJS.CellFormulaValue).result == null && requiredFormulaValue) throw Errors.validation(`公式单元格 ${cell.address} 缺少缓存计算值`);
      return String((value as ExcelJS.CellFormulaValue).result ?? '').trim();
    }
    if ('richText' in value) return value.richText.map((part) => part.text).join('').trim();
    if ('text' in value) return String(value.text).trim();
    if (value instanceof Date) return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

function money(raw: string, unit: 'yuan'|'wan'): number {
  const value = raw.trim();
  if (!value || value === '-') return 0;
  const normalized = value.replace(/[,，\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  return yuanStringToCents(unit === 'wan' ? wanStringToYuanString(normalized) : normalized);
}

function aliases(defaults: Record<string,string[]>, custom?: Record<string,string[]>): Record<string,string[]> {
  const out: Record<string,string[]> = {};
  for (const key of Object.keys(defaults)) out[key] = [...(custom?.[key] ?? []), ...defaults[key]];
  return out;
}

function findSheet(wb: ExcelJS.Workbook, accepted: string[]|undefined, fallback: RegExp): ExcelJS.Worksheet {
  const sheet = wb.worksheets.find((s) => accepted?.includes(s.name)) ?? wb.worksheets.find((s) => fallback.test(s.name));
  if (!sheet) throw Errors.validation(`未找到工作表:${accepted?.join('/') || fallback.source}`);
  return sheet;
}

function headers(sheet: ExcelJS.Worksheet, names: Record<string,string[]>, searchRows: number): { row: number; cols: Record<string,number> } {
  for (let rowNo = 1; rowNo <= Math.min(searchRows, sheet.rowCount); rowNo++) {
    const values = new Map<string,number[]>();
    sheet.getRow(rowNo).eachCell({ includeEmpty: false }, (cell, col) => {
      const value = text(cell, false).replace(/\s/g, '');
      values.set(value, [...(values.get(value) ?? []), col]);
    });
    const cols: Record<string,number> = {};
    let valid = true;
    for (const [key, options] of Object.entries(names)) {
      const matches = options.flatMap((a) => values.get(a.replace(/\s/g, '')) ?? []);
      const unique = [...new Set(matches)];
      if (unique.length > 1) throw Errors.validation(`${sheet.name} 表头“${key}”匹配到多个列`);
      if (unique.length === 0) valid = false; else cols[key] = unique[0];
    }
    if (valid) return { row: rowNo, cols };
  }
  throw Errors.validation(`${sheet.name} 缺少必填表头`);
}

async function workbook(buffer: Buffer, maxRows = 20000): Promise<ExcelJS.Workbook> {
  await assertSafeXlsx(buffer, maxRows);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer); } catch { throw Errors.validation('不是有效的 xlsx 文件'); }
  return wb;
}

function period(row: ExcelJS.Row, cols: Record<string,number>, context: FinanceParseContext): { year:number; snapshotDate:string } {
  const yearRaw = text(row.getCell(cols.year));
  const dateRaw = text(row.getCell(cols.snapshotDate));
  const year = yearRaw ? Number(yearRaw) : context.year;
  const snapshotDate = dateRaw ? dateRaw.slice(0, 10) : context.snapshotDate;
  if (year !== context.year || snapshotDate !== context.snapshotDate) throw Errors.validation(`第 ${row.number} 行期间 ${year}/${snapshotDate} 与请求期间不一致`);
  return { year, snapshotDate };
}

function fixedIdentity(context: FinanceParseContext): { bookCode:string;orgCode:string;orgName:string } {
  const bookCode=String(context.config.fixedBookCode??'').trim(),orgCode=String(context.config.fixedOrgCode??'').trim(),orgName=String(context.config.fixedOrgName??'').trim();
  if(!bookCode||!orgCode||!orgName)throw Errors.validation('双层余额表必须配置 fixedBookCode、fixedOrgCode、fixedOrgName');
  return{bookCode,orgCode,orgName};
}

function twoRowHeaders(sheet:ExcelJS.Worksheet,searchRows:number){
  const norm=(v:string)=>v.replace(/\s/g,'');
  for(let row=1;row<Math.min(searchRows,sheet.rowCount);row++){
    const accountCodes:number[]=[],accountNames:number[]=[],debits:number[]=[],credits:number[]=[];
    for(let col=1;col<=sheet.columnCount;col++){
      const top=norm(text(sheet.getCell(row,col).master,false)),bottom=norm(text(sheet.getCell(row+1,col).master,false));
      const values=new Set([top,bottom]);
      if(values.has('科目代码')||values.has('科目编码')||values.has('财务科目编码'))accountCodes.push(col);
      if(values.has('科目名称')||values.has('财务科目名称'))accountNames.push(col);
      if(top.includes('本年累计')&&bottom==='借方')debits.push(col);
      if(top.includes('本年累计')&&bottom==='贷方')credits.push(col);
    }
    if(accountCodes.length>1||accountNames.length>1||debits.length>1||credits.length>1){
      throw Errors.validation(`${sheet.name} 双层表头匹配到多个科目编码、科目名称或“本年累计/借贷”列`);
    }
    if(accountCodes[0]&&accountNames[0]&&debits[0]&&credits[0])return{row:row+1,cols:{accountCode:accountCodes[0],accountName:accountNames[0],debit:debits[0],credit:credits[0]}};
  }
  throw Errors.validation(`${sheet.name} 缺少“本年累计/借方、贷方”双层表头`);
}

function directChildren<T extends {accountCode:string}>(parent:T,rows:T[]):T[]{
  const descendants=rows.filter(r=>r.accountCode.length>parent.accountCode.length&&r.accountCode.startsWith(parent.accountCode));
  return descendants.filter(child=>!descendants.some(mid=>mid.accountCode.length<child.accountCode.length&&child.accountCode.startsWith(mid.accountCode)));
}

export class FixedFinanceSystemAdapter implements FinanceAdapter {
  async parseBalance(buffer: Buffer, context: FinanceParseContext): Promise<NormalizedFinanceRow[]> {
    const wb = await workbook(buffer, context.config.maxRows ?? 20000); const sheet = findSheet(wb, context.config.balanceSheetNames, /余额|balance/i);
    if(context.config.balanceLayout==='two_row_cumulative'){
      const h=twoRowHeaders(sheet,context.config.headerSearchRows??20),identity=fixedIdentity(context),all:NormalizedFinanceRow[]=[];
      const maxRows=context.config.maxRows??20000,seen=new Set<string>();
      for(let no=h.row+1;no<=sheet.rowCount;no++){
        const row=sheet.getRow(no);if(row.hidden)continue;const accountCode=text(row.getCell(h.cols.accountCode));if(!accountCode)continue;
        if(seen.has(accountCode))throw Errors.validation(`${sheet.name}!${no} 科目编码 ${accountCode} 重复`);seen.add(accountCode);
        if(all.length>=maxRows)throw Errors.validation(`实际解析行数超过安全上限 ${maxRows}`);
        all.push({sourceSheet:sheet.name,sourceRow:no,...identity,accountCode,accountName:text(row.getCell(h.cols.accountName)),auxiliary:{},cumulativeDebitCents:money(text(row.getCell(h.cols.debit)),context.config.amountUnit??'yuan'),cumulativeCreditCents:money(text(row.getCell(h.cols.credit)),context.config.amountUnit??'yuan'),year:context.year,snapshotDate:context.snapshotDate});
      }
      const parents=all.filter(row=>all.some(other=>other.accountCode.length>row.accountCode.length&&other.accountCode.startsWith(row.accountCode)));
      for(const parent of parents){const children=directChildren(parent,all),debit=children.reduce((sum,row)=>sum+row.cumulativeDebitCents,0),credit=children.reduce((sum,row)=>sum+row.cumulativeCreditCents,0);if(debit!==parent.cumulativeDebitCents||credit!==parent.cumulativeCreditCents)throw Errors.validation(`${sheet.name}!${parent.sourceRow} 父科目 ${parent.accountCode} 与直接子科目本年累计不一致`);}
      const parentCodes=new Set(parents.map(row=>row.accountCode));return all.filter(row=>!parentCodes.has(row.accountCode));
    }
    const required = aliases(BALANCE_DEFAULTS, context.config.balanceColumns as Record<string,string[]>);
    const h = headers(sheet, required, context.config.headerSearchRows ?? 20);
    const auxDefs = context.config.auxiliaryColumns ?? {}; const auxCols: Record<string,number> = {};
    const headerTexts = new Map<string,number>(); sheet.getRow(h.row).eachCell((c,n) => headerTexts.set(text(c,false).replace(/\s/g,''), n));
    for (const [key, opts] of Object.entries(auxDefs)) { const found = opts.map((a) => headerTexts.get(a.replace(/\s/g,''))).filter(Boolean) as number[]; if (found.length > 1) throw Errors.validation(`辅助表头 ${key} 多义`); if (found[0]) auxCols[key] = found[0]; }
    const result: NormalizedFinanceRow[] = []; const maxRows = context.config.maxRows ?? 20000;
    for (let no = h.row + 1; no <= sheet.rowCount; no++) {
      const row = sheet.getRow(no); if (row.hidden) continue;
      const accountCode = text(row.getCell(h.cols.accountCode));
      // 不能仅凭名称含“合计/总计”丢行：真实末级科目也可能含这些字样。
      // 带编码的行一律进入后续映射/守恒校验，无法映射时显式阻断而非静默消失。
      if (!accountCode) continue;
      if (result.length >= maxRows) throw Errors.validation(`实际解析行数超过安全上限 ${maxRows}`);
      const auxiliary: Record<string,string> = {}; for (const [key,col] of Object.entries(auxCols)) auxiliary[key] = text(row.getCell(col));
      result.push({ sourceSheet: sheet.name, sourceRow: no, bookCode: text(row.getCell(h.cols.bookCode)), orgCode: text(row.getCell(h.cols.orgCode)), orgName: text(row.getCell(h.cols.orgName)), accountCode, accountName: text(row.getCell(h.cols.accountName)), auxiliary, cumulativeDebitCents: money(text(row.getCell(h.cols.debit)), context.config.amountUnit ?? 'yuan'), cumulativeCreditCents: money(text(row.getCell(h.cols.credit)), context.config.amountUnit ?? 'yuan'), ...period(row,h.cols,context) });
    }
    // 与 two_row_cumulative 同口径的父行防护:父子编码同现时校验父=Σ直接子并剔除父行,
    // 否则父行与子行同时配映射会被双重计入(守恒门不破,勾稽未覆盖即漏出)。
    // 单层表可跨账套/组织,父子判定限定在同一 (账套,组织) 组内;同一编码可能因辅助维度多行,按编码聚合后比较。
    const byIdentity = new Map<string, NormalizedFinanceRow[]>();
    for (const row of result) {
      const key = `${row.bookCode}|${row.orgCode}|${row.orgName}`;
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), row]);
    }
    const kept: NormalizedFinanceRow[] = [];
    for (const group of byIdentity.values()) {
      const codeTotals = new Map<string, { debit: number; credit: number; sourceRow: number }>();
      for (const row of group) {
        const t = codeTotals.get(row.accountCode) ?? { debit: 0, credit: 0, sourceRow: row.sourceRow };
        t.debit += row.cumulativeDebitCents; t.credit += row.cumulativeCreditCents;
        codeTotals.set(row.accountCode, t);
      }
      const codes = [...codeTotals.keys()];
      const parentCodes = new Set(codes.filter((code) => codes.some((other) => other.length > code.length && other.startsWith(code))));
      for (const code of parentCodes) {
        const descendantsOf = codes.filter((c) => c.length > code.length && c.startsWith(code));
        const direct = descendantsOf.filter((c) => !descendantsOf.some((mid) => mid.length < c.length && c.startsWith(mid)));
        const parent = codeTotals.get(code)!;
        const debit = direct.reduce((s, c) => s + codeTotals.get(c)!.debit, 0);
        const credit = direct.reduce((s, c) => s + codeTotals.get(c)!.credit, 0);
        if (debit !== parent.debit || credit !== parent.credit) {
          throw Errors.validation(`${sheet.name}!${parent.sourceRow} 父科目 ${code} 与直接子科目本年累计不一致`);
        }
      }
      kept.push(...group.filter((row) => !parentCodes.has(row.accountCode)));
    }
    return kept;
  }
  async verifyJournal(buffer:Buffer,balance:NormalizedFinanceRow[],context:FinanceParseContext):Promise<JournalVerificationResult>{
    const wb=await workbook(buffer, context.config.maxRows ?? 20000),sheet=findSheet(wb,context.config.journalSheetNames,/序时|凭证|journal/i),h=headers(sheet,JOURNAL_DEFAULTS,context.config.headerSearchRows??20);
    const expectedCompany=String(context.config.journalCompanyName??context.config.fixedOrgName??'').trim();if(!expectedCompany)throw Errors.validation('序时簿核验必须配置 journalCompanyName 或 fixedOrgName');
    const journalUnit=context.config.amountUnit??'yuan';
    const aggregated=new Map<string,{name:string;debit:number;credit:number}>();let sourceRows=0,includedRows=0,ignoredOtherPeriodRows=0,ignoredUnpostedRows=0,ignoredOtherCompanyRows=0;
    for(let no=h.row+1;no<=sheet.rowCount;no++){
      const row=sheet.getRow(no);if(row.hidden)continue;const accountCode=text(row.getCell(h.cols.accountCode));if(!accountCode)continue;sourceRows++;
      // 多公司序时簿:只核验配置公司,其余公司行留痕跳过(多组织余额表启用核验时的合法形态)
      const company=text(row.getCell(h.cols.company));if(company!==expectedCompany){ignoredOtherCompanyRows++;continue;}
      if(text(row.getCell(h.cols.status))!=='已过账'){ignoredUnpostedRows++;continue;}
      const postingDate=text(row.getCell(h.cols.postingDate)).slice(0,10),periodText=text(row.getCell(h.cols.period));
      if(!/^\d{4}-\d{2}-\d{2}$/.test(postingDate))throw Errors.validation(`${sheet.name}!${no} 记账日期不合法`);
      const month=Number(postingDate.slice(5,7)),periodParts=periodText.split('.').map(Number);if(periodParts[0]!==Number(postingDate.slice(0,4))||periodParts[1]!==month)throw Errors.validation(`${sheet.name}!${no} 会计期间与记账日期不一致`);
      if(postingDate<`${context.year}-01-01`||postingDate>context.snapshotDate){ignoredOtherPeriodRows++;continue;}
      const currency=text(row.getCell(h.cols.currency)).toUpperCase();if(!['人民币','CNY','RMB'].includes(currency))throw Errors.validation(`${sheet.name}!${no} 存在未支持币种 ${currency}`);
      const old=aggregated.get(accountCode)??{name:text(row.getCell(h.cols.accountName)),debit:0,credit:0};old.debit+=money(text(row.getCell(h.cols.debit)),journalUnit);old.credit+=money(text(row.getCell(h.cols.credit)),journalUnit);aggregated.set(accountCode,old);includedRows++;
    }
    // 余额侧与序时簿同口径:只取配置公司的行(多组织余额表),父级汇总行已在 parseBalance 按布局剔除
    const balanceByCode=new Map<string,{accountName:string;cumulativeDebitCents:number;cumulativeCreditCents:number}>();
    for(const row of balance){if(row.orgName&&row.orgName!==expectedCompany)continue;const old=balanceByCode.get(row.accountCode)??{accountName:row.accountName,cumulativeDebitCents:0,cumulativeCreditCents:0};old.cumulativeDebitCents+=row.cumulativeDebitCents;old.cumulativeCreditCents+=row.cumulativeCreditCents;balanceByCode.set(row.accountCode,old);}
    for(const [code,row] of balanceByCode)if(row.cumulativeDebitCents===0&&row.cumulativeCreditCents===0)balanceByCode.delete(code);
    const codes=[...new Set([...balanceByCode.keys(),...aggregated.keys()])].sort((a,b)=>a.localeCompare(b));const tolerance=Math.max(0,Math.trunc(context.config.journalToleranceCents??0));const differences=[];
    for(const accountCode of codes){const b=balanceByCode.get(accountCode),j=aggregated.get(accountCode),debitDifferenceCents=(j?.debit??0)-(b?.cumulativeDebitCents??0),creditDifferenceCents=(j?.credit??0)-(b?.cumulativeCreditCents??0);if(Math.abs(debitDifferenceCents)>tolerance||Math.abs(creditDifferenceCents)>tolerance)differences.push({accountCode,accountName:b?.accountName??j?.name??'',balanceDebitCents:b?.cumulativeDebitCents??0,journalDebitCents:j?.debit??0,debitDifferenceCents,balanceCreditCents:b?.cumulativeCreditCents??0,journalCreditCents:j?.credit??0,creditDifferenceCents});}
    return{provided:true,passed:differences.length===0,sourceRows,includedRows,ignoredOtherPeriodRows,ignoredUnpostedRows,ignoredOtherCompanyRows,accountCount:codes.length,matchedCount:codes.length-differences.length,mismatchCount:differences.length,toleranceCents:tolerance,differences};
  }
  async parseProfit(buffer: Buffer, context: FinanceParseContext): Promise<NormalizedProfitRow[]> {
    const wb = await workbook(buffer, context.config.maxRows ?? 20000); const sheet = findSheet(wb, context.config.profitSheetNames, /利润|profit/i);
    const h = headers(sheet, aliases(PROFIT_DEFAULTS, context.config.profitColumns as Record<string,string[]>), context.config.headerSearchRows ?? 20);
    const result: NormalizedProfitRow[] = [];
    for (let no = h.row + 1; no <= sheet.rowCount; no++) { const row = sheet.getRow(no); if (row.hidden) continue; const item = text(row.getCell(h.cols.item)); if (!item) continue; result.push({ sourceSheet: sheet.name, sourceRow:no, item, amountCents: money(text(row.getCell(h.cols.amount)), context.config.amountUnit ?? 'yuan'), ...period(row,h.cols,context) }); }
    return result;
  }
}

export function adapterFor(type: string): FinanceAdapter {
  if (type === 'fixed_finance_system_v1') return new FixedFinanceSystemAdapter();
  throw Errors.validation(`不支持的数据源适配器:${type}`);
}
