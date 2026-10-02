import type { DB } from '../db/connection';
import type { AssistantScope, SelectionDescriptor } from '../contracts/assistant';
import { AppError } from '../core/errors';
import { validateInput } from '../core/input';
import { aliasFilterSchema, metricFilterSchema } from '../contracts/list-filters';
import * as metric from '../modules/metric/metric.service';
import * as alias from '../modules/io/cleaning/alias.service';
import { analyzeConfigDraft } from './config-draft';
import { analyzeGridSelection, resolveGridSelection } from '../modules/analysis/selection.service';
import type { NormalizedDraft } from './draft-context';

/** 只由服务端解析页面快照后构建，模型参数不能提供或覆盖。 */
export interface SelectionExecution {
  selection: SelectionDescriptor;
  scope: AssistantScope;
  view: Record<string, unknown>;
  draft?: NormalizedDraft | null;
}
export function selectionToolName(input: SelectionExecution): string {
  if (input.selection.mode === 'bounds') return input.scope.pageKey === 'budget_edit' ? 'get_budget_selection' : 'get_actual_selection';
  if (input.scope.pageKey === 'metric') return 'list_metrics';
  if (input.scope.pageKey === 'cleaning_config' && input.view.tab === 'aliases') return 'list_cleaning_aliases';
  throw new AppError('CAPABILITY_UNAVAILABLE', '当前页面或页签不支持此选择分析', 400);
}
function selectedIds(input: SelectionExecution, type: string) {
  if (input.selection.mode !== 'refs') return undefined;
  if (!input.selection.refs.length || input.selection.refs.some((r) => r.entityType !== type)) throw new AppError('CONTEXT_INVALID', '请明确选择同类对象', 400);
  const ids = [...new Set(input.selection.refs.map((r) => r.id))];
  if (ids.length > 500) throw new AppError('CONTEXT_TOO_LARGE', '选择超过 500 个对象，请缩小范围', 400);
  return ids;
}
function limit(count: number) {
  if (count > 500) throw new AppError('CONTEXT_TOO_LARGE', '当前筛选匹配超过 500 个对象，请缩小筛选', 400);
}
function queryFilter(input: SelectionExecution, keys: string[]) {
  if (input.selection.mode !== 'query') return {};
  const query = input.selection.query;
  // 页面真实筛选与选择必须同一语义状态；客户端不得声明总数、行或 SQL。
  for (const key of new Set([...Object.keys(query), ...keys.filter((k) => input.view[k] != null)])) {
    if (!keys.includes(key) || query[key] !== input.view[key]) throw new AppError('CONTEXT_CONFLICT', '选择筛选与当前页面不一致，请重新选择当前筛选结果', 409);
  }
  return query;
}
export function analyzeMetricSelection(db: DB, input: SelectionExecution) {
  if (selectionToolName(input) !== 'list_metrics') throw new AppError('CAPABILITY_UNAVAILABLE', '该工具不支持当前选区', 400);
  const ids = selectedIds(input, 'metric');
  const filter = validateInput(metricFilterSchema, queryFilter(input, ['search', 'kind', 'status']));
  if (!ids) limit(metric.countMetrics(db, filter));
  const rows = metric.listMetrics(db, filter, ids);
  if (ids && rows.length !== ids.length) throw new AppError('CONTEXT_STALE', '所选指标已失效，请重新选择', 409);
  const items = rows.slice(0, 30).map((m) => ({ id: m.id, code: m.code, name: m.name, kind: m.kind, status: m.status, terms: m.terms.map((t) => ({ sourceType: t.source_type, sourceAccountId: t.source_account_id, sourceMetricId: t.source_metric_id, coefficient: t.coefficient, role: t.role })) }));
  const analyses = rows.map((m) => ({ id: m.id, ...analyzeConfigDraft(db, 'metric_formula', 'update', {}, m.id) }));
  return { mode: input.selection.mode, count: rows.length, ids: rows.map((m) => m.id), items, issueCount: analyses.reduce((n, a) => n + a.issues.length, 0), analyses: analyses.slice(0, 30), truncated: rows.length > 30, omitted: Math.max(0, rows.length - 30), explanation: '只分析已选择的当前指标；全部对象已校验，详情最多 30 项。公式依赖可读取必要节点，已有历史快照不重算。' };
}
export function analyzeAliasSelection(db: DB, input: SelectionExecution) {
  if (selectionToolName(input) !== 'list_cleaning_aliases') throw new AppError('CAPABILITY_UNAVAILABLE', '该工具不支持当前选区', 400);
  const ids = selectedIds(input, 'alias_rule');
  const filter = validateInput(aliasFilterSchema, queryFilter(input, ['search', 'targetKind', 'mappingKind']));
  if (!ids) limit(alias.countAliases(db, filter));
  const rows = alias.listAliases(db, filter, ids);
  if (ids && rows.length !== ids.length) throw new AppError('CONTEXT_STALE', '所选别名已失效，请重新选择', 409);
  if (rows.some((r) => r.target_kind !== input.view.targetKind)) throw new AppError('CONTEXT_CONFLICT', '所选别名与当前目标数据集不一致', 409);
  const analyses = rows.map((r) => {
    const analysis = analyzeConfigDraft(db, 'alias_rule', 'update', {}, r.id);
    return { id: r.id, mappingKind: r.mapping_kind, targetCode: r.target_code, issues: analysis.issues, explanation: analysis.explanation };
  });
  return { mode: input.selection.mode, count: rows.length, ids: rows.map((r) => r.id), items: analyses.slice(0, 30), issueCount: analyses.reduce((n, a) => n + a.issues.length, 0), truncated: rows.length > 30, omitted: Math.max(0, rows.length - 30), explanation: '已按同源保存规则检查全部选择的规范化重名与目标适用性；来源文本不进入模型。详情最多 30 项。' };
}
export function analyzeSelectedGrid(db: DB, input: SelectionExecution) {
  const range = resolveGridSelection(db, input.scope, input.view, input.selection);
  const entries = input.scope.pageKey === 'budget_edit' ? input.draft?.overlay?.budget?.entries : input.draft?.overlay?.actual?.entries;
  return analyzeGridSelection(db, input.scope, range, entries);
}
export function assertSelectionDraft(input: SelectionExecution) {
  const draft = input.draft;
  if (!draft) return;
  if (input.selection.mode === 'refs') {
    const entityType = draft.kind === 'metric_formula' ? 'metric' : draft.kind === 'alias_rule' ? 'alias_rule' : null;
    if (input.selection.refs.some((r) => r.entityType !== entityType)) throw new AppError('CONTEXT_CONFLICT', '选择类型与未保存草稿不一致，请清空选择', 409);
  }
  if (input.selection.mode !== 'bounds' && (draft.config?.targetId == null || input.selection.mode !== 'refs' || input.selection.refs.length !== 1 || input.selection.refs[0].id !== draft.config.targetId)) throw new AppError('CONTEXT_CONFLICT', '选择与未保存表单对象不一致，请清空选择后检查草稿', 409);
  if (input.selection.mode === 'bounds' && !draft.overlay) throw new AppError('CONTEXT_CONFLICT', '网格选区不能用于配置表单，请清空选择', 409);
}
