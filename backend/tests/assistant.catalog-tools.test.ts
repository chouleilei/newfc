import { describe, expect, it } from 'vitest';
import { executeTool, toolDefinitions, toolLabel, TOOL_REGISTRY } from '../src/assistant/tools';
import { pageDefinition } from '../src/contracts/page-catalog';
import { allowedToolsForCapabilities, capabilityOfTool } from '../src/assistant/page-capabilities';
import { detectIntents } from '../src/assistant/intent';
import { queryFacts } from '../src/assistant/facts';
import { testDb, buildFixture, budget, actual } from './helpers';

/**
 * 目录类与运维类只读工具(2026-09 扩充):编制进度、结构分析、指标目录、洞察列表、
 * 主数据体检、多年趋势、一致性检查、测算模板、清洗配置、工作台总览、年度状态、
 * 工作表目录、备份列表。
 *
 * 本文件只验证「接线」:工具真实存在、schema/标签/能力映射齐全、白名单校验生效、
 * 确定性意图能路由到工具。各服务的业务口径由各自的 service 测试保证。
 */

const NEW_TOOLS = [
  'get_budget_progress', 'calculate_structure', 'list_metrics', 'list_insights',
  'get_master_data_health', 'calculate_multi_year_trend', 'check_consistency',
  'list_calculation_rules', 'list_cleaning_templates', 'list_cleaning_aliases',
  'get_dashboard_overview', 'get_year_states', 'list_sheets', 'list_backups',
  'get_cell_notes',
] as const;

function fixtureWithActual() {
  const db = testDb();
  const fx = buildFixture(db);
  const version = budget.createVersion(db, { year: 2026, name: 'V1' });
  budget.saveEntries(db, version.id, [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '12000000.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '6000000.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '6000000.00' },
  ]);
  actual.saveActual(db, {
    year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
    entries: [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10800000.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '6000000.00' },
    ],
  });
  return { db, fx, version };
}

describe('目录类工具:注册完整性', () => {
  it('新工具全部注册,且 schema 与流式标签同步存在', () => {
    const declared = toolDefinitions.map((t) => t.function.name);
    for (const name of NEW_TOOLS) {
      expect(Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name), `${name} 未注册`).toBe(true);
      expect(declared, `${name} 缺少 toolDefinitions/schema`).toContain(name);
      expect(toolLabel(name), `${name} 缺少中文标签`).not.toBe(name);
    }
    // 上一轮发现的缺口:get_budget_cell_history 也曾漏掉流式标签
    expect(toolLabel('get_budget_cell_history')).toBe('读取单元格修改记录');
  });

  it('每个新工具都属于某个领域能力(或全页面通用),capabilityOfTool 可查', () => {
    for (const name of NEW_TOOLS) {
      const inUniversal = allowedToolsForCapabilities([]).includes(name);
      expect(inUniversal || capabilityOfTool(name) != null, `${name} 未挂载到任何能力`).toBe(true);
    }
    expect(capabilityOfTool('get_budget_progress')).toBe('budget');
    expect(capabilityOfTool('calculate_structure')).toBe('comparison');
    expect(capabilityOfTool('get_master_data_health')).toBe('master_data');
    expect(capabilityOfTool('check_consistency')).toBe('operations');
    expect(capabilityOfTool('list_cleaning_templates')).toBe('import_conversion');
    expect(capabilityOfTool('list_insights')).toBe('assistant_content');
    // 单元格备注挂在 budget/actual/evidence 三个域,capabilityOfTool 取第一个命中域
    expect(capabilityOfTool('get_cell_notes')).toBe('budget');
    // 指标/工作表目录是 ID 发现工具,与 list_budget_versions 一样全页面可用
    for (const page of ['analysis', 'metric_trend', 'metric', 'history']) {
      const cap = pageDefinition(page)!;
      const allowed = allowedToolsForCapabilities(cap.capabilities);
      expect(allowed, `${page} 页应能列出指标`).toContain('list_metrics');
      expect(allowed, `${page} 页应能列出工作表`).toContain('list_sheets');
    }
  });

  it('编制进度页默认能力改为 budget,且允许调用进度工具', () => {
    const page = pageDefinition('budget_progress')!;
    expect(page.defaultCapability).toBe('budget');
    expect(allowedToolsForCapabilities(page.capabilities)).toContain('get_budget_progress');
  });
});

