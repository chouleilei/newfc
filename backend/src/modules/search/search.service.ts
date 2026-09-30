import type { DB } from '../../db/connection';
import { currentAuth } from '../../core/request-context';
import { Errors } from '../../core/errors';
import type { Permission } from '../security/permissions';
import { listProjects, listSuppliers } from '../master/master.service';
import { listContracts } from '../contracts/contract.service';
import { listClaims } from '../expense/expense.service';
import { listProjectBudgetBatches } from '../project-budget/project-budget.service';
import { listFeasProjects } from '../investment/feasibility.service';
import { listIcProjects } from '../investment/control.service';
import { listForecastModels } from '../forecast/forecast.service';
import { listRiskEvents } from '../risk/risk.service';
import { listAnalysisReports } from '../analysis-reports/report.service';
import { listVersions } from '../budget/budget.service';
import { SEARCH_TYPES, SEARCH_TYPE_LABELS, type SearchItemDto, type SearchResultDto, type SearchType } from '../../contracts/search';
import { CONTRACT_STAGE_LABELS, CONTRACT_STATUS_LABELS } from '../../contracts/project-contract';
import { CLAIM_STATUS_LABELS } from '../../contracts/expense';
import { RISK_STATUS_LABELS } from '../../contracts/risk';
import { RPT_STATUS_LABELS } from '../../contracts/analysis-reports';

/**
 * 跨域检索(T-6,AC-F26)。每类对象复用该域页面列表所用的 service,因而与页面使用同一套权限与组织范围裁剪;
 * 缺少读权限的类型跳过并在 skipped 中说明。关键词中的 % _ \ 不作通配符(去除后匹配),去除后为空时拒绝。
 * 这是编码/名称的关键词匹配,不是语义检索。
 */

const PERMISSION: Record<SearchType, Permission> = {
  project: 'master:read', supplier: 'master:read', contract: 'contract:read', expense_claim: 'expense:read',
  project_budget_batch: 'project_budget:read', feasibility_project: 'investment:read', investment_project: 'investment:read',
  forecast_model: 'forecast:read', risk_event: 'risk:read', analysis_report: 'report:read', budget_version: 'budget:read',
};
const PER_TYPE_DEFAULT = 20;
const TOTAL_LIMIT = 100;
const ACTIVE_LABEL: Record<string, string> = { active: '有效', inactive: '停用', archived: '已归档' };
const VERSION_STATUS_LABEL: Record<string, string> = { draft: '草稿', locked: '已定稿', archived: '已归档' };

type Candidate = Omit<SearchItemDto, 'type' | 'typeLabel'>;

export function normalizeKeyword(q: string): string {
  const k = q.replace(/[%_\\]/g, '').trim();
  if (!k) throw Errors.validation('关键词不能只包含通配符');
  return k;
}

/** 0 = 编码/标题完全相同,1 = 前缀,2 = 包含;不命中返回 null(列表 service 可能匹配了描述等其他字段)。 */
function rank(k: string, c: Candidate): number | null {
  const lower = k.toLowerCase();
  const fields = [c.code, c.title].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  if (fields.some((f) => f === lower)) return 0;
  if (fields.some((f) => f.startsWith(lower))) return 1;
  if (fields.some((f) => f.includes(lower)) || c.subtitle.toLowerCase().includes(lower)) return 2;
  return null;
}

