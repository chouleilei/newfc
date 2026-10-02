import { toolPolicy } from '../src/assistant/tools';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { runWithContext } from '../src/core/request-context';
import { loadAuthContext } from '../src/modules/security/security.service';
import { executeTool, toolDefinitions } from '../src/assistant/tools';
import { toolAllowed } from '../src/assistant/tool-policy';
import { pageDefinition } from '../src/contracts/page-catalog';
import { allowedToolsForCapabilities } from '../src/assistant/page-capabilities';
import { boot, get, json, post, type Session } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { createProject } from './t4-helpers';

/**
 * T-5 联动(AC-F11/F12/F13/F17/F18/AC-X04):管理会计新计算器(未关闭风险金额、投资静态偏差率)、
 * 工作台风险/报告待办、助手只读工具(可研/投资控制/预测/风险/报告)按身份与组织范围裁剪,范围外 404、无权限拒绝。
 */

const now = '2026-06-30T00:00:00.000Z';
const NEW_TOOLS = ['feasibility_result', 'investment_comparison', 'forecast_runs', 'risk_summary', 'report_list'];

function as<T>(db: DB, userId: number, fn: () => T): T {
  const auth = loadAuthContext(db, userId);
  if (!auth) throw new Error('user disabled');
  return runWithContext({ requestId: 'test', source: 'http', auth }, fn);
}
function codeOf(fn: () => unknown): string | undefined {
  try { fn(); return undefined; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; }
}

