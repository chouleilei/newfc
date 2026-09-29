import ExcelJS from 'exceljs';
import type { DB } from '../../../db/connection';
import { AppError, Errors } from '../../../core/errors';
import { createOrReuseSnapshot, loadSnapshotNodes } from '../../tree/snapshot';
import { validateMappingVersion } from './mapping-validator';
import { snapshotMetricDefinitions } from './metric-snapshot';
import { writeLog } from '../../audit/log';
import { csvCell } from '../../../core/csv';
import { assertSafeXlsx } from '../../io/xlsx-guard';
import { MAX_IMPORT_ROWS } from '../../io/import-limits';

/** 映射行来源标记(AI 功能增强计划阶段二.3):手工 / 确定性建议 / AI 建议。 */
export type MappingRowOrigin = 'manual' | 'deterministic' | 'ai';
const ORIGINS = new Set<MappingRowOrigin>(['manual', 'deterministic', 'ai']);
function originOf(row: Record<string, unknown>): MappingRowOrigin {
  const value = String(row.origin ?? 'manual');
  if (!ORIGINS.has(value as MappingRowOrigin)) throw Errors.validation('origin 必须为 manual、deterministic 或 ai');
  return value as MappingRowOrigin;
}
/** 建议来源的行默认未复核,手工行默认已复核;调用方可显式覆盖。 */
function reviewedOf(row: Record<string, unknown>, origin: MappingRowOrigin): 0 | 1 {
  if (row.reviewed === undefined || row.reviewed === null) return origin === 'manual' ? 1 : 0;
  return row.reviewed ? 1 : 0;
}

/* ---------- provenance 的导入/导出往返(阶段二核心验收) ---------- */

/**
 * 导入/导出必须带 origin 与 reviewed:否则「导出再导入」会把 AI/确定性建议来源抹成手工,
 * 并把未复核行变成已复核行,等于绕过锁定前的未复核复核提醒(lockMappingVersion 的
 * UNREVIEWED_MAPPINGS 门禁)。这里用中文标签落表格,同时兼容枚举原文与旧文件的空列。
 */
const ORIGIN_LABEL: Record<MappingRowOrigin, string> = { manual: '手工', deterministic: '确定性建议', ai: 'AI 建议' };
const ORIGIN_BY_LABEL = new Map<string, MappingRowOrigin>([
  ['手工', 'manual'], ['确定性建议', 'deterministic'], ['AI 建议', 'ai'], ['AI建议', 'ai'],
  ['manual', 'manual'], ['deterministic', 'deterministic'], ['ai', 'ai'],
]);
export function originLabel(value: unknown): string {
  const origin = String(value ?? 'manual') as MappingRowOrigin;
  return ORIGIN_LABEL[origin] ?? ORIGIN_LABEL.manual;
}
/** 空单元格(旧版导出文件)返回 undefined,由 originOf 落回默认 manual。 */
function parseOriginCell(raw: string): MappingRowOrigin | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  const origin = ORIGIN_BY_LABEL.get(text) ?? ORIGIN_BY_LABEL.get(text.toLowerCase());
  if (!origin) throw Errors.validation(`来源“${text}”非法,必须为 手工、确定性建议 或 AI 建议`);
  return origin;
}
const REVIEWED_TRUE = new Set(['是', '已复核', '1', 'true', 'yes', 'y']);
const REVIEWED_FALSE = new Set(['否', '未复核', '0', 'false', 'no', 'n']);
/** 空单元格返回 undefined,由 reviewedOf 按来源落默认值。 */
function parseReviewedCell(raw: string): boolean | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  const lower = text.toLowerCase();
  if (REVIEWED_TRUE.has(lower)) return true;
  if (REVIEWED_FALSE.has(lower)) return false;
  throw Errors.validation(`已复核“${text}”非法,必须为 是 或 否`);
}

