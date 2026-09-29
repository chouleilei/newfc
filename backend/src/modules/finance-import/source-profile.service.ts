import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import type { FinanceProfileConfig } from './finance.types';
import { writeLog } from '../audit/log';
import { expandOwnedLeafScope } from './owned-scope';
import crypto from 'crypto';

export interface SourceProfileRow { id:number; code:string; name:string; adapter_type:string; config_json:string; status:'active'|'inactive'; created_at:string; updated_at:string }
const ADAPTERS = new Set(['fixed_finance_system_v1']);

function stringArray(value: unknown, field: string, required = false): string[] | undefined {
  if (value === undefined) {
    if (required) throw Errors.validation(`${field} 必须是非空字符串数组`);
    return undefined;
  }
  if (!Array.isArray(value) || (required && value.length === 0)
    || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw Errors.validation(`${field} 必须是非空字符串数组`);
  }
  return value.map((item) => item.trim());
}

function aliasMap(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Errors.validation(`${field} 必须是别名数组对象`);
  for (const [key, aliases] of Object.entries(value)) {
    if (!key.trim()) throw Errors.validation(`${field} 不能包含空字段名`);
    stringArray(aliases, `${field}.${key}`, true);
  }
}

function config(db: DB, raw: unknown): FinanceProfileConfig {
  if (raw == null) throw Errors.validation('config 必须是 JSON 对象');
  let value: unknown;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw Errors.validation('config JSON 格式错误');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Errors.validation('config 必须是 JSON 对象');
  const cfg = { ...(value as FinanceProfileConfig) };
  if (cfg.balanceLayout && !['single_header', 'two_row_cumulative'].includes(cfg.balanceLayout)) throw Errors.validation('balanceLayout 不合法');
  if (cfg.balanceLayout === 'two_row_cumulative' && ![cfg.fixedBookCode, cfg.fixedOrgCode, cfg.fixedOrgName].every((v) => String(v ?? '').trim())) throw Errors.validation('双层余额表必须配置 fixedBookCode、fixedOrgCode、fixedOrgName');
  for (const field of ['balanceSheetNames', 'profitSheetNames', 'journalSheetNames', 'sourceAccountIncludePrefixes'] as const) {
    const normalized = stringArray(cfg[field], field);
    if (normalized) cfg[field] = normalized;
  }
  aliasMap(cfg.balanceColumns, 'balanceColumns');
  aliasMap(cfg.profitColumns, 'profitColumns');
  aliasMap(cfg.auxiliaryColumns, 'auxiliaryColumns');
  if (cfg.headerSearchRows !== undefined && (!Number.isInteger(cfg.headerSearchRows) || cfg.headerSearchRows < 1 || cfg.headerSearchRows > 200)) throw Errors.validation('headerSearchRows 必须在 1 到 200 之间');
  if (cfg.journalRequired !== undefined && typeof cfg.journalRequired !== 'boolean') throw Errors.validation('journalRequired 必须是布尔值');
  if (cfg.journalRequired && !String(cfg.journalCompanyName ?? cfg.fixedOrgName ?? '').trim()) throw Errors.validation('要求序时簿核验时必须配置 journalCompanyName 或 fixedOrgName');
  if (cfg.journalToleranceCents !== undefined && (!Number.isSafeInteger(cfg.journalToleranceCents) || cfg.journalToleranceCents < 0)) throw Errors.validation('journalToleranceCents 必须是非负安全整数分');
  if (cfg.maxRows !== undefined && (!Number.isInteger(cfg.maxRows) || cfg.maxRows < 1 || cfg.maxRows > 100000)) throw Errors.validation('maxRows 必须在 1 到 100000 之间');
  if (cfg.maxOutputBytes !== undefined && (!Number.isInteger(cfg.maxOutputBytes) || cfg.maxOutputBytes < 1024 || cfg.maxOutputBytes > 100 * 1024 * 1024)) throw Errors.validation('maxOutputBytes 必须在 1024 到 104857600 之间');
  if (cfg.amountUnit !== 'yuan' && cfg.amountUnit !== 'wan') throw Errors.validation('amountUnit 必须为 yuan 或 wan');

  const ownedOrgCodes = stringArray(cfg.ownedOrgCodes, 'ownedOrgCodes', true)!;
  const ownedAccountCodes = stringArray(cfg.ownedAccountCodes, 'ownedAccountCodes', true)!;
  const orgCodes = new Set((db.prepare('SELECT code FROM org').all() as { code: string }[]).map((row) => row.code));
  const accountCodes = new Set((db.prepare('SELECT code FROM account').all() as { code: string }[]).map((row) => row.code));
  const unknownOrgs = ownedOrgCodes.filter((code) => !orgCodes.has(code));
  const unknownAccounts = ownedAccountCodes.filter((code) => !accountCodes.has(code));
  if (unknownOrgs.length > 0) throw Errors.validation(`ownedOrgCodes 包含不存在的组织编码: ${unknownOrgs.join(', ')}`);
  if (unknownAccounts.length > 0) throw Errors.validation(`ownedAccountCodes 包含不存在的科目编码: ${unknownAccounts.join(', ')}`);
  cfg.ownedOrgCodes = ownedOrgCodes;
  cfg.ownedAccountCodes = ownedAccountCodes;
  return cfg;
}