describe('目录类工具:执行与参数白名单', () => {
  it('编制进度/结构分析/指标目录/多年趋势基于夹具正常返回', () => {
    const { db, version } = fixtureWithActual();
    const progress = executeTool(db, 'get_budget_progress', { versionId: version.id }) as any;
    expect(progress.summary.orgCount).toBeGreaterThan(0);
    expect(Array.isArray(progress.rows)).toBe(true);

    const structure = executeTool(db, 'calculate_structure', { versionId: version.id }) as any;
    expect(structure.version.id).toBe(version.id);
    expect(Array.isArray(structure.rows)).toBe(true);

    const metrics = executeTool(db, 'list_metrics', {}) as any[];
    expect(metrics.map((m) => m.code)).toEqual(expect.arrayContaining(['GROSS', 'OP']));
    expect(metrics[0].terms.length).toBeGreaterThan(0);
    const versionMetrics = executeTool(db, 'list_metrics', { versionId: version.id }) as any[];
    expect(versionMetrics.map((m) => m.code)).toEqual(metrics.map((m) => m.code));

    const trend = executeTool(db, 'calculate_multi_year_trend', { baseYear: 2026, depth: 2 }) as any;
    expect(trend.baseYear).toBe(2026);
  });

  it('无参目录/运维工具直接返回,拒绝模型多给的参数', () => {
    const db = testDb();
    buildFixture(db);
    expect(() => executeTool(db, 'get_dashboard_overview', { hacker: 1 })).toThrow(/hacker/);
    const overview = executeTool(db, 'get_dashboard_overview', {}) as any;
    expect(overview.counts.orgs).toBeGreaterThan(0);
    // 操作日志不随总览进模型上下文——日志一律走带脱敏的 get_operation_log
    expect('recentLogs' in overview).toBe(false);

    const health = executeTool(db, 'get_master_data_health', {}) as any;
    expect(typeof health.issueCount).toBe('number');
    expect(Array.isArray(health.issues)).toBe(true);

    const consistency = executeTool(db, 'check_consistency', {}) as any;
    expect(typeof consistency.ok).toBe('boolean');
    expect(Array.isArray(consistency.checks)).toBe(true);

    expect(Array.isArray(executeTool(db, 'get_year_states', {}))).toBe(true);
    expect(Array.isArray(executeTool(db, 'list_sheets', {}))).toBe(true);
    expect(Array.isArray(executeTool(db, 'list_backups', {}))).toBe(true);
    expect(executeTool(db, 'list_insights', {})).toEqual([]);
    // 迁移预置了「上网电费测算」模板,目录非空且带配置
    const rules = executeTool(db, 'list_calculation_rules', {}) as any[];
    expect(rules.map((r) => r.code)).toContain('POWER_GRID_REVENUE');
    expect(executeTool(db, 'list_cleaning_templates', {})).toEqual([]);
    expect(executeTool(db, 'list_cleaning_aliases', {})).toEqual([]);
  });

  it('参数白名单:非法参数一律拒绝,不透传下游', () => {
    const db = testDb();
    expect(() => executeTool(db, 'get_budget_progress', {})).toThrow(/versionId/);
    expect(() => executeTool(db, 'calculate_structure', { versionId: 1, basisMode: 'x' })).toThrow(/basisMode/);
    expect(() => executeTool(db, 'calculate_structure', { versionId: 1, basisId: -1 })).toThrow(/basisId/);
    expect(() => executeTool(db, 'list_metrics', { versionId: 0 })).toThrow(/versionId/);
    expect(() => executeTool(db, 'list_insights', { limit: 999 })).toThrow(/limit/);
    expect(() => executeTool(db, 'calculate_multi_year_trend', { baseYear: 1800 })).toThrow(/baseYear/);
    expect(() => executeTool(db, 'calculate_multi_year_trend', { baseYear: 2026, depth: 99 })).toThrow(/depth/);
    expect(() => executeTool(db, 'calculate_multi_year_trend', { baseYear: 2026, orgCodes: 'EAST' })).toThrow(/orgCodes/);
    expect(() => executeTool(db, 'list_cleaning_templates', { targetKind: 'x' })).toThrow(/targetKind/);
    expect(() => executeTool(db, 'list_cleaning_aliases', { mappingKind: 'x' })).toThrow(/mappingKind/);
  });
});

