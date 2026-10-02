/**
 * 集成测试(现行 specs/ai.md 页面上下文契约§13.3)。
 *
 * 覆盖:
 * - chat 与 chat/stream 同输入产生相同 effectiveContext / facts;
 * - 模型不可用时范围不变(routing=rules 仍携带完整 V2 字段);
 * - 页面范围与问题文字冲突时产生正确 overrides;
 * - 会话继承只补空缺,不覆盖当前页面范围;
 * - 页面、助手共用 verificationFacts(同一 factKey 同源数据);
 * - 草稿影响 = 基线 + 本轮 changes 的重算结果;
 * - 历史 response_json 恢复范围摘要但不含原始草稿;
 * - 带 draft 的 preview 被拒绝;写操作仍走 preview/confirmationToken。
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import * as assistant from '../src/assistant/service';
import * as reportService from '../src/modules/report/report.service';
import { buildFixture, standardBudgetVersion, saveActualSnapshot, budget, testDb } from './helpers';

function makeDb() {
  return testDb();
}

function v2Context(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    snapshotId: `snap-${Math.random().toString(36).slice(2, 10)}`,
    pageKey: 'analysis',
    routeInstanceId: 'route-it-1',
    contextVersion: 1,
    scope: {},
    view: {},
    surfaces: [],
    focus: null,
    selection: null,
    draft: null,
    ...overrides,
  };
}

describe('chat 页面对齐集成(§13.3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('携带 pageContext 的 chat 返回 contextSummary / effectiveContext / capability', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    const result = await assistant.chat(db, { message: '本年执行怎么样', pageContext: v2Context({ scope: { year: 2026, budgetVersionId: version.id } }) });
    expect(result.contextStatus).toBe('aligned');
    expect(result.effectiveContext?.pageKey).toBe('analysis');
    expect(result.contextSummary).toContain('年度执行分析');
    expect(result.contextSummary).toContain('2026 年');
    expect(result.contextSummary).toContain('V1');
    expect(result.capability).toBeTruthy();
    db.close();
  });

  it('onToken 流式路径与非流式路径产生相同 effectiveContext 与 facts', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    const input = { message: '列出预算版本', pageContext: v2Context({ scope: { year: 2026, budgetVersionId: version.id } }) };
    const plain = await assistant.chat(db, { ...input });
    // streamChat 复用 svc.chat + onToken；onToken 改变输出路径不改变口径。
    const streamed = await assistant.chat(db, { ...input }, '', { onToken: () => {} });
    expect(streamed.effectiveContext).toEqual(plain.effectiveContext);
    expect(streamed.contextSummary).toBe(plain.contextSummary);
    expect(streamed.facts.map((f) => f.type)).toEqual(plain.facts.map((f) => f.type));
    db.close();
  });

  it('问题明确指定其他版本时产生 explicit_override 与覆盖记录', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const v1 = standardBudgetVersion(fx);
    const v2 = budget.createVersion(db, { year: 2026, name: 'V2-追赶' });
    const pageVersion = v1;
    expect(pageVersion).toBeTruthy();
    const result = await assistant.chat(db, { message: 'V2-追赶 这个版本的执行情况', pageContext: v2Context({ scope: { year: 2026, budgetVersionId: pageVersion!.id } }) });
    expect(result.contextStatus).toBe('explicit_override');
    expect(result.effectiveContext.budgetVersionId).toBe(v2.id);
    const override = result.contextTrace?.overrides.find((o) => o.field === 'budgetVersionId');
    expect(override).toBeTruthy();
    expect(override?.from).toBe(pageVersion!.id);
    expect(override?.to).toBe(v2.id);
    db.close();
  });

  it('版本对比页 base/compare 直接产生确定性版本差异事实', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const base = standardBudgetVersion(fx, 2026, '基准');
    const compare = budget.createVersion(db, { year: 2026, name: '目标' });
    budget.saveEntries(db, compare.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' },
    ]);
    const result = await assistant.chat(db, { message: '这两个版本差异是什么', pageContext: v2Context({
        pageKey: 'version_compare',
        scope: { baseVersionId: base.id, compareVersionId: compare.id },
        view: { sheetKey: 'all' },
      }) });
    expect(result.effectiveContext.budgetVersionId).toBe(base.id);
    expect(result.effectiveContext.targetVersionId).toBe(compare.id);
    expect(result.facts.some((item) => item.type === 'version_variance')).toBe(true);
    expect(result.facts.some((item) => item.type === 'missing_context')).toBe(false);
    db.close();
  });

  it('会话继承只补空缺:页面已给的版本不被上一轮继承覆盖', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const first = standardBudgetVersion(fx);
    const second = budget.createVersion(db, { year: 2026, name: 'V2' });
    // 第一轮:页面指向 V1
    const round1 = await assistant.chat(db, { message: '列出预算版本', pageContext: v2Context({ scope: { year: 2026, budgetVersionId: first.id } }) });
    // 第二轮:同一页面会话内追问,页面仍指向 V1 —— 上一轮 resolved 的是 V1,不变;
    // 但若页面换到 V2(用户点了别的版本),页面优先于会话继承。
    const round2 = await assistant.chat(db, { conversationId: round1.conversationId, message: '费用占比呢', pageContext: v2Context({ scope: { year: 2026, budgetVersionId: second.id } }) });
    expect(round2.effectiveContext.budgetVersionId).toBe(second.id);
    db.close();
  });

  it('核验焦点从领域服务重新取数,与页面 VerifyBar 共用同一份结论(§9.5)', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    saveActualSnapshot(fx, 2026, '2026-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '88.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '55.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '18.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '40.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '29.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseSales, amount: '9.00' },
    ]);
    // 页面侧:completion 报告的 verificationFacts
    const report = reportService.completionReport(db, { versionId: version.id });
    const reconciliation = report.verificationFacts.find((f) => f.factKey === 'reconciliation');
    expect(reconciliation).toBeTruthy();

    // 助手侧:带着该核验焦点提问,返回的 verification_fact 与页面同源同值
    const result = await assistant.chat(db, { message: '这个核验是什么意思', pageContext: v2Context({
        scope: { year: 2026, budgetVersionId: version.id },
        focus: { kind: 'fact', factType: 'verification', ownerKey: 'analysis:root', factKey: 'reconciliation' },
      }) });
    const fact = result.facts.find((f) => f.type === 'verification_fact');
    expect(fact).toBeTruthy();
    const data = fact!.data as { factKey: string; serverLevel: string; facts: Record<string, unknown> };
    expect(data.factKey).toBe('reconciliation');
    expect(data.serverLevel).toBe(reconciliation!.serverLevel);
    expect(data.facts).toEqual(reconciliation!.facts);
    db.close();
  });

  it('客户端伪造核验 label/level 不影响后端结论', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    saveActualSnapshot(fx, 2026, '2026-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '88.00' },
    ]);
    const result = await assistant.chat(db, { message: '这个核验是什么', pageContext: v2Context({
        scope: { year: 2026, budgetVersionId: version.id },
        focus: {
          kind: 'fact', factType: 'verification', ownerKey: 'analysis:root', factKey: 'reconciliation',
          // 伪造字段:后端必须忽略,按服务重算
          label: '伪造的通过结论', level: 'ok', details: ['伪造明细'],
        } as Record<string, unknown>,
      }) });
    const fact = result.facts.find((f) => f.type === 'verification_fact');
    expect(fact).toBeTruthy();
    const data = fact!.data as { label: string };
    expect(data.label).not.toBe('伪造的通过结论');
    expect(JSON.stringify(result)).not.toContain('伪造明细');
    db.close();
  });

  it('草稿影响进入 facts 但原始 changes 不出现在响应与日志中(§9.6/§9.8)', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const created = standardBudgetVersion(fx);
    const version = budget.getVersion(db, created.id);
    const result = await assistant.chat(db, { message: '我这么改会有什么影响', pageContext: v2Context({
        pageKey: 'budget_edit',
        scope: { year: 2026, budgetVersionId: version.id },
        draft: {
          kind: 'budget_grid',
          base: {
            versionId: version.id,
            revision: version.revision,
            orgTreeSnapshotId: version.org_tree_snapshot_id,
            accountTreeSnapshotId: version.account_tree_snapshot_id,
          },
          // 上海主营收入 100 → 123.45 元
          changes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '123.45' }],
        },
      }) });
    expect(result.draftApplied).toMatchObject({ kind: 'budget_grid', changeCount: 1 });
    const fact = result.facts.find((f) => f.type === 'draft_impact');
    expect(fact).toBeTruthy();
    const data = fact!.data as { totalDeltaCents: number; accountDeltas: { deltaCents: number }[] };
    // 100.00 → 123.45 元 = +23.45 元 = 2345 分
    expect(data.totalDeltaCents).toBe(2345);
    expect(data.accountDeltas.length).toBeGreaterThan(0);
    // 原始 changes 值(123.45 元 / 12345 分)不出现在整个响应 JSON 中
    const responseText = JSON.stringify(result);
    expect(responseText).not.toContain('123.45');
    expect(responseText).not.toContain('12345');
    expect(responseText).not.toContain('changedCells');
    // 操作日志同样不含原值
    const log = db.prepare("SELECT detail_json FROM operation_log WHERE action='ai.chat' ORDER BY id DESC LIMIT 1").get() as { detail_json: string };
    expect(log.detail_json).not.toContain('123.45');
    expect(log.detail_json).not.toContain('12345');
    db.close();
  });

  it('历史 response_json 能恢复范围摘要,但不含原始草稿(§13.3)', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const created = standardBudgetVersion(fx);
    const version = budget.getVersion(db, created.id);
    const result = await assistant.chat(db, { message: '草稿影响如何', pageContext: v2Context({
        pageKey: 'budget_edit',
        scope: { year: 2026, budgetVersionId: version.id },
        draft: {
          kind: 'budget_grid',
          base: {
            versionId: version.id,
            revision: version.revision,
            orgTreeSnapshotId: version.org_tree_snapshot_id,
            accountTreeSnapshotId: version.account_tree_snapshot_id,
          },
          changes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '123.45' }],
        },
      }) });
    const conv = assistant.conversation(db, result.conversationId);
    const assistantMsg = conv.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeTruthy();
    const persisted = JSON.stringify(assistantMsg!.response ?? {});
    // 范围摘要与状态完整恢复
    expect(persisted).toContain('contextSummary');
    expect(persisted).toContain('预算编制表格');
    expect(persisted).toContain('draftApplied');
    // 原始草稿值不落库
    expect(persisted).not.toContain('123.45');
    expect(persisted).not.toContain('changedCells');
    db.close();
  });

  it('带 draft 的 preview 被拒绝(§10.4)', () => {
    const db = makeDb();
    const fx = buildFixture(db);
    standardBudgetVersion(fx);
    expect(() => assistant.preview(db, {
      type: 'scenario',
      params: { idempotencyKey: 'draft-reject', incomeGrowth: 0.1 },
      draft: { kind: 'budget_grid', base: {}, changes: [] },
    } as never)).toThrowError(/草稿/);
    db.close();
  });

  it('写操作仍走 preview → confirmationToken → confirm', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    standardBudgetVersion(fx);
    const action = assistant.preview(db, { type: 'scenario', params: { idempotencyKey: 'it-write', incomeGrowth: 0.05 } });
    expect(action.status).toBe('pending');
    expect(action.confirmationToken).toBeTruthy();
    // 无 token 不能确认
    await expect(assistant.confirmAsync(db, action.id, '', undefined)).rejects.toThrow();
    db.close();
  });

  it('未知 pageKey 的 chat 请求被 CONTEXT_INVALID 拒绝', async () => {
    const db = makeDb();
    await expect(assistant.chat(db, { message: '你好', pageContext: v2Context({ pageKey: 'not_a_page' }) })).rejects.toMatchObject({ code: 'CONTEXT_INVALID' });
    db.close();
  });

  it('focus 指向其他版本时报 CONTEXT_STALE,不静默扩大范围', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const v1 = standardBudgetVersion(fx);
    const v2 = budget.createVersion(db, { year: 2026, name: 'V2' });
    await expect(assistant.chat(db, { message: '这个单元格', pageContext: v2Context({
        pageKey: 'budget_edit',
        scope: { year: 2026, budgetVersionId: v1.id },
        focus: { kind: 'cell', source: 'budget', sourceId: v2.id, orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain },
      }) })).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
    db.close();
  });

  it('模型不可用时页面范围与 capability 字段不变(routing=rules)', async () => {
    const db = makeDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    // setup.ts 已清空模型环境变量,此处再显式确保
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
    const result = await assistant.chat(db, { message: '本年执行怎么样', pageContext: v2Context({ scope: { year: 2026, budgetVersionId: version.id } }) });
    expect(result.routing).toBe('rules');
    expect(result.contextStatus).toBe('aligned');
    expect(result.effectiveContext?.pageKey).toBe('analysis');
    expect(result.capability).toBeTruthy();
    db.close();
  });
});
