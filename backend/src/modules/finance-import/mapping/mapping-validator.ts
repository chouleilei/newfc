import type { DB } from '../../../db/connection';
import { loadSnapshotNodes } from '../../tree/snapshot';
import { FINANCE_WEIGHT_SCALE, type ValidationIssue } from '../finance.types';
import { isAccountVisibleForScope } from '../../../core/accountScope';

/** aux JSON 规范化:key 排序序列化,消除空白差异;非法 JSON 已在上游逐行报错,这里按空对象处理 */
function normalizeAux(raw:string):{canonical:string;obj:Record<string,unknown>}{
  let obj:Record<string,unknown>={};
  try{const parsed=JSON.parse(raw||'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))obj=parsed as Record<string,unknown>;}catch{/* 非法 JSON 已由 ORG_SOURCE_AUX_INVALID 报告 */}
  return{canonical:JSON.stringify(Object.fromEntries(Object.entries(obj).sort(([a],[b])=>a.localeCompare(b)))),obj};
}
/** 文本条件兼容(运行时子集匹配语义):双方相等,或任一方为空(空=通配,可匹配对方具体值) */
function textCompatible(a:string,b:string):boolean{return!a||!b||a===b;}
/** aux 条件兼容:共同键的值必须一致(不一致的键使两行条件互斥,不可能同时命中) */
function auxCompatible(a:Record<string,unknown>,b:Record<string,unknown>):boolean{
  for(const k of Object.keys(a))if(k in b&&String(a[k])!==String(b[k]))return false;
  return true;
}
interface Version {id:number;source_profile_id:number;org_tree_snapshot_id:number;account_tree_snapshot_id:number;status:string}
export function validateMappingVersion(db:DB,versionId:number):{passed:boolean;errors:ValidationIssue[]} {
  const v=db.prepare('SELECT * FROM finance_mapping_version WHERE id=?').get(versionId) as Version|undefined; if(!v) return {passed:false,errors:[{gate:'mapping',code:'VERSION_NOT_FOUND',message:'映射版本不存在'}]};
  const errors:ValidationIssue[]=[]; const orgs=loadSnapshotNodes(db,v.org_tree_snapshot_id), accs=loadSnapshotNodes(db,v.account_tree_snapshot_id); const orgChildren=new Set(orgs.map(n=>n.parent_id).filter((x):x is number=>x!=null)), accChildren=new Set(accs.map(n=>n.parent_id).filter((x):x is number=>x!=null)); const orgById=new Map(orgs.map(n=>[n.id,n])),accById=new Map(accs.map(n=>[n.id,n]));
  const profile=db.prepare('SELECT config_json FROM finance_source_profile WHERE id=?').get(v.source_profile_id) as {config_json:string}|undefined;
  let sourcePrefixes:string[]=[];try{const cfg=JSON.parse(profile?.config_json||'{}') as {sourceAccountIncludePrefixes?:unknown};if(Array.isArray(cfg.sourceAccountIncludePrefixes))sourcePrefixes=cfg.sourceAccountIncludePrefixes.map(String).filter(Boolean);}catch{errors.push({gate:'mapping',code:'PROFILE_CONFIG_INVALID',message:'数据源配置 JSON 无法解析'});}
  const om=db.prepare('SELECT * FROM finance_org_mapping WHERE mapping_version_id=?').all(versionId) as any[]; const am=(db.prepare('SELECT * FROM finance_account_mapping WHERE mapping_version_id=?').all(versionId) as any[]).filter(r=>r.status==='active');
  const rr=db.prepare('SELECT * FROM finance_reconciliation_rule WHERE mapping_version_id=?').all(versionId) as any[];
  if(!om.length) errors.push({gate:'mapping',code:'NO_ORG_RULES',message:'至少需要一条组织映射'}); if(!am.length) errors.push({gate:'mapping',code:'NO_ACCOUNT_RULES',message:'至少需要一条科目映射'});
  if(!rr.length) errors.push({gate:'mapping',code:'NO_RECONCILIATION_RULES',message:'至少需要一条官方利润表勾稽规则'});
  // 勾稽门强度兜底:全部 optional 时,利润表为空/缺行不产生任何错误,勾稽门整体架空
  if(rr.length&&!rr.some((r)=>r.required===1)) errors.push({gate:'mapping',code:'RECONCILIATION_ALL_OPTIONAL',message:'至少需要一条 required=1 的勾稽规则,否则利润表缺失/为空时勾稽门不产生任何阻断'});
  for(const r of om){const n=orgById.get(r.target_org_id);if(!n||n.status!=='active'||orgChildren.has(r.target_org_id))errors.push({gate:'mapping',code:'INVALID_TARGET_ORG',message:`组织映射 #${r.id} 目标不是快照内有效叶子`});let aux:unknown={};try{aux=JSON.parse(r.source_aux_json||'{}');}catch{errors.push({gate:'mapping',code:'ORG_SOURCE_AUX_INVALID',message:`组织映射 #${r.id} 的辅助条件不是合法 JSON`});}const hasAux=Boolean(aux&&typeof aux==='object'&&!Array.isArray(aux)&&Object.keys(aux as object).length);if(!String(r.source_book_code||'').trim()&&!String(r.source_org_code||'').trim()&&!String(r.source_org_name||'').trim()&&!hasAux)errors.push({gate:'mapping',code:'ORG_SOURCE_REQUIRED',message:`组织映射 #${r.id} 至少填写一个源账套、源组织编码、源组织名称或辅助条件`});}
  for(const r of am){const n=accById.get(r.target_account_id);if(!n||n.status!=='active'||accChildren.has(r.target_account_id)||n.type==='quantity')errors.push({gate:'mapping',code:'INVALID_TARGET_ACCOUNT',message:`科目映射 #${r.id} 目标不是有效金额叶子`});const sourceCode=String(r.source_account_code||'').trim();if(!sourceCode)errors.push({gate:'mapping',code:'ACCOUNT_SOURCE_REQUIRED',message:`科目映射 #${r.id} 必须填写源科目编码`});if(sourcePrefixes.length&&!sourcePrefixes.some(prefix=>sourceCode.startsWith(prefix)))errors.push({gate:'mapping',code:'ACCOUNT_OUTSIDE_SOURCE_SCOPE',message:`源科目 ${sourceCode} 不在数据源 sourceAccountIncludePrefixes 范围内`});if(n){const creditDirection=r.amount_rule==='credit'||r.amount_rule==='credit_minus_debit';const debitDirection=r.amount_rule==='debit'||r.amount_rule==='debit_minus_credit';if(n.type==='income'&&!creditDirection)errors.push({gate:'mapping',code:'AMOUNT_DIRECTION_MISMATCH',message:`收入科目 ${n.code} 应使用贷方或贷减借方向`});if((n.type==='cost'||n.type==='expense')&&!debitDirection)errors.push({gate:'mapping',code:'AMOUNT_DIRECTION_MISMATCH',message:`成本费用科目 ${n.code} 应使用借方或借减贷方向`});}}
  // 组织规则唯一性:与运行时 matchOrg 同语义(空条件=通配、aux 子集匹配)。
  // 同优先级且各维度互相兼容的规则可同时命中同一行,运行时必报"同优先级多重命中"——文本 key 查重挡不住子集重叠。
  for(let i=0;i<om.length;i++)for(let j=i+1;j<om.length;j++){
    const a=om[i],b=om[j];
    if(a.priority!==b.priority)continue;
    if(!textCompatible(String(a.source_book_code||''),String(b.source_book_code||'')))continue;
    if(!textCompatible(String(a.source_org_code||''),String(b.source_org_code||'')))continue;
    if(!textCompatible(String(a.source_org_name||''),String(b.source_org_name||'')))continue;
    if(!auxCompatible(normalizeAux(a.source_aux_json).obj,normalizeAux(b.source_aux_json).obj))continue;
    errors.push({gate:'mapping',code:'ORG_CONFLICT',message:`组织规则 #${a.id} 与 #${b.id} 同优先级冲突:条件互相兼容,运行时可能同时命中同一行`});
  }
  // 科目规则:运行时 matchAccounts 要求同优先级命中集合的 (名称,辅助条件) 完全一致,
  // 因此同 code 同优先级下"条件兼容但归一化条件不同"的规则对必须在锁定时拦截(如 name='' 与 name='材料费')。
  const accBuckets=new Map<string,any[]>();
  for(const r of am){const k=`${r.source_account_code}|${r.priority}`;accBuckets.set(k,[...(accBuckets.get(k)??[]),r]);}
  for(const bucket of accBuckets.values()){
    for(let i=0;i<bucket.length;i++)for(let j=i+1;j<bucket.length;j++){
      const a=bucket[i],b=bucket[j];
      const nameA=String(a.source_account_name||''),nameB=String(b.source_account_name||'');
      const auxA=normalizeAux(a.source_aux_json),auxB=normalizeAux(b.source_aux_json);
      if(nameA===nameB&&auxA.canonical===auxB.canonical)continue;
      if(textCompatible(nameA,nameB)&&auxCompatible(auxA.obj,auxB.obj)){
        errors.push({gate:'mapping',code:'ACCOUNT_CONFLICT',message:`科目 ${a.source_account_code} 规则 #${a.id} 与 #${b.id} 同优先级、条件兼容但名称/辅助条件不同,运行时必报多重条件命中`});
      }
    }
  }
  // 归一化 (编码,名称,aux,优先级) 分组:组内 direction/method 必须一致,一对多必须 fixed_ratio,权重和守恒
  const groups=new Map<string,any[]>();for(const r of am){const k=[r.source_account_code,String(r.source_account_name||''),normalizeAux(r.source_aux_json).canonical,r.priority].join('|');groups.set(k,[...(groups.get(k)??[]),r]);}
  for(const rows of groups.values()){
    if(rows.length>1&&(rows.some(r=>r.allocation_method!=='fixed_ratio')||new Set(rows.map(r=>r.amount_rule)).size>1))errors.push({gate:'mapping',code:'ACCOUNT_CONFLICT',message:`科目 ${rows[0].source_account_code} 规则冲突`});
    else if(rows.reduce((s,r)=>s+r.allocation_weight,0)!==FINANCE_WEIGHT_SCALE)errors.push({gate:'mapping',code:'WEIGHT_SUM',message:`科目 ${rows[0].source_account_code} 拆分权重不守恒`});
    const targetTypes = new Set(rows.map((r) => accById.get(r.target_account_id)?.type).filter(Boolean));
    if (targetTypes.size > 1) errors.push({gate:'mapping',code:'ALLOCATION_CATEGORY_CONFLICT',message:`科目 ${rows[0].source_account_code} 不得跨收入/成本/费用类别拆分`});
  }
  for(const accountRule of am){const accountNode=accById.get(accountRule.target_account_id);if(!accountNode)continue;for(const orgRule of om){const orgNode=orgById.get(orgRule.target_org_id);if(orgNode&&!isAccountVisibleForScope(accountNode.code,new Set([orgNode.code])))errors.push({gate:'mapping',code:'ACCOUNT_NOT_APPLICABLE',message:`目标科目 ${accountNode.code} 不适用于组织 ${orgNode.code}`});}}
  const aliases=new Set<string>();for(const r of rr){if(aliases.has(r.source_line_alias))errors.push({gate:'mapping',code:'RECONCILIATION_CONFLICT',message:`官方项目 ${r.source_line_alias} 重复`});aliases.add(r.source_line_alias);if(r.tolerance_cents>0&&!r.tolerance_reason)errors.push({gate:'mapping',code:'TOLERANCE_REASON_REQUIRED',message:`官方项目 ${r.source_line_alias} 配置容差时必须记录原因`});if(r.target_type==='account'&&!accs.some(a=>a.code===r.target_code))errors.push({gate:'mapping',code:'RECONCILIATION_TARGET_INVALID',message:`勾稽目标科目不存在:${r.target_code}`});if(r.target_type==='metric'&&!db.prepare("SELECT 1 FROM report_metric WHERE code=? AND kind='linear'").get(r.target_code))errors.push({gate:'mapping',code:'RECONCILIATION_TARGET_INVALID',message:`勾稽目标指标不存在或不是金额型指标(比率指标不能用于利润表勾稽):${r.target_code}`});}
  return {passed:errors.length===0,errors};
}
