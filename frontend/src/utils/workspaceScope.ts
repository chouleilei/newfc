import { DOMAIN_ID_FIELDS } from '../assistant/domainContext';
/**
 * 公共工作范围与路由适配(方案《易用性与直觉化交互实施方案》§5.1,任务 UX-01)。
 *
 * 约定:
 * - 业务实体字段复用 assistant/context.ts 的 PageScope 语义,本模块在其上补充 sheet/view/mode/cutoff
 *   等页面级参数,不另造一套与页面查询竞争的全局年度状态;
 * - URL 值先做格式检查,再经 validateScopeOwnership 基于服务器对象做归属校验;
 *   非法值给出明确失败原因(ScopeIssue),绝不静默替换成另一个可写目标;
 * - 范围取值优先级:有效的显式 URL > 最近使用 > 页面默认;URL 存在但非法时不回落,
 *   由页面说明原因(见 resolveWorkspaceScope);
 * - 版本绑定的年度不可被全局年度选择器覆盖(resolveEffectiveYear 版本优先);
 * - 历史补录模式只由显式 mode=history 决定,不按年度早于当前年推断。
 */
import type { PageKey, PageScope } from '../assistant/context';

export type ActualViewMode = 'orgs' | 'years';
export type ActualEditMode = 'current' | 'history';

/** 页面工作范围:PageScope 业务实体 + 页面级视图参数。 */
export interface WorkspaceScope extends PageScope {
  sheet?: string;
  view?: ActualViewMode;
  mode?: ActualEditMode;
  /** 累计截止日 YYYY-MM-DD,必须属于所选年度。 */
  cutoff?: string;
  tab?: string;
  sourceProfileId?: number;
  revisionOfId?: number;
  level?: number;
  /** 预警阈值百分比 0–100。 */
  threshold?: number;
  basisMode?: string;
  basisId?: number;
  trend?: string;
}

export type ScopeIssueReason =
  | 'invalid_format'
  | 'unknown_value'
  | 'out_of_range'
  | 'not_found'
  | 'scope_mismatch'
  | 'inactive';

export interface ScopeIssue {
  /** URL 参数名。 */
  key: string;
  /** 对应的 scope 字段;路由不支持的参数被忽略时为空。 */
  field?: keyof WorkspaceScope;
  raw: string;
  reason: ScopeIssueReason;
  /** 面向用户的失败原因。 */
  detail: string;
}

export interface ScopeParseResult {
  pageKey: PageKey;
  /** 只包含通过格式检查的值;被拒绝的原始参数不会进入 scope。 */
  scope: WorkspaceScope;
  issues: ScopeIssue[];
  /** 旧参数适配记录(from 旧参数名 → to 现行参数名),便于页面提示。 */
  adapted: { from: string; to: string; value: string }[];
}

export type ScopeValueSource = 'url' | 'recent' | 'default' | 'invalid_url' | 'none';

export interface ResolvedWorkspaceScope {
  scope: WorkspaceScope;
  sources: Partial<Record<keyof WorkspaceScope, ScopeValueSource>>;
  issues: ScopeIssue[];
}

/** 归属校验目录:只校验调用方提供的集合,未提供的集合视为"未校验"而非通过。 */
export interface ScopeCatalog {
  versions?: readonly { id: number; year: number; disabled?: boolean }[];
  snapshotBatches?: readonly { id: number; year: number; disabled?: boolean }[];
  orgs?: readonly { id: number; disabled?: boolean }[];
  accounts?: readonly { id: number; disabled?: boolean }[];
  sheetKeys?: readonly string[];
}

type ParamKind = 'period' | 'id' | 'year' | 'date' | 'sheet' | 'view' | 'mode' | 'percent' | 'text';

interface ParamDef {
  field: keyof WorkspaceScope;
  kind: ParamKind;
  label: string;
}

