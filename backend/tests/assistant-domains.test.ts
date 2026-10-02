import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, post, json, upload } from './t3-helpers';
import { statementWorkbook } from './t3-statement-sample';
import { createScopedUser, sessionFor } from './http-helpers';
import { detectIntents } from '../src/assistant/intent';
import { resolveMessageContext } from '../src/assistant/resolve';
import { resolveDomainMessage } from '../src/assistant/domain-facts';
import * as budget from '../src/modules/budget/budget.service';
import { DOMAIN_READ_RULES } from '../src/assistant/domain-intents';
import { resolveBackendContext } from '../src/assistant/context-v2';
import { runWithContext } from '../src/core/request-context';
import { loadAuthContext } from '../src/modules/security/security.service';
import { executeTool, toolDefinitions } from '../src/assistant/tools';
import { DOMAIN_TOOLS } from '../src/assistant/domain-tools';

beforeEach(() => { vi.stubEnv('AI_BASE_URL', ''); vi.stubEnv('AI_API_KEY', ''); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const now = '2026-06-30T00:00:00.000Z';
function seedContract(db: any, no: string, orgId: number, amount = 9007199254740993n) {
  return Number(db.prepare("INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, paid_cents, stage, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 2500000, 'performance', 'active', ?, ?)")
    .run(no, no, no + '工程合同', orgId, amount, now, now).lastInsertRowid);
}
const pc = (pageKey: string, scope: Record<string, unknown> = {}, view: Record<string, unknown> = {}) => ({ schemaVersion: 2, snapshotId: 'domain-test', routeInstanceId: 'route-test', contextVersion: 1, pageKey, scope, view });

describe('助手跨域问答闭环 AC-F20/AC-X04/X06', () => {
  it('各业务路由识别正确，新财务测算/导出不会误生成经营预算操作', () => {
    for (const [question, intent] of [
      ['有哪些合同待付款', 'contracts'], ['哪些报销单待复核', 'expenses'], ['当前有哪些高风险项目', 'risks'], ['财务预测结果怎么样', 'forecast'],
      ['财务报表资产负债率是多少', 'statements'], ['项目预算执行情况', 'project_budget'], ['计划执行进度如何', 'plan_execution'],
      ['可研内部收益率是否达标', 'feasibility'], ['投资控制概算偏差', 'investment_control'], ['制度条款依据', 'policies'], ['数据治理问题', 'governance'],
    ]) { const d = detectIntents(question); expect(d.read).toContain(intent); expect(d.read).not.toContain('execution'); }
    expect(detectIntents('如果增长 5%，重新测算可研方案').write).toEqual([]);
    expect(detectIntents('导出当前合同台账').write).toEqual([]);
    expect(detectIntents('经营预算利润为什么低于预算').read).toContain('attribution');
    expect(DOMAIN_READ_RULES.length).toBeGreaterThan(15);
  });
  it('财报利润、预测版本和投资项目 ID 不落入经营预算/主数据项目命名空间', async () => {
    const { db } = await boot();
    const version = budget.createVersion(db, { year: 2026, name: '同编号经营预算' });
    expect(detectIntents('当前财务报表净利润是多少', 'statements').read).not.toContain('execution');
    expect(detectIntents('预测版本 #1 的运行结果', 'forecast').read).not.toContain('budget_versions');
    const parsed = resolveMessageContext(db, `财务预测版本 #${version.id}`, { page: 'forecast' });
    expect(parsed.context.budgetVersionId).toBeUndefined();
    const context: any = { page: 'feasibility' };
    expect(() => resolveDomainMessage(db, '可研项目 #987654 的指标', context, {}, ['feasibility'], false)).toThrow();
    expect(context.feasProjectId).toBe(987654); expect(context.projectId).toBeUndefined();
  });
  it('无模型时各业务页面返回同源事实、明确缺源，绝不回退预算版本', async () => {
    const { base, admin, fx } = await boot('newfc-assistant-domain-');
    for (const [page, message, tool, scope] of [
      ['contracts', '有哪些合同待付款', 'contract_summary', {}], ['expense', '哪些报销单待复核', 'expense_audit_queue', {}],
      ['risk', '当前有哪些高风险项目', 'risk_summary', {}], ['forecast', '当前财务预测结果是什么', 'forecast_runs', {}],
      ['statements', '当前财务报表来源是什么', 'statement_overview', { orgScopeId: fx.orgIds.shanghai }],
      ['mgmt', '管理会计指标快照', 'mgmt_metric_snapshots', {}], ['project_budget', '项目预算执行情况', 'project_budget_summary', {}],
      ['plan', '2026 年计划执行', 'plan_execution_overview', { year: 2026 }], ['governance', '数据治理问题', 'governance_issues', {}],
      ['expense_policies', '制度条款', 'policy_search', {}], ['standard_reports', '冻结标准报表', 'standard_report_read', {}],
      ['feasibility', '可研结果', 'feasibility_result', {}], ['investment_control', '投资控制偏差', 'investment_comparison', {}],
      ['analysis_reports', '已发布分析报告', 'report_list', {}], ['master_entities', '供应商目录', 'master_entities', {}],
      ['jobs', '后台任务状态', 'task_status', {}], ['business_settings', '当前业务设置', 'configuration_overview', {}],
    ] as [string, string, string, Record<string, unknown>][]) {
      const response = await post(base, admin, '/api/assistant/chat', { message, pageContext: pc(page, scope) });
      const r = await response.json() as any;
      expect(response.status, JSON.stringify(r)).toBe(200);
      expect(r.facts.some((f: any) => f.type === `tool:${tool}`), `${page}: ${r.text}`).toBe(true);
      expect(r.facts.some((f: any) => f.type === 'budget_versions')).toBe(false);
      expect(r.routing).toBe('rules'); expect(r.action).toBeNull();
    }
  });
  it('合同大额精确字符串、对象引用、上下文追问和指定期间', async () => {
    const { base, db, admin, fx } = await boot();
    const id = seedContract(db, 'HT-SH-001', fx.orgIds.shanghai);
    const first = await json(post(base, admin, '/api/assistant/chat', { message: '当前合同金额和付款情况', pageContext: pc('contracts', { contractId: id, orgScopeId: fx.orgIds.shanghai }) }));
    expect(first.text).toContain('90071992547409.93');
    expect(first.text).toContain('履约执行');
    expect(first.facts.some((f: any) => f.type === 'domain_write_guidance')).toBe(false);
    expect(first.citations.find((c: any) => c.source === 'tool:contract_detail').references).toContainEqual(expect.objectContaining({ kind: 'contract', id, path: `/contracts?id=${id}` }));
    const follow = await json(post(base, admin, '/api/assistant/chat', { conversationId: first.conversationId, message: '它的付款节点呢', context: { page: 'assistant' } }));
    expect(follow.resolvedContext.contractId).toBe(id);
    expect(follow.facts.find((f: any) => f.type === 'tool:contract_detail').data.id).toBe(id);
    const eas = await json(post(base, admin, '/api/assistant/chat', { message: '2026 年 5 月 EAS 对账状态', pageContext: pc('eas', { orgScopeId: fx.orgIds.shanghai }) }));
    expect(eas.resolvedContext.period).toBe('2026-05'); expect(eas.citations.some((c: any) => c.period === '2026-05')).toBe(true);
  });
  it('名称有歧义列出候选，名称找不到不返回其他合同金额，唯一编码能定位', async () => {
    const { base, db, admin, fx } = await boot();
    seedContract(db, 'HT-A', fx.orgIds.shanghai); seedContract(db, 'HT-B', fx.orgIds.shanghai);
    for (const token of ['工程合同', '不存在合同']) {
      const r = await json(post(base, admin, '/api/assistant/chat', { message: `查询合同“${token}”的付款情况`, pageContext: pc('assistant') }));
      expect(r.facts[0].type).toBe('domain_clarification'); expect(r.text).not.toContain('90071992547409.93');
    }
    const r = await json(post(base, admin, '/api/assistant/chat', { message: '查询合同“HT-A”的金额', pageContext: pc('assistant') }));
    expect(r.facts.some((f: any) => f.type === 'tool:contract_detail')).toBe(true);
  });
  it('范围外/缺权限对象拒绝，伪造浮层 ID 拒绝，组织与对象冲突拒绝', async () => {
    const { base, db, fx } = await boot();
    const id = seedContract(db, 'HT-NJ', fx.orgIds.nanjing);
    const user = createScopedUser(db, { username: 'assistant-domain-sh', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    const s = sessionFor(db, user.userId);
    const response = await post(base, s, '/api/assistant/chat', { message: '当前合同是什么', pageContext: pc('contracts', { contractId: id }) });
    expect(response.status).toBe(404);
    const all = createScopedUser(db, { username: 'assistant-domain-no-perm', roleCodes: [], allOrgs: true });
    const auth = loadAuthContext(db, all.userId)!;
    runWithContext({ requestId: 'test', source: 'http', auth }, () => {
      expect(() => executeTool(db, 'expense_detail', { claimId: 1 })).toThrow(/权限/);
      expect(() => resolveBackendContext(db, { ...pc('contracts'), surfaces: [{ id: 's', kind: 'drawer', key: 'contract', entity: { entityType: 'contract', id } }] })).toThrow(/权限/);
    });
  });
  it('费用详情只解释当前审核运行，制度检索无命中明确说明', async () => {
    const { base, db, admin, fx } = await boot();
    const id = Number(db.prepare("INSERT INTO ex_claim (claim_no, org_id, applicant, expense_type, amount_cents, occurred_date, status, created_at, updated_at) VALUES ('BX-1', ?, '张三', '差旅费', 123456, '2026-05-01', 'draft', ?, ?)").run(fx.orgIds.shanghai, now, now).lastInsertRowid);
    const r = await json(post(base, admin, '/api/assistant/chat', { message: '当前报销单审核结果', pageContext: pc('expense', { claimId: id }) }));
    expect(r.text).toContain('1234.56'); expect(r.text).toContain('没有有效审核结果'); expect(r.text).not.toContain('张三');
    const policy = await json(post(base, admin, '/api/assistant/chat', { message: '检索制度“从未存在”', pageContext: pc('expense_policies') }));
    expect(policy.text).toContain('无命中不代表合规');
  });
  it('写请求只能引导页面，聊天确认不支付或审批，导航覆盖全部新业务', async () => {
    const { base, db, admin, fx } = await boot();
    const id = seedContract(db, 'HT-W', fx.orgIds.shanghai);
    for (const message of ['请支付当前合同', '导出合同台账', '批准当前合同', '确认执行']) {
      const r = await json(post(base, admin, '/api/assistant/chat', { message, pageContext: pc('contracts', { contractId: id }) }));
      expect(r.action).toBeNull();
    }
    expect(db.prepare('SELECT paid_cents FROM ct_contract WHERE id=?').get(id)).toEqual({ paid_cents: 2500000 });
    const r = await json(post(base, admin, '/api/assistant/chat', { message: '打开财务预测页面', pageContext: pc('assistant') }));
    expect(r.navigation.path).toBe('/forecast');
    const names = toolDefinitions.map((d) => d.function.name);
    for (const name of Object.keys(DOMAIN_TOOLS)) expect(names).toContain(name);
    expect(names.some((n) => /^(create|approve|pay|publish|scan|import|delete)_/.test(n))).toBe(false);
  });
});

describe('跨域受控模型与降级', () => {
  it('模型必须保留页面指标、期间、分组和页签筛选', async () => {
    const { alignDomainToolArguments } = await import('../src/assistant/service');
    const view = { metricIds: [1, 2], periods: ['2025-05', '2025-06'], groupBy: 'dimension', dimensionId: 3 };
    expect(alignDomainToolArguments('mgmt_analysis', {}, { page: 'mgmt' }, view)).toEqual(view);
    expect(() => alignDomainToolArguments('mgmt_analysis', { metricIds: [99] }, { page: 'mgmt' }, view)).toThrow(/筛选/);
    expect(() => alignDomainToolArguments('mgmt_analysis', { periods: ['2026-01'] }, { page: 'mgmt' }, view)).toThrow(/筛选/);
    expect(alignDomainToolArguments('domain_workspace', {}, { page: 'eas' }, { tab: 'corrections', pendingOnly: true })).toEqual({ kind: 'eas_corrections', pendingOnly: true });
    expect(() => alignDomainToolArguments('domain_workspace', { kind: 'eas_locks' }, { page: 'eas' }, { tab: 'corrections' })).toThrow(/筛选/);
    expect(alignDomainToolArguments('master_entities', {}, { page: 'master_entities' }, { tab: 'suppliers', keyword: '水利' })).toEqual({ kind: 'supplier', keyword: '水利' });
  });
  it('历史批次采用实际来源期间，显式年度或月份冲突拒绝', async () => {
    const { base, admin, fx } = await boot();
    const batch = await json(upload(base, admin, '/api/statements/import', await statementWorkbook(), '2025-05.xlsx', { orgId: String(fx.orgIds.shanghai), period: '2025-05', scope: 'consolidated' }));
    const r = await json(post(base, admin, '/api/assistant/chat', { message: '当前财报批次的金额', pageContext: pc('statements', { statementBatchId: batch.id }) }));
    expect(r.resolvedContext).toMatchObject({ year: 2025, period: '2025-05', statementScope: 'consolidated' });
    expect(r.facts.find((f: any) => f.type === 'tool:domain_batch_read').data.batch.id).toBe(batch.id);
    expect(r.citations.some((c: any) => c.period === '2025-05')).toBe(true);
    expect((await post(base, admin, '/api/assistant/chat', { message: '当前金额', pageContext: pc('statements', { statementBatchId: batch.id, year: 2026 }) })).status).toBe(409);
    expect((await post(base, admin, '/api/assistant/chat', { message: '2026 年 5 月的财务报表', pageContext: pc('statements', { statementBatchId: batch.id }) })).status).toBe(409);
    const named = await json(post(base, admin, '/api/assistant/chat', { message: `财报批次 #${batch.id} 的金额`, pageContext: pc('statements') }));
    expect(named.resolvedContext).toMatchObject({ year: 2025, period: '2025-05' });
  });
  it('当前台账筛选只返回命中合同，供应商页签不误读项目', async () => {
    const { base, db, admin, fx } = await boot();
    seedContract(db, 'HT-MATCH', fx.orgIds.shanghai); seedContract(db, 'HT-EXCLUDE', fx.orgIds.shanghai);
    const r = await json(post(base, admin, '/api/assistant/chat', { message: '当前有哪些合同', pageContext: pc('contracts', {}, { status: 'active', keyword: 'HT-MATCH' }) }));
    const f = r.facts.find((f: any) => f.type === 'tool:domain_ledger');
    expect(f.data.total).toBe(1); expect(f.data.items.map((i: any) => i.contractNo)).toEqual(['HT-MATCH']);
    const suppliers = await json(post(base, admin, '/api/assistant/chat', { message: '当前有哪些记录', pageContext: pc('master_entities', {}, { tab: 'suppliers' }) }));
    expect(suppliers.facts.find((f: any) => f.type === 'tool:master_entities').data.kind).toBe('supplier');
  });
  it('模型漏传对象由后端补齐；大额原文、来源和只读结果完整保留', async () => {
    const { db, fx } = await boot();
    const id = seedContract(db, 'HT-MODEL', fx.orgIds.shanghai);
    const { chat } = await import('../src/assistant/service');
    vi.stubEnv('AI_BASE_URL', 'http://model.test/v1'); vi.stubEnv('AI_API_KEY', 'test');
    let round = 0; const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options: any) => {
      bodies.push(JSON.parse(options.body));
      const message = round++ === 0 ? { content: '', tool_calls: [{ id: 'contract', function: { name: 'contract_detail', arguments: '{}' } }] } : { content: '当前合同金额 90071992547409.93 元，已付 25000.00 元。' };
      return { ok: true, json: async () => ({ choices: [{ message }] }) };
    }));
    const r = await chat(db, { message: '当前合同金额', pageContext: pc('contracts', { contractId: id }) });
    expect(r.routing).toBe('model');
    expect(r.facts.find((f) => f.type === 'tool:contract_detail')?.data).toMatchObject({ id, currentAmount: '90071992547409.93' });
    expect(r.citations.flatMap((c) => c.references ?? [])).toContainEqual(expect.objectContaining({ kind: 'contract', id }));
    const call = bodies[1].messages.find((m: any) => m.tool_calls)?.tool_calls[0];
    expect(JSON.parse(call.function.arguments).contractId).toBe(id);
  });
  it('模型与页面对象冲突、非法参数不能取另一个合同；全部工具失败走真实规则结果', async () => {
    const { db, fx } = await boot();
    const id = seedContract(db, 'HT-EXPECTED', fx.orgIds.shanghai), other = seedContract(db, 'HT-OTHER', fx.orgIds.shanghai, 9900000n);
    const { chat } = await import('../src/assistant/service');
    vi.stubEnv('AI_BASE_URL', 'http://model.test/v1'); vi.stubEnv('AI_API_KEY', 'test');
    let round = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: round++ === 0 ? { content: '', tool_calls: [{ id: 'bad', function: { name: 'contract_detail', arguments: JSON.stringify({ contractId: other }) } }] } : { content: '没有数据' } }] }) })));
    const r = await chat(db, { message: '当前合同金额', pageContext: pc('contracts', { contractId: id }) });
    expect(r.routing).toBe('rules'); expect(r.modelError).toContain('校验'); expect(r.text).toContain('90071992547409.93');
    expect(r.facts.find((f) => f.type === 'tool:contract_detail')?.data).toMatchObject({ id });
    expect(() => executeTool(db, 'expense_detail', { claimId: 1, unrestricted: true })).toThrow();
  });
  it('供应商故障仍以指定期间输出 EAS 状态并保留流式正文', async () => {
    const { db, fx } = await boot(); const { chat } = await import('../src/assistant/service');
    vi.stubEnv('AI_BASE_URL', 'http://model.test/v1'); vi.stubEnv('AI_API_KEY', 'test');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('测试供应商超时'); }));
    const chunks: string[] = [];
    const r = await chat(db, { message: '当前 EAS 对账状态', pageContext: pc('eas', { orgScopeId: fx.orgIds.shanghai, period: '2026-05' }) }, '', { onToken: (chunk) => chunks.push(chunk) });
    expect(r.routing).toBe('rules'); expect(r.modelError).toContain('测试供应商超时'); expect(chunks.join('')).toBe(r.text);
    expect(r.text).toContain('2026-05'); expect(r.citations.some((c) => c.period === '2026-05')).toBe(true);
  });
  it('页签对应查询真实记录，历史 ID 严格校验且不混用经营预算版本', async () => {
    const { base, db, admin } = await boot();
    for (const [page, tab, tool] of [['eas','locks','domain_workspace'], ['risk','rules','domain_workspace'], ['forecast','publications','domain_workspace'], ['mgmt','metrics','mgmt_workspace'], ['feasibility','reports','feasibility_report_read'], ['statements','trends','statement_trends']]) {
      const pageContext = { ...pc(page), view: { tab } };
      const r = await json(post(base, admin, '/api/assistant/chat', { message: '当前有哪些记录', pageContext }));
      expect(r.facts.some((f: any) => f.type === `tool:${tool}`), JSON.stringify(r)).toBe(true);
      expect(r.facts.some((f: any) => f.type === 'budget_versions')).toBe(false);
    }
    expect(() => resolveBackendContext(db, pc('statements', { statementBatchId: 987654 }))).toThrow(/不存在|无权/);
    const { alignDomainToolArguments } = await import('../src/assistant/service');
    expect(() => alignDomainToolArguments('statement_overview', {}, { statementBatchId: 1 })).toThrow(/历史批次/);
    expect(alignDomainToolArguments('domain_batch_read', {}, { planBatchId: 7 })).toEqual({ kind: 'plan', batchId: 7 });
  });
});