export interface MappingVersionRow { id:number;source_profile_id:number;version_no:number;name:string;status:'draft'|'locked'|'retired';org_tree_snapshot_id:number;account_tree_snapshot_id:number;parent_version_id:number|null;created_by:string;reviewed_by:string|null;created_at:string;locked_at:string|null }
export function getMappingVersion(db:DB,id:number):MappingVersionRow{const row=db.prepare('SELECT * FROM finance_mapping_version WHERE id=?').get(id) as MappingVersionRow|undefined;if(!row)throw Errors.notFound('映射版本');return row;}
export function listMappingVersions(db:DB,profileId?:number):MappingVersionRow[]{return db.prepare(`SELECT * FROM finance_mapping_version ${profileId?'WHERE source_profile_id=?':''} ORDER BY id DESC`).all(...(profileId?[profileId]:[])) as MappingVersionRow[];}
export function createMappingVersion(db:DB,input:{sourceProfileId:number;name:string;createdBy?:string}):MappingVersionRow{const profile=db.prepare("SELECT id FROM finance_source_profile WHERE id=? AND status='active'").get(input.sourceProfileId);if(!profile)throw Errors.validation('数据源不存在或已停用');const max=db.prepare('SELECT COALESCE(MAX(version_no),0) n FROM finance_mapping_version WHERE source_profile_id=?').get(input.sourceProfileId) as {n:number};const now=new Date().toISOString();const id=db.transaction(()=>{const info=db.prepare(`INSERT INTO finance_mapping_version(source_profile_id,version_no,name,org_tree_snapshot_id,account_tree_snapshot_id,created_by,created_at)VALUES(?,?,?,?,?,?,?)`).run(input.sourceProfileId,max.n+1,String(input.name||`V${max.n+1}`),createOrReuseSnapshot(db,'org'),createOrReuseSnapshot(db,'account'),input.createdBy??'',now);const createdId=Number(info.lastInsertRowid);writeLog(db,'finance.mapping.create','finance_mapping_version',createdId,{actor:input.createdBy??'',sourceProfileId:input.sourceProfileId,versionNo:max.n+1});return createdId;})();return getMappingVersion(db,id);}
function assertDraft(db:DB,id:number){if(getMappingVersion(db,id).status!=='draft')throw Errors.conflict('只有草稿映射版本可修改');}
export function cloneMappingVersion(db:DB,id:number,actor=''):MappingVersionRow{const old=getMappingVersion(db,id);return db.transaction(()=>{const next=createMappingVersion(db,{sourceProfileId:old.source_profile_id,name:`${old.name} - 副本`,createdBy:actor});for(const table of ['finance_org_mapping','finance_account_mapping','finance_reconciliation_rule'] as const){const columns=table==='finance_org_mapping'?'source_book_code,source_org_code,source_org_name,source_aux_json,target_org_id,priority,note,origin,reviewed':table==='finance_account_mapping'?'source_account_code,source_account_name,source_aux_json,target_account_id,amount_rule,allocation_method,allocation_weight,priority,status,note,origin,reviewed':'source_line_alias,target_type,target_code,org_scope_json,comparison,tolerance_cents,tolerance_reason,required';db.exec(`INSERT INTO ${table}(mapping_version_id,${columns}) SELECT ${next.id},${columns} FROM ${table} WHERE mapping_version_id=${old.id}`);}db.prepare('UPDATE finance_mapping_version SET parent_version_id=? WHERE id=?').run(id,next.id);writeLog(db,'finance.mapping.clone','finance_mapping_version',next.id,{actor,parentVersionId:id});return getMappingVersion(db,next.id);})();}
/** 草稿中未复核的建议来源行数(组织 + 科目)。 */
export function countUnreviewedMappings(db:DB,id:number):number{
  const org=(db.prepare('SELECT COUNT(*) c FROM finance_org_mapping WHERE mapping_version_id=? AND reviewed=0').get(id) as {c:number}).c;
  const acc=(db.prepare('SELECT COUNT(*) c FROM finance_account_mapping WHERE mapping_version_id=? AND reviewed=0').get(id) as {c:number}).c;
  return org+acc;
}
/**
 * 锁定映射版本:结构校验不变;含未复核建议行时不新增阻断规则,
 * 但要求调用方显式确认(confirmUnreviewed),否则以 UNREVIEWED_MAPPINGS 409 拒绝。
 */