const PARAM_DEFS: Record<string, ParamDef> = {
  ...Object.fromEntries(DOMAIN_ID_FIELDS.map((field) => [field, { field, kind: 'id', label: '业务对象' } as ParamDef])),
  period: { field: 'period', kind: 'period', label: '期间' }, periodFrom: { field: 'periodFrom', kind: 'period', label: '起始期间' }, periodTo: { field: 'periodTo', kind: 'period', label: '截至期间' },
  statementScope: { field: 'statementScope', kind: 'text', label: '财报口径' },
  year: { field: 'year', kind: 'year', label: '年度' },
  version: { field: 'budgetVersionId', kind: 'id', label: '预算版本' },
  forecast: { field: 'targetVersionId', kind: 'id', label: '预测版本' },
  batch: { field: 'actualSnapshotId', kind: 'id', label: '实际快照' },
  org: { field: 'orgScopeId', kind: 'id', label: '组织' },
  account: { field: 'accountScopeId', kind: 'id', label: '科目' },
  orgId: { field: 'orgScopeId', kind: 'id', label: '组织' },
  accountId: { field: 'accountScopeId', kind: 'id', label: '科目' },
  base: { field: 'baseVersionId', kind: 'id', label: '基准版本' },
  target: { field: 'targetVersionId', kind: 'id', label: '对比版本' },
  sheet: { field: 'sheet', kind: 'sheet', label: '科目表' },
  view: { field: 'view', kind: 'view', label: '显示视图' },
  mode: { field: 'mode', kind: 'mode', label: '录入任务' },
  cutoff: { field: 'cutoff', kind: 'date', label: '累计截止日' },
  tab: { field: 'tab', kind: 'text', label: '页签' },
  sourceProfileId: { field: 'sourceProfileId', kind: 'id', label: '数据源' },
  revisionOfId: { field: 'revisionOfId', kind: 'id', label: '修订批次' },
  level: { field: 'level', kind: 'id', label: '汇总层级' },
  threshold: { field: 'threshold', kind: 'percent', label: '预警阈值' },
  basisMode: { field: 'basisMode', kind: 'text', label: '对比口径' },
  basisId: { field: 'basisId', kind: 'id', label: '口径对象' },
  trend: { field: 'trend', kind: 'text', label: '趋势选择' },
};

/**
 * 路由白名单:每个 pageKey 允许保存/恢复/解析的查询参数。
 * 未列出的路由不保存范围;路由不支持的参数一律忽略,不产生 issue。
 * 参数键名与各页面当前读取的键名保持一致(§5.1:沿用现有参数,不全面改名)。
 */
export const ROUTE_SCOPE_WHITELIST = {
  eas: ['orgId', 'period', 'batchId'], statements: ['orgId', 'period', 'statementScope', 'tab', 'batchId'], governance: ['orgId', 'period', 'governanceIssueId'], mgmt: ['tab'], standard_reports: ['id'], project_budget: ['year', 'period', 'orgId', 'batchId'], plan: ['year', 'period', 'orgId', 'batchId'], contracts: ['id', 'orgId', 'projectId'], contract_import: [], expense: ['id', 'orgId'], expense_policies: [], feasibility: ['id', 'scenarioId', 'reportId', 'tab'], investment_control: ['id', 'comparisonId'], forecast: ['id', 'versionId', 'tab'], risk: ['id', 'orgId'], analysis_reports: ['id'], master_entities: ['tab'], project_profile: [], search: [], jobs: [], business_settings: [], security: [],
  dashboard: ['year'],
  assistant: [],
  insights: [],
  master_health: [],
  cleaning_config: [],
  budget_progress: ['year', 'version'],
  anomaly_center: ['year', 'version', 'batch', 'threshold'],
  metric_trend: [],
  ai_settings: [],
  org: [],
  account: [],
  metric: [],
  budget_versions: ['year'],
  budget_edit: ['orgId', 'accountId', 'sheet'],
  actual: ['year', 'org', 'sheet', 'view', 'mode', 'cutoff'],
  finance_import: ['tab', 'sourceProfileId', 'cutoff', 'revisionOfId'],
  analysis: ['year', 'version', 'forecast', 'batch', 'org', 'account', 'sheet', 'level', 'threshold', 'trend'],
  structure: ['year', 'version', 'batch', 'org', 'account', 'sheet', 'level', 'basisMode', 'basisId'],
  history: [],
  version_compare: ['base', 'target', 'org', 'sheet'],
  calculations: [],
  imports: [],
  data_check: [],
  yearclose: [],
  backup: [],
  migration: [],
  data_export: [],
  logs: [],
} as const satisfies Record<PageKey, readonly string[]>;

/**
 * 旧参数适配:现行参数缺失时才把旧参数映射过来,现行参数优先。
 * budget_edit 现行契约保留 orgId/accountId(§5.1);助手 buildScopedPath 生成的
 * org/account 旧形式链接必须继续有效。
 */
const LEGACY_PARAM_ALIASES: Partial<Record<PageKey, Record<string, string>>> = {
  budget_edit: { org: 'orgId', account: 'accountId' },
};

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function issue(key: string, field: keyof WorkspaceScope | undefined, raw: string, reason: ScopeIssueReason, detail: string): ScopeIssue {
  return { key, field, raw, reason, detail };
}

