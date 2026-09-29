/**
 * 业务设置(AC-F23):类型化登记表 + app_setting 键值存储。
 *
 * - 只接受登记过的键;未知键(含 Dify/DB-GPT 等旧平台设置)一律 422,不静默落库。
 * - 整批校验后在一个短事务内写入,任一项不合法则全部不写。
 * - 凭据类(secret)只写不读:读取只返回“是否已配置 + 末 4 位预览”,审计只记键名。
 * - 各领域随阶段往登记表追加自己的键(逐域扩展),读取方用 getSetting 取类型化值与默认值。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { writeLog } from '../audit/log';

type SettingType = 'string' | 'int' | 'bool' | 'enum' | 'url' | 'secret';

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  type: SettingType;
  default: string | number | boolean | null;
  description?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: { value: string; label: string }[];
}

export const BUSINESS_SETTINGS: readonly SettingDef[] = [
  { key: 'report.company_name', label: '报表单位名称', group: '报表', type: 'string', default: '', maxLength: 100, description: '报表抬头与导出文件中的单位名称' },
  { key: 'report.preparer_title', label: '编制人落款', group: '报表', type: 'string', default: '', maxLength: 50 },
  { key: 'finance.fiscal_year_start_month', label: '会计年度起始月', group: '财务', type: 'int', default: 1, min: 1, max: 12 },
  {
    key: 'display.amount_unit', label: '默认金额单位', group: '显示', type: 'enum', default: 'yuan',
    options: [{ value: 'yuan', label: '元' }, { value: 'wan_yuan', label: '万元' }],
  },
  { key: 'display.amount_decimals', label: '默认金额小数位', group: '显示', type: 'int', default: 2, min: 0, max: 4 },
  { key: 'jobs.retention_days', label: '任务记录保留天数', group: '任务', type: 'int', default: 90, min: 7, max: 3650, description: '服务启动时清理超期的已结束任务及其步骤' },
  { key: 'integration.ocr_base_url', label: 'OCR 服务地址', group: '集成', type: 'url', default: '', maxLength: 300 },
  { key: 'integration.ocr_api_key', label: 'OCR 服务密钥', group: '集成', type: 'secret', default: null, maxLength: 500 },
];

const DEFS = new Map(BUSINESS_SETTINGS.map((d) => [d.key, d]));

export interface PublicSetting {
  key: string; label: string; group: string; type: SettingType; description?: string;
  min?: number; max?: number; maxLength?: number; options?: { value: string; label: string }[];
  /** secret 类型恒为 null */
  value: string | number | boolean | null;
  defaultValue: string | number | boolean | null;
  isDefault: boolean;
  /** 仅 secret:是否已配置与末 4 位预览 */
  configured?: boolean;
  preview?: string | null;
  updatedAt: string | null;
}

function preview(secret: string): string {
  return secret.length <= 4 ? '****' : `****${secret.slice(-4)}`;
}

function validate(def: SettingDef, raw: unknown): string | number | boolean | null {
  const fail = (msg: string) => new AppError('VALIDATION_FAILED', `${def.label}:${msg}`, 400, [{ row: 0, field: def.key, message: msg }]);
  if (raw === null) {
    if (def.type === 'secret' || def.type === 'url' || def.type === 'string') return null; // 清空 → 回默认
    throw fail('不能为空');
  }
  switch (def.type) {
    case 'int': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(n)) throw fail('必须是整数');
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) throw fail(`取值范围 ${def.min}～${def.max}`);
      return n;
    }
    case 'bool':
      if (typeof raw !== 'boolean') throw fail('必须是布尔值');
      return raw;
    case 'enum':
      if (typeof raw !== 'string' || !def.options?.some((o) => o.value === raw)) throw fail(`只能是 ${def.options?.map((o) => o.value).join('/')}`);
      return raw;
    case 'string':
    case 'secret':
    case 'url': {
      if (typeof raw !== 'string') throw fail('必须是字符串');
      const v = raw.trim();
      if (def.maxLength && v.length > def.maxLength) throw fail(`不能超过 ${def.maxLength} 个字符`);
      if (/[\u0000-\u001f]/.test(v)) throw fail('不能包含控制字符');
      if (def.type === 'url' && v) {
        let u: URL;
        try { u = new URL(v); } catch { throw fail('地址格式不正确'); }
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw fail('只允许 https,或本机 http');
        if (u.username || u.password) throw fail('地址中不能包含账号口令');
      }
      return v === '' ? null : v;
    }
  }
}