function collect(db: DB, type: SearchType, k: string): Candidate[] {
  const enc = encodeURIComponent;
  switch (type) {
    case 'project':
      return listProjects(db, { keyword: k }).map((p) => ({
        id: p.id, code: p.code, title: p.name, subtitle: p.projectType, orgName: p.orgName, status: ACTIVE_LABEL[p.status] ?? p.status,
        path: `/projects/${p.id}`, updatedAt: p.updatedAt,
      }));
    case 'supplier':
      return listSuppliers(db, { keyword: k }).map((s) => ({
        id: s.id, code: s.code, title: s.name, subtitle: [s.supplierType, s.creditCode].filter(Boolean).join(' · '), orgName: null,
        status: ACTIVE_LABEL[s.status] ?? s.status, path: `/master-entities?tab=suppliers&keyword=${enc(s.name)}`, updatedAt: s.updatedAt,
      }));
    case 'contract':
      return listContracts(db, { keyword: k }).map((c) => ({
        id: c.id, code: c.contractNo, title: c.name, subtitle: [c.contractType, CONTRACT_STAGE_LABELS[c.stage]].filter(Boolean).join(' · '),
        orgName: c.orgName, status: CONTRACT_STATUS_LABELS[c.status] ?? c.status, path: `/contracts?id=${c.id}`, updatedAt: c.updatedAt,
      }));
    case 'expense_claim':
      return listClaims(db, { keyword: k }).map((c) => ({
        id: c.id, code: c.claimNo, title: `${c.applicant} · ${c.expenseType}`, subtitle: c.description, orgName: c.orgName,
        status: CLAIM_STATUS_LABELS[c.status] ?? c.status, path: `/expense?id=${c.id}`, updatedAt: c.updatedAt,
      }));
    case 'project_budget_batch': {
      const lower = k.toLowerCase();
      return listProjectBudgetBatches(db).filter((b) => b.name.toLowerCase().includes(lower) || b.period.includes(k)).map((b) => ({
        id: b.id, code: b.period, title: b.name, subtitle: b.fileName, orgName: null, status: b.status === 'voided' ? '已作废' : b.isCurrent ? '当前批次' : '已导入',
        path: `/project-budget?batchId=${b.id}`, updatedAt: b.createdAt,
      }));
    }
    case 'feasibility_project':
      return listFeasProjects(db, { keyword: k }).items.map((p) => ({
        id: p.id, code: p.code, title: p.name, subtitle: `建设 ${p.constructionStartYear} · 运营 ${p.operationStartYear} · ${p.scenarioCount} 个方案`,
        orgName: p.orgName, status: ACTIVE_LABEL[p.status] ?? p.status, path: `/feasibility?id=${p.id}`, updatedAt: p.updatedAt,
      }));
    case 'investment_project':
      return listIcProjects(db, { keyword: k }).items.map((p) => ({
        id: p.id, code: p.code, title: p.name, subtitle: p.approvalDocNo ? `批复 ${p.approvalDocNo}` : '', orgName: p.orgName,
        status: ACTIVE_LABEL[p.status] ?? p.status, path: `/investment-control?id=${p.id}`, updatedAt: p.updatedAt,
      }));
    case 'forecast_model':
      return listForecastModels(db, { keyword: k }).items.map((m) => ({
        id: m.id, code: null, title: m.name, subtitle: `基准年 ${m.baseYear} · ${m.horizonYears} 年`, orgName: m.orgName,
        status: ACTIVE_LABEL[m.status] ?? m.status, path: `/forecast?id=${m.id}`, updatedAt: m.updatedAt,
      }));
    case 'risk_event':
      return listRiskEvents(db, { keyword: k }).map((e) => ({
        id: e.id, code: e.projectCode, title: e.title, subtitle: `${e.ruleName}${e.projectName ? ` · ${e.projectName}` : ''}`, orgName: e.orgName,
        status: RISK_STATUS_LABELS[e.status] ?? e.status, path: `/risk?id=${e.id}`, updatedAt: e.updatedAt,
      }));
    case 'analysis_report': {
      // 与助手 report_list 同一可见规则:已发布(含被替代)或本人创建;页面同样可以打开这些报告
      const userId = currentAuth()?.userId ?? null;
      return listAnalysisReports(db, { keyword: k })
        .filter((r) => r.status === 'published' || r.status === 'superseded' || (userId !== null && r.createdByUserId === userId))
        .map((r) => ({
          id: r.id, code: r.seriesNo, title: r.title, subtitle: `${r.kindLabel} · 修订 ${r.revisionNo}`, orgName: r.orgName ?? '集团',
          status: RPT_STATUS_LABELS[r.status] ?? r.status, path: `/analysis-reports?id=${r.id}`, updatedAt: r.updatedAt,
        }));
    }
    case 'budget_version': {
      const lower = k.toLowerCase();
      return listVersions(db).filter((v) => v.name.toLowerCase().includes(lower) || String(v.year) === k).map((v) => ({
        id: v.id, code: String(v.year), title: v.name, subtitle: v.is_current ? '当前采用' : '', orgName: null,
        status: VERSION_STATUS_LABEL[v.status] ?? v.status, path: `/budget/${v.id}`, updatedAt: v.updated_at,
      }));
    }
  }
}

export function crossDomainSearch(db: DB, input: { q: string; types?: SearchType[]; limit?: number }): SearchResultDto {
  const k = normalizeKeyword(input.q);
  const auth = currentAuth();
  const can = (p: Permission) => !auth || auth.permissions.has(p);
  const perType = input.limit ?? PER_TYPE_DEFAULT;
  const wanted = input.types ?? [...SEARCH_TYPES];
  const items: SearchItemDto[] = [];
  const truncated: SearchResultDto['truncated'] = {};
  const skipped: SearchType[] = [];
  for (const type of wanted) {
    if (!can(PERMISSION[type])) { skipped.push(type); continue; }
    const ranked = collect(db, type, k)
      .map((c) => ({ c, r: rank(k, c) }))
      .filter((x): x is { c: Candidate; r: number } => x.r !== null)
      .sort((a, b) => a.r - b.r || (b.c.updatedAt ?? '').localeCompare(a.c.updatedAt ?? ''));
    if (ranked.length > perType) truncated[type] = true;
    for (const { c } of ranked.slice(0, perType)) items.push({ type, typeLabel: SEARCH_TYPE_LABELS[type], ...c });
  }
  return { query: k, items: items.slice(0, TOTAL_LIMIT), truncated, skipped };
}