function parseId(def: ParamDef, key: string, raw: string): number | ScopeIssue {
  if (!/^\d+$/.test(raw)) {
    return issue(key, def.field, raw, 'invalid_format', `${def.label}「${raw}」不是有效的正整数编号`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return issue(key, def.field, raw, 'invalid_format', `${def.label}「${raw}」超出有效编号范围`);
  }
  return value;
}

function isValidDateText(raw: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseParamValue(key: string, raw: string, override?: ParamDef): { field: keyof WorkspaceScope; value: string | number } | ScopeIssue {
  const def = override ?? PARAM_DEFS[key];
  switch (def.kind) {
    case 'period': { if (!/^(?:19|20)\d{2}(?:-(?:0[1-9]|1[0-2]))?$/.test(raw)) return issue(key, def.field, raw, 'invalid_format', `${def.label}不是有效的 YYYY 或 YYYY-MM`); return { field: def.field, value: raw }; }
    case 'id': {
      const parsed = parseId(def, key, raw);
      if (typeof parsed !== 'number') return parsed;
      return { field: def.field, value: parsed };
    }
    case 'year': {
      if (!/^\d{4}$/.test(raw)) {
        return issue(key, def.field, raw, 'invalid_format', `年度「${raw}」不是四位年份`);
      }
      const value = Number(raw);
      if (value < MIN_YEAR || value > MAX_YEAR) {
        return issue(key, def.field, raw, 'out_of_range', `年度「${raw}」超出支持范围(${MIN_YEAR}–${MAX_YEAR})`);
      }
      return { field: def.field, value };
    }
    case 'date': {
      if (!isValidDateText(raw)) {
        return issue(key, def.field, raw, 'invalid_format', `${def.label}「${raw}」不是合法的 YYYY-MM-DD 日期`);
      }
      return { field: def.field, value: raw };
    }
    case 'sheet': {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
        return issue(key, def.field, raw, 'invalid_format', `${def.label}「${raw}」不是有效的表标识`);
      }
      return { field: def.field, value: raw };
    }
    case 'view': {
      if (raw !== 'orgs' && raw !== 'years') {
        return issue(key, def.field, raw, 'unknown_value', `显示视图「${raw}」无效,仅支持 orgs / years`);
      }
      return { field: def.field, value: raw };
    }
    case 'mode': {
      if (raw !== 'current' && raw !== 'history') {
        return issue(key, def.field, raw, 'unknown_value', `录入任务「${raw}」无效,仅支持 current / history`);
      }
      return { field: def.field, value: raw };
    }
    case 'percent': {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return issue(key, def.field, raw, 'out_of_range', `${def.label}「${raw}」不是 0–100 的数字`);
      }
      return { field: def.field, value };
    }
    case 'text': {
      if (raw.length > 128) {
        return issue(key, def.field, raw, 'invalid_format', `${def.label}「${raw.slice(0, 32)}…」过长`);
      }
      return { field: def.field, value: raw };
    }
  }
}

/** 参数键 → scope 字段(供 URL 同步 hook 按键写回;键不在词表时返回 undefined)。 */
export function scopeFieldOfParam(key: string): keyof WorkspaceScope | undefined {
  return PARAM_DEFS[key]?.field;
}


const DOMAIN_ROUTE_FIELDS: Partial<Record<PageKey, Record<string, keyof WorkspaceScope>>> = {
  eas: { batchId: 'easBatchId' }, statements: { batchId: 'statementBatchId' }, project_budget: { batchId: 'projectBudgetBatchId' }, plan: { batchId: 'planBatchId' },
  contracts: { id: 'contractId' }, expense: { id: 'claimId' }, feasibility: { id: 'feasProjectId', reportId: 'feasReportId' }, investment_control: { id: 'icProjectId' },
  forecast: { id: 'modelId', versionId: 'forecastVersionId' }, risk: { id: 'riskId' }, analysis_reports: { id: 'reportId' }, standard_reports: { id: 'standardReportId' },
};
function paramDef(pageKey: PageKey, key: string): ParamDef | undefined {
  const field = DOMAIN_ROUTE_FIELDS[pageKey]?.[key];
  return field ? { field, kind: 'id', label: '业务对象' } : PARAM_DEFS[key];
}

