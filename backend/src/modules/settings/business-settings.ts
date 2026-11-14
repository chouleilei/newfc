import { probePdfServiceHealth, validatePdfServiceUrl } from '../contracts/pdf-service-url';
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
import { parseDecimalToCents, parseScaled, RATIO_SCALE } from '../../core/decimal';
import { LEGAL_CATEGORIES } from '../../contracts/contract-legal-review';

/** ratio:0～1 的十进制字符串,最多 6 位小数(缩放 bigint 校验,不经浮点) */
type SettingType = 'string' | 'int' | 'bool' | 'enum' | 'url' | 'secret' | 'ratio';

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
  { key: 'contract.legal_entity_org_ids', label: '二级法人组织节点ID', group: '合同', type: 'string', default: '', maxLength: 2000, description: '英文逗号分隔；名义签署为二级单位时取最近法人祖先，未配置从严归顶级法人' },
  { key: 'contract.prior_year_net_assets', label: '法人年度净资产', group: '合同', type: 'string', default: '', maxLength: 12000, description: 'JSON数组，如 [{"orgId":1,"year":2025,"amount":"100000000.00"}]。付款按前一年净资产1%与500万元孰低核验；缺失时要求集体决策。' },
  { key: 'calendar.holidays', label: '法定休息日', group: '日历', type: 'string', default: '', maxLength: 12000, description: '英文逗号分隔的 YYYY-MM-DD 日期，含法定节假日' },
  { key: 'calendar.workdays', label: '调休工作日', group: '日历', type: 'string', default: '', maxLength: 12000, description: '英文逗号分隔的 YYYY-MM-DD 日期，优先于周末规则' },
  { key: 'report.company_name', label: '报表单位名称', group: '报表', type: 'string', default: '', maxLength: 100, description: '报表抬头与导出文件中的单位名称' },
  { key: 'report.preparer_title', label: '编制人落款', group: '报表', type: 'string', default: '', maxLength: 50 },
  { key: 'finance.fiscal_year_start_month', label: '会计年度起始月', group: '财务', type: 'int', default: 1, min: 1, max: 12 },
  {
    key: 'display.amount_unit', label: '默认金额单位', group: '显示', type: 'enum', default: 'yuan',
    options: [{ value: 'yuan', label: '元' }, { value: 'wan_yuan', label: '万元' }],
  },
  { key: 'display.amount_decimals', label: '默认金额小数位', group: '显示', type: 'int', default: 2, min: 0, max: 4 },
  { key: 'jobs.retention_days', label: '任务记录保留天数', group: '任务', type: 'int', default: 90, min: 7, max: 3650, description: '服务启动时清理超期的已结束任务及其步骤' },
  // T-6:投资控制默认偏差阈值(对比请求未指定时取用,快照记录实际使用的阈值)与预测运行超时
  { key: 'investment.ic_threshold_normal', label: '投资偏差“正常”上限', group: '投资控制', type: 'ratio', default: '0.03', description: '偏差率不超过该值为正常(0～1,如 0.03 表示 3%)' },
  { key: 'investment.ic_threshold_attention', label: '投资偏差“关注”上限', group: '投资控制', type: 'ratio', default: '0.08', description: '超过正常上限且不超过该值为关注' },
  { key: 'investment.ic_threshold_warning', label: '投资偏差“预警”上限', group: '投资控制', type: 'ratio', default: '0.10', description: '超过关注上限且不超过该值为预警,再高为超限;三者须单调不减' },
  { key: 'forecast.timeout_seconds', label: '预测运行超时(秒)', group: '财务预测', type: 'int', default: 30, min: 5, max: 120, description: '单次预测重算的最长计算时间,超时记为失败' },
  { key: 'integration.pdf_parser_base_url', label: 'PDF 解析服务地址', group: '集成', type: 'string', default: '', maxLength: 300, description: '独立 PDF 服务根地址；支持 HTTPS、本机与受控私网 HTTP' },
  { key: 'integration.pdf_parser_api_key', label: 'PDF 解析服务密钥', group: '集成', type: 'secret', default: null, maxLength: 500 },
  { key: 'integration.pdf_parser_timeout_seconds', label: 'PDF 解析超时（秒）', group: '集成', type: 'int', default: 60, min: 5, max: 300 },
  { key: 'integration.pdf_fallback_ocr', label: 'PDF 解析不可用时回退 OCR', group: '集成', type: 'bool', default: true },
  { key: 'integration.ocr_provider', label: 'OCR 接口类型', group: '集成', type: 'enum', default: 'json_http', options: [{ value: 'json_http', label: 'JSON 同步接口' }, { value: 'tangdalei_http', label: '原有 OCR 服务（异步）' }] },
  { key: 'integration.ocr_base_url', label: 'OCR 服务地址', group: '集成', type: 'url', default: '', maxLength: 300, description: '原有 OCR 服务填写 https://ocr.tangdalei.com/api；JSON 接口填写完整调用地址' },
  { key: 'integration.ocr_api_key', label: 'OCR 服务密钥', group: '集成', type: 'secret', default: null, maxLength: 500, description: '仅用于 JSON 同步接口' },
  { key: 'integration.ocr_username', label: 'OCR 登录账号', group: '集成', type: 'string', default: '', maxLength: 200, description: '原有 OCR 服务的登录账号' },
  { key: 'integration.ocr_password', label: 'OCR 登录密码', group: '集成', type: 'secret', default: null, maxLength: 500, description: '原有 OCR 服务的登录密码，留空不修改' },
  { key: 'integration.ocr_api_type', label: 'OCR 识别类型', group: '集成', type: 'string', default: '1', maxLength: 50, description: '原有 OCR 服务的识别类型，按服务约定填写' },
  { key: 'integration.ocr_timeout_seconds', label: '异步 OCR 超时（秒）', group: '集成', type: 'int', default: 120, min: 5, max: 300, description: '单附件登录、上传、轮询与下载的总时限' },
  {
    key: 'contract.change_or_mode', label: '合同变更分级比例与限额口径', group: '合同', type: 'enum', default: 'min',
    options: [{ value: 'min', label: '孰低从严（默认）' }, { value: 'max', label: '孰高' }],
    description: '附件 5 变更增加额“≤比例 或 ≤固定限额”的组合判定口径（CLM-DEC-01）',
  },
  {
    key: 'contract.countersign_due_days', label: '合同会签参考反馈天数', group: '合同', type: 'int', default: 0, min: 0, max: 60,
    description: '默认 0 表示不设限办日；大于 0 时按发起日推算会签参考反馈日并纳入超期提醒',
  },
  {
    key: 'contract.archive_transfer_sla_days', label: '合同档案移交时限预警阈值（日）', group: '合同', type: 'int', default: 0, min: 0, max: 365,
    description: '默认 0 表示仅结案强检；大于 0 时对档案验收通过后超期未移交档案室的合同触发预警（CW-30）',
  },
  {
    key: 'contract.legal_review_categories', label: '智能法审启用合同类别', group: '合同', type: 'string',
    default: 'goods_procurement,small_construction,construction,tech_service,general_service,important_special',
    maxLength: 500,
    description: '英文逗号分隔的法审触发类别枚举，默认覆盖货物采购、小型施工、工程施工、技术服务、一般服务、重要特殊六大类别',
  },
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
    case 'ratio': {
      if (typeof raw !== 'string') throw fail('必须是十进制字符串');
      const v = raw.trim();
      let scaled: bigint;
      try { scaled = parseScaled(v, RATIO_SCALE, { label: def.label }); } catch { throw fail(`须为 0～1 之间最多 ${RATIO_SCALE} 位小数的数字`); }
      if (scaled < 0n || scaled > 10n ** BigInt(RATIO_SCALE)) throw fail('取值范围 0～1');
      return v;
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
      if (def.key === 'contract.legal_entity_org_ids' && v && !/^\d+(,\d+)*$/.test(v)) throw fail('须为英文逗号分隔的组织ID');
      if (def.key === 'contract.legal_review_categories' && v) {
        const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0 || parts.some((p) => !(LEGAL_CATEGORIES as readonly string[]).includes(p))) {
          throw fail(`须为英文逗号分隔的合法合同类别（${LEGAL_CATEGORIES.join('/')}）`);
        }
      }
      if (def.key === 'contract.prior_year_net_assets' && v) {
        try {
          const entries = JSON.parse(v) as { orgId: number; year: number; amount: string }[];
          if (!Array.isArray(entries)) throw new Error();
          const keys = new Set<string>();
          for (const e of entries) {
            if (!Number.isSafeInteger(e.orgId) || e.orgId < 1 || !Number.isInteger(e.year) || e.year < 2000 || e.year > 2100 || typeof e.amount !== 'string' || parseDecimalToCents(e.amount) <= 0n) throw new Error();
            const k = `${e.orgId}:${e.year}`; if (keys.has(k)) throw new Error(); keys.add(k);
          }
        } catch { throw fail('须为无重复的法人组织、年度、正数金额JSON数组'); }
      }
      if (def.key.startsWith('calendar.') && v && v.split(',').some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) throw fail('须为有效日期列表');
      if (def.key === 'integration.pdf_parser_base_url' && v) {
        try { validatePdfServiceUrl(v); } catch (e) { throw fail(e instanceof Error ? e.message : '地址不合法'); }
      }
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

