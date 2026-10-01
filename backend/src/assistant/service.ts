import crypto from 'crypto';
import { promptSupplement } from '../modules/settings/prompt-supplements.service';
import { currentOwnerId, insightRowsFilter, ownedRowsFilter } from './ownership';
import type { DB } from '../db/connection';
import * as budget from '../modules/budget/budget.service';
import * as exportSvc from '../modules/io/export.service';
import { writeLog } from '../modules/audit/log';
import { AppError, Errors } from '../core/errors';
import {
  centsToYuanString,
  displayToSignedCents,
  isQuantityType,
  QUANTITY_SCALE,
  completionRate,
  quantityStringToScaled,
  safeIntegerAdd,
  scaledToQuantityString,
  signedCentsToDisplay,
  wanStringToYuanString,
  yuanStringToCents,
} from '../core/money';
import { csvCell } from '../core/csv';
import { isAccountVisibleForScope } from '../core/accountScope';
import { modelConfigured, EnvChatModel } from './model';
import {
  buildActionProposalPrompt,
  buildFallbackFactsPrompt,
  buildFinalAnswerPrompt,
  buildRoutingPrompt,
  buildTaskPrompt,
} from './prompts';
import { normalizeContext } from './context';
import { citationsForFacts, deterministicExtras, queryFacts, type FactRecord } from './facts';
import {
  detectIntents, detectRankFocus, looksLikeFollowUp, looksLikeWriteConfirmation,
  needsBudgetVersion, readIntentLabel, withInheritedIntents, type IntentDetection,
} from './intent';
import { contextDigest, resolveMessageContext, type ContextResolution } from './resolve';
import { resolveNavigation, type NavigationTarget } from './navigation';
import { reportDraft as buildReportDraft, centsToWanText, normalizeReportKind, sectionMarkdown, type ReportDraft } from './report-draft';
import { rewriteTemplateNarrative } from './narrative';
import { PROMPT_VERSION, REPORT_REWRITE_TASK, TREND_SECTION_REWRITE_TASK } from './prompts';
import { trendNarrativeAiEnabled } from './feature-flags';
import { executeTool, toolAcceptsParam, toolDefinitions, toolLabel } from './tools';
import { authorizeToolCall, requireActionPermission, requireAllOrgsForAction, scopedOrgId, toolAllowed } from './tool-policy';
import type { Permission } from '../modules/security/permissions';
import { assertOrgVisible } from '../modules/security/scope';
import { currentAuth } from '../core/request-context';
import type { AssistantContext } from './schemas';
import {
  buildContextSummary, detectOverrides, resolveBackendContext,
  type FocusDescriptor, type ResolvedBackendContext,
} from './context-v2';
import {
  allowedToolsForCapabilities, filterIntentsByCapability, pageCapability, pickCapability, type DomainCapability,
} from './page-capabilities';
import { computeDraftImpact, draftSummary } from './draft-context';
import { completionReport } from '../modules/report/report.service';
import { structureReport } from '../modules/report/structure.service';
import { metricEvidence } from '../modules/evidence/evidence.service';
import type { VerificationFactItem } from '../modules/report/verification';

const ACTION_TYPES = new Set(['budget_draft', 'scenario', 'copy_budget', 'bulk_adjustment', 'basis_text', 'export']);

/**
 * AI 操作与对应正式页面同一套权限(AC-F20/AC-F24):预算版本写入与路由表一致要求 budget:write
 * 且全组织范围;导出要求 analysis:export(明细导出另在 normalizeExport 限全组织)。
 * 预览与确认各校验一次:预览后被撤权/降级的用户不能再确认。
 */
const ACTION_POLICIES: Record<string, { permission: Permission; allOrgs: boolean; label: string }> = {
  budget_draft: { permission: 'budget:write', allOrgs: true, label: '新建预算版本' },
  copy_budget: { permission: 'budget:write', allOrgs: true, label: '复制预算版本' },
  bulk_adjustment: { permission: 'budget:write', allOrgs: true, label: '批量调整预算' },
  scenario: { permission: 'analysis:read', allOrgs: false, label: '情景测算' },
  basis_text: { permission: 'assistant:use', allOrgs: false, label: '保存依据草稿' },
  export: { permission: 'analysis:export', allOrgs: false, label: '导出' },
};

function authorizeAction(db: DB, type: string, params?: Record<string, any>): void {
  const policy = ACTION_POLICIES[type];
  if (!policy) throw Errors.validation('不支持的 AI 操作类型');
  requireActionPermission(policy.permission, policy.label);
  if (policy.allOrgs) requireAllOrgsForAction(policy.label);
  if (!params) return;
  // 确认时复核已存参数的范围:预览后授权范围被收窄的用户不能再取得范围外事实。
  if (type === 'export') {
    if (params.kind !== 'completion') requireAllOrgsForAction(`导出「${params.kind}」`);
    else scopedOrgId(db, params.options?.orgScopeId ?? null);
  }
  if (type === 'scenario' && params.versionId != null) scopedOrgId(db, params.orgScopeId ?? null);
}
const now = () => new Date().toISOString();
function actionTtlMs(): number {
  const value = Number(process.env.AI_ACTION_TTL_MS || 15 * 60 * 1000);
  return Number.isFinite(value) ? Math.min(24 * 60 * 60 * 1000, Math.max(10, Math.trunc(value))) : 15 * 60 * 1000;
}

interface AiActionDbRow {
  id: number;
  conversation_id: number | null;
  type: string;
  params_json: string;
  preview_json: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
  idempotency_key: string | null;
  confirmation_token: string;
  expires_at: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  owner_user_id?: number | null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw Errors.validation(`${label}必须是正整数`);
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw Errors.validation(`${label}必须是正整数`);
  return n;
}

function optionalInt(value: unknown, label: string): number | undefined {
  if (value == null || value === '') return undefined;
  return positiveInt(value, label);
}

function validYear(value: unknown, label = '年度'): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw Errors.validation(`${label}必须是 1900-9999 的整数`);
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 1900 || n > 9999) throw Errors.validation(`${label}必须是 1900-9999 的整数`);
  return n;
}

function boundedRate(value: unknown, label: string): number {
  if (value == null || value === '') return 0;
  let n: number;
  if (typeof value === 'string') {
    const s = value.trim();
    n = s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s);
  } else n = Number(value);
  if (!Number.isFinite(n) || n < -1 || n > 10) throw Errors.validation(`${label}必须在 -1 到 10 之间`);
  // Keep a deterministic decimal representation in persisted params.
  // budget service 的整数增长算法精确到百万分之一（最多六位小数）。
  return Number(n.toFixed(6));
}

function boundedText(value: unknown, label: string, max: number, required = false): string {
  if (value != null && typeof value !== 'string' && typeof value !== 'number') throw Errors.validation(`${label}必须是字符串`);
  const text = value == null ? '' : String(value).trim();
  if (required && !text) throw Errors.validation(`${label}不能为空`);
  if (text.length > max) throw Errors.validation(`${label}不能超过 ${max} 字符`);
  return text;
}

function largestChanges(changes: any[], limit = 20): any[] {
  return [...changes].sort((a, b) => Math.abs(Number(b.changeCents || 0)) - Math.abs(Number(a.changeCents || 0))).slice(0, limit);
}

/**
 * 会话标题：取首条用户消息的前 20 字，超出补省略号。
 * 标题的作用是让人在一行列表里认出会话(侧栏「最近会话」只有约 180px)，
 * 200 字的整句问话起不到这个作用；完整原文永远在消息列表里，需要更贴切的
 * 名字时仍可重命名(重命名上限维持 200 字)。
 */