export function lockMappingVersion(db:DB,id:number,reviewedBy='',options:{confirmUnreviewed?:boolean}={}):MappingVersionRow{return db.transaction(()=>{assertDraft(db,id);const report=validateMappingVersion(db,id);if(!report.passed)throw Errors.validation(report.errors.map(e=>e.message).join('; '));const unreviewed=countUnreviewedMappings(db,id);if(unreviewed>0&&!options.confirmUnreviewed)throw new AppError('UNREVIEWED_MAPPINGS',`映射含 ${unreviewed} 行未复核的建议来源行,锁定前需逐行复核或显式确认`,409,undefined,{unreviewed});snapshotMetricDefinitions(db,id);db.prepare("UPDATE finance_mapping_version SET status='locked',reviewed_by=?,locked_at=? WHERE id=?").run(reviewedBy,new Date().toISOString(),id);writeLog(db,'finance.mapping.lock','finance_mapping_version',id,{actor:reviewedBy,unreviewedConfirmed:unreviewed});return getMappingVersion(db,id);})();}
export function retireMappingVersion(db:DB,id:number,actor=''):MappingVersionRow{const v=getMappingVersion(db,id);if(v.status!=='locked')throw Errors.conflict('只有已锁定版本可停用');db.transaction(()=>{db.prepare("UPDATE finance_mapping_version SET status='retired' WHERE id=?").run(id);writeLog(db,'finance.mapping.retire','finance_mapping_version',id,{actor});})();return getMappingVersion(db,id);}
export function listOrgMappings(db:DB,id:number){const version=getMappingVersion(db,id);const snapshot=new Map(loadSnapshotNodes(db,version.org_tree_snapshot_id).map(node=>[node.id,node]));const current=new Map((db.prepare('SELECT id,code,name FROM org').all() as {id:number;code:string;name:string}[]).map(node=>[node.id,node]));const rows=db.prepare('SELECT m.* FROM finance_org_mapping m WHERE mapping_version_id=? ORDER BY priority DESC,id').all(id) as any[];return rows.map(row=>({...row,target_org_code:snapshot.get(row.target_org_id)?.code??null,target_org_name:snapshot.get(row.target_org_id)?.name??null,current_target_org_code:current.get(row.target_org_id)?.code??null,current_target_org_name:current.get(row.target_org_id)?.name??null}));}
/** HTTP 传入的 rows 可以是任意 JSON:进入删除/插入事务前必须先证明是对象数组。 */
function assertRowArray(rows:unknown,name:string):Record<string,unknown>[]{
  if(!Array.isArray(rows))throw Errors.validation(`${name} 必须是数组`);
  if(rows.some((row)=>row===null||typeof row!=='object'||Array.isArray(row)))throw Errors.validation(`${name} 的每一项必须是对象`);
  return rows as Record<string,unknown>[];
}
export function replaceOrgMappings(db:DB,id:number,rows:Record<string,unknown>[],actor=''){assertDraft(db,id);const items=assertRowArray(rows,'组织映射');db.transaction(()=>{db.prepare('DELETE FROM finance_org_mapping WHERE mapping_version_id=?').run(id);const stmt=db.prepare(`INSERT INTO finance_org_mapping(mapping_version_id,source_book_code,source_org_code,source_org_name,source_aux_json,target_org_id,priority,note,origin,reviewed)VALUES(?,?,?,?,?,?,?,?,?,?)`);for(const r of items){const origin=originOf(r);stmt.run(id,String(r.sourceBookCode??''),String(r.sourceOrgCode??''),String(r.sourceOrgName??''),JSON.stringify(r.sourceAux??{}),Number(r.targetOrgId),Number(r.priority??0),String(r.note??''),origin,reviewedOf(r,origin));}writeLog(db,'finance.mapping.replace_org','finance_mapping_version',id,{actor,count:items.length});})();return listOrgMappings(db,id);}
export function listAccountMappings(db:DB,id:number){const version=getMappingVersion(db,id);const snapshot=new Map(loadSnapshotNodes(db,version.account_tree_snapshot_id).map(node=>[node.id,node]));const current=new Map((db.prepare('SELECT id,code,name,type FROM account').all() as {id:number;code:string;name:string;type:string}[]).map(node=>[node.id,node]));const rows=db.prepare('SELECT m.* FROM finance_account_mapping m WHERE mapping_version_id=? ORDER BY priority DESC,id').all(id) as any[];return rows.map(row=>({...row,target_account_code:snapshot.get(row.target_account_id)?.code??null,target_account_name:snapshot.get(row.target_account_id)?.name??null,target_account_type:snapshot.get(row.target_account_id)?.type??null,current_target_account_code:current.get(row.target_account_id)?.code??null,current_target_account_name:current.get(row.target_account_id)?.name??null,current_target_account_type:current.get(row.target_account_id)?.type??null}));}
export function replaceAccountMappings(db:DB,id:number,rows:Record<string,unknown>[],actor=''){assertDraft(db,id);const items=assertRowArray(rows,'科目映射');db.transaction(()=>{db.prepare('DELETE FROM finance_account_mapping WHERE mapping_version_id=?').run(id);const stmt=db.prepare(`INSERT INTO finance_account_mapping(mapping_version_id,source_account_code,source_account_name,source_aux_json,target_account_id,amount_rule,allocation_method,allocation_weight,priority,status,note,origin,reviewed)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);for(const r of items){const origin=originOf(r);stmt.run(id,String(r.sourceAccountCode??''),String(r.sourceAccountName??''),JSON.stringify(r.sourceAux??{}),Number(r.targetAccountId),String(r.amountRule??'debit_minus_credit'),String(r.allocationMethod??'direct'),Number(r.allocationWeight??1000000),Number(r.priority??0),r.status==='inactive'?'inactive':'active',String(r.note??''),origin,reviewedOf(r,origin));}writeLog(db,'finance.mapping.replace_account','finance_mapping_version',id,{actor,count:items.length});})();return listAccountMappings(db,id);}
export function listReconciliationRules(db:DB,id:number){getMappingVersion(db,id);return db.prepare('SELECT * FROM finance_reconciliation_rule WHERE mapping_version_id=? ORDER BY id').all(id);}
export function replaceReconciliationRules(db:DB,id:number,rows:Record<string,unknown>[],actor=''){assertDraft(db,id);const items=assertRowArray(rows,'勾稽规则');db.transaction(()=>{db.prepare('DELETE FROM finance_reconciliation_rule WHERE mapping_version_id=?').run(id);const stmt=db.prepare(`INSERT INTO finance_reconciliation_rule(mapping_version_id,source_line_alias,target_type,target_code,org_scope_json,comparison,tolerance_cents,tolerance_reason,required)VALUES(?,?,?,?,?,'equal',?,?,?)`);for(const r of items)stmt.run(id,String(r.sourceLineAlias),r.targetType==='metric'?'metric':'account',String(r.targetCode),JSON.stringify(r.orgScope??[]),Number(r.toleranceCents??0),String(r.toleranceReason??''),r.required===false?0:1);writeLog(db,'finance.mapping.replace_reconciliation','finance_mapping_version',id,{actor,count:items.length});})();return listReconciliationRules(db,id);}

export async function exportMappings(db:DB,id:number):Promise<Buffer>{const v=getMappingVersion(db,id);const wb=new ExcelJS.Workbook();const meta=wb.addWorksheet('元数据');meta.addRows([['映射版本ID',v.id],['状态',v.status],['版本号',v.version_no],['名称口径','映射版本绑定树快照']]);const org=wb.addWorksheet('组织映射');org.addRow(['源账套','源组织编码','源组织名称','辅助条件JSON','目标组织编码','优先级','依据','来源','已复核','目标组织快照名称']);for(const r of listOrgMappings(db,id) as any[])org.addRow([r.source_book_code,r.source_org_code,r.source_org_name,r.source_aux_json,r.target_org_code,r.priority,r.note,originLabel(r.origin),r.reviewed?'是':'否',r.target_org_name]);const acc=wb.addWorksheet('科目映射');acc.addRow(['源科目编码','源科目名称','辅助条件JSON','目标科目编码','金额规则','分配方式','权重','优先级','状态','依据','来源','已复核','目标科目快照名称']);for(const r of listAccountMappings(db,id) as any[])acc.addRow([r.source_account_code,r.source_account_name,r.source_aux_json,r.target_account_code,r.amount_rule,r.allocation_method,r.allocation_weight,r.priority,r.status,r.note,originLabel(r.origin),r.reviewed?'是':'否',r.target_account_name]);const rec=wb.addWorksheet('利润表勾稽');rec.addRow(['官方项目','目标类型','目标编码','组织范围JSON','容差分','容差原因','必填']);for(const r of listReconciliationRules(db,id) as any[])rec.addRow([r.source_line_alias,r.target_type,r.target_code,r.org_scope_json,r.tolerance_cents,r.tolerance_reason,r.required]);return Buffer.from(await wb.xlsx.writeBuffer());}

function parseJsonCell(
  raw: string,
  row: number,
  field: string,
  kind: 'object' | 'array',
): Record<string, unknown> | string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw || (kind === 'array' ? '[]' : '{}'));
  } catch {
    throw Errors.validation(`第 ${row} 行“${field}”JSON 格式错误`, [
      { row, field, message: '必须是合法 JSON' },
    ]);
  }
  const valid = kind === 'array'
    ? Array.isArray(value) && value.every((item) => typeof item === 'string')
    : value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!valid) {
    throw Errors.validation(`第 ${row} 行“${field}”类型错误`, [
      { row, field, message: kind === 'array' ? '必须是字符串数组 JSON' : '必须是对象 JSON' },
    ]);
  }
  return value as Record<string, unknown> | string[];
}

export async function importMappings(db:DB,id:number,buffer:Buffer){assertDraft(db,id);await assertSafeXlsx(buffer,MAX_IMPORT_ROWS,3);const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);const value=(r:ExcelJS.Row,n:number)=>String(r.getCell(n).value??'').trim();const orgSheet=wb.getWorksheet('组织映射'),accSheet=wb.getWorksheet('科目映射'),recSheet=wb.getWorksheet('利润表勾稽');if(!orgSheet||!accSheet||!recSheet)throw Errors.validation('映射文件缺少组织映射、科目映射或利润表勾稽工作表');const orgByCode=new Map((db.prepare('SELECT id,code FROM org').all() as any[]).map(r=>[r.code,r.id])),accByCode=new Map((db.prepare('SELECT id,code FROM account').all() as any[]).map(r=>[r.code,r.id]));const orgRows:any[]=[];orgSheet.eachRow((r,n)=>{if(n>1&&value(r,5)){const target=orgByCode.get(value(r,5));if(!target)throw Errors.validation(`未知目标组织编码:${value(r,5)}`);orgRows.push({sourceBookCode:value(r,1),sourceOrgCode:value(r,2),sourceOrgName:value(r,3),sourceAux:parseJsonCell(value(r,4),n,'辅助条件JSON','object'),targetOrgId:target,priority:Number(value(r,6)||0),note:value(r,7),origin:parseOriginCell(value(r,8)),reviewed:parseReviewedCell(value(r,9))});}});const accRows:any[]=[];accSheet.eachRow((r,n)=>{if(n>1&&value(r,4)){const target=accByCode.get(value(r,4));if(!target)throw Errors.validation(`未知目标科目编码:${value(r,4)}`);accRows.push({sourceAccountCode:value(r,1),sourceAccountName:value(r,2),sourceAux:parseJsonCell(value(r,3),n,'辅助条件JSON','object'),targetAccountId:target,amountRule:value(r,5),allocationMethod:value(r,6),allocationWeight:Number(value(r,7)),priority:Number(value(r,8)),status:value(r,9),note:value(r,10),origin:parseOriginCell(value(r,11)),reviewed:parseReviewedCell(value(r,12))});}});const recRows:any[]=[];recSheet.eachRow((r,n)=>{if(n>1&&value(r,1))recRows.push({sourceLineAlias:value(r,1),targetType:value(r,2),targetCode:value(r,3),orgScope:parseJsonCell(value(r,4),n,'组织范围JSON','array'),toleranceCents:Number(value(r,5)||0),toleranceReason:value(r,6),required:!['否','false','0'].includes(value(r,7))});});db.transaction(()=>{replaceOrgMappings(db,id,orgRows);replaceAccountMappings(db,id,accRows);replaceReconciliationRules(db,id,recRows);})();return {orgCount:orgRows.length,accountCount:accRows.length,reconciliationCount:recRows.length,unreviewedCount:countUnreviewedMappings(db,id)};}

function parseCsv(buffer:Buffer):string[][]{const text=buffer.toString('utf8').replace(/^\uFEFF/,'');const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const char=text[i];if(quoted){if(char==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(char==='"')quoted=false;else cell+=char;}else if(char==='"')quoted=true;else if(char===','){row.push(cell);cell='';}else if(char==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=char;}if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}if(quoted)throw Errors.validation('CSV 引号未闭合');return rows;}
export function exportMappingsCsv(db:DB,id:number,sheet:'org'|'account'|'reconciliation'):Buffer{let rows:unknown[][];if(sheet==='org')rows=[['源账套','源组织编码','源组织名称','辅助条件JSON','目标组织编码','优先级','依据','来源','已复核'],...(listOrgMappings(db,id) as any[]).map(r=>[r.source_book_code,r.source_org_code,r.source_org_name,r.source_aux_json,r.target_org_code,r.priority,r.note,originLabel(r.origin),r.reviewed?'是':'否'])];else if(sheet==='account')rows=[['源科目编码','源科目名称','辅助条件JSON','目标科目编码','金额规则','分配方式','权重','优先级','状态','依据','来源','已复核'],...(listAccountMappings(db,id) as any[]).map(r=>[r.source_account_code,r.source_account_name,r.source_aux_json,r.target_account_code,r.amount_rule,r.allocation_method,r.allocation_weight,r.priority,r.status,r.note,originLabel(r.origin),r.reviewed?'是':'否'])];else rows=[['官方项目','目标类型','目标编码','组织范围JSON','容差分','容差原因','必填'],...(listReconciliationRules(db,id) as any[]).map(r=>[r.source_line_alias,r.target_type,r.target_code,r.org_scope_json,r.tolerance_cents,r.tolerance_reason,r.required])];return Buffer.from('\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),'utf8');}
export function importMappingsCsv(db:DB,id:number,sheet:'org'|'account'|'reconciliation',buffer:Buffer){assertDraft(db,id);const rows=parseCsv(buffer).map((cells,index)=>({cells,row:index+1})).slice(1).filter(({cells})=>cells.some(Boolean));if(sheet==='org'){const targets=new Map((db.prepare('SELECT code,id FROM org').all() as any[]).map(r=>[r.code,r.id]));return replaceOrgMappings(db,id,rows.map(({cells:r,row})=>{const target=targets.get(r[4]);if(!target)throw Errors.validation(`未知目标组织编码:${r[4]}`);return{sourceBookCode:r[0],sourceOrgCode:r[1],sourceOrgName:r[2],sourceAux:parseJsonCell(r[3],row,'辅助条件JSON','object'),targetOrgId:target,priority:Number(r[5]||0),note:r[6],origin:parseOriginCell(r[7]),reviewed:parseReviewedCell(r[8])};}));}if(sheet==='account'){const targets=new Map((db.prepare('SELECT code,id FROM account').all() as any[]).map(r=>[r.code,r.id]));return replaceAccountMappings(db,id,rows.map(({cells:r,row})=>{const target=targets.get(r[3]);if(!target)throw Errors.validation(`未知目标科目编码:${r[3]}`);return{sourceAccountCode:r[0],sourceAccountName:r[1],sourceAux:parseJsonCell(r[2],row,'辅助条件JSON','object'),targetAccountId:target,amountRule:r[4],allocationMethod:r[5],allocationWeight:Number(r[6]),priority:Number(r[7]),status:r[8],note:r[9],origin:parseOriginCell(r[10]),reviewed:parseReviewedCell(r[11])};}));}return replaceReconciliationRules(db,id,rows.map(({cells:r,row})=>({sourceLineAlias:r[0],targetType:r[1],targetCode:r[2],orgScope:parseJsonCell(r[3],row,'组织范围JSON','array'),toleranceCents:Number(r[4]||0),toleranceReason:r[5],required:!['否','false','0'].includes(r[6])})));}
