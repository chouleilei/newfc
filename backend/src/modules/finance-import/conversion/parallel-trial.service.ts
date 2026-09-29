import crypto from 'crypto';
import ExcelJS from 'exceljs';
import type { DB } from '../../../db/connection';
import { Errors } from '../../../core/errors';
import { yuanStringToCents } from '../../../core/money';
import { parseActualImport, type ParsedActualRow } from '../../io/excel';
import { writeLog } from '../../audit/log';
import { getConversion } from './conversion-batch.service';
import { expandOwnedLeafScope } from '../owned-scope';
import type { FinanceProfileConfig } from '../finance.types';

export interface ParallelDifference {
  orgCode:string; accountCode:string; convertedCents:number; manualCents:number; differenceCents:number;
}
export interface ParallelComparison {
  year:number; snapshotDate:string; totalCombinations:number; matchedCount:number; mismatchCount:number;
  netDifferenceCents:number; absoluteDifferenceCents:number; ignoredOutsideScopeRows:number;
  differences:ParallelDifference[];
}
export interface ParallelExplanation { orgCode:string;accountCode:string;reason:string;resolution:string }
export interface ParallelTrialRow {id:number;conversion_batch_id:number;status:'compared'|'explained'|'passed';manual_name:string;manual_sha256:string;manual_blob:Buffer;comparison_json:string;explanations_json:string;created_by:string;reviewed_by:string|null;created_at:string;reviewed_at:string|null}
const sha=(buffer:Buffer)=>crypto.createHash('sha256').update(buffer).digest('hex');
const keyOf=(row:Pick<ParsedActualRow,'orgCode'|'accountCode'>)=>`${row.orgCode}|${row.accountCode}`;
function centsOf(row:ParsedActualRow):number{if(row.quantityText&&!row.amountText)return 0;return yuanStringToCents(row.amountText||'0');}
export function getParallelTrial(db:DB,id:number):ParallelTrialRow{const row=db.prepare('SELECT * FROM finance_parallel_trial WHERE id=?').get(id) as ParallelTrialRow|undefined;if(!row)throw Errors.notFound('并行试运行');return row;}
export function publicParallelTrial(row:ParallelTrialRow){const {manual_blob,comparison_json,explanations_json,...rest}=row;return{...rest,comparison:JSON.parse(comparison_json) as ParallelComparison,explanations:JSON.parse(explanations_json) as ParallelExplanation[]};}
export function listParallelTrials(db:DB,conversionId?:number){const rows=db.prepare(`SELECT * FROM finance_parallel_trial ${conversionId?'WHERE conversion_batch_id=?':''} ORDER BY id DESC`).all(...(conversionId?[conversionId]:[])) as ParallelTrialRow[];return rows.map(publicParallelTrial);}