function conversationTitle(message: string): string {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

function ensureConversation(db: DB, id?: number, title = ''): number {
  if (id != null) {
    const n = positiveInt(id, 'conversationId');
    const owner = ownedRowsFilter();
    const row = db.prepare(`SELECT id FROM ai_conversation WHERE id=? AND ${owner.sql}`).get(n, ...owner.params) as { id: number } | undefined;
    if (!row) throw Errors.notFound('AI 会话');
    return n;
  }
  const t = now();
  const safeTitle = conversationTitle(title);
  const result = db.prepare('INSERT INTO ai_conversation(title,created_at,updated_at,owner_user_id) VALUES(?,?,?,?)').run(safeTitle, t, t, currentOwnerId());
  return Number(result.lastInsertRowid);
}

function validateContextConsistency(db: DB, context: ReturnType<typeof normalizeContext>): void {
  if (context.budgetVersionId != null) {
    const version = budget.getVersion(db, context.budgetVersionId);
    if (context.year != null && version.year !== context.year) {
      throw new AppError('CONTEXT_CONFLICT', 'context.year 与 budgetVersionId 年度不一致', 409, undefined, { field: 'year', reason: '年度与版本年度冲突' });
    }
  }
  // 对比版本同样参与年度一致性：残留的跨年 targetVersionId 会静默产生「2025 预算 vs
  // 2026 对比」这类错误口径的回答，比报错更糟，必须在这里拦下。
  if (context.targetVersionId != null) {
    const target = budget.getVersion(db, context.targetVersionId);
    if (context.year != null && target.year !== context.year) {
      throw new AppError('CONTEXT_CONFLICT', 'context.year 与 targetVersionId 年度不一致', 409, undefined, { field: 'year', reason: '年度与对比版本年度冲突' });
    }
  }
  if (context.actualSnapshotId != null) {
    const batch = db.prepare('SELECT year FROM actual_snapshot_batch WHERE id=?').get(context.actualSnapshotId) as { year: number } | undefined;
    if (!batch) throw Errors.notFound('实际快照批次');
    if (context.year != null && batch.year !== context.year) {
      throw new AppError('CONTEXT_CONFLICT', 'context.year 与 actualSnapshotId 年度不一致', 409, undefined, { field: 'year', reason: '年度与快照年度冲突' });
    }
  }
}

/* export 确认并发占用的乐观锁哨兵:写进 result_json 表示「本动作正在生成导出物」,
   不占 status 列(其 CHECK 约束只允许 pending/confirmed/cancelled/expired 四值)。
   占位期间 publicAction 对 pending 行回吐 result_json,需在其处过滤掉该哨兵。 */
const CONFIRMING_SENTINEL = '__confirming__';

function expire(db: DB): number {
  const t = now();
  return db.prepare("UPDATE ai_action SET status='expired',updated_at=? WHERE status='pending' AND expires_at <= ?").run(t, t).changes;
}

function normalizeActionType(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase().replace(/^preview[_-]/, '').replace(/-/g, '_');
  if (!ACTION_TYPES.has(raw)) throw Errors.validation('不支持的 AI 操作类型');
  return raw;
}

/**
 * 模型不可用时的确定性回答。
 *
 * 这段文字是「模板模式」下用户唯一能看到的内容，因此必须带上真实数字而不是
 * 「已查询到 N 组事实」这类空话。所有金额都由 centsToWanText 按整数分格式化成
 * 万元两位小数，不做任何浮点运算。
 */
function deterministicSummary(
  facts: FactRecord[],
  context: AssistantContext = {},
  options: { rankFocus?: number | null } = {},
): string {
  if (!facts.length) return '当前问题没有足够的上下文。请提供年度、预算版本或实际快照；如涉及修改，请先创建预览并确认。';
  // 导航是最强意图信号：用户明确要求跳转时先给页面。
  const navigation: any = facts.find((f) => f.type === 'navigation')?.data;
  if (navigation?.target) {
    return `可前往页面「${navigation.target.label}」(${navigation.target.path})，${navigation.target.reason}。`;
  }
  // 报告与归因本身就是确定性成品，模型不可用时直接作为回答。
  const draft: any = facts.find((f) => f.type === 'report_draft')?.data;
  if (draft?.narrative) return String(draft.narrative);
  const attribution: any = facts.find((f) => f.type === 'attribution')?.data;
  if (attribution?.totals) return summarizeAttributionText(attribution, options.rankFocus ?? null);
  const financeDetail: any = facts.find((f) => f.type === 'finance_conversion_detail')?.data;
  const financeList: any = facts.find((f) => f.type === 'finance_conversions')?.data;
  const financeMapping: any = facts.find((f) => f.type === 'finance_mapping_version')?.data;
  const financeTrials: any = facts.find((f) => f.type === 'finance_parallel_trials')?.data;
  if (financeDetail || financeList || financeMapping || financeTrials) {
    return summarizeFinanceText({ detail: financeDetail, list: financeList, mapping: financeMapping, trials: financeTrials });
  }
  const importHelp: any = facts.find((f) => f.type === 'import_help')?.data;
  if (importHelp?.groups) {
    const unmatchedOrg = importHelp.unmatched?.org?.length ?? 0;
    const unmatchedAccount = importHelp.unmatched?.account?.length ?? 0;
    return `导入诊断：共 ${importHelp.errorCount} 条校验错误，分为 ${importHelp.groups.length} 类`
      + `（${(importHelp.groups as any[]).slice(0, 4).map((g) => `${g.label} ${g.count} 条`).join('、')}）。`
      + `未匹配组织编码 ${unmatchedOrg} 个、科目编码 ${unmatchedAccount} 个，重复行 ${importHelp.duplicates?.length ?? 0} 处。`
      + `处理顺序：${(importHelp.nextSteps as string[]).join('；')}`;
  }
  // 单元格备注是具体查询(问依据/问备注)，优先级高于执行分析这类通用分析。
  const cellNotesBudget: any = facts.find((f) => f.type === 'cell_notes_budget')?.data;
  const cellNotesActual: any = facts.find((f) => f.type === 'cell_notes_actual')?.data;
  if (cellNotesBudget || cellNotesActual) return summarizeCellNotesText(cellNotesBudget, cellNotesActual);
  // 业务解释与导航目录同为后端固化口径，模型不可用时也必须给出准确答案。
  const deterministicParts: string[] = [];
  const catalog: any = facts.find((f) => f.type === 'navigation_catalog')?.data;
  if (Array.isArray(catalog?.pages)) {
    deterministicParts.push(`可导航页面：${catalog.pages.map((p: any) => `${p.label}(${p.path})`).join('、')}。`);
  }
  const glossary: any = facts.find((f) => f.type === 'glossary')?.data;
  if (Array.isArray(glossary?.entries) && glossary.entries.length) {
    deterministicParts.push(glossary.entries
      .map((entry: any) => `【${entry.term}】${entry.text}${Array.isArray(entry.examples) && entry.examples.length ? `\n示例：${entry.examples.join('；')}` : ''}`)
      .join('\n'));
  }
  if (deterministicParts.length) return deterministicParts.join('\n\n');
  const missing = facts.filter((f) => f.type === 'missing_context');
  const errors = facts.filter((f) => f.type === 'query_error');
  if (missing.length) return `已查询到 ${facts.length - missing.length} 组事实，但缺少必要条件：${missing.map((f) => String((f.data as any)?.reason || '')).filter(Boolean).join('；')}`;
  if (errors.length) return `已查询到 ${facts.length - errors.length} 组事实；部分查询未完成，请根据错误来源补充条件。`;
  const execution: any = facts.find((f) => f.type === 'execution')?.data;
  if (execution?.version) return summarizeExecutionText(execution);
  const anomalies: any = facts.find((f) => f.type === 'anomalies')?.data;
  if (anomalies?.anomalies) return summarizeAnomalyText(anomalies);
  const quality: any = facts.find((f) => f.type === 'budget_quality')?.data;
  if (quality && Array.isArray(quality.issues)) {
    const blocking = quality.issues.filter((i: any) => i.severity === 'blocking').length;
    return `质量报告：共 ${quality.issues.length} 项问题，其中阻断项 ${blocking} 项${blocking ? '，存在阻断项时不能定稿' : '，当前不阻断定稿'}。明细与判定依据见引用来源。`;
  }
  const trend: any = facts.find((f) => f.type === 'trend')?.data;
  if (Array.isArray(trend?.points)) {
    const points = trend.points;
    return `年内趋势共 ${points.length} 个快照时点${points.length ? `（${points[0].date} 至 ${points[points.length - 1].date}）` : ''}；各时点完成率见引用来源。`;
  }
  const variance: any = facts.find((f) => f.type === 'version_variance')?.data;
  if (variance) {
    const rows = Array.isArray(variance.rows) ? variance.rows : Array.isArray(variance.items) ? variance.items : [];
    return `版本对比完成：共 ${rows.length} 行差异明细，逐项变动与来源见引用来源。`;
  }
  const versions: any = facts.find((f) => f.type === 'budget_versions')?.data;
  if (Array.isArray(versions)) return summarizeVersionsText(versions, context);
  const snapshots: any = facts.find((f) => f.type === 'actual_snapshots')?.data;
  if (Array.isArray(snapshots)) {
    if (!snapshots.length) return `${context.year ? `${context.year} 年` : ''}未查询到实际快照批次。请先在历史数据维护页录入或导入实际数。`;
    return `共 ${snapshots.length} 个实际快照批次，最新为 ${snapshots[0].snapshot_date}（修订 ${snapshots[0].revision}，${snapshots[0].entry_count ?? 0} 条明细）。`;
  }
  const accuracy: any = facts.find((f) => f.type === 'accuracy')?.data;
  if (accuracy) return '预算准确率已按已关闭年度的最终快照计算，明细见引用来源。';
  return `已查询到 ${facts.length} 组后端事实数据；金额、汇总和完成率请以引用来源为准。`;
}

/**
 * 单元格备注的确定性摘要。
 *
 * 备注是录入人填写的文本，模板只做陈列与来源标注，不做任何推断与汇总；
 * 空结果如实说明「没有备注」——这是查过之后的否定，与「看不到」是两回事。
 */
function summarizeCellNotesText(budgetData: any, actualData: any): string {
  const parts: string[] = [];
  const render = (data: any, label: string) => {
    const notes: any[] = Array.isArray(data?.notes) ? data.notes : [];
    if (!notes.length) {
      parts.push(`${label}没有查询到单元格备注。`);
      return;
    }
    const lines = notes.map((n: any, index: number) =>
      `${index + 1}. ${n.orgName} × ${n.accountName}${n.cell === 'summary' ? '（汇总格批注）' : ''}：${n.note}`);
    parts.push(`${label}共 ${data.totalCount} 条单元格备注${data.truncated ? `，仅列前 ${data.shown} 条` : ''}：\n${lines.join('\n')}`);
    if (data.caveat) parts.push(String(data.caveat));
  };
  if (budgetData) render(budgetData, `预算版本「${budgetData.version?.name ?? ''}」`);
  if (actualData) render(actualData, `实际数(${actualData.year} 年)`);
  return parts.join('\n');
}

/**
 * 备注命中后的定位导航(引用衔接)：预算编制页支持 ?orgId=&accountId= 定位到具体单元格。
 * 只在用户没有显式导航意图时兜底(resolveNavigation 命中优先)，且仅在带具体过滤条件
 * 且确实查到备注时给出——「全部备注」或空结果挂一个定位按钮没有意义。
 * 实际数页不支持 URL 定位参数，不挂导航。
 */
function cellNoteNavigation(facts: FactRecord[]): NavigationTarget | null {
  const budgetNotes: any = facts
    .map((f) => f.data as any)
    .find((data) => data && data.source === 'budget' && Array.isArray(data.notes));
  if (budgetNotes?.version?.id != null
    && Array.isArray(budgetNotes.notes) && budgetNotes.notes.length > 0
    && (budgetNotes.filters?.orgId != null || budgetNotes.filters?.accountId != null)) {
    const params = new URLSearchParams();
    if (budgetNotes.filters.orgId != null) params.set('orgId', String(budgetNotes.filters.orgId));
    if (budgetNotes.filters.accountId != null) params.set('accountId', String(budgetNotes.filters.accountId));
    return {
      page: 'budget_edit',
      label: '预算编制表格',
      path: `/budget/${budgetNotes.version.id}?${params.toString()}`,
      reason: '定位到带备注的单元格',
    };
  }
  return null;
}

/**
 * 差异归因的确定性摘要。
 *
 * `rankFocus` 有值时按名次输出该名的完整明细(这是「那第二名呢」这类追问真正想要的)，
 * 没有值时给前三名概览。名次超出排行榜长度时如实说明榜内只有几项，不编造。
 */
function summarizeAttributionText(attribution: any, rankFocus: number | null): string {
  const direction = attribution.totals?.favorable === 'favorable' ? '有利'
    : attribution.totals?.favorable === 'unfavorable' ? '不利' : '持平';
  const head = `范围内净差异 ${centsToWanText(attribution.totals.varianceCents)} 万元(${direction})。`;
  const reconciled = `组织与科目两个维度的根层合计${attribution.reconciliation?.matched ? '已核对一致' : '不一致，请检查筛选范围'}。`;
  const orgLeaves: any[] = attribution.rankedOrgLeaves || [];
  const accountLeaves: any[] = attribution.rankedAccountLeaves || [];
  if (rankFocus != null) {
    const detail = (rows: any[], label: string): string => {
      if (rows.length < rankFocus) return `${label}排行榜只有 ${rows.length} 项，没有第 ${rankFocus} 名。`;
      const row = rows[rankFocus - 1];
      const share = row.shareOfTotal == null ? '' : `，占总差异 ${(Number(row.shareOfTotal) * 100).toFixed(2)}%`;
      const rate = row.rate == null ? '' : `，完成率 ${(Number(row.rate) * 100).toFixed(2)}%`;
      const path = Array.isArray(row.path) && row.path.length ? `（路径：${row.path.join(' / ')}）` : '';
      return `${label}第 ${rankFocus} 名：「${row.name}」(${row.code})${path}，`
        + `预算 ${centsToWanText(Math.abs(Number(row.budgetCents || 0)))} / 实际 ${centsToWanText(Math.abs(Number(row.actualCents || 0)))} 万元，`
        + `差异 ${centsToWanText(row.varianceCents)} 万元${share}${rate}。`;
    };
    return `${head}${detail(orgLeaves, '组织')}${detail(accountLeaves, '科目')}${reconciled}`;
  }
  const top = (rows: any[], label: string) => (rows || []).slice(0, 3)
    .map((row: any, index: number) => `第 ${index + 1} 名${label}「${row.name}」(${row.code}) ${centsToWanText(row.varianceCents)} 万元`).join('、');
  return `${head}主要科目：${top(accountLeaves, '科目') || '无'}；主要组织：${top(orgLeaves, '组织') || '无'}。`
    + `逐层展开与占比见引用来源，${reconciled}`;
}

/**
 * 财务实际数转换的确定性摘要。
 *
 * 只陈述已固化的闸门结论(解析/映射/守恒/利润表勾稽/序时簿)，不重算金额。
 * 没有任何批次时明确说「还没有转换批次」，不给「没有问题」这类结论。
 */
function summarizeFinanceText(input: { detail?: any; list?: any; mapping?: any; trials?: any }): string {
  const parts: string[] = [];
  const { detail, list, mapping, trials } = input;
  if (list && !detail) {
    if (!list.count) return '财务转换：目前还没有任何转换批次。请在「财务系统转换」页选择数据源与已锁定映射，上传余额表和官方利润表后再来看结论。';
    parts.push(`财务转换共 ${list.count} 个批次，最近一批 #${list.batches[0].id}（${list.batches[0].year} 年，截至 ${list.batches[0].snapshotDate}，状态 ${list.batches[0].status}）。`);
  }
  if (detail) {
    const gateText = (label: string, value: boolean | null) => `${label}${value === null ? '未涉及' : value ? '通过' : '未通过'}`;
    parts.push(
      `财务转换批次 #${detail.id}（${detail.year} 年，截至 ${detail.snapshotDate}，状态 ${detail.status}，`
      + `映射版本 #${detail.mappingVersionId}）：整体${detail.passed === true ? '校验通过' : detail.passed === false ? '校验未通过' : '校验结论缺失'}。`,
      `闸门：${[
        gateText('解析', detail.gates?.parse ?? null),
        gateText('映射', detail.gates?.mapping ?? null),
        gateText('金额守恒', detail.gates?.conservation ?? null),
        gateText('利润表勾稽', detail.gates?.reconciliation ?? null),
        gateText('序时簿核验', detail.gates?.journal ?? null),
      ].join('、')}。`,
    );
    if (detail.errors?.total) {
      parts.push(`阻断错误 ${detail.errors.total} 条：${detail.errors.shown.slice(0, 3).map((e: any) => `[${e.gate}/${e.code}] ${e.message}`).join('；')}${detail.errors.hidden ? `，另有 ${detail.errors.hidden} 条见引用来源` : ''}。`);
    }
    if (detail.reconciliation?.failedCount) {
      parts.push(`利润表勾稽未通过 ${detail.reconciliation.failedCount} 项（共 ${detail.reconciliation.ruleCount} 项规则），差异明细见引用来源。`);
    }
    if (detail.journalVerification?.provided && detail.journalVerification.mismatchCount) {
      parts.push(`序时簿与余额表有 ${detail.journalVerification.mismatchCount} 个科目对不上（容差 ${detail.journalVerification.toleranceCents} 分）。`);
    }
    if (detail.importBatchId) parts.push(`已生成下游导入批次 #${detail.importBatchId}。`);
    if (detail.passed === true && !detail.errors?.total) parts.push('该批次全部闸门通过，可创建导入预览并人工确认。');
  }
  if (mapping) {
    parts.push(
      `映射版本 #${mapping.id}「${mapping.name}」（${mapping.status}）：组织规则 ${mapping.counts.orgRules} 条、`
      + `科目规则 ${mapping.counts.activeAccountRules} 条有效/${mapping.counts.inactiveAccountRules} 条停用、勾稽规则 ${mapping.counts.reconciliationRules} 条。`
      + `映射校验${mapping.validation.passed ? '通过' : `未通过，共 ${mapping.validation.errorCount} 项：${mapping.validation.errors.shown.slice(0, 3).map((e: any) => e.message).join('；')}`}。`,
    );
    parts.push('注意：「未映射的源科目」只有在实际转换某个文件时才能判定（范围内未映射即失败关闭），映射校验本身不预判源文件里会出现哪些科目。');
  }
  if (trials?.count) {
    const first = trials.trials[0];
    parts.push(
      `并行试运行 ${trials.count} 次，最近一次 #${first.id}：组合 ${first.totalCombinations ?? '未知'} 个，`
      + `差异 ${first.mismatchCount} 个，状态 ${first.status}${first.reviewedBy ? `，复核人 ${first.reviewedBy}` : ''}。`,
    );
  } else if (trials) {
    parts.push('该批次还没有并行试运行记录，未与原手工结果做过逐组合比较。');
  }
  return parts.join('');
}

/** 执行分析的确定性摘要：总量、完成率、时间进度与指标净额，全部来自后端事实。 */
function summarizeExecutionText(execution: any): string {
  const parts: string[] = [
    `预算执行事实查询：版本「${execution.version.name}」（${execution.version.year} 年，${execution.version.status}）`
    + `，实际取数 ${execution.actualSource || '未知'}，截至 ${execution.asOfDate || '当前可用快照'}。`,
  ];
  // 顶层科目按类型汇总。存储中成本费用为负数，展示口径统一翻正。
  const totalsByType = new Map<string, { budgetCents: number; actualCents: number }>();
  for (const row of execution.analysisAccounts || []) {
    if (row.level !== 0 || !['income', 'cost', 'expense'].includes(row.type)) continue;
    const prev = totalsByType.get(row.type) ?? { budgetCents: 0, actualCents: 0 };
    totalsByType.set(row.type, {
      // 与全仓一致走 safeIntegerAdd：这里是展示用汇总，溢出概率低，
      // 但金额汇总不该出现第二种写法(独立审计指出的最后一处裸加法)。
      budgetCents: safeIntegerAdd(prev.budgetCents, Math.trunc(Number(row.cell?.budgetCents || 0)), '执行摘要预算汇总'),
      actualCents: safeIntegerAdd(prev.actualCents, Math.trunc(Number(row.cell?.actualCents || 0)), '执行摘要实际汇总'),
    });
  }
  const money: string[] = [];
  for (const [type, label] of [['income', '收入'], ['cost', '成本'], ['expense', '费用']] as const) {
    const totals = totalsByType.get(type);
    if (!totals || (!totals.budgetCents && !totals.actualCents)) continue;
    const displaySign = type === 'income' ? 1 : -1;
    /* 翻正与完成率都走 core/money 的确定性口径:金额汇总已由 safeIntegerAdd 保证整数,
       完成率与报表的 na_zero_budget/na_negative_budget 语义对齐,不再自己写一套浮点判定。 */
    const budgetDisplay = totals.budgetCents * displaySign;
    const actualDisplay = totals.actualCents * displaySign;
    const rateValue = completionRate(actualDisplay, budgetDisplay);
    const rate = budgetDisplay === 0
      ? '不适用(预算为 0)'
      : rateValue == null
        ? '不适用(预算为负)'
        : `${(rateValue * 100).toFixed(1)}%`;
    money.push(`${label}预算 ${centsToWanText(budgetDisplay)} / 实际 ${centsToWanText(actualDisplay)} 万元，完成率 ${rate}`);
  }
  if (money.length) parts.push(`${money.join('；')}。`);
  /**
   * 数量科目单独成句。
   *
   * 实测背景：「2026年发电量完成了多少」路由到执行分析后，金额汇总全是 0（数量与金额隔离），
   * 摘要却只讲金额，读起来像「没有数据」。数量按 10^4 缩放整数存储，这里只做除法展示，
   * 并带上该科目自己的单位。
   */
  const quantityRows = (execution.analysisAccounts || [])
    .filter((row: any) => row.type === 'quantity' && row.isLeaf
      && (Number(row.cell?.budgetQuantity || 0) !== 0 || Number(row.cell?.actualQuantity || 0) !== 0))
    .slice(0, 3)
    .map((row: any) => {
      const unit = row.unit ? String(row.unit) : '';
      const budget = Number(row.cell?.budgetQuantity || 0) / QUANTITY_SCALE;
      const actualValue = Number(row.cell?.actualQuantity || 0) / QUANTITY_SCALE;
      const rate = row.cell?.rate == null ? null : `${(Number(row.cell.rate) * 100).toFixed(1)}%`;
      return `${row.name}(${row.code}) 预算 ${budget.toFixed(2)} / 实际 ${actualValue.toFixed(2)} ${unit}`
        + `${rate ? `，完成率 ${rate}` : ''}`;
    });
  if (quantityRows.length) parts.push(`数量科目：${quantityRows.join('；')}。`);
  if (execution.timeProgressValue != null) {
    parts.push(`时间进度 ${(Number(execution.timeProgressValue) * 100).toFixed(1)}%（均匀自然日口径，仅用于节奏对比）。`);
  }
  // 只列有数的指标：范围缩到数量科目或单一科目时，指标全为 0，列出来只会让人以为没数据。
  const metrics = (execution.metrics || [])
    .filter((m: any) => Number(m.cell?.budgetCents || 0) !== 0 || Number(m.cell?.actualCents || 0) !== 0)
    .slice(0, 4)
    .map((m: any) => {
      const displaySign = m.displaySign === -1 ? -1 : 1;
      return `${m.name} 预算 ${centsToWanText((m.cell?.budgetCents ?? 0) * displaySign)}`
        + ` / 实际 ${centsToWanText((m.cell?.actualCents ?? 0) * displaySign)} 万元`;
    });
  if (metrics.length) parts.push(`指标：${metrics.join('；')}。`);
  if (Number(execution.unbudgetedActual?.count || 0) > 0) {
    parts.push(
      `未预算/新增结构实际 ${execution.unbudgetedActual.count} 条，净额 ${centsToWanText(execution.unbudgetedActual.amountCents || 0)} 万元，`
      + `已进入承接区；来源实际对账差额 ${centsToWanText(execution.reconciliation?.differenceCents || 0)} 万元。`,
    );
  }
  parts.push('逐组织、逐科目明细与差异方向见引用来源。');
  return parts.join('');
}

/** 异常检查的确定性摘要：命中数量按规则分组列出。 */
function summarizeAnomalyText(anomalies: any): string {
  const counts = anomalies.countsByCode && typeof anomalies.countsByCode === 'object'
    ? Object.entries(anomalies.countsByCode as Record<string, number>).filter(([, count]) => Number(count) > 0)
    : [];
  const detail = counts.length ? `（${counts.map(([code, count]) => `${code} ${count} 条`).join('、')}）` : '';
  return `异常与质量检查：共执行 ${(anomalies.checks || []).length} 项规则，命中 ${anomalies.anomalies.length} 条${detail}。`
    + `阈值：完成率 ${anomalies.threshold}、同比 ${anomalies.yoyThreshold}、同类 ${anomalies.peerThreshold}。明细与判定依据见引用来源。`;
}

/** 版本列表的确定性摘要。 */
function summarizeVersionsText(versions: any[], context: AssistantContext): string {
  if (!versions.length) return `${context.year ? `${context.year} 年` : ''}还没有任何预算或预测版本。可在预算版本页新建，或让我基于历史预算/实际生成草案（需确认）。`;
  const current = versions.filter((v: any) => v.is_current === 1)
    .map((v: any) => `${v.kind === 'forecast' ? '预测' : '预算'}当前生效「${v.name}」(${v.status})`);
  const list = versions.slice(0, 8)
    .map((v: any) => `${v.year} 年「${v.name}」${v.kind === 'forecast' ? '[预测]' : ''}(${v.status}${v.is_current === 1 ? '，当前生效' : ''})`);
  return `共 ${versions.length} 个版本${context.year ? `（${context.year} 年）` : ''}。${current.length ? `${current.join('；')}。` : ''}`
    + `列表：${list.join('；')}${versions.length > 8 ? ' 等' : ''}。`;
}

/** 上下文相关建议:只根据已获得的事实和缺失条件生成，全部标记为建议供用户点击。 */
function buildSuggestions(facts: FactRecord[], context: AssistantContext, navigation: NavigationTarget | null): string[] {
  const out: string[] = [];
  const has = (type: string) => facts.some((f) => f.type === type);
  for (const f of facts.filter((x) => x.type === 'missing_context')) {
    const data: any = f.data;
    const fields: string[] = data?.fields ? data.fields : data?.field ? [data.field] : [];
    if (fields.length) out.push(`补充 ${fields.join(' 与 ')} 后重新提问（${data?.reason || '缺少必要条件'}）`);
  }
  if (navigation) out.push(`打开「${navigation.label}」页面`);
  if (context.budgetVersionId == null) out.push('选择预算版本以分析执行、异常与质量');
  else {
    if (!has('execution')) out.push('分析该版本的预算执行与完成率');
    if (!has('anomalies')) out.push('运行异常与质量检查（七类规则）');
    out.push('导出当前口径的完成情况');
  }
  if (has('execution') || has('report_draft')) out.push('按组织和科目逐层展开差异归因');
  if (has('attribution')) out.push('生成执行月报(含归因与异常)');
  if (has('anomalies') || has('execution') || has('attribution')) out.push('把本次分析结果保存为洞察');
  if (has('budget_versions')) out.push('以上一版预算或实际为基准生成草案（需确认）');
  if (context.year == null) out.push('补充年度以计算预算准确率与历年对比');
  else out.push('生成年度复盘材料');
  if (has('import_batches') || has('import_batch') || has('import_help')) out.push('解释导入错误并列出未匹配项');
  return [...new Set(out)].slice(0, 5);
}

function compactForModel(value: unknown, depth = 0, collectionLimit = 100, stringLimit = 4_000): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > stringLimit ? `${value.slice(0, stringLimit)}…[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, collectionLimit).map((item) => compactForModel(item, depth + 1, collectionLimit, stringLimit));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).slice(0, collectionLimit)) out[key] = compactForModel((value as Record<string, unknown>)[key], depth + 1, collectionLimit, stringLimit);
    return out;
  }
  return value;
}

/** 始终返回语法完整的 JSON；超限时逐级收紧结构化摘要，绝不截断 JSON 字节。 */
function stringifyForModel(value: unknown, maxChars: number): string {
  for (const limit of [100, 50, 20, 10, 5, 2]) {
    const json = JSON.stringify(compactForModel(value, 0, limit, Math.min(4_000, Math.floor(maxChars / 4))));
    if (json.length <= maxChars) return json;
  }
  return JSON.stringify({ truncated: true, summary: compactForModel(value, 0, 1, 200) });
}

/* ------------------------------------------------------------------ *
 * 写操作参数抽取(方案 4.2)
 *
 * 两条路径：模型抽取(优先) + 规则兜底。两者产出的参数都必须通过
 * normalizePreview 校验才会返回给前端，且返回的只是「建议」，
 * 真正落库仍要走 preview → confirm 并携带确认令牌。
 * ------------------------------------------------------------------ */

/** 「增长 5%」「下调 3 个点」→ ±0.05 / -0.03。没有明确增减词时返回 0。 */
function parseGrowthRate(message: string): number {
  const hit = message.match(/(增长|上升|提高|增加|上涨|翻|下降|下调|减少|降低|压减|缩减)\s*(?:了)?\s*([+-]?\d+(?:\.\d+)?)\s*(?:%|％|个点|个百分点|成)?/);
  if (!hit) return 0;
  const value = Number(hit[2]);
  if (!Number.isFinite(value)) return 0;
  const negative = /下降|下调|减少|降低|压减|缩减/.test(hit[1]);
  const rate = value / 100;
  const bounded = Math.min(10, Math.max(-1, negative ? -rate : rate));
  return Number(bounded.toFixed(6));
}

/** 按出现顺序取出消息里的年份。 */
function parseYears(message: string): number[] {
  return [...message.matchAll(/(?<![\d.])((?:19|20)\d{2})(?![\d.])/g)].map((m) => Number(m[1]));
}

/** 「叫做 X」「命名为 X」「名字用 X」→ 版本名。带引号时允许名称内含空格。 */
function parseName(message: string): string | null {
  const trigger = '(?:叫做|叫作|叫|命名为|名为|名字(?:用|叫)?|取名)';
  const quoted = message.match(new RegExp(`${trigger}\\s*[「"'『]([^」"'』]{1,60})[」"'』]`));
  if (quoted) return quoted[1].trim() || null;
  const bare = message.match(new RegExp(`${trigger}\\s*([^\\s，。,；;、）)]{1,60})`));
  return bare ? bare[1].trim() || null : null;
}

/** 基准来源：实际 / 历史快照 / 预算。 */
function parseBaseFrom(message: string, context: AssistantContext): { baseFrom: 'budget' | 'actual' | 'actual_snapshot'; baseSnapshotId?: number } {
  if (/快照/.test(message) && context.actualSnapshotId != null) return { baseFrom: 'actual_snapshot', baseSnapshotId: context.actualSnapshotId };
  if (/实际(?:数|值|完成)?/.test(message)) return { baseFrom: 'actual' };
  return { baseFrom: 'budget' };
}

/**
 * 规则兜底的写操作推断。
 *
 * 相比旧实现不再把 baseFrom / baseYear / name 写死：基准来源、基准年度、目标年度、
 * 名称、导出类型和格式都从消息里解析，解析不出来才用保守默认值。
 */
function inferActionFromRules(
  db: DB,
  message: string,
  context: AssistantContext,
  detection: IntentDetection,
): { type: string; params: Record<string, unknown> } | null {
  if (!detection.write.length) return null;
  const growthRate = parseGrowthRate(message);
  const years = parseYears(message);
  const name = parseName(message);
  const wants = (intent: string) => detection.write.includes(intent as never);

  if (wants('copy_budget') && context.budgetVersionId != null) {
    const source = (() => { try { return budget.getVersion(db, context.budgetVersionId!); } catch { return null; } })();
    const sourceYear = source?.year ?? context.year ?? new Date().getFullYear();
    // 目标年度取消息里与源版本年度不同的那个；没有就沿用源年度。
    const targetYear = years.find((y) => y !== sourceYear) ?? sourceYear;
    return {
      type: 'copy_budget',
      params: {
        sourceVersionId: context.budgetVersionId,
        targetYear,
        name: name || `${source?.name ?? '预算'} 副本${targetYear !== sourceYear ? `(${targetYear})` : ''}`,
        growthRate,
      },
    };
  }
  if (wants('budget_draft')) {
    const base = parseBaseFrom(message, context);
    // 两个年份时较大的是目标年度、较小的是基准年度。
    const sorted = [...new Set(years)].sort((a, b) => a - b);
    const year = sorted.length >= 2 ? sorted[sorted.length - 1] : sorted[0] ?? context.year ?? new Date().getFullYear();
    const baseYear = sorted.length >= 2 ? sorted[0] : year - 1;
    return {
      type: 'budget_draft',
      params: {
        year,
        name: name || `${year} 年草案`,
        baseFrom: base.baseFrom,
        baseYear,
        ...(base.baseSnapshotId == null ? {} : { baseSnapshotId: base.baseSnapshotId }),
        growthRate,
        kind: /预测/.test(message) ? 'forecast' : 'budget',
      },
    };
  }
  if (wants('scenario')) {
    if (context.budgetVersionId == null) return null;
    const categoryRate = (words: RegExp, fallback: number) => {
      const match = message.match(new RegExp(`${words.source}[^%％]{0,12}([+-]?\\d+(?:\\.\\d+)?)\\s*(?:%|％|个点)`));
      if (!match) return fallback;
      const negative = /下降|下调|减少|降低|压减/.test(match[0]);
      return Number(match[1]) / 100 * (negative ? -1 : 1);
    };
    const preset = /保守|悲观/.test(message) ? 'conservative' : /进取|乐观|激进/.test(message) ? 'aggressive' : 'baseline';
    const targetProfit = message.match(/目标利润\s*([0-9.]+)\s*(万元|万|元)?/);
    return {
      type: 'scenario',
      params: {
        versionId: context.budgetVersionId,
        preset,
        incomeGrowth: categoryRate(/收入/, 0),
        costGrowth: categoryRate(/成本/, 0),
        expenseGrowth: categoryRate(/费用/, 0),
        ...(targetProfit
          ? { targetProfit: /万/.test(targetProfit[2] || '') ? wanStringToYuanString(targetProfit[1]) : targetProfit[1] }
          : {}),
      },
    };
  }
  if (wants('export')) {
    const kind = /预算明细|明细表|预算表/.test(message) ? 'budget_detail'
      : /实际(?:数|值)|累计实际/.test(message) ? 'actual_current'
        : 'completion';
    const format = /csv/i.test(message) ? 'csv' : 'xlsx';
    if (kind === 'actual_current') {
      const year = context.year ?? years[0];
      return year == null ? null : { type: 'export', params: { kind, year, format } };
    }
    if (context.budgetVersionId == null) return null;
    return { type: 'export', params: { kind, versionId: context.budgetVersionId, format } };
  }
  // bulk_adjustment 与 basis_text 需要逐格金额或用户提供的原文，不做推断。
  return null;
}

/** 模型只允许提出这些字段；其余一律丢弃，避免把任意 JSON 透传进业务参数。 */
const PROPOSAL_FIELDS: Record<string, string[]> = {
  copy_budget: ['sourceVersionId', 'targetYear', 'name', 'note', 'growthRate'],
  budget_draft: ['year', 'name', 'baseFrom', 'baseYear', 'baseSnapshotId', 'growthRate', 'kind', 'note'],
  scenario: ['versionId', 'preset', 'incomeGrowth', 'costGrowth', 'expenseGrowth', 'targetProfit', 'targetProfitCents', 'batchId', 'orgScopeId', 'accountScopeId'],
  export: ['kind', 'format', 'versionId', 'year', 'options'],
  basis_text: ['title', 'text', 'citations'],
};

/** 从模型输出里抽出 JSON 对象。允许被 Markdown 代码块包裹。 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * 让模型把自然语言写操作请求转成结构化参数(方案 4.2)。
 *
 * 只在识别到写意图时调用；只保留白名单字段；参数必须能通过 normalizePreview
 * 构造出预览才返回。任何异常都退回规则推断，绝不写入业务数据。
 */
async function proposeActionViaModel(
  db: DB,
  message: string,
  digest: unknown,
  detection: IntentDetection,
  signal?: AbortSignal,
): Promise<{ type: string; params: Record<string, unknown>; reason?: string } | null> {
  if (!detection.write.length || !modelConfigured()) return null;
  const model = new EnvChatModel('chat');
  const result = await model.complete({
    messages: [
      { role: 'system', content: buildActionProposalPrompt({ digest, candidates: detection.write }) },
      { role: 'user', content: message.slice(0, 4_000) },
    ],
    signal,
  });
  const parsed = extractJsonObject(result.text);
  if (!parsed) return null;
  const rawType = typeof parsed.type === 'string' ? parsed.type.trim().toLowerCase().replace(/^preview[_-]/, '').replace(/-/g, '_') : '';
  if (!rawType || !ACTION_TYPES.has(rawType) || rawType === 'bulk_adjustment') return null;
  const allowed = PROPOSAL_FIELDS[rawType] ?? [];
  const source = plainObject(parsed.params);
  const params: Record<string, unknown> = {};
  for (const key of allowed) if (source[key] != null) params[key] = source[key];
  if (!Object.keys(params).length) return null;
  return {
    type: rawType,
    params,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : undefined,
  };
}

/**
 * 校验候选 action：用 normalizePreview 做一次「干跑」。
 * normalizePreview 只读取数据并计算差异，不写任何业务数据，因此可以安全地
 * 用来判断参数是否真的能构造出预览。
 */
function actionIsConstructible(db: DB, type: string, params: Record<string, unknown>): { ok: true } | { ok: false; message: string } {
  try {
    normalizePreview(db, type, params);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export interface ProposedAction {
  type: string;
  params: Record<string, unknown>;
  /** model = 模型抽取参数；rules = 关键词兜底 */
  source: 'model' | 'rules';
  /** 参数已通过 normalizePreview 干跑校验，可直接调用 /assistant/preview */
  previewable: boolean;
  reason?: string;
  /** previewable=false 时说明缺什么 */
  validationMessage?: string;
  /** true 表示这是上一轮的操作建议(本轮没有重述写请求)，参数已重新干跑校验 */
  inherited?: boolean;
}

/** 先让模型抽参数，失败或不可构造时退回规则推断。 */
async function resolveProposedAction(
  db: DB,
  message: string,
  context: AssistantContext,
  detection: IntentDetection,
  digest: unknown,
  signal?: AbortSignal,
): Promise<ProposedAction | null> {
  const candidates: { candidate: { type: string; params: Record<string, unknown>; reason?: string }; source: 'model' | 'rules' }[] = [];
  if (detection.write.length && modelConfigured()) {
    try {
      const proposal = await proposeActionViaModel(db, message, digest, detection, signal);
      if (proposal) candidates.push({ candidate: proposal, source: 'model' });
    } catch {
      if (signal?.aborted) {
        const error = new Error('客户端已取消请求');
        error.name = 'AbortError';
        throw error;
      }
      // 模型抽参失败不影响规则兜底
    }
  }
  const rules = inferActionFromRules(db, message, context, detection);
  if (rules) candidates.push({ candidate: rules, source: 'rules' });
  let firstInvalid: ProposedAction | null = null;
  for (const { candidate, source } of candidates) {
    const check = actionIsConstructible(db, candidate.type, candidate.params);
    if (check.ok) return { ...candidate, source, previewable: true };
    if (!firstInvalid) firstInvalid = { ...candidate, source, previewable: false, validationMessage: check.message };
  }
  return firstInvalid;
}

/* ------------------------------------------------------------------ *
 * 会话历史与上下文继承(方案 5.6)
 * ------------------------------------------------------------------ */

/**
 * 上一轮助手回答里可继承的信息。
 *
 * - `context`：已解析出的上下文，用于「那第二名呢」这类无上下文追问；
 * - `read`：已识别的只读意图，用于纯追问时的话题延续(见 intent.ts:withInheritedIntents)；
 * - `action`：上一轮给出的操作建议。用户回一句「确认执行」时本轮识别不到写意图，
 *   如果不把它挂回来，界面上的「创建预览」按钮就消失了，用户只能重述整句话。
 *
 * 三者来自同一条 response_json，因此一次查询取回，避免重复读同一行。
 */
function inheritedTurn(db: DB, conversationId: number): { context: AssistantContext; read: string[]; action: ProposedAction | null } {
  const row = db.prepare(
    "SELECT response_json FROM ai_message WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
  ).get(conversationId) as { response_json: string } | undefined;
  if (!row) return { context: {}, read: [], action: null };
  const parsed = parseJson<Record<string, unknown>>(row.response_json, {});
  let context: AssistantContext = {};
  try { context = normalizeContext(plainObject(parsed.resolvedContext)); } catch { context = {}; }
  const intents = plainObject(parsed.intents);
  const read = Array.isArray(intents.read) ? intents.read.filter((value): value is string => typeof value === 'string') : [];
  const rawAction = plainObject(parsed.action);
  const action = typeof rawAction.type === 'string' && rawAction.type
    ? {
      type: rawAction.type,
      params: plainObject(rawAction.params),
      source: rawAction.source === 'model' ? 'model' as const : 'rules' as const,
      previewable: rawAction.previewable === true,
      reason: typeof rawAction.reason === 'string' ? rawAction.reason : undefined,
    }
    : null;
  return { context, read, action };
}

/** 单条事实的历史摘要：只留识别信息与排行榜头部，避免把整份报表塞回提示词。 */
function factForHistory(record: { type: string; data?: unknown; source?: unknown }): unknown {
  const data: any = record.data;
  const base = { type: record.type, source: record.source };
  const factType = record.type.replace(/^tool:/, '');
  if (!data || typeof data !== 'object') return { ...base, data };
  if (factType === 'attribution' || factType === 'calculate_attribution') {
    return {
      ...base,
      totals: data.totals,
      rankedAccountLeaves: (data.rankedAccountLeaves || []).slice(0, 5),
      rankedOrgLeaves: (data.rankedOrgLeaves || []).slice(0, 5),
    };
  }
  if (factType === 'execution' || factType === 'calculate_execution') {
    return {
      ...base,
      version: data.version,
      asOfDate: data.asOfDate,
      timeProgressValue: data.timeProgressValue,
      metrics: (data.metrics || []).map((m: any) => ({ code: m.code, name: m.name, displaySign: m.displaySign, cell: m.cell })).slice(0, 6),
    };
  }
  if (factType === 'anomalies' || factType === 'calculate_anomalies') {
    return { ...base, anomalyCount: data.anomalyCount, countsByCode: data.countsByCode, anomalies: (data.anomalies || []).slice(0, 5) };
  }
  if (factType === 'report_draft' || factType === 'draft_report') {
    return { ...base, kind: data.kind, sections: (data.sections || []).map((s: any) => ({ key: s.key, title: s.title, bullets: (s.bullets || []).slice(0, 4) })) };
  }
  return { ...base, data: compactForModel(data, 0, 5, 300) };
}

/**
 * 构造给模型的历史消息。
 *
 * 旧实现只回灌 role+content(纯文本)，模型看不到上一轮的结构化事实，
 * 所以「那第二名呢」「再往下拆一层」这类追问接不上。这里把 response_json
 * 里的事实压成有界摘要一起回灌。
 */
function historyMessagesForModel(db: DB, conversationId: number, limit = 10): any[] {
  const rows = (db.prepare(
    'SELECT role,content,response_json FROM ai_message WHERE conversation_id=? ORDER BY id DESC LIMIT ?',
  ).all(conversationId, limit) as { role: string; content: string; response_json: string }[]).reverse();
  return rows.map((row) => {
    // 正文同样截断:assistant 允许 10 万字符,10 条原文回灌即近 MB 级,
    // 放大按 token 计费的模型成本且可能超供应商上下文窗口
    const content = row.content.length > 4_000 ? `${row.content.slice(0, 4_000)}…[已截断]` : row.content;
    if (row.role !== 'assistant') return { role: row.role, content };
    const parsed = parseJson<Record<string, any>>(row.response_json, {});
    const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 6).map(factForHistory) : [];
    if (!facts.length) return { role: 'assistant', content };
    const summary = stringifyForModel(facts, 4_000);
    return { role: 'assistant', content: `${content}\n[上一轮结构化事实(可直接引用，勿改数字)]${summary}` };
  });
}

/* ------------------------------------------------------------------ *
 * 对话主流程
 * ------------------------------------------------------------------ */

/** 单轮工具调用上限:每轮调用数由模型输出决定,而多数工具是全库级同步重计算,
 *  不设上限时一次 chat 可被放大成数百次同步查询把单进程打满(请求级限流管不住单请求内放大)。
 *  超出部分不执行,以错误作为 tool 消息回给模型。 */
const MAX_TOOL_CALLS_PER_ROUND = 8;

/** 工具调用结果转事实记录，并把调用与结果写回消息列表供模型继续推理。 */
function runToolCalls(
  db: DB,
  calls: { id?: string; name: string; arguments: Record<string, unknown> }[],
  round: number,
  context: AssistantContext,
  messages: any[],
  allowedTools?: ReadonlySet<string>,
): FactRecord[] {
  const out: FactRecord[] = [];
  for (const [callIndex, call] of calls.entries()) {
    const callId = call.id || `call-${round}-${callIndex}`;
    let data: unknown;
    if (callIndex >= MAX_TOOL_CALLS_PER_ROUND) {
      data = { error: `单轮工具调用数超过上限 ${MAX_TOOL_CALLS_PER_ROUND} 个,请精简为最必要的查询后重试`, code: 'TOO_MANY_TOOL_CALLS' };
    } else if (allowedTools && !allowedTools.has(call.name)) {
      // 模型只暴露本轮 PageCapabilityMap 允许的领域能力(§9.3)。
      data = { error: `当前页面不提供该查询能力(${call.name})，请改用页面允许的只读工具`, code: 'CAPABILITY_UNAVAILABLE' };
    } else {
      try { data = executeTool(db, call.name, call.arguments); }
      catch (err) { data = { error: err instanceof Error ? err.message : String(err) }; }
    }
    const toolData: any = data as any;
    // 事实来源只标注工具真实声明的入参维度:没有 year/versionId/batchId 入参的工具
    // (get_org_tree、list_backups 等)不得贴上当前上下文 ID;非法入参回落为空而非 NaN。
    const safeInt = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : null;
    };
    out.push({
      type: `tool:${call.name}`,
      data,
      source: {
        year: toolAcceptsParam(call.name, 'year') ? (safeInt(call.arguments?.year) ?? context.year) : undefined,
        budgetVersionId: toolAcceptsParam(call.name, 'versionId') ? (safeInt(call.arguments?.versionId) ?? context.budgetVersionId ?? null) : null,
        actualSnapshotId: toolAcceptsParam(call.name, 'batchId') ? (safeInt(call.arguments?.batchId) ?? context.actualSnapshotId ?? null) : null,
        asOf: typeof toolData?.asOfDate === 'string' ? toolData.asOfDate : now(),
      },
    });
    messages.push(
      { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
      { role: 'tool', tool_call_id: callId, name: call.name, content: stringifyForModel(data, 20_000) },
    );
  }
  return out;
}

const MAX_TOOL_ROUNDS = 4;
/* 单次 chat 的工具调用总次数上限:MAX_TOOL_CALLS_PER_ROUND × MAX_TOOL_ROUNDS = 32 次
   同步重型计算(execution/attribution/completionReport 全库级)仍可把单进程占满十几秒×,
   请求级限流(30/min)管不住单请求内放大。这里再压一道总量闸,超额以错误回给模型。 */
const MAX_TOTAL_TOOL_CALLS = 12;

interface RoutingOutcome {
  facts: FactRecord[];
  text: string;
  model: string;
  /** 本轮向模型发出的请求次数(路由轮 + 作答轮 + 兜底轮)，用于度量成本 */
  modelCalls: number;
  /** 模型请求累计耗时毫秒 */
  modelMs: number;
  /** 实际执行的只读工具调用次数 */
  toolCalls: number;
  /** true 表示模型确实调用了只读工具完成路由 */
  routed: boolean;
  /**
   * 模型全程没产出可用内容(空正文、空工具调用)时的说明。
   *
   * 有值时调用方必须按「模型不可用」处理：走确定性兜底并把这里的原因如实写进
   * `modelError`，不能标成 routing='model'，否则前端会显示「模型路由」却拿到模板文案。
   */
  degraded: string | null;
}

const MODEL_EMPTY_REASON = '模型未返回可用内容，已改用后端确定性结果';

/**
 * 模型优先的意图路由(方案 3、5.6)。
 *
 * 与旧实现的关键区别：不再由后端按关键词预先算好重型报表再塞给模型，
 * 而是先给一份只含 ID/名称/状态的上下文摘要，让模型自己调用需要的只读工具。
 * 这样「哪个厂亏得最多」这类没有关键词的问题也能路由到差异归因，
 * 而「利润为什么低于预算」不会把同一份 completionReport 算两遍。
 *
 * 模型一次工具都没调用时，用正则兜底取事实，再让模型基于这些事实作答，
 * 避免出现「没有任何后端事实支撑的自由发挥」。
 */
async function runModelRouting(
  db: DB,
  input: {
    message: string;
    context: AssistantContext;
    detection: IntentDetection;
    digest: unknown;
    conversationId: number;
    /** 本轮允许的领域能力工具集(V2 页面口径)；缺省不限制(旧客户端)。 */
    allowedTools?: ReadonlySet<string>;
  },
  emit?: (chunk: string) => void,
  onProgress?: (event: ChatProgress) => void,
  signal?: AbortSignal,
): Promise<RoutingOutcome> {
  const model = new EnvChatModel('chat');
  const messages: any[] = [
    {
      role: 'system',
      content: buildRoutingPrompt({
        digest: input.digest,
        intentHints: input.detection.hints,
        suppressed: input.detection.suppressed,
        inheritedIntents: input.detection.inheritedRead,
      }),
    },
    ...historyMessagesForModel(db, input.conversationId),
    { role: 'user', content: input.message },
  ];
  const toolFacts: FactRecord[] = [];
  let modelName = 'configured';
  /** 模型调用度量：次数与累计耗时，随响应返回并写入操作日志，便于估算用量。 */
  const usage = { modelCalls: 0, modelMs: 0, toolCalls: 0 };
  /** V2 页面口径下只暴露页面允许的领域能力工具(§9.3)。 */
  /** 同时按当前身份过滤(AC-F24):不向模型暴露必然被拒的工具。 */
  const roundToolDefinitions = toolDefinitions.filter((def) =>
    (!input.allowedTools || input.allowedTools.has(def.function.name)) && toolAllowed(def.function.name));

  /**
   * 跑一轮请求。
   *
   * `emitLive` 控制是否把正文实时转发给客户端：只有「确定是最终作答」的那一轮才转发，
   * 否则模型先自由发挥、后又被兜底事实覆盖时，客户端会看到两段拼在一起的文字。
   */
  const runRound = async (withTools: boolean, emitLive: boolean) => {
    usage.modelCalls += 1;
    const startedAt = Date.now();
    let buffered = '';
    let last: { text: string; model?: string; toolCalls?: { id?: string; name: string; arguments: Record<string, unknown> }[] } | null = null;
    for await (const event of model.streamChat({ messages, ...(withTools ? { tools: roundToolDefinitions } : {}), signal })) {
      if (event.type === 'text') { buffered += event.text; if (emitLive) emit?.(event.text); }
      else last = event.result;
    }
    if (!last) last = { text: buffered };
    if (last.model) modelName = last.model;
    usage.modelMs += Date.now() - startedAt;
    return last;
  };

  // 第 0 轮是路由轮：正文先缓冲，因为可能被兜底事实作答覆盖。
  let result = await runRound(true, false);
  let firstRoundText = (result.text || '').trim();
  let totalToolCalls = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS && result.toolCalls?.length; round++) {
    for (const call of result.toolCalls) {
      onProgress?.({ stage: 'tool', label: `正在${toolLabel(call.name)}`, detail: call.name });
    }
    /* 总量闸:超过 MAX_TOTAL_TOOL_CALLS 的调用截断,以错误回给模型而不是继续执行。 */
    const callsThisRound = result.toolCalls;
    const allowedThisRound = Math.max(0, MAX_TOTAL_TOOL_CALLS - totalToolCalls);
    const executable = callsThisRound.slice(0, allowedThisRound);
    const overflow = callsThisRound.slice(allowedThisRound);
    usage.toolCalls += callsThisRound.length;
    toolFacts.push(...runToolCalls(db, executable, round, input.context, messages, input.allowedTools));
    for (const call of overflow) {
      messages.push({ role: 'tool', tool_call_id: call.id || `overflow-${call.name}`, name: call.name, content: JSON.stringify({ error: `单次对话工具调用总数超过上限 ${MAX_TOTAL_TOOL_CALLS} 个,请基于已取到的事实作答`, code: 'TOO_MANY_TOOL_CALLS_TOTAL' }) });
    }
    totalToolCalls += executable.length;
    onProgress?.({ stage: 'answer', label: '事实已取到，正在组织回答' });
    // 工具已执行，之后的轮次就是作答轮，可以实时转发。
    result = await runRound(true, true);
    firstRoundText = '';
  }
  let text = (result.text || '').trim() || firstRoundText;
  // 工具轮预算用尽时模型可能还在要工具，从没进入作答轮，此时 text 是空的。
  // 再跑一轮「不给工具」强制它用已取到的事实作答，否则正文会掉回通用模板，
  // 而 routed=true 又让前端显示「模型路由」，用户看到的是一句没有信息的套话。
  if (!text && toolFacts.length) {
    messages.push({ role: 'system', content: buildFinalAnswerPrompt() });
    const forced = await runRound(false, true);
    text = (forced.text || '').trim();
  }
  const modelProducedNothing = !text;

  if (!toolFacts.length) {
    // 模型没有路由：用正则兜底取事实，再让模型基于事实作答(不再给工具，避免来回)。
    onProgress?.({ stage: 'fallback', label: '模型未调用工具，改用关键词兜底取数' });
    const fallback = queryFacts(db, input.message, input.context, { intents: input.detection, includeExtras: false });
    if (fallback.length) {
      const factsJson = stringifyForModel(fallback.map((f) => ({ type: f.type, source: f.source, data: f.data })), 60_000);
      messages.push({ role: 'system', content: buildFallbackFactsPrompt(factsJson) });
      const narrated = await runRound(false, true);
      const narratedText = (narrated.text || '').trim();
      if (narratedText) return { facts: fallback, text: narratedText, model: modelName, routed: true, degraded: null, ...usage };
      // 两轮都没拿到正文：交给调用方按「模型不可用」统一兜底，不在这里伪装成模型路由。
      return { facts: [], text: '', model: modelName, routed: false, degraded: MODEL_EMPTY_REASON, ...usage };
    }
  }
  // 到这里 text 尚未转发过(路由轮是缓冲的)，交由调用方决定如何输出。
  if (text && !toolFacts.length) emit?.(text);
  return {
    facts: toolFacts,
    text,
    model: modelName,
    routed: toolFacts.length > 0,
    degraded: modelProducedNothing ? MODEL_EMPTY_REASON : null,
    ...usage,
  };
}

/** 无模型时也让前端有逐步输出的观感；按标点/长度切块，不切断多字节字符。 */
function emitInChunks(text: string, emit?: (chunk: string) => void): void {
  if (!emit || !text) return;
  const chars = [...text];
  const size = 24;
  for (let i = 0; i < chars.length; i += size) emit(chars.slice(i, i + size).join(''));
}

/**
 * 正文数字核对(与报告的数字守卫同源，但处置方式不同)。
 *
 * 报告有一份确定性模板稿可以退回，所以数字对不上就整篇丢弃改写；正文没有等价替代品，
 * 丢弃只会退回「已查询到 N 组后端事实数据」这句没信息的套话，因此这里**只核对并标注**，
 * 不改写正文，把无法与事实对上的数值交给界面提示用户复核。
 *
 * 实测依据：模型会在转述工具结果时改坏个别数字(把 399666.86 写成 439666.86)，
 * 后端事实是对的、错在转述那一步，所以只能在正文侧做事后核对。
 */
const NUMBER_CHECK_NODE_LIMIT = 200_000;

/**
 * 符号即结论的字段名(利润方向口径:正=有利、负=不利)。
 *
 * 单科目金额(budgetCents/actualCents/amountCents 等)存储为带符号整数分,但界面与
 * 通用报表口径按科目类型展示正值(成本费用显示正数,方案 §1「金额统一使用带符号整数」),
 * 模型照界面口径转述成正数是正确行为,因此维持正负双写法放行;
 * 差异/净额/汇总类字段的符号本身就是结论(「有利 +120 万」写成「-120 万」是语义反转),
 * 必须严格带符号匹配,不能 Math.abs。数量字段同理只看字段名,数值无方向语义。
 */
const SIGN_STRICT_KEY_RE = /(?:variance|delta|diff|change|net|total|sum|budget_cents_total|profit)(?:cents|_?scaled|pp)?$/i;

/** 键名落入符号严格清单时,值本身(而非其相反数)才是唯一允许写法。 */
function isSignStrictKey(key: string): boolean {
  return SIGN_STRICT_KEY_RE.test(key);
}

/** 把事实里的原始整数/小数展开成「允许出现在正文里的数值文本」。 */
function collectAllowedNumbers(value: unknown, into: Set<string>, budget: { left: number }, depth = 0, key = ''): void {
  if (budget.left <= 0 || depth > 12) return;
  const signStrict = key !== '' && isSignStrictKey(key);
  if (typeof value === 'number') {
    budget.left -= 1;
    if (!Number.isFinite(value)) return;
    const abs = Math.abs(value);
    if (Number.isInteger(value)) {
      // 整数可能是分(金额)、10^4 缩放整数(数量),也可能就是个 ID/计数。
      // 符号严格字段(差异/净额/汇总)不生成相反数写法;科目金额维持双写法放行。
      for (const cents of signStrict ? [value] : [value, -value]) into.add(centsToWanText(cents));
      into.add((abs / 100).toFixed(2));            // 元
      into.add((abs / QUANTITY_SCALE).toFixed(4)); // 数量四位小数
      into.add((abs / QUANTITY_SCALE).toFixed(2)); // 数量两位小数
      into.add(String(value));
      into.add(String(abs));
    } else {
      // 小数通常是比率:允许一位与两位小数的百分数,以及原值本身。
      // 比率完成率本身无方向语义,沿用绝对值口径;符号严格的小数字段补原值写法。
      for (const percent of [abs * 100]) {
        into.add(percent.toFixed(1));
        into.add(percent.toFixed(2));
      }
      into.add(abs.toFixed(2));
      into.add(abs.toFixed(4));
      if (signStrict) {
        into.add(value.toFixed(2));
        into.add(value.toFixed(4));
      }
    }
    return;
  }
  if (typeof value === 'string') {
    // 事实里已经成文的数值(如快照日期、编码里的数字)直接按原样放行
    budget.left -= 1;
    for (const token of value.replace(/,/g, '').match(/[+-]?\d+(?:\.\d+)?/g) ?? []) into.add(token.replace(/^\+/, ''));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) { if (budget.left <= 0) return; collectAllowedNumbers(item, into, budget, depth + 1, key); }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
      if (budget.left <= 0) return;
      collectAllowedNumbers(item, into, budget, depth + 1, childKey);
    }
  }
}

export interface NumberCheck {
  /** ok = 全部数值都能与事实对上；unverified = 有对不上的；skipped = 没有可核对的事实或正文没有数值 */
  status: 'ok' | 'unverified' | 'skipped';
  /** 正文里被核对的数值个数 */
  checked: number;
  /** 正文里出现、但无法由本轮事实推导出来的数值(最多 10 个) */
  unverified: string[];
  note: string;
}

/**
 * 用户自己在提问里写出的数值，以及助手抽出的操作参数。
 *
 * 这些数字**不是模型转述后端事实的产物**，因此不该被判成「无法由事实推导」。
 * 实测误报：问「整体增长 5%」时正文出现「+5.00%」与「growthRate: 0.05」，
 * 二者都来自用户原话，却被标成对不上事实。
 *
 * 这里刻意放宽：同一个数字的百分数/小数/两位/四位写法全部放行，
 * 宁可漏报几个用户给的数字，也不要让真正的转述错误被淹在误报里。
 */
function collectUserProvidedNumbers(message: string, params: unknown, into: Set<string>): void {
  for (const token of String(message || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? []) {
    const value = Number(token);
    if (!Number.isFinite(value)) continue;
    into.add(token);
    for (const candidate of [value, value / 100, value * 100]) {
      into.add(candidate.toFixed(1));
      into.add(candidate.toFixed(2));
      into.add(candidate.toFixed(4));
    }
  }
  if (params && typeof params === 'object') {
    collectAllowedNumbers(params, into, { left: 500 });
  }
}

function checkNumbersAgainstFacts(
  text: string,
  facts: FactRecord[],
  userProvided: { message?: string; actionParams?: unknown } = {},
): NumberCheck {
  // 小数一律核对；纯整数仅在带业务单位时核对，避开年度、版本号和章节序号误报。
  const normalizedText = text.replace(/,/g, '');
  const decimals = normalizedText.match(/[+-]?\d+\.\d+/g) ?? [];
  const unitIntegers = [...normalizedText.matchAll(/[+-]?\d+(?:\.\d+)?(?=\s*(?:%|个百分点|亿元|万元|元|万度|度|人|条|项|个|笔|份|家|次))/g)]
    .map((match) => match[0])
    .filter((token) => !token.includes('.'));
  const tokens = [...decimals, ...unitIntegers]
    .map((token) => token.replace(/^\+/, ''))
    .filter((token, index, all) => all.indexOf(token) === index);
  if (!tokens.length) return { status: 'skipped', checked: 0, unverified: [], note: '正文没有需要核对的数值' };
  if (!facts.length) return { status: 'skipped', checked: tokens.length, unverified: [], note: '本轮没有后端事实可供核对' };
  const allowed = new Set<string>();
  const budget = { left: NUMBER_CHECK_NODE_LIMIT };
  for (const fact of facts) collectAllowedNumbers(fact.data, allowed, budget);
  collectUserProvidedNumbers(userProvided.message ?? '', userProvided.actionParams, allowed);
  const truncated = budget.left <= 0;
  const unverified: string[] = [];
  for (const token of tokens) {
    if (allowed.has(token)) continue;
    if (!unverified.includes(token)) unverified.push(token);
  }
  if (!unverified.length) {
    return { status: 'ok', checked: tokens.length, unverified: [], note: `正文 ${tokens.length} 个数值均可由本轮后端事实推导` };
  }
  return {
    status: 'unverified',
    checked: tokens.length,
    unverified: unverified.slice(0, 10),
    note: truncated
      ? `有 ${unverified.length} 个数值未能与事实对上，但事实体量过大、核对集合已截断，可能是漏建索引而非数字有误，请对照引用来源复核`
      : `有 ${unverified.length} 个数值无法由本轮后端事实推导，可能是模型转述时算错或改错，请对照引用来源复核`,
  };
}

/** 流式进度事件：让客户端知道等待期间后端在做什么，而不是干等一个转圈。 */
export interface ChatProgress {
  /** 阶段标识：context / routing / tool / fallback / answer / template */
  stage: 'context' | 'routing' | 'tool' | 'fallback' | 'answer' | 'template';
  /** 面向用户的一句话，例如「正在计算差异归因」 */
  label: string;
  /** 可选补充说明(工具名、命中范围等) */
  detail?: string;
}

export interface ChatOptions {
  /** 有值时逐块回调正文，用于 SSE 真流式 */
  onToken?: (chunk: string) => void;
  /**
   * 有值时回调处理进度。
   *
   * 实测背景：模型路由的首字延迟约 17 秒(要先跑完工具调用轮)，界面上只有转圈。
   * 把「正在解析上下文 / 正在计算差异归因 / 正在组织回答」如实播报出来，等待才有解释。
   */
  onProgress?: (event: ChatProgress) => void;
  /** HTTP/SSE 客户端断开时贯穿模型 fetch、工具轮与最终落库的取消信号。 */
  signal?: AbortSignal;
}

function throwIfChatAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('客户端已取消请求');
  error.name = 'AbortError';
  throw error;
}

/* ============ V2 页面上下文集成(§9.1、§9.5、§9.6) ============ */

/**
 * 核验焦点 → 从领域服务重新取得核验事实(§9.5)。
 * 客户端传来的 label、details、level、数量和差额全部忽略，一律以本次重算为准。
 */
function fetchVerificationFact(
  db: DB,
  focus: Extract<FocusDescriptor, { kind: 'fact' }>,
  context: AssistantContext,
  view: Record<string, unknown>,
): VerificationFactItem | null {
  const [root] = focus.ownerKey.split(':');
  const thresholdRaw = typeof view.threshold === 'number' ? view.threshold : Number(view.threshold ?? NaN);
  const warningThreshold = Number.isFinite(thresholdRaw) ? Math.min(100, Math.max(0, thresholdRaw)) / 100 : 0.2;
  const scopeInput = {
    versionId: 0,
    batchId: context.actualSnapshotId ?? null,
    orgScopeId: scopedOrgId(db, context.orgId),
    accountScopeId: context.accountId ?? null,
    sheetKey: typeof view.sheetKey === 'string' ? view.sheetKey : null,
  };
  requireActionPermission('analysis:read', '核验分析事实');
  if (root === 'analysis') {
    if (context.budgetVersionId == null) return null;
    const report = completionReport(db, { ...scopeInput, versionId: context.budgetVersionId, warningThreshold });
    return report.verificationFacts.find((item) => item.factKey === focus.factKey) ?? null;
  }
  if (root === 'structure') {
    if (context.budgetVersionId == null) return null;
    const report = structureReport(db, { ...scopeInput, versionId: context.budgetVersionId });
    return report.verificationFacts.find((item) => item.factKey === focus.factKey) ?? null;
  }
  if (root === 'evidence') {
    const parts = focus.ownerKey.split(':');
    const versionId = Number(parts[2]);
    const metricId = Number(parts[3]);
    if (!Number.isSafeInteger(versionId) || !Number.isSafeInteger(metricId)) return null;
    const evidence = metricEvidence(db, { ...scopeInput, versionId, metricId });
    return evidence.verificationFacts.find((item) => item.factKey === focus.factKey) ?? null;
  }
  return null;
}

/** 核验事实的一句话摘要(模板模式下的确定性回答)。 */
function summarizeVerificationFact(fact: VerificationFactItem): string {
  const levelText = fact.serverLevel === 'ok' ? '通过' : fact.serverLevel === 'warn' ? '需要注意' : '未通过';
  const lines = [`核验「${fact.label}」：${levelText}。`];
  for (const detail of fact.details) lines.push(detail);
  return lines.join('\n');
}

/** 草稿影响的确定性摘要(万元口径，整数分格式化)。 */
function summarizeDraftImpact(impact: ReturnType<typeof computeDraftImpact>): string {
  if (!impact) return '';
  const lines = [`已按未保存的 ${impact.changeCount} 项修改重算（基线：${impact.baseline}，不写入数据库）：`];
  if (impact.totalDeltaCents !== 0) lines.push(`变更合计影响 ${centsToWanText(impact.totalDeltaCents)} 万元（利润方向）。`);
  if (impact.metricDeltas.length) {
    lines.push(`指标影响：${impact.metricDeltas.slice(0, 5).map((m) => `${m.name} ${centsToWanText(m.beforeCents)}→${centsToWanText(m.afterCents)} 万元`).join('；')}${impact.metricDeltas.length > 5 ? ` 等 ${impact.metricDeltas.length} 项` : ''}。`);
  }
  if (impact.accountDeltas.length) {
    lines.push(`科目子树变化：${impact.accountDeltas.slice(0, 5).map((a) => `${a.name} ${centsToWanText(a.deltaCents)} 万元`).join('；')}${impact.accountDeltas.length > 5 ? ` 等 ${impact.accountDeltas.length} 项` : ''}。`);
  }
  if (impact.quantityChanges.length) lines.push(`另有 ${impact.quantityChanges.length} 项数量变更(与金额口径隔离)。`);
  return lines.join('\n');
}

/** 配置类草稿校验结论的确定性摘要。 */
function summarizeDraftValidation(draft: { baseline: string; changeCount: number; issues: string[] }): string {
  if (!draft.issues.length) return `草稿校验通过（基线：${draft.baseline}，${draft.changeCount} 个字段有修改，未写入数据库）。`;
  return [`草稿校验发现 ${draft.issues.length} 个问题（基线：${draft.baseline}，未写入数据库）：`, ...draft.issues.map((issue) => `- ${issue}`)].join('\n');
}

/** 后端实际采用的安全范围(§9.7 effectiveContext)。 */
function buildEffectiveContext(backendCtx: ResolvedBackendContext, context: AssistantContext) {
  return {
    pageKey: backendCtx.pageKey,
    pageLabel: backendCtx.pageLabel,
    ...(context.year != null ? { year: context.year } : {}),
    ...(context.budgetVersionId != null ? { budgetVersionId: context.budgetVersionId } : {}),
    ...(context.targetVersionId != null ? { targetVersionId: context.targetVersionId } : {}),
    ...(context.actualSnapshotId != null ? { actualSnapshotId: context.actualSnapshotId } : {}),
    ...(context.importBatchId != null ? { importBatchId: context.importBatchId } : {}),
    ...(context.orgId != null ? { orgScopeId: context.orgId } : {}),
    ...(context.accountId != null ? { accountScopeId: context.accountId } : {}),
    ...(backendCtx.extras.metricId != null ? { metricId: backendCtx.extras.metricId } : {}),
    view: backendCtx.view,
  };
}

export async function chat(
  db: DB,
  input: { conversationId?: number; message: string; context?: unknown; pageContext?: unknown },
  actor = '',
  options: ChatOptions = {},
) {
  const startedAt = Date.now();
  throwIfChatAborted(options.signal);
  const usage = { modelCalls: 0, modelMs: 0, toolCalls: 0 };
  const message = boundedText(input?.message, 'message', 20_000, true);
  let requested: ReturnType<typeof normalizeContext>;
  try { requested = normalizeContext(input?.context); }
  catch (err) { throw Errors.validation(err instanceof Error ? err.message : 'context格式不正确'); }
  validateContextConsistency(db, requested);
  /**
   * V2 页面上下文统一解析入口(§9.1)：schema/大小/白名单、资源 ID 与树关系核验、
   * surface > focus > 页面 scope 合并都在这里完成；篡改 ID、冲突版本、失效焦点、
   * 未知页面与超限草稿在调用任何业务工具之前被拒绝。
   */
  const backendCtx = resolveBackendContext(db, input?.pageContext);
  if (backendCtx) {
    requested = { ...requested, ...backendCtx.pageContext };
    validateContextConsistency(db, requested);
  }
  // 新会话先用 0 作为无历史的临时 ID，直到回答完成且未取消才真正落库；
  // 这样 SSE 在 open 后立即断开不会留下空会话。
  let conversationId = input?.conversationId == null ? 0 : ensureConversation(db, input.conversationId, message);

  // 1) 意图识别(正则)：既作为模型不可用时的路由，也作为提示词里的参考
  const detected = detectIntents(message);
  // 2) 上下文解析：年度/组织/科目/版本/快照/导入批次，请求 > 消息 > 上一轮 > 默认
  const inherited = inheritedTurn(db, conversationId);
  // 只读提问才允许句子里的年度覆盖筛选器；写操作里的年份通常是目标年度，不能覆盖。
  const yearOverride = detected.write.length === 0;
  // §6：V2 页面口径下，问题明确写出的年度/版本/组织/科目可以覆盖页面范围(名称歧义不覆盖)。
  const messageOverride = backendCtx != null && yearOverride;
  let resolved = resolveMessageContext(db, message, requested, inherited.context, {
    defaultVersion: needsBudgetVersion(detected),
    yearOverride,
    messageOverride,
  });
  // 3) 纯追问(本轮一个意图都没命中)时沿用上一轮意图，否则「那第二名呢」只会退化成版本列表。
  //    从消息里解析出新的组织/科目范围也算追问信号(如「上海公司呢」)。
  const scopeFromMessage = resolved.resolution.some(
    (item) => item.origin === 'message' && (item.field === 'orgId' || item.field === 'accountId'),
  );
  const detection = withInheritedIntents(detected, inherited.read, message, { scopeFromMessage });
  // 继承来的意图需要版本、而上下文里还没有版本时，重解析一次补上该年度当前生效版本。
  if (detection.inheritedRead.length && resolved.context.budgetVersionId == null && needsBudgetVersion(detection)) {
    resolved = resolveMessageContext(db, message, requested, inherited.context, { defaultVersion: true, yearOverride, messageOverride });
  }
  const { context, resolution } = resolved;
  /* AC-X04:受限用户的组织范围由服务端确定。页面/消息/上一轮给出的组织必须在授权范围内;
     未指定时取唯一授权根并如实写入解析说明;多根时留空,由需要组织范围的查询要求明确选择。 */
  const chatAuth = currentAuth();
  if (chatAuth && !chatAuth.allOrgs) {
    if (context.orgId != null) assertOrgVisible(db, chatAuth, context.orgId);
    else if (chatAuth.orgRootIds.length === 1) {
      context.orgId = chatAuth.orgRootIds[0];
      const orgRow = db.prepare('SELECT name FROM org WHERE id=?').get(context.orgId) as { name: string } | undefined;
      resolution.push({ field: 'orgId', value: context.orgId, origin: 'default', reason: '按当前账号的授权组织范围', label: orgRow?.name });
    }
  }
  const ambiguities = resolved.ambiguities;
  options.onProgress?.({
    stage: 'context',
    label: '已解析提问范围',
    detail: [
      context.year == null ? null : `${context.year} 年`,
      context.budgetVersionId == null ? null : `版本 #${context.budgetVersionId}`,
      detection.read.length ? `方向：${detection.read.map(readIntentLabel).join('、')}` : null,
    ].filter(Boolean).join('，') || undefined,
  });
  validateContextConsistency(db, context);
  const digest = contextDigest(db, context, resolution);

  /* ===== V2 页面范围落地(§9.1、§9.4、§9.6、§9.7) ===== */
  const pageCap = backendCtx ? pageCapability(backendCtx.pageKey) : null;
  const capability: DomainCapability | null = backendCtx && pageCap
    ? pickCapability(pageCap, detection.read, { hasVerificationFocus: backendCtx.focus?.kind === 'fact' })
    : null;
  /** 模型只暴露本轮 PageCapabilityMap 允许的领域能力(§9.3)；旧客户端不限制。 */
  const allowedTools = backendCtx && pageCap ? new Set(allowedToolsForCapabilities(pageCap.capabilities)) : undefined;
  /** 规则兜底同样按页面能力过滤读意图；被拒绝的意图如实告知，不静默换口径。 */
  const [allowedReadIntents, deniedReadIntents] = backendCtx && pageCap
    ? filterIntentsByCapability(pageCap, detection.read)
    : [detection.read, [] as string[]];
  const effectiveDetection: IntentDetection = deniedReadIntents.length ? { ...detection, read: allowedReadIntents as IntentDetection['read'] } : detection;

  /** 核验焦点：从领域服务重新取得核验事实；客户端 label/details/level 一律不参与(§9.5)。 */
  let verificationFact: VerificationFactItem | null = null;
  /** 取数失败不吞掉(§9.7)：contextTrace.warnings 必须如实说明「焦点核验项本轮未能重算」。 */
  let verificationFactWarning: string | null = null;
  if (backendCtx?.focus?.kind === 'fact') {
    try { verificationFact = fetchVerificationFact(db, backendCtx.focus, context, backendCtx.view); }
    catch (err) {
      verificationFact = null;
      verificationFactWarning = `核验项「${backendCtx.focus.factKey}」本轮未能从领域服务重算（${err instanceof Error ? err.message : String(err)}），回答未包含该项核验结论`;
    }
  }

  /** 草稿影响：请求内叠加基线重算(§9.6)。结果只进 facts/正文，不进模型、不落库。 */
  // 草稿影响按整版重算汇总(集团口径),与编制页同样只对全组织用户开放。
  if (backendCtx?.draft) requireAllOrgsForAction('草稿影响测算');
  const draftImpact = backendCtx?.draft ? computeDraftImpact(db, backendCtx.draft) : null;
  if (backendCtx && (verificationFact || backendCtx.draft)) {
    // 模型可见的只有「页面给出的脱敏范围 + 后端重算的核验/草稿结论摘要」，原始 draft.changes 永不进入。
    (digest as unknown as Record<string, unknown>).pageFocus = {
      pageKey: backendCtx.pageKey,
      ...(verificationFact ? { verification: { factKey: verificationFact.factKey, level: verificationFact.serverLevel, label: verificationFact.label, details: verificationFact.details } } : {}),
      ...(backendCtx.draft ? { draft: draftSummary(backendCtx.draft) } : {}),
    };
  }

  let facts: FactRecord[] = [];
  let text = '';
  let modelName = 'template';
  let routing: 'model' | 'rules' = 'rules';
  let modelError: string | null = null;

  if (modelConfigured()) {
    options.onProgress?.({ stage: 'routing', label: '正在由模型选择需要的数据' });
    try {
      const outcome = await runModelRouting(db, { message, context, detection: effectiveDetection, digest, conversationId, allowedTools }, options.onToken, options.onProgress, options.signal);
      throwIfChatAborted(options.signal);
      usage.modelCalls += outcome.modelCalls;
      usage.modelMs += outcome.modelMs;
      usage.toolCalls += outcome.toolCalls;
      // 模型没产出任何可用内容时按「模型不可用」处理，走下面的确定性兜底分支，
      // 这样 routing / modelError 与超时、上游报错等场景保持一致。
      if (outcome.degraded) modelError = outcome.degraded;
      else if (outcome.routed || outcome.text) {
        facts = outcome.facts;
        text = outcome.text;
        modelName = outcome.model;
        routing = 'model';
      }
    } catch (err) {
      throwIfChatAborted(options.signal);
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  if (routing === 'rules') {
    throwIfChatAborted(options.signal);
    options.onProgress?.({ stage: 'template', label: '正在用后端确定性查询取数' });
    facts = queryFacts(db, message, context, { intents: effectiveDetection });
    text = deterministicSummary(facts, context, { rankFocus: detectRankFocus(message) });
    if (modelError && !facts.length) text = `模型暂时不可用：${modelError}。${text}`;
    emitInChunks(text, options.onToken);
  } else {
    // 业务解释与导航是后端固化口径，模型路由时同样附加，保证引用完整。
    facts = [...facts, ...deterministicExtras(db, message, context)];
    if (!text) {
      text = deterministicSummary(facts, context, { rankFocus: detectRankFocus(message) });
      emitInChunks(text, options.onToken);
    }
  }
  /* V2：核验焦点与草稿影响的事实附加上去——页面、助手与导出共用同一份核验结论(§9.5)。 */
  if (verificationFact) {
    facts.unshift({
      type: 'verification_fact',
      data: verificationFact,
      source: {
        year: context.year,
        budgetVersionId: verificationFact.scope.versionId ?? context.budgetVersionId ?? null,
        actualSnapshotId: verificationFact.scope.batchId ?? context.actualSnapshotId ?? null,
      },
    });
  }
  if (draftImpact) {
    // 只保留聚合影响；原始 changes 与逐格修改值不进入响应与持久化(§9.6/§9.8)。
    const { changedCells: _dropped, ...aggregates } = draftImpact;
    facts.push({
      type: 'draft_impact',
      data: aggregates,
      source: { year: context.year, budgetVersionId: context.budgetVersionId ?? null, actualSnapshotId: context.actualSnapshotId ?? null },
    });
  } else if (backendCtx?.draft) {
    facts.push({
      type: 'draft_validation',
      data: { kind: backendCtx.draft.kind, baseline: backendCtx.draft.baseline, changeCount: backendCtx.draft.changeCount, issues: backendCtx.draft.issues },
      source: { year: context.year },
    });
  }
  /* 模板模式下把核验/草稿结论放到正文最前面：它们就是用户指着页面元素问的那个问题。 */
  if (routing === 'rules') {
    const prefix: string[] = [];
    if (verificationFact) prefix.push(summarizeVerificationFact(verificationFact));
    if (draftImpact) prefix.push(summarizeDraftImpact(draftImpact));
    else if (backendCtx?.draft?.issues.length) prefix.push(summarizeDraftValidation(backendCtx.draft));
    if (prefix.length) text = `${prefix.join('\n\n')}\n\n${text}`;
  }
  text = text.slice(0, 100_000);

  const navigation = resolveNavigation(message, context) ?? cellNoteNavigation(facts);
  let action: ProposedAction | null = null;
  try {
    action = await resolveProposedAction(db, message, context, detection, digest, options.signal);
  } catch (error) {
    throwIfChatAborted(options.signal);
    action = null;
  }
  throwIfChatAborted(options.signal);
  const notices: string[] = [];
  /**
   * 名称片段有歧义时如实说明。
   *
   * 实测背景：「江垭今年收入完成得怎么样」原来会静默返回全集团合计，
   * 和不带组织的问法一字不差。现在片段命中多个节点就明确列出候选，让用户补一句话即可。
   */
  for (const item of ambiguities) {
    if (item.field === 'orgId' && context.orgId != null) continue;
    if (item.field === 'accountId' && context.accountId != null) continue;
    const label = item.field === 'orgId' ? '组织' : '科目';
    notices.push(
      `「${item.token}」可能指 ${item.candidates.map((c) => `${c.name}(${c.code})`).join('、')}，`
      + `助手没有替你二选一，本轮按未指定${label}范围回答。要限定请给出完整名称或编码。`,
    );
  }
  /**
   * 用户在聊天里直接说「确认执行」时的两件事(实测缺失)：
   * 1. 本轮识别不到写意图 → action 为 null → 界面上的「创建预览」按钮消失，
   *    因此把上一轮的建议重新挂回来，并用 normalizePreview 重新干跑校验参数是否仍然可用；
   * 2. 明确告诉用户对话里的「确认」不会写入，真实路径是预览卡片上的确认按钮。
   */
  const confirmAttempt = looksLikeWriteConfirmation(message);
  if (!action && inherited.action && (confirmAttempt || looksLikeFollowUp(message))) {
    const check = actionIsConstructible(db, inherited.action.type, inherited.action.params);
    action = check.ok
      ? { ...inherited.action, previewable: true, inherited: true }
      : { ...inherited.action, previewable: false, validationMessage: check.message, inherited: true };
  }
  if (confirmAttempt) {
    notices.push(
      action
        ? '在聊天里回复「确认」不会写入任何数据。请在下方操作卡片点「创建预览」，核对逐行影响后再点「确认」，落库前后端会再复查版本状态与预览基线。'
        : '在聊天里回复「确认」不会写入任何数据，而且当前没有待确认的操作建议。请重述要做的操作（例如「把 2026 年预算复制成 2027 年草案，增长 5%」），助手会给出参数并提供「创建预览」按钮。',
    );
  }
  /* 干跑只做参数形态/读取校验,不重新断言源/目标版本当前状态(那在 confirm 的基线复核里),
     文案不能暗示「已重新校验过版本状态」,否则会高估实际校验强度。 */
  if (action?.inherited) notices.push(`本轮沿用上一轮的操作建议（${action.type}），参数已重新读取，最终仍以确认时的状态与基线复查为准。`);

  /* ===== V2 提示：能力拒绝、草稿状态与覆盖说明(§6、§9.4、§10.4) ===== */
  if (backendCtx && deniedReadIntents.length) {
    notices.push(`当前页面（${backendCtx.pageLabel}）不提供「${deniedReadIntents.map((intent) => readIntentLabel(intent as never)).join('、')}」所需的确定性能力，已按本页可回答范围作答；请前往对应页面提问。`);
  }
  if (backendCtx?.draft && detection.write.length > 0) {
    notices.push('检测到页面有未保存修改：助手本轮可以分析草稿，但正式写操作不携带草稿——请先保存页面修改，再创建正式操作预览。');
  }
  const contextWarnings: string[] = [];
  if (backendCtx?.draft) {
    contextWarnings.push(`本轮计算包含 ${backendCtx.draft.changeCount} 项未保存修改（${backendCtx.draft.baseline}），不会写入数据库`);
    for (const issue of backendCtx.draft.issues) contextWarnings.push(`草稿校验：${issue}`);
  }
  for (const warning of backendCtx?.warnings ?? []) contextWarnings.push(warning);
  if (verificationFactWarning) contextWarnings.push(verificationFactWarning);
  const contextOverrides = backendCtx ? detectOverrides(backendCtx.pageContext, resolution) : [];
  for (const override of contextOverrides) {
    notices.push(override.reason.includes('覆盖') ? override.reason : `问题指定的${override.field}已覆盖页面范围`);
  }

  // 模板正文的数字本来就是后端按事实格式化出来的，不必自我核对；模型转述的正文才有风险。
  // 用户原话与操作参数里的数字一并放行，避免把「增长 5%」这类用户给的数字判成转述错误。
  const numberCheck = routing === 'model'
    ? checkNumbersAgainstFacts(text, facts, { message, actionParams: action?.params })
    : { status: 'skipped' as const, checked: 0, unverified: [], note: '正文来自后端确定性模板，数字无需核对' };
  const response = {
    text,
    facts,
    citations: citationsForFacts(facts),
    suggestions: buildSuggestions(facts, context, navigation),
    action,
    navigation,
    /** 后端最终使用的上下文；前端据此回填下拉框，下一轮也会继承 */
    resolvedContext: context,
    /** 每一项上下文的来源与依据，供前端如实展示「助手替你选了什么」 */
    resolution,
    /** model = 模型自主调用只读工具；rules = 关键词兜底 */
    routing,
    /** 本轮实际生效的模型名；template 表示模型不可用、答案来自后端确定性模板 */
    model: modelName,
    /** 正文数值与本轮后端事实的核对结果；unverified 表示有数值对不上，需对照引用来源复核 */
    numberCheck,
    /**
     * 本轮度量：总耗时、模型请求次数与耗时、只读工具调用次数。
     * 模型按请求次数计费，因此这里如实回传，也一并写入操作日志便于回溯用量。
     */
    metrics: { durationMs: 0, modelCalls: usage.modelCalls, modelMs: usage.modelMs, toolCalls: usage.toolCalls },
    /**
     * 后端确定性提示，与模型无关，前端必须原样展示。
     * 目前用于纠正「在聊天里回复确认」这类会让用户误以为已经落库的操作。
     */
    notices,
    intents: {
      read: detection.read,
      write: detection.write,
      suppressed: detection.suppressed,
      /** 本轮是纯追问、沿用上一轮的意图；为空表示意图来自本轮消息 */
      inheritedRead: detection.inheritedRead,
    },
    modelError,
    /* ===== V2 页面范围回答口径(§9.7)；随 response_json 持久化，历史会话直接读取当时响应 ===== */
    ...(backendCtx ? {
      /** aligned = 已对齐当前页面；explicit_override = 问题覆盖了页面范围 */
      contextStatus: (contextOverrides.length ? 'explicit_override' : 'aligned') as 'aligned' | 'explicit_override',
      /** 后端实际采用的安全范围 */
      effectiveContext: buildEffectiveContext(backendCtx, context),
      /** 一行范围摘要，例如「年度执行分析 · 2026 年 · 预算 V3 · 江垭电站 · 截至 6 月」 */
      contextSummary: buildContextSummary(db, backendCtx.pageLabel, context, backendCtx.extras, backendCtx.view),
      contextTrace: {
        used: resolution.map((item) => ({ field: item.field, value: item.value, origin: item.origin, reason: item.reason })),
        overrides: contextOverrides,
        warnings: contextWarnings,
      },
      /** 本轮调用的领域能力 */
      capability,
      /** 是否采用草稿、类型和变更数量；不含原值 */
      draftApplied: backendCtx.draft ? draftSummary(backendCtx.draft) : null,
    } : {}),
  };
  response.metrics.durationMs = Date.now() - startedAt;
  const timestamp = now();
  throwIfChatAborted(options.signal);
  if (conversationId === 0) conversationId = ensureConversation(db, undefined, message);
  db.transaction(() => {
    throwIfChatAborted(options.signal);
    db.prepare('INSERT INTO ai_message(conversation_id,role,content,response_json,model,created_at) VALUES(?,?,?,?,?,?)').run(conversationId, 'user', message, '{}', null, timestamp);
    db.prepare('INSERT INTO ai_message(conversation_id,role,content,response_json,model,created_at) VALUES(?,?,?,?,?,?)').run(conversationId, 'assistant', text, JSON.stringify(response), modelName, timestamp);
    db.prepare('UPDATE ai_conversation SET updated_at=? WHERE id=?').run(timestamp, conversationId);
    /**
     * 提问本身也入操作日志(不重复存正文，正文在 ai_message 里)。
     *
     * 目的：模型路由会把上下文摘要发到外部接口，需要一条可审计的记录说明
     * 「什么时候、谁、走了哪种路由、发了几次模型请求」。
     */
    writeLog(db, 'ai.chat', 'ai_conversation', conversationId, {
      actor,
      routing,
      model: modelName,
      messageChars: message.length,
      factTypes: facts.map((f) => f.type),
      intents: detection.read,
      // V2 页面口径摘要(§9.8)：只记 pageKey/capability/contextStatus/draftApplied，不记上下文步骤明细。
      ...(backendCtx ? {
        pageKey: backendCtx.pageKey,
        capability,
        contextStatus: contextOverrides.length ? 'explicit_override' : 'aligned',
        draftApplied: backendCtx.draft ? draftSummary(backendCtx.draft) : null,
      } : {}),
      ...response.metrics,
    });
  })();
  return { conversationId, ...response };
}

function parseAmountForEntry(entry: Record<string, unknown>, type: string): { amount?: string; amountCents?: number; display: string } {
  if (entry.amountWan != null) {
    const display = wanStringToYuanString(String(entry.amountWan));
    return { amount: display, display };
  }
  if (entry.amountCents != null) {
    const cents = Number(entry.amountCents);
    if (!Number.isSafeInteger(cents)) throw Errors.validation('amountCents必须是安全整数');
    const display = signedCentsToDisplay(cents, type as 'income' | 'cost' | 'expense');
    return { amount: display, amountCents: cents, display };
  }
  if (entry.amount == null || String(entry.amount).trim() === '') throw Errors.validation('金额科目必须提供 amount、amountCents 或 amountWan');
  const display = String(entry.amount).trim();
  // Parse once at preview time so malformed decimal input never reaches confirmation.
  displayToSignedCents(display, type as 'income' | 'cost' | 'expense');
  return { amount: display, display };
}

function normalizeBulkEntries(db: DB, versionId: number, rawEntries: unknown[]): { entries: budget.BudgetEntryInput[]; changes: unknown[] } {
  if (rawEntries.length > 50_000) throw Errors.validation('批量调整最多 50000 条明细');
  const matrix = budget.getEditMatrix(db, versionId);
  const leafOrg = new Set(matrix.leafOrgIds);
  const leafAcc = new Set(matrix.leafAccountIds);
  const accountById = new Map(matrix.accountNodes.map((a: any) => [a.id, a]));
  const orgById = new Map(matrix.orgNodes.map((o: any) => [o.id, o]));
  const before = new Map(matrix.entries.map((e) => [`${e.orgId}:${e.accountId}`, e]));
  const seen = new Set<string>();
  const entries: budget.BudgetEntryInput[] = [];
  const changes: unknown[] = [];
  rawEntries.forEach((raw, index) => {
    const e = plainObject(raw);
    const orgId = positiveInt(e.orgId, `第 ${index + 1} 条 orgId`);
    const accountId = positiveInt(e.accountId, `第 ${index + 1} 条 accountId`);
    const key = `${orgId}:${accountId}`;
    if (seen.has(key)) throw Errors.validation(`第 ${index + 1} 条明细重复:组织 ${orgId} × 科目 ${accountId}`);
    seen.add(key);
    if (!leafOrg.has(orgId) || !leafAcc.has(accountId)) throw Errors.validation(`第 ${index + 1} 条必须使用版本绑定树快照中的叶子节点`);
    const accountRow: any = accountById.get(accountId);
    const orgRow: any = orgById.get(orgId);
    if (!accountRow || !orgRow) throw Errors.validation(`第 ${index + 1} 条节点不存在`);
    if (!isAccountVisibleForScope(String(accountRow.code), new Set([String(orgRow.code)]))) throw Errors.validation(`第 ${index + 1} 条科目不适用于该组织`);
    const formula = boundedText(e.formula, `第 ${index + 1} 条 formula`, 2_000);
    const note = boundedText(e.note, `第 ${index + 1} 条 note`, 10_000);
    let normalized: budget.BudgetEntryInput;
    let after: any;
    if (isQuantityType(accountRow.type)) {
      if (e.amount != null || e.amountCents != null || e.amountWan != null) throw Errors.validation(`第 ${index + 1} 条数量科目不能同时提供金额`);
      if (e.quantity == null || String(e.quantity).trim() === '') throw Errors.validation(`第 ${index + 1} 条数量不能为空`);
      const scaled = quantityStringToScaled(String(e.quantity));
      normalized = { orgId, accountId, quantity: String(e.quantity).trim(), formula, note };
      after = { amountCents: 0, quantity: scaled, quantityDisplay: scaledToQuantityString(scaled), formula, note };
    } else {
      if (e.quantity != null) throw Errors.validation(`第 ${index + 1} 条金额科目不能提供 quantity`);
      const amount = parseAmountForEntry(e, accountRow.type);
      const storage = displayToSignedCents(amount.display, accountRow.type);
      normalized = { orgId, accountId, amount: amount.display, formula, note };
      after = { amountCents: storage, amountDisplay: amount.display, quantity: null, formula, note };
    }
    entries.push(normalized);
    // changeCents 供预览的「最大变化行」排序;缺失会让 largestChanges 恒按 0 排,
    // 展示的变成前 50 条输入而非变化最大的 50 条。数量科目金额恒 0,不参与该排序。
    const beforeEntry = before.get(key);
    const beforeCents = Number(beforeEntry?.amountCents ?? 0);
    const beforeQuantity = beforeEntry?.quantity as number | null | undefined;
    const changeCents = safeIntegerAdd(after.amountCents, -beforeCents, '批量调整变化金额');
    const changeQuantity = after.quantity == null || beforeQuantity == null ? null : after.quantity - beforeQuantity;
    changes.push({ orgId, accountId, before: beforeEntry || null, after, changeCents, changeQuantity });
  });
  return { entries, changes };
}

function normalizeCopy(db: DB, p: Record<string, unknown>) {
  const sourceVersionId = positiveInt(p.sourceVersionId, 'sourceVersionId');
  const source = budget.getVersion(db, sourceVersionId);
  if (source.status === 'draft') throw Errors.conflict('草稿版本无需复制,可直接编辑');
  const targetYear = p.targetYear == null ? source.year : validYear(p.targetYear, 'targetYear');
  const name = boundedText(p.name || `${source.name} copy`, '版本名称', 200, true);
  const note = boundedText(p.note, '备注', 10_000);
  const growthRate = boundedRate(p.growthRate, 'growthRate');
  const rows = db.prepare('SELECT org_id, account_id, amount_cents, quantity, formula, note FROM budget_entry WHERE version_id=? ORDER BY org_id,account_id').all(sourceVersionId) as any[];
  const changes = rows.map((r) => {
    const amount = budget.scaleIntegerByGrowthRate(r.amount_cents, growthRate);
    const quantity = r.quantity == null ? null : budget.scaleIntegerByGrowthRate(r.quantity, growthRate);
    return { orgId: r.org_id, accountId: r.account_id, before: r, after: { ...r, amount_cents: amount, quantity }, changeCents: amount - r.amount_cents, changeQuantity: quantity == null || r.quantity == null ? null : quantity - r.quantity };
  });
  const totalChangeCents = changes.reduce((sum, row) => safeIntegerAdd(sum, row.changeCents, '复制变化金额汇总'), 0);
  return {
    params: { sourceVersionId, targetYear, name, note, growthRate },
    preview: {
      type: 'copy_budget', source: { id: source.id, year: source.year, name: source.name, status: source.status, treeSnapshotIds: { org: source.org_tree_snapshot_id, account: source.account_tree_snapshot_id } },
      target: { year: targetYear, name },
      // 与草案预览同口径：只带前 N 行最大变化，不把源版本全部明细(生产库 2402 行)
      // 复制进 preview_json 再回传一遍。
      changeCount: changes.length,
      totalChangeCents,
      largestChanges: largestChanges(changes, 50),
      note: targetYear === source.year
        ? '同年复制为修订，沿用源版本绑定的树快照；确认时再次检查源版本状态'
        : '跨年复制将绑定目标年度的当前树快照，源年度之后新增/停用的组织与科目按新快照生效；确认时再次检查源版本状态',
    },
  };
}

function normalizeDraft(db: DB, p: Record<string, unknown>) {
  const year = validYear(p.year, 'year');
  const baseFromRaw = String(p.baseFrom || '').toLowerCase();
  const baseFrom = baseFromRaw === 'previous' ? 'budget' : baseFromRaw === 'snapshot' ? 'actual_snapshot' : baseFromRaw;
  if (baseFrom !== 'budget' && baseFrom !== 'actual' && baseFrom !== 'actual_snapshot') throw Errors.validation('baseFrom必须为 budget、actual 或 actual_snapshot');
  const baseYear = p.baseYear == null ? year - 1 : validYear(p.baseYear, 'baseYear');
  const baseSnapshotId = baseFrom === 'actual_snapshot' ? positiveInt(p.baseSnapshotId ?? p.actualSnapshotId, 'baseSnapshotId') : undefined;
  const growthRate = boundedRate(p.growthRate, 'growthRate');
  const name = boundedText(p.name || 'AI预算草案', '版本名称', 200, true);
  const note = boundedText(p.note, '备注', 10_000);
  const details = budget.previewVersionGenerationDetails(db, { year, name, baseFrom, baseYear, baseSnapshotId, growthRate, kind: p.kind === 'forecast' ? 'forecast' : 'budget', note });
  // 预览只保留摘要 + 最大变化行：`items` 是「叶子组织 × 叶子科目」的完整网格
  // (生产库实测 2402 行、序列化后约 767KB)，整份写进 ai_action.preview_json
  // 再随响应回传毫无必要——前端表格只展示 largestChanges 的前 20 行，
  // 确认阶段也不读 items(由 params 重新走 createVersion)。
  const { items, ...summary } = details;
  const params = { year, name, baseFrom, baseYear, ...(baseSnapshotId == null ? {} : { baseSnapshotId }), growthRate, kind: p.kind === 'forecast' ? 'forecast' : 'budget', note };
  return {
    params,
    preview: {
      ...summary,
      largestChanges: largestChanges(items, 50),
      /** 明细未随预览落库：candidateCount 是完整网格行数，largestChanges 是按变动额取的前 N 行。 */
      itemsTruncatedTo: Math.min(50, items.length),
      params: { year, name, baseFrom, baseYear, ...(baseSnapshotId == null ? {} : { baseSnapshotId }), growthRate },
      rounding: 'integer cents / quantity 1e4',
      note: '确定性参数预览，需确认后执行',
    },
  };
}

function normalizeScenario(db: DB, p: Record<string, unknown>) {
  const versionId = optionalInt(p.versionId, 'versionId');
  const preset = p.preset == null ? 'baseline' : String(p.preset).toLowerCase();
  if (!['conservative', 'baseline', 'aggressive'].includes(preset)) throw Errors.validation('preset必须为 conservative、baseline 或 aggressive');
  const incomeGrowth = boundedRate(p.incomeGrowth ?? (preset === 'conservative' ? -0.05 : preset === 'aggressive' ? 0.1 : 0), 'incomeGrowth');
  const costGrowth = boundedRate(p.costGrowth ?? (preset === 'conservative' ? -0.02 : preset === 'aggressive' ? 0.08 : 0), 'costGrowth');
  const expenseGrowth = boundedRate(p.expenseGrowth ?? (preset === 'conservative' ? -0.02 : preset === 'aggressive' ? 0.08 : 0), 'expenseGrowth');
  const batchId = p.batchId == null ? undefined : positiveInt(p.batchId, 'batchId');
  const orgScopeId = scopedOrgId(db, p.orgScopeId == null ? undefined : positiveInt(p.orgScopeId, 'orgScopeId')) ?? undefined;
  const accountScopeId = p.accountScopeId == null ? undefined : positiveInt(p.accountScopeId, 'accountScopeId');
  const params: Record<string, unknown> = { preset, ...(versionId == null ? {} : { versionId }), ...(batchId == null ? {} : { batchId }), ...(orgScopeId == null ? {} : { orgScopeId }), ...(accountScopeId == null ? {} : { accountScopeId }), incomeGrowth, costGrowth, expenseGrowth };
  if (p.targetProfitCents != null) {
    // 原来这里只是 Number()：没有 versionId 的分支直接 return，NaN 会被
    // JSON.stringify 存成 null，等到补上 versionId 再确认时才报错。
    const target = Number(p.targetProfitCents);
    if (!Number.isSafeInteger(target)) throw Errors.validation('targetProfitCents必须是安全整数分');
    params.targetProfitCents = target;
  } else if (p.targetProfit != null) params.targetProfit = boundedText(p.targetProfit, 'targetProfit', 100, true);
  if (versionId == null) return { params, preview: { ...params, changes: [], note: '提供 versionId 后执行确定性情景测算' } };
  const report = require('../modules/report/report.service').completionReport(db, { versionId, batchId: batchId ?? null, orgScopeId: orgScopeId ?? null, accountScopeId: accountScopeId ?? null });
  const totals = { income: 0, cost: 0, expense: 0 };
  for (const row of report.analysisAccounts) {
    if (row.isLeaf && (row.type === 'income' || row.type === 'cost' || row.type === 'expense')) {
      const key = row.type as 'income' | 'cost' | 'expense';
      totals[key] = safeIntegerAdd(totals[key], row.cell.budgetCents, '情景基准汇总');
    }
  }
  const adjusted = {
    income: budget.scaleIntegerByGrowthRate(totals.income, incomeGrowth),
    cost: budget.scaleIntegerByGrowthRate(totals.cost, costGrowth),
    expense: budget.scaleIntegerByGrowthRate(totals.expense, expenseGrowth),
  };
  let expenseCap: number | null = null;
  let expenseCapDisplay: number | null = null;
  let targetProfitInfeasible = false;
  if (p.targetProfitCents != null || p.targetProfit != null) {
    const target = p.targetProfitCents != null ? Number(p.targetProfitCents) : yuanStringToCents(String(p.targetProfit));
    if (!Number.isSafeInteger(target)) throw Errors.validation('targetProfit必须是合法金额');
    // 金额在存储中按利润方向为负：目标利润 = 收入 + 成本 + 费用。
    // 费用上限以界面正数表示，再转换成可接受的最小负数。
    expenseCapDisplay = safeIntegerAdd(safeIntegerAdd(adjusted.income, adjusted.cost, '情景费用上限'), -target, '情景费用上限');
    if (expenseCapDisplay < 0) targetProfitInfeasible = true;
    else {
      expenseCap = -expenseCapDisplay;
      if (adjusted.expense < expenseCap) adjusted.expense = expenseCap;
    }
  }
  const profitBaseline = safeIntegerAdd(safeIntegerAdd(totals.income, totals.cost, '情景利润基准'), totals.expense, '情景利润基准');
  const profitAdjusted = safeIntegerAdd(safeIntegerAdd(adjusted.income, adjusted.cost, '情景利润建议'), adjusted.expense, '情景利润建议');
  const changes = (['income', 'cost', 'expense'] as const).map((key) => ({ dimension: key, beforeCents: totals[key], afterCents: adjusted[key], changeCents: safeIntegerAdd(adjusted[key], -totals[key], '情景变化') }));
  return { params, preview: { baseline: totals, rates: { income: incomeGrowth, cost: costGrowth, expense: expenseGrowth }, adjusted, expenseCap, expenseCapDisplay, targetProfitInfeasible, profitBaseline, profitAdjusted, profitImpact: safeIntegerAdd(profitAdjusted, -profitBaseline, '情景利润影响'), quantityIsolated: true, changes } };
}

function normalizeBasis(p: Record<string, unknown>) {
  const text = boundedText(p.text, '依据文本', 20_000, true);
  const title = boundedText(p.title || 'AI草稿', '标题', 200, true);
  const citations = Array.isArray(p.citations)
    ? p.citations.slice(0, 200).map((item) => {
      const c = plainObject(item);
      return { source: boundedText(c.source, 'citation.source', 200, true), asOf: boundedText(c.asOf, 'citation.asOf', 80, true), ...(c.year == null ? {} : { year: validYear(c.year, 'citation.year') }), ...(c.budgetVersionId == null ? {} : { budgetVersionId: positiveInt(c.budgetVersionId, 'citation.budgetVersionId') }), ...(c.actualSnapshotId == null ? {} : { actualSnapshotId: positiveInt(c.actualSnapshotId, 'citation.actualSnapshotId') }) };
    })
    : [];
  return { params: { text, title, citations }, preview: { type: 'basis_text', title, text, citations, draft: true, changes: [] } };
}

function normalizeExport(db: DB, p: Record<string, unknown>) {
  const kind = String(p.kind || '').toLowerCase();
  if (!['budget_detail', 'actual_current', 'completion'].includes(kind)) throw Errors.validation('不支持的导出类型');
  const format = String(p.format || 'xlsx').toLowerCase();
  if (format !== 'xlsx' && format !== 'csv') throw Errors.validation('导出格式必须是 xlsx 或 csv');
  const params: Record<string, unknown> = { kind, format };
  // 明细导出是整版/整年全组织数据,只对全组织用户开放;执行报告导出按组织范围裁剪。
  if (kind !== 'completion') requireAllOrgsForAction(`导出「${kind}」`);
  if (kind === 'budget_detail' || kind === 'completion') params.versionId = positiveInt(p.versionId, 'versionId');
  if (kind === 'actual_current') params.year = validYear(p.year, 'year');
  if (kind === 'completion' && p.options != null) {
    if (typeof p.options !== 'object' || Array.isArray(p.options)) throw Errors.validation('导出 options 格式不正确');
    // 显式白名单：原来是 plainObject 原样存下，确认时又以 `{ versionId, ...options }`
    // 展开给 completionReport / exportCompletion，options 里塞一个 versionId
    // 就能把已校验的版本换掉——预览说导 A、下载拿到 B。
    const raw = plainObject(p.options);
    if (raw.versionId != null) throw Errors.validation('导出 options 不能覆盖 versionId');
    const options: Record<string, unknown> = {};
    if (raw.batchId != null) options.batchId = positiveInt(raw.batchId, 'options.batchId');
    if (raw.orgScopeId != null) options.orgScopeId = positiveInt(raw.orgScopeId, 'options.orgScopeId');
    if (raw.accountScopeId != null) options.accountScopeId = positiveInt(raw.accountScopeId, 'options.accountScopeId');
    if (raw.forecastVersionId != null) options.forecastVersionId = positiveInt(raw.forecastVersionId, 'options.forecastVersionId');
    if (raw.sheetKey != null) options.sheetKey = boundedText(raw.sheetKey, 'options.sheetKey', 80);
    if (raw.summaryLevel != null) {
      const level = positiveInt(raw.summaryLevel, 'options.summaryLevel');
      if (level > 20) throw Errors.validation('options.summaryLevel 超出范围');
      options.summaryLevel = level;
    }
    const unknownKeys = Object.keys(raw).filter((key) => !['batchId', 'orgScopeId', 'accountScopeId', 'forecastVersionId', 'sheetKey', 'summaryLevel'].includes(key));
    if (unknownKeys.length) throw Errors.validation(`导出 options 不支持的字段：${unknownKeys.join('、')}`);
    params.options = options;
  }
  if (kind === 'completion') {
    const options = (params.options ?? {}) as Record<string, unknown>;
    const orgScopeId = scopedOrgId(db, options.orgScopeId as number | undefined);
    if (orgScopeId != null) params.options = { ...options, orgScopeId };
  }
  // 预览阶段只读取元数据，不生成文件；确认阶段再次调用正式导出 service。
  let estimate = 0;
  try {
    if (kind === 'budget_detail') estimate = (db.prepare('SELECT COUNT(*) AS c FROM budget_entry WHERE version_id=?').get(params.versionId) as any).c;
    if (kind === 'actual_current') estimate = (db.prepare('SELECT COUNT(*) AS c FROM actual_current WHERE year=?').get(params.year) as any).c;
  } catch { /* 确认时返回业务层的 NOT_FOUND/VALIDATION */ }
  return { params, preview: { type: 'export', kind, format, estimatedRows: estimate, changes: [], note: '确认后生成导出文件' } };
}

function normalizePreview(db: DB, type: string, inputParams: Record<string, unknown>) {
  if (type === 'copy_budget') return normalizeCopy(db, inputParams);
  if (type === 'budget_draft') return normalizeDraft(db, inputParams);
  if (type === 'bulk_adjustment') {
    const versionId = positiveInt(inputParams.versionId, 'versionId');
    if (!Array.isArray(inputParams.entries)) throw Errors.validation('bulk_adjustment.entries必须是数组');
    const rawEntries = inputParams.entries;
    try {
      const normalized = normalizeBulkEntries(db, versionId, rawEntries);
      // changes 是「明细 + 变更前值」，与 params.entries 一一对应；批量调整最多
      // 允许上万条，预览里再存一份纯属重复，只保留计数与最大变化行。
      return { params: { versionId, entries: normalized.entries }, preview: { type, versionId, changeCount: normalized.changes.length, largestChanges: largestChanges(normalized.changes, 50), note: '确认后由预算业务事务整体写入' } };
    } catch (err) {
      // 保留不存在版本的 pending 预览，确认时由正式 service 给出 NOT_FOUND；这也
      // 确保预览本身不产生任何业务写入。
      const message = err instanceof Error ? err.message : String(err);
      const version = db.prepare('SELECT id,status FROM budget_version WHERE id=?').get(versionId);
      // 延期校验分支同样受条数上限约束,params 只保留白名单字段——
      // 否则未校验的原始 entries(仅受 body 大小限制)与客户端任意字段会被放大落库。
      if (!version) {
        if (rawEntries.length > 50_000) throw Errors.validation('批量调整最多 50000 条明细');
        return { params: { versionId, entries: rawEntries }, preview: { type, versionId, changes: rawEntries, validationDeferred: true, validationMessage: message } };
      }
      throw err;
    }
  }
  if (type === 'scenario') return normalizeScenario(db, inputParams);
  if (type === 'basis_text') return normalizeBasis(inputParams);
  if (type === 'export') return normalizeExport(db, inputParams);
  throw Errors.validation('不支持的 AI 操作类型');
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** 预览基线指纹：确认前若业务数据已变化，拒绝把旧预览当成新写入。 */
function previewBaseline(db: DB, type: string, params: Record<string, any>): string | null {
  try {
    if (type === 'copy_budget') {
      const version = db.prepare('SELECT id,year,status,updated_at,org_tree_snapshot_id,account_tree_snapshot_id FROM budget_version WHERE id=?').get(params.sourceVersionId);
      const entries = db.prepare('SELECT org_id,account_id,amount_cents,quantity,formula,note,updated_at FROM budget_entry WHERE version_id=? ORDER BY org_id,account_id').all(params.sourceVersionId);
      return digest({ version, entries });
    }
    if (type === 'budget_draft') {
      const tree = {
        org: db.prepare('SELECT id,parent_id,code,name,sort_order,status FROM org ORDER BY id').all(),
        account: db.prepare('SELECT id,parent_id,code,name,type,unit,quantity_agg,sort_order,status FROM account ORDER BY id').all(),
      };
      let source: unknown;
      if (params.baseFrom === 'budget') {
        const versions = db.prepare("SELECT id,year,status,is_current,updated_at,org_tree_snapshot_id,account_tree_snapshot_id FROM budget_version WHERE year=? AND kind='budget' AND status<>'draft' ORDER BY is_current DESC,created_at DESC,id DESC").all(params.baseYear);
        const selected: any = (versions as any[])[0];
        source = selected ? { version: selected, entries: db.prepare('SELECT org_id,account_id,amount_cents,quantity FROM budget_entry WHERE version_id=? ORDER BY org_id,account_id').all(selected.id) } : null;
      } else if (params.baseFrom === 'actual') {
        source = db.prepare('SELECT org_id,account_id,cumulative_amount_cents,quantity,updated_at FROM actual_current WHERE year=? ORDER BY org_id,account_id').all(params.baseYear);
      } else {
        source = { batch: db.prepare('SELECT id,year,snapshot_date,revision,status,org_tree_snapshot_id,account_tree_snapshot_id FROM actual_snapshot_batch WHERE id=?').get(params.baseSnapshotId), entries: db.prepare('SELECT org_id,account_id,cumulative_amount_cents,quantity FROM actual_snapshot_entry WHERE batch_id=? ORDER BY org_id,account_id').all(params.baseSnapshotId) };
      }
      return digest({ tree, source });
    }
    if (type === 'bulk_adjustment') {
      const version = db.prepare('SELECT id,status,updated_at,org_tree_snapshot_id,account_tree_snapshot_id FROM budget_version WHERE id=?').get(params.versionId);
      const entries = db.prepare('SELECT org_id,account_id,amount_cents,quantity,formula,note,updated_at FROM budget_entry WHERE version_id=? ORDER BY org_id,account_id').all(params.versionId);
      return digest({ version, entries });
    }
  } catch { return null; }
  return null;
}

export function preview(db: DB, input: { type: unknown; params?: unknown; conversationId?: number; idempotencyKey?: string; draft?: unknown }, actor = '') {
  expire(db);
  /**
   * 任何写操作建议都必须基于正式数据库重新创建 preview(§9.6)：
   * 请求内草稿只参与只读回答，绝不透传到 preview/confirm 等正式写入流程。
   */
  if (input?.draft != null) {
    throw Errors.validation('预览不接收页面草稿：请先保存页面修改，再创建正式操作预览');
  }
  const rawParams = plainObject(input?.params);
  if (rawParams.draft != null) {
    throw Errors.validation('预览参数不接收页面草稿：请先保存页面修改，再创建正式操作预览');
  }
  const type = normalizeActionType(input?.type);
  authorizeAction(db, type);
  const keyRaw = input?.idempotencyKey ?? rawParams.idempotencyKey;
  const idempotencyKey = keyRaw == null ? null : boundedText(keyRaw, 'idempotencyKey', 200, true);
  if (idempotencyKey) {
    const old = idempotentAction(db, idempotencyKey);
    // 幂等命中不回吐确认令牌:前端幂等键是可预测的非加密哈希,持键不等于持有预览。
    // 令牌只在创建响应中下发生成方;重试方拿到公开视图,确认必须持原令牌。
    if (old) return { ...publicAction(old), confirmationToken: undefined };
  }
  const conversationId = input?.conversationId == null ? undefined : ensureConversation(db, input.conversationId);
  const normalized = normalizePreview(db, type, rawParams);
  const baseline = previewBaseline(db, type, normalized.params);
  /* 用「键存在」区分「已校验且基线为 null」与「根本没算基线」:
     基线恒写入(即使为 null),确认侧据 hasOwnProperty 判断是否复核,
     而不是靠「有值才比」把延期校验(版本不存在)那条路放空。 */
  const storedParams = { ...normalized.params, _previewBaseline: baseline };
  const timestamp = now();
  const expiresAt = new Date(Date.now() + actionTtlMs()).toISOString();
  const confirmationToken = crypto.randomBytes(32).toString('hex');
  let id: number;
  try {
    const result = db.prepare(
      `INSERT INTO ai_action(conversation_id,type,params_json,preview_json,status,idempotency_key,confirmation_token,expires_at,created_at,updated_at,owner_user_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(conversationId ?? null, type, JSON.stringify(storedParams), JSON.stringify(normalized.preview), 'pending', idempotencyKey, confirmationToken, expiresAt, timestamp, timestamp, currentOwnerId());
    id = Number(result.lastInsertRowid);
  } catch (err) {
    if (idempotencyKey && String((err as Error)?.message || '').includes('UNIQUE')) {
      const old = idempotentAction(db, idempotencyKey);
      if (old) return { ...publicAction(old), confirmationToken: undefined };
    }
    throw err;
  }
  writeLog(db, 'ai.preview', 'ai_action', id, { actor, type, idempotencyKey });
  return publicAction(db.prepare('SELECT * FROM ai_action WHERE id=?').get(id) as AiActionDbRow);
}

export function publicAction(row: AiActionDbRow | undefined): any {
  if (!row) throw Errors.notFound('AI 操作');
  return {
    id: row.id,
    conversationId: row.conversation_id,
    type: row.type,
    status: row.status,
    preview: parseJson(row.preview_json, {}),
    expiresAt: row.expires_at,
    confirmationToken: row.status === 'pending' ? row.confirmation_token : undefined,
    /* result_json 为占用哨兵(export 正在生成)时不作为结果回吐,只暴露生成中态 */
    result: row.result_json === CONFIRMING_SENTINEL ? null : parseJson(row.result_json, null),
    confirming: row.result_json === CONFIRMING_SENTINEL ? true : undefined,
  };
}

/**
 * 幂等键命中的已有操作。键全局唯一:命中他人的操作时不回吐其内容(即使是公开视图),
 * 按冲突拒绝,由调用方换键重试。
 */
function idempotentAction(db: DB, idempotencyKey: string): AiActionDbRow | undefined {
  const old = db.prepare('SELECT * FROM ai_action WHERE idempotency_key=?').get(idempotencyKey) as AiActionDbRow | undefined;
  if (!old) return undefined;
  const owner = ownedRowsFilter();
  const visible = db.prepare(`SELECT id FROM ai_action WHERE id=? AND ${owner.sql}`).get(old.id, ...owner.params);
  if (!visible) throw Errors.conflict('幂等键已被其他操作使用,请重新生成预览');
  return old;
}

function getAction(db: DB, id: number): AiActionDbRow {
  const actionId = positiveInt(id, 'actionId');
  const owner = ownedRowsFilter();
  const row = db.prepare(`SELECT * FROM ai_action WHERE id=? AND ${owner.sql}`).get(actionId, ...owner.params) as AiActionDbRow | undefined;
  if (!row) throw Errors.notFound('AI 操作');
  return row;
}

function checkToken(row: AiActionDbRow, token: unknown): void {
  const supplied = typeof token === 'string' ? token : '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(row.confirmation_token || '');
  if (!supplied || !row.confirmation_token || suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) throw Errors.conflict('确认令牌无效');
}

function executeConfirmed(db: DB, row: AiActionDbRow, actor: string): any {
  // 在事务内再次读取状态，防止两个并发确认都基于事务外的 pending 快照执行写入。
  const current = getAction(db, row.id);
  if (current.status !== 'pending') {
    if (current.status === 'expired') throw Errors.conflict('AI 操作已过期');
    return publicAction(current);
  }
  row = current;
  authorizeAction(db, row.type, parseJson<Record<string, any>>(row.params_json, {}));
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("UPDATE ai_action SET status='expired',updated_at=? WHERE id=? AND status='pending'").run(now(), row.id);
    throw Errors.conflict('AI 操作已过期');
  }
  const p = parseJson<Record<string, any>>(row.params_json, {});
  /* 基线复核按「是否记录过」判定,而非「是否有值」:
     预览侧现在恒写 _previewBaseline(基线为 null 也写)。只有携带键的记录才复核;
     旧记录(本修复前落库、无此键)或基线为 null 的延期校验预览跳过比对,
     由具体业务 service 的最终状态校验(版本存在/状态/守恒闸门)兜底。 */
  if (Object.prototype.hasOwnProperty.call(p, '_previewBaseline') && p._previewBaseline != null) {
    const current = previewBaseline(db, row.type, p);
    if (!current || current !== p._previewBaseline) throw Errors.conflict('预览依据已发生变化，请重新创建预览');
  }
  let result: any;
  if (row.type === 'copy_budget') result = budget.copyVersion(db, positiveInt(p.sourceVersionId, 'sourceVersionId'), boundedText(p.name, '版本名称', 200, true), boundedText(p.note, '备注', 10_000), validYear(p.targetYear, 'targetYear'), boundedRate(p.growthRate, 'growthRate'));
  else if (row.type === 'budget_draft') result = budget.createVersion(db, { year: validYear(p.year, 'year'), name: boundedText(p.name, '版本名称', 200, true), kind: p.kind === 'forecast' ? 'forecast' : 'budget', note: boundedText(p.note, '备注', 10_000), baseFrom: p.baseFrom, baseYear: validYear(p.baseYear, 'baseYear'), baseSnapshotId: p.baseSnapshotId == null ? undefined : positiveInt(p.baseSnapshotId, 'baseSnapshotId'), growthRate: boundedRate(p.growthRate, 'growthRate') });
  else if (row.type === 'bulk_adjustment') result = budget.saveEntries(db, positiveInt(p.versionId, 'versionId'), Array.isArray(p.entries) ? p.entries : []);
  else if (row.type === 'basis_text') {
    const info = db.prepare('INSERT INTO ai_insight(conversation_id,title,result_json,citations_json,created_at,owner_user_id) VALUES(?,?,?,?,?,?)').run(row.conversation_id, boundedText(p.title, '标题', 200, true), JSON.stringify({ text: boundedText(p.text, '依据文本', 20_000, true), draft: true }), JSON.stringify(Array.isArray(p.citations) ? p.citations : []), now(), row.owner_user_id ?? null);
    result = { insightId: Number(info.lastInsertRowid), draft: true };
  } else if (row.type === 'scenario') result = { accepted: true, params: p, deterministic: true };
  else throw Errors.validation('导出操作请使用 confirmAsync');
  db.prepare("UPDATE ai_action SET status='confirmed',result_json=?,updated_at=? WHERE id=? AND status='pending'").run(JSON.stringify(result), now(), row.id);
  writeLog(db, 'ai.confirm', 'ai_action', row.id, { actor, type: row.type });
  return publicAction(getAction(db, row.id));
}

export function confirm(db: DB, id: number, actor = '', confirmationToken?: string) {
  expire(db);
  const row = getAction(db, id);
  if (row.status !== 'pending') {
    if (row.status === 'expired') throw Errors.conflict('AI 操作已过期');
    return publicAction(row);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) throw Errors.conflict('AI 操作已过期');
  checkToken(row, confirmationToken);
  return db.transaction(() => executeConfirmed(db, row, actor))();
}

export async function confirmAsync(db: DB, id: number, actor = '', confirmationToken?: string) {
  expire(db);
  const row = getAction(db, id);
  if (row.status !== 'pending') {
    if (row.status === 'expired') throw Errors.conflict('AI 操作已过期');
    return publicAction(row);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) throw Errors.conflict('AI 操作已过期');
  checkToken(row, confirmationToken);
  if (row.type !== 'export') return confirm(db, id, actor, confirmationToken);
  authorizeAction(db, row.type, parseJson<Record<string, any>>(row.params_json, {}));
  /* 乐观锁:先用条件 UPDATE 把 pending 原子地推进到 confirming,只有一个并发
     确认能拿到 changes=1;拿不到的直接返回现状(另一个请求正在生成)。
     否则两个并发 confirm 都通过事务外的 pending+令牌校验,各自跑一遍大导出
     (CPU/内存放大),最后的条件 UPDATE 只能拦结果落库,拦不住重复生成。
     confirming 不走 status 列(ai_action 的 CHECK 约束只允许四值),改以
     result_json 的 '__confirming__' 哨兵标记 + status 保持 pending 表达,避免迁移。 */
  const claim = db.prepare("UPDATE ai_action SET result_json=?, updated_at=? WHERE id=? AND status='pending' AND (result_json IS NULL OR result_json <> ?)");
  const claimed = claim.run(CONFIRMING_SENTINEL, now(), row.id, CONFIRMING_SENTINEL);
  if (!claimed.changes) return publicAction(getAction(db, row.id));
  const p = parseJson<Record<string, any>>(row.params_json, {});
  let built;
  try {
    built = await buildArtifact(db, row);
  } catch (err) {
    // 生成失败要清掉哨兵回到可重试态;否则这条动作会永久占住无法重试。
    db.prepare("UPDATE ai_action SET result_json=NULL, updated_at=? WHERE id=? AND status='pending' AND result_json=?").run(now(), row.id, CONFIRMING_SENTINEL);
    throw err;
  }
  const result = { contentType: p.format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: built.filename, size: built.buffer.length, downloadUrl: `/api/assistant/actions/${row.id}/download` };
  /* 落定真实结果并推进到 confirmed:只有仍持哨兵(本次占用未被取消/过期)
     才写入,避免与取消/过期竞争时把脏结果盖回去。 */
  const updated = db.prepare("UPDATE ai_action SET status='confirmed',result_json=?,updated_at=? WHERE id=? AND status='pending' AND result_json=?").run(JSON.stringify(result), now(), row.id, CONFIRMING_SENTINEL);
  // 只有本次确认真正把状态推成 confirmed 才缓存，避免并发确认时缓存到被丢弃的那份。
  if (updated.changes) {
    cacheArtifact(row.id, built.filename, built.buffer);
    writeLog(db, 'ai.confirm', 'ai_action', row.id, { actor, type: row.type, size: built.buffer.length });
  }
  return publicAction(getAction(db, row.id));
}

async function csvExport(db: DB, p: Record<string, any>): Promise<string> {
  if (p.kind === 'budget_detail') {
    const rows = db.prepare('SELECT org_id,account_id,amount_cents,quantity,formula,note FROM budget_entry WHERE version_id=? ORDER BY org_id,account_id').all(positiveInt(p.versionId, 'versionId')) as any[];
    return [['org_id', 'account_id', 'amount_cents', 'quantity', 'formula', 'note'], ...rows.map((r) => [r.org_id, r.account_id, r.amount_cents, r.quantity ?? '', r.formula ?? '', r.note ?? ''])].map((r) => r.map(csvCell).join(',')).join('\n');
  }
  if (p.kind === 'actual_current') {
    const rows = db.prepare('SELECT org_id,account_id,cumulative_amount_cents,quantity,source,memo,updated_at FROM actual_current WHERE year=? ORDER BY org_id,account_id').all(validYear(p.year, 'year')) as any[];
    return [['org_id', 'account_id', 'cumulative_amount_cents', 'quantity', 'source', 'memo', 'updated_at'], ...rows.map((r) => [r.org_id, r.account_id, r.cumulative_amount_cents, r.quantity ?? '', r.source, r.memo, r.updated_at])].map((r) => r.map(csvCell).join(',')).join('\n');
  }
  if (p.kind === 'completion') {
    // versionId 放在展开之后：预览阶段已白名单化 options，这里再兜一层，
    // 保证本次修复之前落库的旧 pending 记录也无法用 options 换掉版本。
    const report = require('../modules/report/report.service').completionReport(db, { ...(p.options || {}), versionId: positiveInt(p.versionId, 'versionId') });
    const rows = [['dimension', 'code', 'name', 'budget_cents', 'actual_cents', 'variance_cents', 'rate'], ...report.byAccount.map((r: any) => ['account', r.code, r.name, r.cell.budgetCents, r.cell.actualCents, r.cell.varianceCents, r.cell.rate ?? ''])];
    return rows.map((r) => r.map(csvCell).join(',')).join('\n');
  }
  throw Errors.validation('不支持的导出类型');
}

/**
 * 已确认导出文件的进程内缓存。
 *
 * 原来 `confirmAsync` 生成一次只为了拿 `size` 就丢掉，`exportArtifact` 每次下载再
 * 重新生成一遍：同一份导出至少算两次，重复点下载就是 N 次。缓存后：
 * - 下载直接复用确认那一刻的字节，与「确认即所得」一致(重算可能已受后续数据变更影响)；
 * - 进程重启或缓存淘汰后回退到重新生成，行为不变。
 */
const ARTIFACT_CACHE_MAX_ENTRIES = 8;
const ARTIFACT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const artifactCache = new Map<number, { buffer: Buffer; filename: string }>();

function cacheArtifact(actionId: number, filename: string, buffer: Buffer): void {
  if (buffer.length > ARTIFACT_CACHE_MAX_BYTES) return;
  artifactCache.delete(actionId);
  artifactCache.set(actionId, { buffer, filename });
  let total = 0;
  for (const entry of artifactCache.values()) total += entry.buffer.length;
  // Map 保持插入顺序，先淘汰最早的。
  while (artifactCache.size > ARTIFACT_CACHE_MAX_ENTRIES || total > ARTIFACT_CACHE_MAX_BYTES) {
    const oldest = artifactCache.keys().next();
    if (oldest.done) break;
    const dropped = artifactCache.get(oldest.value);
    artifactCache.delete(oldest.value);
    total -= dropped?.buffer.length ?? 0;
  }
}

/** 仅供测试使用：清空导出缓存。 */
export function resetArtifactCache(): void { artifactCache.clear(); }

async function buildArtifact(db: DB, row: AiActionDbRow): Promise<{ buffer: Buffer; filename: string }> {
  const p = parseJson<Record<string, any>>(row.params_json, {});
  const base = `assistant-export-${row.id}`;
  if (p.format === 'csv') return { buffer: Buffer.from(await csvExport(db, p), 'utf8'), filename: `${base}.csv` };
  if (p.kind === 'budget_detail') return { buffer: await exportSvc.exportBudgetDetail(db, positiveInt(p.versionId, 'versionId')), filename: `${base}.xlsx` };
  if (p.kind === 'actual_current') return { buffer: await exportSvc.exportActualCurrent(db, validYear(p.year, 'year')), filename: `${base}.xlsx` };
  if (p.kind === 'completion') return { buffer: await exportSvc.exportCompletion(db, positiveInt(p.versionId, 'versionId'), p.options || null), filename: `${base}.xlsx` };
  throw Errors.validation('不支持的导出类型');
}

export async function exportArtifact(db: DB, id: number): Promise<{ buffer: Buffer; filename: string }> {
  const row = getAction(db, id);
  if (row.status !== 'confirmed' || row.type !== 'export') throw Errors.conflict('导出操作尚未确认');
  // 下载同样复核授权:确认后被撤权/收窄范围的用户不能再取得文件。
  authorizeAction(db, row.type, parseJson<Record<string, any>>(row.params_json, {}));
  const cached = artifactCache.get(row.id);
  if (cached) return cached;
  const built = await buildArtifact(db, row);
  cacheArtifact(row.id, built.filename, built.buffer);
  return built;
}

export function cancel(db: DB, id: number, actor = '') {
  expire(db);
  const row = getAction(db, id);
  if (row.status !== 'pending') return publicAction(row);
  const changed = db.prepare("UPDATE ai_action SET status='cancelled',updated_at=? WHERE id=? AND status='pending'").run(now(), row.id).changes;
  if (changed) writeLog(db, 'ai.cancel', 'ai_action', row.id, { actor });
  return publicAction(getAction(db, row.id));
}

export function conversations(db: DB) {
  const owner = ownedRowsFilter();
  return db.prepare(`SELECT id,title,created_at,updated_at FROM ai_conversation WHERE ${owner.sql} ORDER BY updated_at DESC,id DESC`).all(...owner.params);
}

/**
 * 会话重命名。
 *
 * 标题原来只能取首条消息的前若干字符，一长串问句在侧栏里根本认不出来，
 * 所以补一个显式重命名入口；空标题回退成「会话 #id」由前端展示。
 */
export function renameConversation(db: DB, id: number, title: unknown, actor = '') {
  const conversationId = ensureConversation(db, id);
  const safeTitle = boundedText(title, 'title', 200, false);
  db.prepare('UPDATE ai_conversation SET title=?, updated_at=? WHERE id=?').run(safeTitle, now(), conversationId);
  writeLog(db, 'ai.conversation.rename', 'ai_conversation', conversationId, { actor, title: safeTitle });
  return db.prepare('SELECT id,title,created_at,updated_at FROM ai_conversation WHERE id=?').get(conversationId);
}

/**
 * 删除会话。
 *
 * 消息随 `ON DELETE CASCADE` 一起删除；已产生的操作(ai_action)与洞察(ai_insight)
 * 只把 conversation_id 置空(建表即为 ON DELETE SET NULL)，**不删除已落库的业务痕迹**，
 * 因此已确认的操作、已保存的洞察和操作日志仍然可追溯。
 */
export function deleteConversation(db: DB, id: number, actor = '') {
  const conversationId = ensureConversation(db, id);
  const row = db.prepare('SELECT id,title FROM ai_conversation WHERE id=?').get(conversationId) as { id: number; title: string };
  const messageCount = (db.prepare('SELECT COUNT(*) n FROM ai_message WHERE conversation_id=?').get(conversationId) as { n: number }).n;
  const pending = (db.prepare("SELECT COUNT(*) n FROM ai_action WHERE conversation_id=? AND status='pending'").get(conversationId) as { n: number }).n;
  db.transaction(() => {
    db.prepare('DELETE FROM ai_conversation WHERE id=?').run(conversationId);
    writeLog(db, 'ai.conversation.delete', 'ai_conversation', conversationId, { actor, title: row.title, messageCount, pendingActions: pending });
  })();
  return { id: conversationId, deleted: true, messageCount, pendingActions: pending };
}

/** 删除已保存的洞察。洞察是只读分析快照，删除不影响任何业务数据。 */
export function deleteInsight(db: DB, id: number, actor = '') {
  const insightId = positiveInt(id, 'insightId');
  const owner = insightRowsFilter();
  const row = db.prepare(`SELECT id,title FROM ai_insight WHERE id=? AND ${owner.sql}`).get(insightId, ...owner.params) as { id: number; title: string } | undefined;
  if (!row) throw Errors.notFound('AI 洞察');
  db.transaction(() => {
    db.prepare('DELETE FROM ai_insight WHERE id=?').run(insightId);
    writeLog(db, 'ai.insight.delete', 'ai_insight', insightId, { actor, title: row.title });
  })();
  return { id: insightId, deleted: true };
}

export function conversation(db: DB, id: number) {
  const conversationId = ensureConversation(db, id);
  const row = db.prepare('SELECT id,title,created_at,updated_at FROM ai_conversation WHERE id=?').get(conversationId);
  const messages = db.prepare('SELECT id,role,content,response_json,model,created_at FROM ai_message WHERE conversation_id=? ORDER BY id').all(conversationId) as any[];
  // 只回解析后的 response：原来是 `{ ...m, response: parseJson(...) }`，把原始
  // response_json 字符串和解析结果一起发出去，等于把同一份事实传两遍。
  // 单条 execution 事实就有 190KB 量级，前端也从不读 response_json。
  return {
    conversation: row,
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, model: m.model, created_at: m.created_at, response: parseJson(m.response_json, {}) })),
  };
}

export function insight(db: DB, id: number) {
  const insightId = positiveInt(id, 'insightId');
  const owner = insightRowsFilter();
  const row = db.prepare(`SELECT * FROM ai_insight WHERE id=? AND ${owner.sql}`).get(insightId, ...owner.params) as any;
  if (!row) throw Errors.notFound('洞察');
  // 同理：result_json / citations_json 不随解析结果一起回传;归属列是内部授权字段,不外露。
  const { result_json: _resultJson, citations_json: _citationsJson, owner_user_id: _owner, ...rest } = row;
  return { ...rest, result: parseJson(row.result_json, {}), citations: parseJson(row.citations_json, []) };
}

export function insights(db: DB, limit = 50) {
  const size = Math.min(200, Math.max(1, Number.isSafeInteger(Number(limit)) ? Number(limit) : 50));
  const owner = insightRowsFilter();
  return db.prepare(`SELECT id,conversation_id,title,created_at FROM ai_insight WHERE ${owner.sql} ORDER BY id DESC LIMIT ?`).all(...owner.params, size)
    .map((row: any) => ({ id: row.id, conversationId: row.conversation_id, title: row.title, createdAt: row.created_at }));
}

/** 保存的分析洞察类型;结果由后端重新确定性计算，不接受前端传入的数字。 */
const INSIGHT_KINDS = new Set(['execution', 'anomalies', 'attribution', 'report', 'trend', 'accuracy', 'version_variance', 'historical_comparison', 'budget_quality']);

function boundedCell(cell: any) {
  if (!cell || typeof cell !== 'object') return null;
  return {
    budgetCents: cell.budgetCents, actualCents: cell.actualCents, varianceCents: cell.varianceCents,
    budgetQuantity: cell.budgetQuantity, actualQuantity: cell.actualQuantity, varianceQuantity: cell.varianceQuantity,
    rate: cell.rate, rateSpecial: cell.rateSpecial, favorable: cell.favorable, progressDeviation: cell.progressDeviation, pace: cell.pace,
  };
}

/** 洞察只保存有界摘要与引用，不保存完整数据库副本(方案 5.4)。 */
function summarizeInsight(kind: string, data: any) {
  const top = (rows: any[], key: 'accountId' | 'orgId') => [...(rows || [])]
    .filter((row) => row.isLeaf)
    .sort((a, b) => Math.abs(b.cell?.varianceCents ?? 0) - Math.abs(a.cell?.varianceCents ?? 0))
    .slice(0, 20)
    .map((row) => ({ [key]: row[key], code: row.code, name: row.name, type: row.type, cell: boundedCell(row.cell) }));
  if (kind === 'execution') {
    return {
      version: { id: data.version?.id, year: data.version?.year, name: data.version?.name, status: data.version?.status },
      asOfDate: data.asOfDate, actualSource: data.actualSource, actualBatchId: data.actualBatchId,
      timeProgressValue: data.timeProgressValue, treeBasis: data.treeBasis, scopeBasis: data.scopeBasis,
      metrics: (data.metrics || []).map((m: any) => ({ metricId: m.metricId, code: m.code, name: m.name, displaySign: m.displaySign, cell: boundedCell(m.cell) })),
      topAccounts: top(data.analysisAccounts, 'accountId'), topOrganizations: top(data.byOrg, 'orgId'),
      unbudgetedActual: data.unbudgetedActual,
      reconciliation: data.reconciliation,
      notes: data.notes,
    };
  }
  if (kind === 'anomalies') {
    return {
      version: { id: data.version?.id, year: data.version?.year, name: data.version?.name, status: data.version?.status },
      asOfDate: data.asOfDate, actualSource: data.actualSource, actualBatchId: data.actualBatchId,
      thresholds: { rate: data.threshold, yoy: data.yoyThreshold, peer: data.peerThreshold },
      previousYear: data.previousYear, quality: data.quality, countsByCode: data.countsByCode, checks: data.checks,
      anomalyCount: data.anomalyCount,
      anomalies: (data.anomalies || []).slice(0, 200).map((item: any) => ({ ...item, cell: boundedCell(item.cell) })),
      notes: data.notes,
    };
  }
  if (kind === 'budget_quality') return data;
  if (kind === 'attribution') {
    const trim = (nodes: any[], depth = 0): any[] => (depth > 3 ? [] : (nodes || []).slice(0, 20).map((node: any) => ({
      ...node, children: trim(node.children, depth + 1),
    })));
    return {
      version: { id: data.version?.id, year: data.version?.year, name: data.version?.name, status: data.version?.status },
      asOfDate: data.asOfDate, actualSource: data.actualSource, actualBatchId: data.actualBatchId,
      params: data.params, totals: data.totals, reconciliation: data.reconciliation,
      byOrg: trim(data.byOrg), byAccount: trim(data.byAccount),
      rankedOrgLeaves: (data.rankedOrgLeaves || []).slice(0, 50),
      rankedAccountLeaves: (data.rankedAccountLeaves || []).slice(0, 50),
      quantityVariances: (data.quantityVariances || []).slice(0, 50),
      notes: data.notes,
    };
  }
  if (kind === 'report') {
    return {
      kind: data.kind, kindLabel: data.kindLabel, title: data.title, generatedAt: data.generatedAt,
      period: data.period, scope: data.scope,
      sections: (data.sections || []).map((section: any) => ({
        key: section.key, title: section.title, bullets: section.bullets, citations: section.citations,
      })),
      narrative: data.narrative, narrativeSource: data.narrativeSource,
      suggestions: data.suggestions, notes: data.notes,
    };
  }
  if (kind === 'accuracy' || kind === 'historical_comparison') return data;
  if (kind === 'version_variance') {
    return { ...data, rows: Array.isArray(data.rows) ? data.rows.slice(0, 200) : data.rows, items: Array.isArray(data.items) ? data.items.slice(0, 200) : data.items };
  }
  if (kind === 'trend') return data;
  return data;
}

export function saveInsight(db: DB, input: { conversationId?: number; title?: unknown; kind: unknown; params?: unknown; note?: unknown }, actor = '') {
  const kind = String(input?.kind || '').trim().toLowerCase();
  if (!INSIGHT_KINDS.has(kind)) throw Errors.validation(`不支持的洞察类型，可选：${[...INSIGHT_KINDS].join('、')}`);
  const p = plainObject(input?.params);
  const note = boundedText(input?.note, '备注', 10_000);
  const conversationId = input?.conversationId == null ? null : ensureConversation(db, positiveInt(input.conversationId, 'conversationId'));
  let data: any;
  let source: FactRecord['source'] = {};
  if (kind === 'attribution') {
    const versionId = positiveInt(p.versionId, 'versionId');
    const version = budget.getVersion(db, versionId);
    data = executeTool(db, 'calculate_attribution', {
      versionId,
      batchId: p.batchId == null ? null : positiveInt(p.batchId, 'batchId'),
      orgScopeId: p.orgScopeId == null ? null : positiveInt(p.orgScopeId, 'orgScopeId'),
      accountScopeId: p.accountScopeId == null ? null : positiveInt(p.accountScopeId, 'accountScopeId'),
      sheetKey: p.sheetKey == null ? null : boundedText(p.sheetKey, 'sheetKey', 80),
      ...(p.maxDepth == null ? {} : { maxDepth: Number(p.maxDepth) }),
      ...(p.topN == null ? {} : { topN: Number(p.topN) }),
      ...(p.direction == null ? {} : { direction: String(p.direction) }),
    });
    source = { year: version.year, budgetVersionId: versionId, actualSnapshotId: data.actualBatchId ?? null, asOf: data.asOfDate || now(), treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id } };
  } else if (kind === 'report') {
    data = executeTool(db, 'generate_report', {
      kind: normalizeReportKind(p.reportKind ?? p.kind ?? 'monthly_execution'),
      versionId: p.versionId == null ? null : positiveInt(p.versionId, 'versionId'),
      year: p.year == null ? null : validYear(p.year, 'year'),
      batchId: p.batchId == null ? null : positiveInt(p.batchId, 'batchId'),
      targetVersionId: p.targetVersionId == null ? null : positiveInt(p.targetVersionId, 'targetVersionId'),
      orgScopeId: p.orgScopeId == null ? null : positiveInt(p.orgScopeId, 'orgScopeId'),
      accountScopeId: p.accountScopeId == null ? null : positiveInt(p.accountScopeId, 'accountScopeId'),
      sheetKey: p.sheetKey == null ? null : boundedText(p.sheetKey, 'sheetKey', 80),
      ...(p.topN == null ? {} : { topN: Number(p.topN) }),
    });
    source = {
      year: data.period?.year ?? undefined,
      budgetVersionId: data.scope?.versionId ?? null,
      targetVersionId: data.scope?.targetVersionId ?? undefined,
      actualSnapshotId: data.scope?.actualBatchId ?? null,
      asOf: data.period?.asOfDate || data.generatedAt,
      treeSnapshotIds: data.scope?.treeSnapshotIds,
    };
  } else if (kind === 'execution' || kind === 'anomalies') {
    const versionId = positiveInt(p.versionId, 'versionId');
    const version = budget.getVersion(db, versionId);
    const args = {
      versionId,
      batchId: p.batchId == null ? null : positiveInt(p.batchId, 'batchId'),
      orgScopeId: p.orgScopeId == null ? null : positiveInt(p.orgScopeId, 'orgScopeId'),
      accountScopeId: p.accountScopeId == null ? null : positiveInt(p.accountScopeId, 'accountScopeId'),
      sheetKey: p.sheetKey == null ? null : boundedText(p.sheetKey, 'sheetKey', 80),
      ...(kind === 'anomalies' ? {
        threshold: p.threshold == null ? undefined : Number(p.threshold),
        yoyThreshold: p.yoyThreshold == null ? undefined : Number(p.yoyThreshold),
        peerThreshold: p.peerThreshold == null ? undefined : Number(p.peerThreshold),
      } : {}),
    };
    data = executeTool(db, kind === 'execution' ? 'calculate_execution' : 'calculate_anomalies', args);
    source = { year: version.year, budgetVersionId: versionId, actualSnapshotId: data.actualBatchId ?? null, asOf: data.asOfDate || now(), treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id } };
  } else if (kind === 'trend') {
    const versionId = positiveInt(p.versionId, 'versionId');
    const version = budget.getVersion(db, versionId);
    data = executeTool(db, 'calculate_trend', { year: p.year == null ? version.year : validYear(p.year, 'year'), versionId, batchId: p.batchId == null ? null : positiveInt(p.batchId, 'batchId') });
    source = { year: version.year, budgetVersionId: versionId, asOf: now(), treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id } };
  } else if (kind === 'accuracy') {
    const year = validYear(p.year, 'year');
    data = executeTool(db, 'calculate_accuracy', { year });
    source = { year, asOf: now() };
  } else if (kind === 'version_variance') {
    const baseVersionId = positiveInt(p.baseVersionId, 'baseVersionId');
    const targetVersionId = positiveInt(p.targetVersionId, 'targetVersionId');
    data = executeTool(db, 'calculate_variance', { baseVersionId, targetVersionId });
    source = { year: budget.getVersion(db, baseVersionId).year, budgetVersionId: baseVersionId, targetVersionId, asOf: now() };
  } else if (kind === 'budget_quality') {
    const versionId = positiveInt(p.versionId, 'versionId');
    const version = budget.getVersion(db, versionId);
    data = executeTool(db, 'get_budget_quality', { versionId });
    source = { year: version.year, budgetVersionId: versionId, asOf: now(), treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id } };
  } else {
    data = executeTool(db, 'get_historical_comparison', {});
    source = { asOf: now() };
  }
  const citations = citationsForFacts([{ type: `insight:${kind}`, data, source }]);
  const title = boundedText(input?.title || `${kind} 分析洞察`, '标题', 200, true);
  const timestamp = now();
  const result = { kind, params: p, generatedAt: timestamp, note, summary: summarizeInsight(kind, data) };
  const info = db.prepare('INSERT INTO ai_insight(conversation_id,title,result_json,citations_json,created_at,owner_user_id) VALUES(?,?,?,?,?,?)')
    .run(conversationId, title, JSON.stringify(result), JSON.stringify(citations), timestamp, currentOwnerId());
  const id = Number(info.lastInsertRowid);
  writeLog(db, 'ai.insight', 'ai_insight', id, { actor, kind });
  return insight(db, id);
}

/* ------------------------------------------------------------------ *
 * 只读分析入口(方案 4.1 导入辅助 / 4.3 差异归因与报告生成)
 * 三个入口都不写业务数据；数字全部来自现有分析 service。
 * ------------------------------------------------------------------ */

/** 差异归因:按组织、科目和方向排序,支持逐层展开(方案 4.3)。 */
export function attribution(db: DB, input: Record<string, unknown>) {
  const p = plainObject(input);
  // §9.1：与 chat 共用统一解析入口；页面范围作为参数的缺省来源。
  const pageCtx = resolveBackendContext(db, p.pageContext);
  return executeTool(db, 'calculate_attribution', {
    versionId: positiveInt(p.versionId ?? pageCtx?.pageContext.budgetVersionId, 'versionId'),
    batchId: p.batchId == null ? pageCtx?.pageContext.actualSnapshotId ?? null : positiveInt(p.batchId, 'batchId'),
    orgScopeId: p.orgScopeId == null ? pageCtx?.pageContext.orgId ?? null : positiveInt(p.orgScopeId, 'orgScopeId'),
    accountScopeId: p.accountScopeId == null ? pageCtx?.pageContext.accountId ?? null : positiveInt(p.accountScopeId, 'accountScopeId'),
    sheetKey: p.sheetKey == null ? (typeof pageCtx?.view.sheetKey === 'string' ? pageCtx.view.sheetKey : null) : boundedText(p.sheetKey, 'sheetKey', 80),
    ...(p.maxDepth == null ? {} : { maxDepth: Number(p.maxDepth) }),
    ...(p.topN == null ? {} : { topN: Number(p.topN) }),
    ...(p.direction == null ? {} : { direction: boundedText(p.direction, 'direction', 20) }),
  });
}

/** 导入辅助:错误解释 + 组织/科目匹配建议 + 未匹配与重复清单(方案 4.1)。 */
export function importHelp(db: DB, input: Record<string, unknown>) {
  const p = plainObject(input);
  const pageCtx = resolveBackendContext(db, p.pageContext);
  if (p.errors != null && !Array.isArray(p.errors)) throw Errors.validation('errors必须是数组');
  if (Array.isArray(p.errors) && p.errors.length > 20_000) throw Errors.validation('errors 最多 20000 条');
  return executeTool(db, 'explain_import', {
    batchId: p.batchId == null ? pageCtx?.pageContext.importBatchId ?? null : positiveInt(p.batchId, 'batchId'),
    errors: Array.isArray(p.errors) ? p.errors : undefined,
    suggestionLimit: p.suggestionLimit == null ? null : positiveInt(p.suggestionLimit, 'suggestionLimit'),
  });
}

/**
 * 报告生成(方案 4.3):后端先确定性组稿,模型可用时只改写叙述文字。
 * 改写走公共叙述管道(narrative.ts):双向事实 token 守卫(数字 + 编码 + 专名词条)
 * + 按草稿哈希缓存;模型失败、不可用或改动了任何事实时保留模板叙述,
 * 数字与引用在任何情况下都不变。
 *
 * 年度复盘(计划阶段五)只改写「年度节奏对比」章节:其余章节是历年对比、准确率与归因的
 * 确定性表格化结论,不在本阶段叙述范围内,整份改写会越过阶段边界。
 */
export async function reportDraft(db: DB, input: Record<string, unknown>): Promise<ReportDraft & { model: string }> {
  const p = plainObject(input);
  // §9.1：与 chat 共用统一解析入口；页面范围作为参数的缺省来源。
  const pageCtx = resolveBackendContext(db, p.pageContext);
  // 与 generate_report 工具同一道授权(AC-X04):权限、组织范围与集团口径章节限制。
  const [authorized] = authorizeToolCall(db, 'generate_report', [{
    kind: normalizeReportKind(p.kind),
    versionId: p.versionId == null ? pageCtx?.pageContext.budgetVersionId ?? null : positiveInt(p.versionId, 'versionId'),
    year: p.year == null ? pageCtx?.pageContext.year ?? null : validYear(p.year, 'year'),
    batchId: p.batchId == null ? pageCtx?.pageContext.actualSnapshotId ?? null : positiveInt(p.batchId, 'batchId'),
    targetVersionId: p.targetVersionId == null ? pageCtx?.pageContext.targetVersionId ?? null : positiveInt(p.targetVersionId, 'targetVersionId'),
    orgScopeId: p.orgScopeId == null ? pageCtx?.pageContext.orgId ?? null : positiveInt(p.orgScopeId, 'orgScopeId'),
    accountScopeId: p.accountScopeId == null ? pageCtx?.pageContext.accountId ?? null : positiveInt(p.accountScopeId, 'accountScopeId'),
    sheetKey: p.sheetKey == null ? (typeof pageCtx?.view.sheetKey === 'string' ? pageCtx.view.sheetKey : null) : boundedText(p.sheetKey, 'sheetKey', 80),
    topN: p.topN == null ? null : positiveInt(p.topN, 'topN'),
  }]);
  const draft = buildReportDraft(db, authorized as Parameters<typeof buildReportDraft>[1]);
  const wantsNarrative = p.narrative == null ? true : Boolean(p.narrative);
  if (!wantsNarrative) return { ...draft, model: 'template' };
  if (draft.kind === 'annual_review') return annualReviewTrendRewrite(db, draft);
  const rewrite = await rewriteTemplateNarrative({
    enabled: true,
    promptVersion: PROMPT_VERSION.reportRewrite,
    supplement: promptSupplement(db, 'reportRewrite'),
    task: REPORT_REWRITE_TASK,
    template: draft.narrative,
    factTerms: draft.factTerms,
  });
  if (rewrite.guardFailure) return { ...draft, model: 'template', notes: guardFallbackNotes(draft, rewrite.guardFailure) };
  if (rewrite.source === 'model') {
    return { ...draft, narrative: rewrite.text, narrativeSource: 'model', model: rewrite.model };
  }
  return { ...draft, model: 'template' };
}

function guardFallbackNotes(draft: ReportDraft, failure: { extra: string[]; missing: string[] }): string[] {
  return [
    ...(draft.notes ?? []),
    `模型改写稿改变了事实 token（新增: ${failure.extra.join('、') || '无'}；缺失: ${failure.missing.join('、') || '无'}），已丢弃改写并保留确定性叙述`,
  ];
}

/**
 * 年度复盘:只把「年度节奏对比」章节交给模型改写,再按原位替换回整份叙述。
 * 章节块由 sectionMarkdown 生成,与 assemble 的组装口径同源,因此替换后其余章节逐字不变;
 * 开关关闭、模型不可用或守卫失败时整份保持模板稿。
 */
async function annualReviewTrendRewrite(db: DB, draft: ReportDraft): Promise<ReportDraft & { model: string }> {
  const section = draft.sections.find((item) => item.key === 'trend');
  if (!section) return { ...draft, model: 'template' };
  const block = sectionMarkdown(section);
  if (!draft.narrative.includes(block)) return { ...draft, model: 'template' };
  const rewrite = await rewriteTemplateNarrative({
    enabled: trendNarrativeAiEnabled(),
    promptVersion: PROMPT_VERSION.trendNarrative,
    supplement: promptSupplement(db, 'trendNarrative'),
    task: TREND_SECTION_REWRITE_TASK,
    template: block,
    factTerms: draft.factTerms,
    maxChars: 20_000,
  });
  if (rewrite.guardFailure) return { ...draft, model: 'template', notes: guardFallbackNotes(draft, rewrite.guardFailure) };
  if (rewrite.source !== 'model') return { ...draft, model: 'template' };
  return {
    ...draft,
    // 函数式替换:避免改写稿中的 $& / $1 被当成替换模式解释
    narrative: draft.narrative.replace(block, () => rewrite.text),
    narrativeSource: 'model',
    model: rewrite.model,
    notes: [...(draft.notes ?? []), '模型改写仅作用于「四、年度节奏对比」章节,其余章节逐字保留确定性叙述'],
  };
}