describe('目录类工具:确定性意图路由(无模型兜底)', () => {
  it('新意图关键词命中且不与旧意图冲突', () => {
    expect(detectIntents('哪些单位还没填预算').read).toContain('budget_progress');
    expect(detectIntents('各科目费用占比是多少').read).toContain('structure');
    expect(detectIntents('有哪些报表指标,毛利率指标怎么算').read).toContain('metric_catalog');
    expect(detectIntents('最近生成了哪些洞察报告').read).toContain('insights');
    expect(detectIntents('主数据健康检查有没有问题').read).toContain('master_health');
    expect(detectIntents('一致性检查跑一下').read).toContain('consistency_check');
    expect(detectIntents('测算模板有哪些').read).toContain('calculation_rules');
    expect(detectIntents('清洗模板和别名配置').read).toContain('cleaning_config');
    // 「洞察报告」里的「报告」指已保存记录,不触发整份报告组稿
    expect(detectIntents('洞察报告列表').read).not.toContain('report');
  });

  it('「洞察报告」双向消歧:组稿语气归报告生成,查询语境归已保存列表', () => {
    // 创建诉求:report 优先,insights 被抑制——不能再路由成列已保存清单
    const creation = detectIntents('写一份洞察报告');
    expect(creation.read).toContain('report');
    expect(creation.read).not.toContain('insights');
    expect(creation.suppressed).toContain('insights');
    // 查询语境:维持抑制 report;「生成了哪些」是过去式查询,不是组稿语气
    const listing = detectIntents('最近生成了哪些洞察报告');
    expect(listing.read).toContain('insights');
    expect(listing.read).not.toContain('report');
    expect(listing.suppressed).toContain('report');
  });

  it('queryFacts 按新意图取数,缺版本时给出 missing_context 而非抛错', () => {
    const { db, version } = fixtureWithActual();
    const withVersion = queryFacts(db, '哪些单位还没填预算', { budgetVersionId: version.id, year: 2026 }, { includeExtras: false });
    expect(withVersion.some((f) => f.type === 'budget_progress')).toBe(true);

    const noVersion = queryFacts(db, '编制进度怎么样', {}, { includeExtras: false });
    expect(noVersion.some((f) => f.type === 'missing_context')).toBe(true);

    const health = queryFacts(db, '主数据健康体检', {}, { includeExtras: false });
    expect(health.some((f) => f.type === 'master_data_health')).toBe(true);

    const consistency = queryFacts(db, '一致性检查', {}, { includeExtras: false });
    expect(consistency.some((f) => f.type === 'consistency_check')).toBe(true);

    const metrics = queryFacts(db, '有哪些报表指标', { budgetVersionId: version.id, year: 2026 }, { includeExtras: false });
    expect(metrics.some((f) => f.type === 'metric_catalog')).toBe(true);

    const insights = queryFacts(db, '已保存的洞察', {}, { includeExtras: false });
    expect(insights.some((f) => f.type === 'insights')).toBe(true);

    const cleaning = queryFacts(db, '清洗模板有哪些', {}, { includeExtras: false });
    expect(cleaning.some((f) => f.type === 'cleaning_templates')).toBe(true);
    expect(cleaning.some((f) => f.type === 'cleaning_aliases')).toBe(true);
  });

  it('历年对比意图同时附带多年趋势(与历年对比页同源)', () => {
    const { db } = fixtureWithActual();
    const facts = queryFacts(db, '历年对比怎么样', { year: 2026 }, { includeExtras: false });
    expect(facts.some((f) => f.type === 'historical_comparison')).toBe(true);
    expect(facts.some((f) => f.type === 'multi_year_trend')).toBe(true);
  });
});