/** 解析 URL 查询串为工作范围:只处理路由白名单内的参数,非法值记入 issues 不进入 scope。 */
export function parseWorkspaceScope(pageKey: PageKey, search: string | URLSearchParams): ScopeParseResult {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const whitelist = ROUTE_SCOPE_WHITELIST[pageKey] ?? [];
  const aliases = LEGACY_PARAM_ALIASES[pageKey] ?? {};
  const scope: Record<string, string | number> = {};
  const issues: ScopeIssue[] = [];
  const adapted: ScopeParseResult['adapted'] = [];

  const readParam = (key: string, rawOverride?: string) => {
    const def = paramDef(pageKey, key);
    if (!def) return;
    const raw = rawOverride ?? params.get(key);
    if (raw == null || raw === '') return;
    const parsed = parseParamValue(key, raw, def);
    if ('reason' in parsed) {
      issues.push(parsed);
    } else {
      scope[parsed.field] = parsed.value;
    }
  };

  for (const key of whitelist) readParam(key);
  for (const [legacy, canonical] of Object.entries(aliases)) {
    if (!(whitelist as readonly string[]).includes(canonical)) continue;
    const raw = params.get(legacy);
    if (raw == null || raw === '' || params.has(canonical)) continue;
    adapted.push({ from: legacy, to: canonical, value: raw });
    readParam(canonical, raw);
  }

  return { pageKey, scope: scope as WorkspaceScope, issues, adapted };
}

