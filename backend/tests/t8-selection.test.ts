import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDb, buildFixture, standardBudgetVersion, saveActualSnapshot, account, budget, metric } from './helpers';
import { pageSnapshot } from './assistant-context';
import { prepareChat, chat } from '../src/assistant/service';
import { executeTool } from '../src/assistant/tools';
import * as aliases from '../src/modules/io/cleaning/alias.service';
import { runWithContext } from '../src/core/request-context';
import type { AssistantPageContext } from '../src/contracts/assistant';

describe('T-8.5 选择范围实际取数', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('受控模型工具与流式回答使用同一选区事实，原始备注不进上游', async () => {
    const db = testDb(); const fx = buildFixture(db); const version = standardBudgetVersion(fx); const current = budget.getVersion(db, version.id);
    vi.stubEnv('AI_BASE_URL', 'http://model.test/v1'); vi.stubEnv('AI_API_KEY', 'synthetic'); vi.stubEnv('AI_STREAM', 'false');
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => bodies.length === 1 ? { choices: [{ message: { content: '', tool_calls: [{ id: 'selected', function: { name: 'get_budget_selection', arguments: '{}' } }] } }] } : { choices: [{ message: { content: '当前选区金额为 123.45 元。' } }] } };
    }));
    const page = { ...pageSnapshot({ pageKey: 'budget_edit', year: 2026, budgetVersionId: version.id }), view: { sheetKey: 'all' }, selection: { mode: 'bounds' as const, bounds: { sheetKey: 'all', orgIds: [fx.orgIds.shanghai], accountIds: [fx.accIds.incomeMain] } }, draft: { kind: 'budget_grid' as const, base: { versionId: version.id, revision: current.revision }, changes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '123.45', note: 'SECRET_RAW_NOTE' }] } };
    const chunks: string[] = [];
    const result = await chat(db, { message: '分析当前选择', pageContext: page }, 'synthetic-test', { onToken: (text) => chunks.push(text) });
    expect(result.routing).toBe('model'); expect(result.text).toContain('123.45'); expect(chunks.join('')).toContain('当前选择');
    expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual(['get_budget_selection']);
    expect(JSON.stringify(bodies)).not.toContain('SECRET_RAW_NOTE');
    expect(result.facts.find((f) => f.type === 'tool:get_budget_selection')?.data).toMatchObject({ count: 1, amount: '123.45' });
    db.close();
  });
  it('预算只读选择与父子去重限定实际金额；清空恢复页面范围', async () => {
    const db = testDb(); const fx = buildFixture(db); const version = standardBudgetVersion(fx);
    const page = { ...pageSnapshot({ pageKey: 'budget_edit', year: 2026, budgetVersionId: version.id }), view: { sheetKey: 'all' }, selection: { mode: 'bounds' as const, bounds: { sheetKey: 'all', orgIds: [fx.orgIds.east, fx.orgIds.shanghai], accountIds: [fx.accIds.incomeRoot, fx.accIds.incomeMain] } } };
    const before = db.prepare('SELECT total_changes() count').get();
    const prepared = prepareChat(db, { message: '分析当前选择', pageContext: page });
    expect(prepared.selectionData).toMatchObject({ count: 2, amount: '150.00', orgIds: [fx.orgIds.shanghai, fx.orgIds.hangzhou], accountIds: [fx.accIds.incomeMain] });
    expect(db.prepare('SELECT total_changes() count').get()).toEqual(before);
    const reply = await chat(db, { message: '分析当前选择', pageContext: page });
    expect(reply.text).toContain('150.00'); expect(reply.facts.every((f) => f.type === 'selection_analysis')).toBe(true);
    expect(prepareChat(db, { message: '预算金额', pageContext: { ...page, selection: null } }).selection).toBeUndefined(); db.close();
  });
  it('组织×科目只包含声明的格，不扩大到未选中同级科目', () => {
    const db = testDb(); const fx = buildFixture(db); const v = standardBudgetVersion(fx);
    const p = prepareChat(db, { message: '分析当前选择', pageContext: { ...pageSnapshot({ pageKey: 'budget_edit', budgetVersionId: v.id }), view: { sheetKey: 'all' }, selection: { mode: 'bounds', bounds: { sheetKey: 'all', orgIds: [fx.orgIds.shanghai], accountIds: [fx.accIds.costSub, fx.accIds.expenseAdmin] } } } });
    expect(p.selectionData).toMatchObject({ count: 2, amount: '-80.00', accountIds: [fx.accIds.costSub, fx.accIds.expenseAdmin] });
    expect(() => prepareChat(db, { message: '分析当前选择', pageContext: { ...pageSnapshot({ pageKey: 'budget_edit', budgetVersionId: v.id, accountScopeId: fx.accIds.incomeRoot }), view: { sheetKey: 'all' }, selection: { mode: 'bounds', bounds: { sheetKey: 'all', orgIds: [fx.orgIds.shanghai], accountIds: [fx.accIds.costSub] } } } })).toThrow(/科目超出/);
    db.close();
  });
  it('网格草稿仅叠加选择内变更，金额与数量独立精确', () => {
    const db = testDb(); const fx = buildFixture(db);
    const q = account.createAccount(db, { parentId: null, code: 'SELQ', name: '数量', type: 'quantity', unit: '万度' });
    const v = standardBudgetVersion(fx); const current = budget.getVersion(db, v.id);
    const p = prepareChat(db, { message: '检查当前选择', pageContext: { ...pageSnapshot({ pageKey: 'budget_edit', budgetVersionId: v.id }), view: { sheetKey: 'all' }, selection: { mode: 'bounds', bounds: { sheetKey: 'all', orgIds: [fx.orgIds.shanghai], accountIds: [fx.accIds.incomeMain, q.id] } }, draft: { kind: 'budget_grid', base: { versionId: v.id, revision: current.revision }, changes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '123.45' }, { orgId: fx.orgIds.shanghai, accountId: q.id, quantity: '1.2345' }, { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '999.00' }] } } });
    expect(p.selectionData.amount).toBe('123.45'); expect(p.selectionData.quantities).toEqual([{ accountId: q.id, unit: '万度', quantity: '1.2345' }]); db.close();
  });
  it('实际选择从当前累计取数，历史视图明确拒绝', () => {
    const db = testDb(); const fx = buildFixture(db);
    saveActualSnapshot(fx, 2026, '2026-06-30', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '90.01' }, { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '900.00' }]);
    const page = { ...pageSnapshot({ pageKey: 'actual', year: 2026 }), view: { sheetKey: 'all', viewMode: 'orgs' }, selection: { mode: 'bounds' as const, bounds: { sheetKey: 'all', orgIds: [fx.orgIds.shanghai], accountIds: [fx.accIds.incomeMain] } } };
    expect(prepareChat(db, { message: '分析选择', pageContext: page }).selectionData.amount).toBe('90.01');
    expect(() => prepareChat(db, { message: '分析选择', pageContext: { ...page, view: { ...page.view, historyMode: true } } })).toThrow(/不支持/); db.close();
  });
  it('refs 只分析选中指标，失效 ID 拒绝；工具不能忽略或覆盖选择', () => {
    const db = testDb(); const fx = buildFixture(db);
    const page: AssistantPageContext = { ...pageSnapshot({ pageKey: 'metric' }), selection: { mode: 'refs', refs: [{ entityType: 'metric', id: fx.metricIds.gross }] } };
    const p = prepareChat(db, { message: '检查选择', pageContext: page });
    expect(p.selectionData.ids).toEqual([fx.metricIds.gross]);
    expect(() => executeTool(db, 'get_org_tree', {}, p.selection)).toThrow(/不支持/);
    expect(() => executeTool(db, 'list_metrics', { versionId: 1 }, p.selection)).toThrow(/覆盖/);
    expect(() => prepareChat(db, { message: '检查选择', pageContext: { ...page, selection: { mode: 'refs', refs: [{ entityType: 'metric', id: fx.metricIds.gross }, { entityType: 'metric', id: 999999 }] } } })).toThrow(/不存在/); db.close();
  });
  it('query 复用真实筛选且覆盖分页外，详情截断如实显示', () => {
    const db = testDb(); const fx = buildFixture(db);
    for (let i = 0; i < 35; i++) metric.createMetric(db, { code: 'SEL' + i, name: '选择样本' + i, terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1 }] });
    const filter = { search: '选择样本', kind: 'linear' as const, status: 'active' as const };
    const p = prepareChat(db, { message: '检查筛选结果', pageContext: { ...pageSnapshot({ pageKey: 'metric' }), view: filter, selection: { mode: 'query', query: filter } } });
    expect(p.selectionData.ids).toEqual(metric.listMetrics(db, filter).map((m) => m.id));
    expect(p.selectionData).toMatchObject({ count: 35, truncated: true, omitted: 5 }); expect(p.selectionData.items).toHaveLength(30); db.close();
  });
  it('query 先核对全部总量，超限和客户端伪造总数/筛选都拒绝', () => {
    const db = testDb(); const fx = buildFixture(db);
    const row = metric.getMetric(db, fx.metricIds.gross);
    const insert = db.prepare("INSERT INTO report_metric(code,name,created_at,updated_at) VALUES(?,?,'now','now')");
    for (let i = 0; i < 501; i++) insert.run('LIMIT' + i, '超限样本');
    const filter = { search: '超限样本' };
    const page = { ...pageSnapshot({ pageKey: 'metric' }), view: filter, selection: { mode: 'query' as const, query: filter } };
    expect(() => prepareChat(db, { message: '分析筛选', pageContext: page })).toThrow(/500/);
    for (const query of [{ search: '别的筛选' }, { ...filter, count: 1 }, { ...filter, sql: 'SELECT 1' }]) expect(() => prepareChat(db, { message: '分析筛选', pageContext: { ...page, selection: { mode: 'query', query } } })).toThrow(/不一致/);
    expect(metric.getMetric(db, row.id)).toEqual(row); db.close();
  });
  it('别名 query 与目标数据集一致，同源核对目标与规范化重名', () => {
    const db = testDb(); buildFixture(db);
    const a = aliases.createAlias(db, { targetKind: 'budget', mappingKind: 'org', sourceText: '上海一', targetCode: 'SH' });
    aliases.createAlias(db, { targetKind: 'budget', mappingKind: 'account', sourceText: '收入一', targetCode: 'I01' });
    const filter = { targetKind: 'budget' as const, mappingKind: 'org' as const };
    const page = { ...pageSnapshot({ pageKey: 'cleaning_config' }), view: { tab: 'aliases', ...filter }, selection: { mode: 'query' as const, query: filter } };
    expect(prepareChat(db, { message: '核对筛选', pageContext: page }).selectionData.ids).toEqual([a.id]);
    expect(() => prepareChat(db, { message: '核对选择', pageContext: { ...page, view: { tab: 'aliases', targetKind: 'actual-current' }, selection: { mode: 'refs', refs: [{ entityType: 'alias_rule', id: a.id }] } } })).toThrow(/不一致/);
    expect(JSON.stringify(prepareChat(db, { message: '核对筛选', pageContext: page }).selectionData)).not.toContain('上海一'); db.close();
  });
  it('范围消息、工作表与草稿冲突拒绝，受限授权先于取数', () => {
    const db = testDb(); const fx = buildFixture(db); const v = standardBudgetVersion(fx);
    const page = { ...pageSnapshot({ pageKey: 'budget_edit', year: 2026, budgetVersionId: v.id }), view: { sheetKey: 'all' }, selection: { mode: 'bounds' as const, bounds: { sheetKey: 'all', orgIds: [fx.orgIds.shanghai], accountIds: [fx.accIds.incomeMain] } } };
    expect(() => prepareChat(db, { message: '2025 年收入是多少', pageContext: page })).toThrow(/范围/);
    expect(() => prepareChat(db, { message: '分析选择', pageContext: { ...page, view: { sheetKey: 'profit' } } })).toThrow(/工作表/);
    const auth = { userId: 99, username: 'restricted', displayName: '受限测试', permissions: new Set(['assistant:use', 'budget:read'] as const), allOrgs: false, orgRootIds: [fx.orgIds.hangzhou] };
    expect(() => runWithContext({ auth, source: 'assistant', requestId: 'selection-test' }, () => prepareChat(db, { message: '分析选择', pageContext: page }))).toThrow(/范围|权限|全组织/);
    const m = metric.getMetric(db, fx.metricIds.gross);
    expect(() => prepareChat(db, { message: '检查选择', pageContext: { ...pageSnapshot({ pageKey: 'metric' }), selection: { mode: 'refs', refs: [{ entityType: 'metric', id: fx.metricIds.operating }] }, draft: { kind: 'metric_formula', base: { id: m.id, updatedAt: m.updated_at, operation: 'update' }, changes: { name: '新名' } } } })).toThrow(/草稿|表单/); db.close();
  });
});