const IC_THRESHOLD_KEYS = ['investment.ic_threshold_normal', 'investment.ic_threshold_attention', 'investment.ic_threshold_warning'] as const;

/** 跨项校验使用本次提交与已存值/默认值，校验失败整批拒绝。 */
function crossCheck(db: DB, parsed: [SettingDef, string | number | boolean | null][]): { row: number; field: string; message: string }[] {
  const next = new Map(parsed.map(([d, v]) => [d.key, v]));
  const effective = (k: string) => next.has(k) ? next.get(k) ?? DEFS.get(k)!.default : getSetting(db, k);
  const errors: { row: number; field: string; message: string }[] = [];
  if (next.has('integration.ocr_provider') || next.has('integration.ocr_base_url')) {
    const url = effective('integration.ocr_base_url');
    if (effective('integration.ocr_provider') === 'tangdalei_http' && typeof url === 'string' && url) {
      const root = new URL(url);
      if (root.search || root.hash) errors.push({ row: 0, field: 'integration.ocr_base_url', message: '原有 OCR 服务根地址不能带查询参数或片段' });
    }
  }
  if (parsed.some(([d]) => (IC_THRESHOLD_KEYS as readonly string[]).includes(d.key))) {
    const eff = IC_THRESHOLD_KEYS.map((k) => parseScaled(String(effective(k)), RATIO_SCALE));
    if (!(eff[0] <= eff[1] && eff[1] <= eff[2])) errors.push({ row: 0, field: 'investment.ic_threshold_attention', message: '投资偏差阈值须满足 正常 ≤ 关注 ≤ 预警' });
  }
  if (next.has('calendar.holidays') || next.has('calendar.workdays')) {
    const hol = new Set(String(effective('calendar.holidays') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    const work = String(effective('calendar.workdays') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const overlap = work.filter((d) => hol.has(d));
    if (overlap.length > 0) {
      errors.push({ row: 0, field: 'calendar.workdays', message: `同一日期不能同时配置为法定休息日与调休工作日: ${overlap.join(', ')}` });
    }
  }
  return errors;
}

/** 投资控制默认阈值(对比请求未指定时使用)。 */
export function icDefaultThresholds(db: DB): { normal: string; attention: string; warning: string } {
  const [normal, attention, warning] = IC_THRESHOLD_KEYS.map((k) => getSetting<string>(db, k));
  return { normal, attention, warning };
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
  if (!errors.length) errors.push(...crossCheck(db, parsed));
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

/** 所有工作日门禁使用同一套可配置法定节假日/调休表。 */
export function workingCalendar(db: DB) {
  return { holidays: new Set(getSetting<string>(db, 'calendar.holidays').split(',').filter(Boolean)), workdays: new Set(getSetting<string>(db, 'calendar.workdays').split(',').filter(Boolean)) };
}

/** 探活 PDF 解析服务（可传未保存的待测 baseUrl，未传则使用库内已保存地址）。 */
export async function testPdfParserConnection(
  db: DB,
  input?: { baseUrl?: unknown }
): Promise<{ ok: boolean; status: number; latencyMs: number; message: string }> {
  const candidate = typeof input?.baseUrl === 'string' && input.baseUrl.trim()
    ? input.baseUrl.trim()
    : (getSetting<string | null>(db, 'integration.pdf_parser_base_url') ?? '').trim();
  if (!candidate) {
    return { ok: false, status: 0, latencyMs: 0, message: '尚未配置 PDF 解析服务地址' };
  }
  const apiKey = getSetting<string | null>(db, 'integration.pdf_parser_api_key');
  const timeoutSec = getSetting<number>(db, 'integration.pdf_parser_timeout_seconds');
  return probePdfServiceHealth(candidate, apiKey, Math.min(Math.max(timeoutSec * 1000, 3_000), 10_000));
}

/**
 * 幂等初始化或同步期初业务设置快照（GAP-03）：
 * - 自动根据 org 表计算二级在运法人 ID 列表（org_kind='legal_entity' AND status='active' AND parent_id IS NOT NULL）；
 * - 合并调用方显式提供的覆盖参数（不编造未提供的涉密净资产或密钥）；
 * - 支持 preview | confirm 模式。
 */
export function importBusinessSettingsSnapshot(
  db: DB,
  overrides: Record<string, unknown> = {},
  mode: 'preview' | 'confirm' = 'confirm'
): { mode: 'preview' | 'confirm'; effectiveEntries: Record<string, unknown>; settings: PublicSetting[] } {
  const secondaryLegalIds = (
    db.prepare(
      "SELECT id FROM org WHERE org_kind = 'legal_entity' AND status = 'active' AND parent_id IS NOT NULL ORDER BY id"
    ).all() as { id: number }[]
  ).map((r) => r.id);

  const effectiveEntries: Record<string, unknown> = {};
  if (secondaryLegalIds.length > 0 && overrides['contract.legal_entity_org_ids'] === undefined) {
    effectiveEntries['contract.legal_entity_org_ids'] = secondaryLegalIds.join(',');
  }
  for (const [k, v] of Object.entries(overrides)) {
    effectiveEntries[k] = v;
  }

  if (Object.keys(effectiveEntries).length === 0) {
    return { mode, effectiveEntries, settings: listBusinessSettings(db) };
  }

  if (mode === 'preview') {
    const unknown = Object.keys(effectiveEntries).filter((k) => !DEFS.has(k));
    if (unknown.length) {
      throw new AppError('UNKNOWN_SETTING', `不支持的设置项:${unknown.join(', ')}`, 400);
    }
    const parsed: [SettingDef, string | number | boolean | null][] = [];
    for (const [k, raw] of Object.entries(effectiveEntries)) {
      const def = DEFS.get(k)!;
      parsed.push([def, validate(def, raw)]);
    }
    const errs = crossCheck(db, parsed);
    if (errs.length) throw new AppError('VALIDATION_FAILED', '设置快照校验未通过', 400, errs);
    return { mode: 'preview', effectiveEntries, settings: listBusinessSettings(db) };
  }

  const settings = saveBusinessSettings(db, effectiveEntries);
  return { mode: 'confirm', effectiveEntries, settings };
}