/** 保存时即校验拥有范围重叠(与转换创建时 assertScopeNotOverlapping 同口径):
 *  两个 active 数据源范围相交会把双方的转换创建与手工导入一并 409 锁死,配置错误必须在保存时报出。 */
function assertOwnedScopeNotOverlapping(db: DB, ownConfigJson: string, excludeProfileId?: number): void {
  const ownScope = expandOwnedLeafScope(db, JSON.parse(ownConfigJson) as FinanceProfileConfig);
  const profiles = db.prepare("SELECT id, name, config_json FROM finance_source_profile WHERE status='active' AND id<>?").all(excludeProfileId ?? -1) as { id: number; name: string; config_json: string }[];
  for (const p of profiles) {
    const otherScope = expandOwnedLeafScope(db, JSON.parse(p.config_json || '{}') as FinanceProfileConfig);
    const orgOverlap = [...ownScope.orgIds].some((x) => otherScope.orgIds.has(x));
    const accountOverlap = [...ownScope.accountIds].some((x) => otherScope.accountIds.has(x));
    if (orgOverlap && accountOverlap) throw Errors.conflict(`数据源拥有范围与数据源「${p.name}」(#${p.id}) 重叠:同一组织×科目组合只能有一个财务数据源拥有`);
  }
}

export function listSourceProfiles(db: DB): SourceProfileRow[] { return db.prepare('SELECT * FROM finance_source_profile ORDER BY id DESC').all() as SourceProfileRow[]; }
export function getSourceProfile(db: DB, id: number): SourceProfileRow { const row=db.prepare('SELECT * FROM finance_source_profile WHERE id=?').get(id) as SourceProfileRow|undefined; if(!row) throw Errors.notFound('财务数据源'); return row; }
export function getSourceProfileByCode(db: DB, code: string): SourceProfileRow { const row=db.prepare('SELECT * FROM finance_source_profile WHERE code=?').get(code) as SourceProfileRow|undefined; if(!row) throw Errors.notFound('财务数据源'); return row; }
export function createSourceProfile(db: DB, input: {code:string;name:string;adapterType?:string;config?:unknown;status?:string}, actor=''): SourceProfileRow {
  const code=String(input.code??'').trim(); const name=String(input.name??'').trim(); const adapter=input.adapterType??'fixed_finance_system_v1';
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(code)||!name) throw Errors.validation('数据源编码或名称不合法'); if(!ADAPTERS.has(adapter)) throw Errors.validation('adapterType 不在后端白名单');
  const now=new Date().toISOString(); const configJson=JSON.stringify(config(db,input.config));
  if(input.status!=='inactive') assertOwnedScopeNotOverlapping(db,configJson);
  const id=db.transaction(()=>{const info=db.prepare(`INSERT INTO finance_source_profile(code,name,adapter_type,config_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(code,name,adapter,configJson,input.status==='inactive'?'inactive':'active',now,now);const createdId=Number(info.lastInsertRowid);writeLog(db,'finance.profile.create','finance_source_profile',createdId,{actor,code,adapter,configSha256:crypto.createHash('sha256').update(configJson).digest('hex')});return createdId;})(); return getSourceProfile(db,id);
}
export function updateSourceProfile(db: DB,id:number,input:{name?:string;config?:unknown;status?:string},actor=''):SourceProfileRow { const old=getSourceProfile(db,id); const status=input.status??old.status; if(!['active','inactive'].includes(status)) throw Errors.validation('status 不合法'); const nextConfig=JSON.stringify(input.config===undefined?config(db,old.config_json):config(db,input.config)); if(status==='active') assertOwnedScopeNotOverlapping(db,nextConfig,id); db.transaction(()=>{db.prepare('UPDATE finance_source_profile SET name=?,config_json=?,status=?,updated_at=? WHERE id=?').run(String(input.name??old.name).trim(),nextConfig,status,new Date().toISOString(),id);writeLog(db,'finance.profile.update','finance_source_profile',id,{actor,before:{name:old.name,status:old.status,configSha256:crypto.createHash('sha256').update(old.config_json).digest('hex')},after:{name:String(input.name??old.name).trim(),status,configSha256:crypto.createHash('sha256').update(nextConfig).digest('hex')}});})(); return getSourceProfile(db,id); }