function seedContract(db: DB, no: string, orgId: number, original: number, paid: number): void {
  db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, paid_cents, payment_cap_ratio_scaled, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 800000, 'performance', 'active', ?, ?)`).run(no, no, `${no} 施工合同`, orgId, original, paid, now, now);
}

async function seedComparison(base: string, admin: Session, db: DB, orgId: number): Promise<{ projectId: number; comparisonId: number }> {
  const md = await createProject(base, admin, 'P-IC-NJ', '水库扩容', orgId);
  const projectId = Number(db.prepare('INSERT INTO ic_project (md_project_id, org_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(md, orgId, now, now).lastInsertRowid);
  const ver = (type: string, cents: number) => Number(db.prepare(`INSERT INTO ic_version (project_id, version_type, version_no, name, status, is_current, static_cents, created_at, updated_at)
    VALUES (?, ?, 1, ?, 'confirmed', 1, ?, ?, ?)`).run(projectId, type, type, cents, now, now).lastInsertRowid);
  const design = ver('design_estimate', 10_000_000);
  const budget = ver('construction_budget', 10_500_000);
  const summary = { baseTotalStatic: '100000.00', targetTotalStatic: '105000.00', totalDeviation: '5000.00', totalDeviationRate: '0.050000', totalLevel: 'warning', controlChain: [], exceedCount: 0 };
  const comparisonId = Number(db.prepare(`INSERT INTO ic_comparison (project_id, base_version_id, target_version_id, base_content_hash, target_content_hash, redline_version_id,
    thresholds_json, rows_json, summary_json, content_sha256, created_at) VALUES (?, ?, ?, 'a', 'b', ?, '{}', '[]', ?, 'sha', ?)`)
    .run(projectId, design, budget, design, JSON.stringify(summary), now).lastInsertRowid);
  return { projectId, comparisonId };
}

function seedFeasibility(db: DB, orgId: number): number {
  const p = Number(db.prepare(`INSERT INTO if_project (code, name, org_id, construction_start_year, operation_start_year, horizon_years, created_at, updated_at)
    VALUES ('FS-HZ', '杭州供水测算', ?, 2026, 2028, 20, ?, ?)`).run(orgId, now, now).lastInsertRowid);
  const s = Number(db.prepare(`INSERT INTO if_scenario (project_id, code, name, assumptions_json, assumptions_hash, created_at, updated_at)
    VALUES (?, 'base', '基准方案', '{}', 'h', ?, ?)`).run(p, now, now).lastInsertRowid);
  const result = {
    modelVersion: 'standard-1.0', roundingRule: '', parameterHash: 'ph1', discountBaseYear: 2026, allChecksPassed: false, cashflows: [],
    checks: [{ code: 'balance', severity: 'error', passed: false, message: '资金来源与运用不平衡', evidence: {} }],
    indicators: [{ code: 'project_npv', name: '项目净现值', value: '120.500000', unit: '万元', status: 'ok', evidence: null }],
  };
  db.prepare(`INSERT INTO if_run (scenario_id, kind, scenario_version, project_years_json, assumptions_json, parameter_hash, model_version, status, all_checks_passed, result_json, created_at)
    VALUES (?, 'base', 1, '[]', '{}', 'ph1', 'standard-1.0', 'succeeded', 0, ?, ?)`).run(s, JSON.stringify(result), now);
  return s;
}

function seedModel(db: DB, name: string, orgId: number): number {
  return Number(db.prepare('INSERT INTO ff_model (name, org_id, base_year, horizon_years, created_at, updated_at) VALUES (?, ?, 2026, 5, ?, ?)').run(name, orgId, now, now).lastInsertRowid);
}

function seedReport(db: DB, seriesNo: string, orgId: number | null, status: string): number {
  return Number(db.prepare(`INSERT INTO rpt_report (series_no, title, kind, org_id, year, status, created_at, updated_at)
    VALUES (?, ?, 'risk_investment', ?, 2026, ?, ?, ?)`).run(seriesNo, `${seriesNo} 风险与投资专题`, orgId, status, now, now).lastInsertRowid);
}

async function metric(base: string, s: Session, code: string, calculator: string) {
  const res = await post(base, s, '/api/mgmt/metrics', { code, name: code, params: { calculator }, thresholds: {} });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json() as Promise<any>;
}

describe('T-5 联动', () => {
  it('助手工具登记为只读 org_scope 工具并挂到工作台/助手页能力', () => {
    for (const name of NEW_TOOLS) {
      expect(toolPolicy(name)?.scope).toBe('org_scope');
      expect(toolDefinitions.some((d) => d.function.name === name)).toBe(true);
      expect(allowedToolsForCapabilities(['risk_investment'])).toContain(name);
    }
    expect(pageDefinition('assistant')!.capabilities).toContain('risk_investment');
    expect(pageDefinition('dashboard')!.capabilities).toContain('risk_investment');
    // 扫描、状态流转、审批、发布等写操作没有对应工具
    expect(toolDefinitions.map((d) => d.function.name).filter((n) => /risk|report_|feasib|investment|forecast/.test(n)).sort()).toEqual([...NEW_TOOLS, 'feasibility_report_read', 'analysis_report_read', 'forecast_result', 'risk_detail', 'standard_report_read'].sort());
  });

  it('计算器、待办与助手工具按范围取数;扫描前风险金额不可用而不是 0', async () => {
    const { base, db, admin, fx } = await boot('newfc-t5-link-');
    seedContract(db, 'HT-SH', fx.orgIds.shanghai, 10_000_000, 9_000_000);
    seedContract(db, 'HT-NJ', fx.orgIds.nanjing, 5_000_000, 5_000_000);
    const ic = await seedComparison(base, admin, db, fx.orgIds.nanjing);
    const scenarioHz = seedFeasibility(db, fx.orgIds.hangzhou);
    seedModel(db, '上海水务预测', fx.orgIds.shanghai);
    const modelNj = seedModel(db, '南京水务预测', fx.orgIds.nanjing);
    seedReport(db, 'RPT-202606-00001', fx.orgIds.shanghai, 'published');
    seedReport(db, 'RPT-202606-00002', fx.orgIds.nanjing, 'published');
    seedReport(db, 'RPT-202606-00003', fx.orgIds.shanghai, 'pending_approval');

    // 管理会计计算器
    const riskAmt = await metric(base, admin, 'RISK_OPEN', 'risk_open_amount');
    const devRate = await metric(base, admin, 'IC_DEV', 'investment_deviation_rate');
    expect([riskAmt.unit, devRate.unit]).toEqual(['money', 'ratio']);
    const calc = async () => {
      const res = await post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [riskAmt.id, devRate.id], orgIds: [fx.orgIds.shanghai, fx.orgIds.nanjing] });
      expect(res.status, await res.clone().text()).toBe(201);
      const r = await res.json() as any;
      return (m: any, orgId: number) => r.snapshots.find((s: any) => s.metricId === m.id && s.orgId === orgId);
    };
    const before = await calc();
    expect(before(riskAmt, fx.orgIds.shanghai)).toMatchObject({ status: 'unavailable', value: null });
    expect(before(riskAmt, fx.orgIds.shanghai).reasons[0].code).toBe('RISK_SCAN_MISSING');
    expect(before(devRate, fx.orgIds.nanjing)).toMatchObject({ status: 'valid', value: '0.050000' });
    expect(before(devRate, fx.orgIds.nanjing).evidence).toMatchObject({ source: 'ic_comparison', comparisonIds: [ic.comparisonId], deviation: '5000.00', base: '100000.00' });
    expect(before(devRate, fx.orgIds.shanghai).reasons[0].code).toBe('IC_COMPARISON_MISSING');

    const scan = await post(base, admin, '/api/risk/scans', {});
    expect(scan.status, await scan.clone().text()).toBe(201);
    const after = await calc();
    expect(after(riskAmt, fx.orgIds.shanghai)).toMatchObject({ status: 'valid', value: '10000.00' });
    expect(after(riskAmt, fx.orgIds.nanjing)).toMatchObject({ status: 'valid', value: '10000.00' });

    // 工作台待办:按权限出现,按范围计数
    const openAll = (db.prepare("SELECT COUNT(*) AS n FROM risk_event WHERE status = 'open'").get() as { n: number }).n;
    const todos = async (s: Session) => Object.fromEntries(((await json(get(base, s, '/api/dashboard/todos'))).items as any[]).map((i) => [i.key, i.count]));
    expect(await todos(admin)).toMatchObject({ risk_confirm: openAll, risk_review: 0, report_approve: 1, report_publish: 0 });
    const analyst = createScopedUser(db, { username: 't5-analyst-sh', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });
    const analystTodos = await todos(analyst.session);
    expect(analystTodos.risk_confirm).toBe(1);
    expect(analystTodos).not.toHaveProperty('risk_review');
    expect(analystTodos).not.toHaveProperty('report_approve');
    const reviewer = createScopedUser(db, { username: 't5-reviewer-nj', roleCodes: ['business_reviewer'], orgIds: [fx.orgIds.nanjing] });
    const reviewerTodos = await todos(reviewer.session);
    expect(reviewerTodos).toMatchObject({ risk_review: 0, report_approve: 0, report_publish: 0 });
    expect(reviewerTodos).not.toHaveProperty('risk_confirm');

    // 助手只读工具:受限用户缺省落在唯一授权根,范围外组织与对象 404
    const sh = createScopedUser(db, { username: 't5-viewer-sh', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    as(db, sh.userId, () => {
      for (const name of NEW_TOOLS) expect(toolAllowed(name)).toBe(true);
      const risk = executeTool(db, 'risk_summary', {}) as any;
      expect(risk.summary).toMatchObject({ openCount: 1, openAmount: '10000.00' });
      expect(risk.openRisks.items.map((r: any) => r.orgName)).toEqual(['上海公司']);
      expect(risk.openRisks.items[0]).not.toHaveProperty('evidence');
      expect((executeTool(db, 'investment_comparison', {}) as any).projects.total).toBe(0);
      expect((executeTool(db, 'feasibility_result', {}) as any).scenarios.total).toBe(0);
      expect((executeTool(db, 'forecast_runs', {}) as any).models.items.map((m: any) => m.name)).toEqual(['上海水务预测']);
      const reports = executeTool(db, 'report_list', {}) as any;
      expect(reports.reports.items.map((r: any) => r.seriesNo)).toEqual(['RPT-202606-00001']);
      expect(JSON.stringify([risk, reports])).not.toContain('南京');

      for (const name of NEW_TOOLS) expect(codeOf(() => executeTool(db, name, { orgScopeId: fx.orgIds.nanjing }))).toBe('NOT_FOUND');
      expect(codeOf(() => executeTool(db, 'investment_comparison', { comparisonId: ic.comparisonId }))).toBe('NOT_FOUND');
      expect(codeOf(() => executeTool(db, 'feasibility_result', { scenarioId: scenarioHz }))).toBe('NOT_FOUND');
      expect(codeOf(() => executeTool(db, 'forecast_runs', { modelId: modelNj }))).toBe('NOT_FOUND');
      expect(codeOf(() => executeTool(db, 'risk_summary', { level: 'urgent' }))).toBe('TOOL_ARGUMENTS_INVALID');
      expect(codeOf(() => executeTool(db, 'report_list', { kind: 'weekly' }))).toBe('TOOL_ARGUMENTS_INVALID');
    });

    const all = createScopedUser(db, { username: 't5-viewer-all', roleCodes: ['viewer'], allOrgs: true });
    as(db, all.userId, () => {
      const projects = (executeTool(db, 'investment_comparison', {}) as any).projects;
      expect(projects.items).toEqual([expect.objectContaining({ projectId: ic.projectId, comparisonId: ic.comparisonId, totalDeviation: '5000.00', totalDeviationRate: '0.050000' })]);
      expect((executeTool(db, 'investment_comparison', { comparisonId: ic.comparisonId }) as any).comparison.summary.baseTotalStatic).toBe('100000.00');
      const feas = executeTool(db, 'feasibility_result', { scenarioId: scenarioHz }) as any;
      expect(feas.latestRun).toMatchObject({ status: 'succeeded', allChecksPassed: false });
      expect(feas.latestRun.indicators[0]).toMatchObject({ code: 'project_npv', value: '120.500000', unit: '万元' });
      expect(feas.latestRun.failedChecks).toEqual([{ code: 'balance', severity: 'error', message: '资金来源与运用不平衡' }]);
      expect((executeTool(db, 'forecast_runs', { modelId: modelNj }) as any).model.name).toBe('南京水务预测');
      expect((executeTool(db, 'report_list', {}) as any).reports.total).toBe(2);
      expect((executeTool(db, 'report_list', { orgScopeId: fx.orgIds.nanjing }) as any).reports.items.map((r: any) => r.seriesNo)).toEqual(['RPT-202606-00002']);
      expect((executeTool(db, 'risk_summary', { orgScopeId: fx.orgIds.nanjing }) as any).summary.openAmount).toBe('10000.00');
    });

    const noPerm = createScopedUser(db, { username: 't5-none', roleCodes: [], allOrgs: true });
    as(db, noPerm.userId, () => {
      for (const name of NEW_TOOLS) {
        expect(toolAllowed(name)).toBe(false);
        expect(codeOf(() => executeTool(db, name, {}))).toBe('FORBIDDEN');
      }
    });
  });
});