/** 把范围序列化为该路由的规范查询串(不含 ?);只输出白名单参数,非法/不支持字段被丢弃。 */
export function buildScopeSearch(pageKey: PageKey, scope: WorkspaceScope): string {
  const params = new URLSearchParams();
  const source = scope as Record<string, unknown>;
  for (const key of ROUTE_SCOPE_WHITELIST[pageKey] ?? []) {
    const def = paramDef(pageKey, key);
    if (!def) continue;
    const value = source[def.field];
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/**
 * 规范化查询串:解析后按白名单重建。
 * 旧参数被改写为现行参数,非法值被丢弃(原因需由 parseWorkspaceScope 单独获取),
 * 对合法范围幂等,往返不改变有效范围。
 */
export function normalizeScopeSearch(pageKey: PageKey, search: string | URLSearchParams): string {
  return buildScopeSearch(pageKey, parseWorkspaceScope(pageKey, search).scope);
}

/** 该路由是否支持范围保存/恢复。 */
export function isScopeRestorable(pageKey: PageKey): boolean {
  return (ROUTE_SCOPE_WHITELIST[pageKey]?.length ?? 0) > 0;
}

/**
 * 基于服务器对象做归属校验。只读不写:返回全部问题及原因,不修改 scope,
 * 更不会把无效目标替换成其他目标。目录中未提供的集合不做判断。
 */
export function validateScopeOwnership(scope: WorkspaceScope, catalog: ScopeCatalog): ScopeIssue[] {
  const issues: ScopeIssue[] = [];

  const checkVersion = (field: 'budgetVersionId' | 'targetVersionId' | 'baseVersionId', key: string, label: string) => {
    const id = scope[field];
    if (id == null || !catalog.versions) return;
    const version = catalog.versions.find((item) => item.id === id);
    if (!version) {
      issues.push(issue(key, field, String(id), 'not_found', `${label} ${id} 不存在或已删除`));
      return;
    }
    if (version.disabled) {
      issues.push(issue(key, field, String(id), 'inactive', `${label}「${id}」已停用`));
      return;
    }
    if (scope.year != null && version.year !== scope.year) {
      issues.push(issue(key, field, String(id), 'scope_mismatch', `${label} ${id} 属于 ${version.year} 年,与所选 ${scope.year} 年不一致`));
    }
  };

  checkVersion('budgetVersionId', 'version', '预算版本');
  checkVersion('targetVersionId', 'forecast', '对比/预测版本');
  checkVersion('baseVersionId', 'base', '基准版本');

  if (scope.actualSnapshotId != null && catalog.snapshotBatches) {
    const batch = catalog.snapshotBatches.find((item) => item.id === scope.actualSnapshotId);
    if (!batch) {
      issues.push(issue('batch', 'actualSnapshotId', String(scope.actualSnapshotId), 'not_found', `实际快照 ${scope.actualSnapshotId} 不存在或已删除`));
    } else if (batch.disabled) {
      issues.push(issue('batch', 'actualSnapshotId', String(scope.actualSnapshotId), 'inactive', `实际快照 ${scope.actualSnapshotId} 已停用`));
    } else if (scope.year != null && batch.year !== scope.year) {
      issues.push(issue('batch', 'actualSnapshotId', String(scope.actualSnapshotId), 'scope_mismatch', `实际快照 ${scope.actualSnapshotId} 属于 ${batch.year} 年,不能用于 ${scope.year} 年`));
    }
  }

  const checkEntity = (
    field: 'orgScopeId' | 'accountScopeId',
    key: string,
    label: string,
    entries: readonly { id: number; disabled?: boolean }[] | undefined,
  ) => {
    const id = scope[field];
    if (id == null || !entries) return;
    const entry = entries.find((item) => item.id === id);
    if (!entry) {
      issues.push(issue(key, field, String(id), 'not_found', `${label} ${id} 不存在或已删除`));
    } else if (entry.disabled) {
      issues.push(issue(key, field, String(id), 'inactive', `${label}「${id}」已停用`));
    }
  };

  checkEntity('orgScopeId', 'org', '组织', catalog.orgs);
  checkEntity('accountScopeId', 'account', '科目', catalog.accounts);

  if (scope.sheet != null && catalog.sheetKeys && !catalog.sheetKeys.includes(scope.sheet)) {
    issues.push(issue('sheet', 'sheet', scope.sheet, 'not_found', `科目表「${scope.sheet}」不存在`));
  }

  if (scope.cutoff != null && scope.year != null && Number(scope.cutoff.slice(0, 4)) !== scope.year) {
    issues.push(issue('cutoff', 'cutoff', scope.cutoff, 'out_of_range', `累计截止日 ${scope.cutoff} 不属于所选 ${scope.year} 年`));
  }

  return issues;
}

/**
 * 来源优先级合成:有效的显式 URL > 最近使用 > 页面默认。
 * URL 存在但未通过格式检查的字段标记为 invalid_url,保持空值并附 issue,
 * 不回落到最近使用或默认值——写入目标不能被悄悄换掉。
 */
export function resolveWorkspaceScope(
  parsed: ScopeParseResult,
  recent?: Partial<WorkspaceScope>,
  defaults?: Partial<WorkspaceScope>,
): ResolvedWorkspaceScope {
  const scope: Record<string, unknown> = {};
  const sources: Partial<Record<keyof WorkspaceScope, ScopeValueSource>> = {};
  const urlScope = parsed.scope as Record<string, unknown>;
  const invalidFields = new Set(parsed.issues.map((item) => item.field).filter((field) => field != null));

  const fields = new Set<keyof WorkspaceScope>([
    ...(Object.keys(urlScope) as (keyof WorkspaceScope)[]),
    ...[...invalidFields] as (keyof WorkspaceScope)[],
    ...(Object.keys(recent ?? {}) as (keyof WorkspaceScope)[]),
    ...(Object.keys(defaults ?? {}) as (keyof WorkspaceScope)[]),
  ]);

  for (const field of fields) {
    const urlValue = urlScope[field];
    if (urlValue !== undefined) {
      scope[field] = urlValue;
      sources[field] = 'url';
      continue;
    }
    if (invalidFields.has(field)) {
      sources[field] = 'invalid_url';
      continue;
    }
    const recentValue = (recent as Record<string, unknown> | undefined)?.[field];
    if (recentValue !== undefined && recentValue !== null && recentValue !== '') {
      scope[field] = recentValue;
      sources[field] = 'recent';
      continue;
    }
    const defaultValue = (defaults as Record<string, unknown> | undefined)?.[field];
    if (defaultValue !== undefined && defaultValue !== null && defaultValue !== '') {
      scope[field] = defaultValue;
      sources[field] = 'default';
      continue;
    }
    sources[field] = 'none';
  }

  return { scope: scope as WorkspaceScope, sources, issues: [...parsed.issues] };
}

/**
 * 有效年度:版本绑定的年度优先,不可被全局年度选择器覆盖。
 * 版本在目录中查不到时回退到显式 year;年度冲突由 validateScopeOwnership 报告。
 */
export function resolveEffectiveYear(
  scope: Pick<WorkspaceScope, 'year' | 'budgetVersionId'>,
  catalog?: Pick<ScopeCatalog, 'versions'>,
): { year?: number; source: 'version' | 'scope' | 'none' } {
  if (scope.budgetVersionId != null && catalog?.versions) {
    const version = catalog.versions.find((item) => item.id === scope.budgetVersionId);
    if (version) return { year: version.year, source: 'version' };
  }
  if (scope.year != null) return { year: scope.year, source: 'scope' };
  return { source: 'none' };
}

/**
 * 当前/历史任务区分:只有显式 mode=history 才是历史补录;
 * 缺省一律为更新当前累计,绝不因所选年份早于当前年而自动推断历史模式(§5.1)。
 */
export function resolveActualMode(scope: Pick<WorkspaceScope, 'mode'>): ActualEditMode {
  return scope.mode === 'history' ? 'history' : 'current';
}