interface StoredRow { key: string; value_json: string; updated_at: string }

function stored(db: DB): Map<string, StoredRow> {
  return new Map((db.prepare('SELECT key, value_json, updated_at FROM app_setting').all() as StoredRow[]).map((r) => [r.key, r]));
}

function toPublic(def: SettingDef, row: StoredRow | undefined): PublicSetting {
  const { key, label, group, type, description, min, max, maxLength, options } = def;
  const base = { key, label, group, type, description, min, max, maxLength, options, defaultValue: type === 'secret' ? null : def.default, updatedAt: row?.updated_at ?? null };
  const value = row ? JSON.parse(row.value_json) as string | number | boolean : null;
  if (type === 'secret') return { ...base, value: null, isDefault: !row, configured: !!row, preview: row ? preview(String(value)) : null };
  return { ...base, value: row ? value : def.default, isDefault: !row };
}

export function listBusinessSettings(db: DB): PublicSetting[] {
  const rows = stored(db);
  return BUSINESS_SETTINGS.map((d) => toPublic(d, rows.get(d.key)));
}

/** 服务端读取类型化值(含 secret 明文,仅供服务内部使用,不得回传前端)。 */
export function getSetting<T extends string | number | boolean | null>(db: DB, key: string): T {
  const def = DEFS.get(key);
  if (!def) throw new Error(`unregistered setting ${key}`);
  const row = db.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(key) as { value_json: string } | undefined;
  return (row ? JSON.parse(row.value_json) : def.default) as T;
}

/**
 * 批量保存:{ key: value }。value 为 null 表示恢复默认(secret 为清除)。
 * secret 传 undefined/省略表示不修改;前端不会拿到明文,因此无法“原样回传”。
 */
export function saveBusinessSettings(db: DB, input: unknown): PublicSetting[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Errors.validation('请求体必须是 { key: value } 对象');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) throw Errors.validation('没有要保存的设置');
  const unknown = entries.map(([k]) => k).filter((k) => !DEFS.has(k));
  if (unknown.length) {
    throw new AppError('UNKNOWN_SETTING', `不支持的设置项:${unknown.join(', ')}`, 400, unknown.map((k) => ({ row: 0, field: k, message: '未登记的设置项' })));
  }
  const errors: { row: number; field: string; message: string }[] = [];
  const parsed: [SettingDef, string | number | boolean | null][] = [];
  for (const [key, raw] of entries) {
    const def = DEFS.get(key)!;
    try {
      parsed.push([def, validate(def, raw)]);
    } catch (err) {
      if (err instanceof AppError) errors.push(...(err.errors ?? [{ row: 0, field: key, message: err.message }]));
      else throw err;
    }
  }
  if (errors.length) throw new AppError('VALIDATION_FAILED', '设置校验未通过', 400, errors);

  const auth = currentAuth();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const changed: string[] = [];
    const cleared: string[] = [];
    for (const [def, value] of parsed) {
      if (value === null || (def.type !== 'secret' && value === def.default)) {
        if (db.prepare('DELETE FROM app_setting WHERE key = ?').run(def.key).changes) cleared.push(def.key);
      } else {
        db.prepare(`INSERT INTO app_setting (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(def.key, JSON.stringify(value), auth?.userId ?? null, now);
        changed.push(def.key);
      }
    }
    // 审计只记键名,不记值(值可能含凭据,且业务设置本身可从当前状态读回)
    writeLog(db, 'settings.business.save', 'settings', '-', { changed, cleared });
  });
  tx();
  return listBusinessSettings(db);
}