function assertPeriod(rows:ParsedActualRow[],year:number,date:string,label:string){for(const row of rows)if(row.year!==year||row.snapshotDate!==date)throw Errors.validation(`${label}第 ${row.rowNumber} 行期间 ${row.year}/${row.snapshotDate} 与转换批次 ${year}/${date} 不一致`);}
export async function createParallelTrial(db:DB,input:{conversionId:number;manualName:string;manual:Buffer;actor?:string}){
  const conversion=getConversion(db,input.conversionId);if(!['validated','imported'].includes(conversion.status)||!conversion.output_blob)throw Errors.conflict('只有校验通过或已导入的转换批次可并行比较');
  const [converted,manual]=await Promise.all([parseActualImport(conversion.output_blob,db),parseActualImport(input.manual,db)]);if(!converted.ok)throw Errors.importValidation('转换标准文件边界校验失败',converted.errors);if(!manual.ok)throw Errors.importValidation('原手工结果文件存在错误',manual.errors);assertPeriod(converted.rows,conversion.year,conversion.snapshot_date,'转换文件');assertPeriod(manual.rows,conversion.year,conversion.snapshot_date,'原手工结果');
  const convertedByKey=new Map(converted.rows.map(row=>[keyOf(row),row])),manualByKey=new Map(manual.rows.map(row=>[keyOf(row),row]));const differences:ParallelDifference[]=[];let matchedCount=0,netDifferenceCents=0,absoluteDifferenceCents=0;
  for(const [key,row] of convertedByKey){const convertedCents=centsOf(row),manualCents=centsOf(manualByKey.get(key)??{...row,amountText:'0'}),differenceCents=convertedCents-manualCents;differences.push({orgCode:row.orgCode,accountCode:row.accountCode,convertedCents,manualCents,differenceCents});if(differenceCents===0)matchedCount++;netDifferenceCents+=differenceCents;absoluteDifferenceCents+=Math.abs(differenceCents);}
  // 双向比较:手工文件独有的组合不能只计数——落在数据源拥有范围内的缺失组合是真实差异
  // (本应被转换覆盖却缺失,如拥有范围快照漂移);范围外才计入 ignoredOutsideScopeRows。
  const ownedScope=expandOwnedLeafScope(db,JSON.parse(conversion.profile_config_json||'{}') as FinanceProfileConfig);
  let ignoredOutsideScopeRows=0;
  for(const [key,row] of manualByKey){
    if(convertedByKey.has(key))continue;
    if(ownedScope.orgCodes.has(row.orgCode)&&ownedScope.accountCodes.has(row.accountCode)){
      const manualCents=centsOf(row),differenceCents=-manualCents;
      differences.push({orgCode:row.orgCode,accountCode:row.accountCode,convertedCents:0,manualCents,differenceCents});
      if(differenceCents===0)matchedCount++;
      netDifferenceCents+=differenceCents;absoluteDifferenceCents+=Math.abs(differenceCents);
    }else ignoredOutsideScopeRows++;
  }
  const comparison:ParallelComparison={year:conversion.year,snapshotDate:conversion.snapshot_date,totalCombinations:differences.length,matchedCount,mismatchCount:differences.length-matchedCount,netDifferenceCents,absoluteDifferenceCents,ignoredOutsideScopeRows,differences};const now=new Date().toISOString(),digest=sha(input.manual);const info=db.prepare(`INSERT INTO finance_parallel_trial(conversion_batch_id,status,manual_name,manual_sha256,manual_blob,comparison_json,created_by,created_at)VALUES(?,'compared',?,?,?,?,?,?)`).run(conversion.id,input.manualName.slice(0,255),digest,input.manual,JSON.stringify(comparison),input.actor??'',now);const id=Number(info.lastInsertRowid);writeLog(db,'finance.parallel_compare','finance_parallel_trial',id,{conversionId:conversion.id,manualSha256:digest,mismatchCount:comparison.mismatchCount,absoluteDifferenceCents});return publicParallelTrial(getParallelTrial(db,id));
}
export function saveExplanations(db:DB,id:number,items:ParallelExplanation[]){const row=getParallelTrial(db,id);if(row.status!=='compared')throw Errors.conflict('已复核的并行试运行不可修改差异说明');const comparison=JSON.parse(row.comparison_json) as ParallelComparison,mismatchKeys=new Set(comparison.differences.filter(d=>d.differenceCents!==0).map(d=>`${d.orgCode}|${d.accountCode}`)),seen=new Set<string>();const clean=items.map(item=>{const key=`${String(item.orgCode)}|${String(item.accountCode)}`;if(!mismatchKeys.has(key))throw Errors.validation(`差异组合不存在:${key}`);if(seen.has(key))throw Errors.validation(`差异说明重复:${key}`);seen.add(key);const reason=String(item.reason??'').trim(),resolution=String(item.resolution??'').trim();if(!reason||!resolution)throw Errors.validation(`差异 ${key} 必须填写原因和处理结论`);return{orgCode:String(item.orgCode),accountCode:String(item.accountCode),reason,resolution};});db.prepare('UPDATE finance_parallel_trial SET explanations_json=? WHERE id=?').run(JSON.stringify(clean),id);writeLog(db,'finance.parallel_explain','finance_parallel_trial',id,{count:clean.length});return publicParallelTrial(getParallelTrial(db,id));}
export function reviewParallelTrial(db:DB,id:number,reviewer=''){const row=getParallelTrial(db,id);if(row.status!=='compared')throw Errors.conflict('并行试运行已复核');const comparison=JSON.parse(row.comparison_json) as ParallelComparison,explanations=JSON.parse(row.explanations_json) as ParallelExplanation[];if(comparison.mismatchCount>0){const explained=new Set(explanations.map(e=>`${e.orgCode}|${e.accountCode}`));const missing=comparison.differences.filter(d=>d.differenceCents!==0&&!explained.has(`${d.orgCode}|${d.accountCode}`));if(missing.length)throw Errors.validation(`仍有 ${missing.length} 个差异未填写原因和处理结论`);}const status=comparison.mismatchCount===0?'passed':'explained',now=new Date().toISOString();db.prepare('UPDATE finance_parallel_trial SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(status,reviewer,now,id);writeLog(db,'finance.parallel_review','finance_parallel_trial',id,{status,mismatchCount:comparison.mismatchCount});return publicParallelTrial(getParallelTrial(db,id));}
export async function parallelTrialReport(db:DB,id:number):Promise<Buffer>{const row=getParallelTrial(db,id),comparison=JSON.parse(row.comparison_json) as ParallelComparison,explanations=JSON.parse(row.explanations_json) as ParallelExplanation[],explainByKey=new Map(explanations.map(e=>[`${e.orgCode}|${e.accountCode}`,e]));const wb=new ExcelJS.Workbook(),summary=wb.addWorksheet('并行试运行摘要');summary.addRows([['试运行ID',row.id],['转换批次ID',row.conversion_batch_id],['状态',row.status],['期间',comparison.snapshotDate],['组合数',comparison.totalCombinations],['差异数',comparison.mismatchCount],['差异绝对值(分)',comparison.absoluteDifferenceCents],['原手工文件SHA-256',row.manual_sha256],['复核人',row.reviewed_by??'']]);const detail=wb.addWorksheet('逐组合差异');detail.addRow(['组织编码','科目编码','转换数(分)','原手工数(分)','差异(分)','原因','处理结论']);for(const d of comparison.differences){const e=explainByKey.get(`${d.orgCode}|${d.accountCode}`);detail.addRow([d.orgCode,d.accountCode,d.convertedCents,d.manualCents,d.differenceCents,e?.reason??'',e?.resolution??'']);}return Buffer.from(await wb.xlsx.writeBuffer());}
