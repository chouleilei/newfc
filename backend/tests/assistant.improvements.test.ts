import { afterEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { detectIntents, detectRankFocus, looksLikeWriteConfirmation } from '../src/assistant/intent';
import { resolveMessageContext } from '../src/assistant/resolve';
import { queryFacts } from '../src/assistant/facts';
import * as assistant from '../src/assistant/service';
import { executeTool, toolDefinitions } from '../src/assistant/tools';
import { SYSTEM_PROMPT } from '../src/assistant/prompts';
import { resetAssistantRateLimit } from '../src/assistant/rate-limit';
import { createApp } from '../src/server';
import { queryLogs } from '../src/modules/audit/log';
import { createSourceProfile } from '../src/modules/finance-import/source-profile.service';
import {
  createMappingVersion, lockMappingVersion, replaceAccountMappings,
  replaceOrgMappings, replaceReconciliationRules,
} from '../src/modules/finance-import/mapping/mapping.service';
import { createConversion } from '../src/modules/finance-import/conversion/conversion-batch.service';
import { testDb, tempFileDb, buildFixture, standardBudgetVersion, saveActualSnapshot, budget, org, account, actual } from './helpers';

/**
 * AI 助手 P0/P1/P2 完善项的回归测试。
 *
 * 对应实测发现的问题：
 * P0 财务转换盲区(模型对看不见的模块给肯定结论)、numberCheck 未落地且误报、
 *    写操作确认路径说错且追问会丢掉 action；
 * P1 首字空白无进度、模板模式三处退化(名称片段/口语化问法/追问名次)、会话与洞察管理；
 * P2 测试隔离(见 tests/setup.ts)、速率限制与模型调用度量。
 */

function fixtureWithActual(db = testDb()) {
  const fx = buildFixture(db);
  const version = standardBudgetVersion(fx, 2026, 'V1');
  budget.lockVersion(db, version.id);
  budget.setCurrentVersion(db, version.id);
  saveActualSnapshot(fx, 2026, '2026-06-30', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '35.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '30.00' },
  ]);
  return { db, fx, version };
}

/* ------------------------------------------------------------------ *
 * P0-1 财务转换只读工具
 * ------------------------------------------------------------------ */

async function balanceWorkbook(year: number, date: string, rows: { org: string; orgName: string; code: string; name: string; debit: number; credit: number }[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('科目余额表');
  ws.addRow(['账套编码', '组织编码', '组织名称', '科目编码', '科目名称', '本年累计借方', '本年累计贷方', '年度', '截止日期']);
  for (const r of rows) ws.addRow(['BOOK1', r.org, r.orgName, r.code, r.name, r.debit, r.credit, year, date]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function profitWorkbook(year: number, date: string, rows: { item: string; amount: number }[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('利润表');
  ws.addRow(['项目', '本年累计金额', '年度', '截止日期']);
  for (const r of rows) ws.addRow([r.item, r.amount, year, date]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function financeSetup() {
  const { db, fx, version } = fixtureWithActual();
  const profile = createSourceProfile(db, {
    code: 'FIXED', name: '固定财务系统',
    config: {
      balanceSheetNames: ['科目余额表'], profitSheetNames: ['利润表'],
      ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I', 'C', 'E'], amountUnit: 'yuan',
    },
  });
  const mapping = createMappingVersion(db, { sourceProfileId: profile.id, name: '已审核映射' });
  replaceOrgMappings(db, mapping.id, [
    { sourceBookCode: 'BOOK1', sourceOrgCode: 'S001', targetOrgId: fx.orgIds.shanghai, priority: 10, note: '公司编码确认' },
    { sourceBookCode: 'BOOK1', sourceOrgCode: 'H001', targetOrgId: fx.orgIds.hangzhou, priority: 10, note: '公司编码确认' },
  ]);
  replaceAccountMappings(db, mapping.id, [
    { sourceAccountCode: '4001', targetAccountId: fx.accIds.incomeMain, amountRule: 'credit_minus_debit', note: '主营收入' },
    { sourceAccountCode: '5001', targetAccountId: fx.accIds.costSub, amountRule: 'debit_minus_credit', note: '主营成本' },
    { sourceAccountCode: '6601', targetAccountId: fx.accIds.expenseAdmin, amountRule: 'debit_minus_credit', note: '管理费用' },
  ]);
  replaceReconciliationRules(db, mapping.id, [
    { sourceLineAlias: '营业收入', targetType: 'account', targetCode: 'I' },
    { sourceLineAlias: '营业成本', targetType: 'account', targetCode: 'C' },
    { sourceLineAlias: '期间费用', targetType: 'account', targetCode: 'E' },
    { sourceLineAlias: '净利润', targetType: 'metric', targetCode: 'OP' },
  ]);
  const locked = lockMappingVersion(db, mapping.id, 'reviewer');
  return { db, fx, version, profile, locked };
}

describe('AI 助手:财务转换只读工具(原来是盲区)', () => {
  it('工具清单包含财务转换只读工具，且参数经白名单校验', () => {
    const names = toolDefinitions.map((t) => t.function.name);
    for (const name of [
      'list_finance_conversions', 'get_finance_conversion', 'list_finance_mapping_versions',
      'get_finance_mapping_version', 'list_finance_parallel_trials', 'list_finance_source_profiles',
    ]) expect(names).toContain(name);
    const db = testDb();
    expect(() => executeTool(db, 'get_finance_conversion', {})).toThrow(/conversionId/);
    expect(() => executeTool(db, 'get_finance_mapping_version', { mappingVersionId: 0 })).toThrow(/mappingVersionId/);
    expect(() => executeTool(db, 'list_finance_conversions', { limit: 999 })).toThrow(/1-100/);
    // 没有任何批次时如实返回空，不报错
    expect(executeTool(db, 'list_finance_conversions', {})).toMatchObject({ count: 0, batches: [] });
  });

  it('转换失败时逐闸门给出结论与阻断原因，映射校验单独可查', async () => {
    const { db, profile, locked } = financeSetup();
    // 利润表与余额表故意不勾稽 → reconciliation 闸门失败关闭
    const conversion = await createConversion(db, {
      sourceProfileId: profile.id, mappingVersionId: locked.id, year: 2026, snapshotDate: '2026-06-30',
      balanceName: 'balance.xlsx',
      balance: await balanceWorkbook(2026, '2026-06-30', [
        { org: 'S001', orgName: '上海', code: '4001', name: '主营收入', debit: 0, credit: 100 },
        { org: 'S001', orgName: '上海', code: '5001', name: '主营成本', debit: 60, credit: 0 },
      ]),
      profitName: 'profit.xlsx',
      profit: await profitWorkbook(2026, '2026-06-30', [
        { item: '营业收入', amount: 999 }, { item: '营业成本', amount: 60 },
        { item: '期间费用', amount: 0 }, { item: '净利润', amount: 939 },
      ]),
    });
    expect(conversion.status).toBe('blocked');

    const list: any = executeTool(db, 'list_finance_conversions', {});
    expect(list.count).toBe(1);
    expect(list.batches[0]).toMatchObject({ id: conversion.id, status: 'blocked', passed: false });
    expect(list.batches[0].firstError.code).toBeTruthy();

    const detail: any = executeTool(db, 'get_finance_conversion', { conversionId: conversion.id });
    expect(detail.passed).toBe(false);
    expect(detail.gates.reconciliation).toBe(false);
    expect(detail.errors.total).toBeGreaterThan(0);
    // 明细必须有界，并显式告知隐藏条数
    expect(detail.errors.shown.length).toBeLessThanOrEqual(20);
    expect(detail.errors.hidden).toBe(Math.max(0, detail.errors.total - 20));
    expect(detail.reconciliation.failedCount).toBeGreaterThan(0);

    const mapping: any = executeTool(db, 'get_finance_mapping_version', { mappingVersionId: locked.id });
    expect(mapping.status).toBe('locked');
    expect(mapping.validation.passed).toBe(true);
    expect(mapping.counts.activeAccountRules).toBe(3);

    // 模板模式下的问答：必须落到财务转换事实，且文字给出闸门结论
    const facts = queryFacts(db, '上次财务数据转换为什么失败，映射有没有漏的科目', { year: 2026 });
    const types = facts.map((f) => f.type);
    expect(types).toContain('finance_conversions');
    expect(types).toContain('finance_conversion_detail');
    expect(types).toContain('finance_mapping_version');

    const answer = await assistant.chat(db, { message: '上次财务数据转换为什么失败，映射有没有漏的科目', context: { year: 2026 } });
    expect(answer.routing).toBe('rules');
    expect(answer.text).toMatch(/财务转换批次/);
    expect(answer.text).toMatch(/利润表勾稽未通过/);
    // 不得给出「没有问题」这类结论
    expect(answer.text).not.toMatch(/未检测到遗漏|没有问题/);
  });

  it('提示词固化了能力范围与写操作确认路径(防回归)', () => {
    expect(SYSTEM_PROMPT).toMatch(/助手看不到这部分数据/);
    expect(SYSTEM_PROMPT).toMatch(/不得给出「没有问题」/);
    expect(SYSTEM_PROMPT).toMatch(/list_finance_conversions/);
    expect(SYSTEM_PROMPT).toMatch(/不能通过对话确认/);
    expect(SYSTEM_PROMPT).toMatch(/创建预览/);
  });
});

/* ------------------------------------------------------------------ *
 * P0-2 numberCheck
 * ------------------------------------------------------------------ */

describe('AI 助手:正文数字核对', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
  });

  it('用户原话与操作参数里的数字不再被误判为对不上事实', async () => {
    const { db, version } = fixtureWithActual();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    // 模型正文里出现的 5.00 与 0.05 都来自用户原话/抽出的参数，不是转述后端事实的产物
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '将按整体增长 5.00%（growthRate 0.05）复制版本，请点击下方「创建预览」核对逐行影响。',
          },
        }],
      }),
    })));
    const answer = await assistant.chat(db, {
      message: `把 2026 年版本 #${version.id} 复制成 2027 年草案，整体增长 5%`,
      context: { year: 2026, budgetVersionId: version.id },
    });
    expect(answer.routing).toBe('model');
    expect(answer.numberCheck.unverified).not.toContain('5.00');
    expect(answer.numberCheck.unverified).not.toContain('0.05');
    expect(answer.numberCheck.status).toBe('ok');
  });

  it('模型改错的数字仍会被标记为无法核对', async () => {
    const { db, version } = fixtureWithActual();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '', tool_calls: [{ id: 't1', function: { name: 'calculate_execution', arguments: JSON.stringify({ versionId: version.id }) } }] } }],
          }),
        };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: '收入实际 987654.32 万元。' } }] }) };
    }));
    const answer = await assistant.chat(db, { message: '2026 年执行情况如何', context: { year: 2026, budgetVersionId: version.id } });
    expect(answer.routing).toBe('model');
    expect(answer.numberCheck.status).toBe('unverified');
    expect(answer.numberCheck.unverified).toContain('987654.32');
  });

  it('差异类数字符号翻转被判为对不上,科目金额正数转述仍放行', async () => {
    const { db, version, fx } = fixtureWithActual();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '', tool_calls: [{ id: 't1', function: { name: 'calculate_execution', arguments: JSON.stringify({ versionId: version.id }) } }] } }],
          }),
        };
      }
      // 成本科目金额按界面口径用正数转述(合法);整体净差异被翻转符号(非法)
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: `成本累计实际 35.00 万元(低于预算,有利);整体净差异被写成 -35.00 万元。`,
            },
          }],
        }),
      };
    }));
    const answer = await assistant.chat(db, { message: '2026 年执行情况如何', context: { year: 2026, budgetVersionId: version.id } });
    expect(answer.routing).toBe('model');
    // 科目金额正数写法是界面口径,必须放行
    expect(answer.numberCheck.unverified).not.toContain('35.00');
    void fx;
    db.close();
  });
});

/* ------------------------------------------------------------------ *
 * P0-3 写操作确认路径与追问保留 action
 * ------------------------------------------------------------------ */

describe('AI 助手:写操作确认路径', () => {
  it('识别聊天里的「确认执行」，说明真实路径并沿用上一轮操作建议', async () => {
    const { db, version } = fixtureWithActual();
    expect(looksLikeWriteConfirmation('确认执行')).toBe(true);
    expect(looksLikeWriteConfirmation('确认一下这个版本的状态')).toBe(false);

    const first = await assistant.chat(db, {
      message: `把 2026 年版本 #${version.id} 复制成 2027 年草案，整体增长 5%`,
      context: { year: 2026, budgetVersionId: version.id },
    });
    expect(first.action?.type).toBe('copy_budget');
    expect(first.action?.previewable).toBe(true);

    const second = await assistant.chat(db, { conversationId: first.conversationId, message: '确认执行' });
    expect(second.notices.some((n) => n.includes('不会写入任何数据'))).toBe(true);
    expect(second.action?.type).toBe('copy_budget');
    expect(second.action?.inherited).toBe(true);
    expect(second.action?.previewable).toBe(true);
    // 关键：真的没有落库
    expect(db.prepare('SELECT COUNT(*) n FROM budget_version WHERE year=2027').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM ai_action').get()).toEqual({ n: 0 });
  });

  it('没有历史操作建议时也如实说明，不假装有待确认操作', async () => {
    const { db } = fixtureWithActual();
    const answer = await assistant.chat(db, { message: '确认' });
    expect(answer.action).toBeNull();
    expect(answer.notices.some((n) => n.includes('没有待确认的操作建议'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * P1-4 流式进度
 * ------------------------------------------------------------------ */

describe('AI 助手:流式进度事件', () => {
  it('模板模式也会先播报解析与取数阶段', async () => {
    const { db, version } = fixtureWithActual();
    const events: { stage: string; label: string }[] = [];
    await assistant.chat(
      db,
      { message: '2026 年执行完成情况如何', context: { year: 2026, budgetVersionId: version.id } },
      '',
      { onProgress: (event) => events.push({ stage: event.stage, label: event.label }) },
    );
    expect(events.map((e) => e.stage)).toContain('context');
    expect(events.map((e) => e.stage)).toContain('template');
    expect(events[0].label).toBe('已解析提问范围');
  });

  it('模型路由时按工具调用逐条播报', async () => {
    const { db, version } = fixtureWithActual();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '', tool_calls: [{ id: 't1', function: { name: 'calculate_attribution', arguments: JSON.stringify({ versionId: version.id }) } }] } }],
          }),
        };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: '归因结论' } }] }) };
    }));
    const events: { stage: string; label: string; detail?: string }[] = [];
    await assistant.chat(
      db,
      { message: '哪个组织亏得最多', context: { year: 2026, budgetVersionId: version.id } },
      '',
      { onProgress: (event) => events.push(event) },
    );
    const tool = events.find((e) => e.stage === 'tool');
    expect(tool?.label).toBe('正在计算差异归因');
    expect(tool?.detail).toBe('calculate_attribution');
    expect(events.some((e) => e.stage === 'answer')).toBe(true);
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
  });
});

/* ------------------------------------------------------------------ *
 * P1-6 模板模式三处退化
 * ------------------------------------------------------------------ */

describe('AI 助手:模板模式退化修复', () => {
  it('名称片段可命中唯一组织，重名片段报歧义而不是静默按全范围', async () => {
    const { db, fx, version } = fixtureWithActual();
    // 「上海」是「上海公司」的核心名，唯一命中
    const single = resolveMessageContext(db, '上海今年收入完成得怎么样', {}, {}, { defaultVersion: true });
    expect(single.context.orgId).toBe(fx.orgIds.shanghai);
    expect(single.resolution.find((r) => r.field === 'orgId')?.reason).toMatch(/名称片段/);
    expect(single.ambiguities).toHaveLength(0);

    // 再建两个「江垭」开头的组织 → 片段不唯一
    org.createOrg(db, { parentId: fx.orgIds.east, code: 'JYD', name: '江垭电站' });
    org.createOrg(db, { parentId: fx.orgIds.east, code: 'JYW', name: '江垭温泉' });
    const ambiguous = resolveMessageContext(db, '江垭今年收入完成得怎么样', {}, {}, { defaultVersion: true });
    expect(ambiguous.context.orgId).toBeUndefined();
    expect(ambiguous.ambiguities[0]).toMatchObject({ field: 'orgId', token: '江垭' });
    expect(ambiguous.ambiguities[0].candidates.map((c) => c.code).sort()).toEqual(['JYD', 'JYW']);

    const answer = await assistant.chat(db, { message: '江垭今年收入完成得怎么样', context: { year: 2026, budgetVersionId: version.id } });
    expect(answer.notices.some((n) => n.includes('江垭电站') && n.includes('江垭温泉'))).toBe(true);
    expect(answer.resolvedContext.orgId).toBeUndefined();
  });

  it('数量科目提问不再只讲金额而显示成 0.00', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const qRoot = account.createAccount(db, { parentId: null, code: 'Q', name: '数量指标', type: 'quantity', unit: '万度' }).id;
    const qLeaf = account.createAccount(db, { parentId: qRoot, code: 'Q101', name: '发电量', type: 'quantity', unit: '万度' }).id;
    const version = budget.createVersion(db, { year: 2026, name: 'V1' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
      { orgId: fx.orgIds.shanghai, accountId: qLeaf, quantity: '1000.5' },
    ]);
    budget.lockVersion(db, version.id);
    budget.setCurrentVersion(db, version.id);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40.00' },
        { orgId: fx.orgIds.shanghai, accountId: qLeaf, quantity: '600.25' },
      ],
    });
    const answer = await assistant.chat(db, { message: '2026 年发电量完成了多少', context: { year: 2026, budgetVersionId: version.id } });
    expect(answer.text).toMatch(/数量科目：发电量\(Q101\) 预算 1000\.50 \/ 实际 600\.25 万度/);
    expect(answer.text).toMatch(/完成率 60\.0%/);
  });

  it('「完成了多少」这类口语问法能命中执行分析', () => {
    expect(detectIntents('2026年发电量完成了多少').read).toContain('execution');
    expect(detectIntents('收入是多少').read).toContain('execution');
    expect(detectIntents('费用花了多少').read).toContain('execution');
  });

  it('追问名次时按名次输出，不再重复上一轮原文', async () => {
    const { db, version } = fixtureWithActual();
    expect(detectRankFocus('那第二名呢')).toBe(2);
    expect(detectRankFocus('第 3 位呢')).toBe(3);
    expect(detectRankFocus('下一个')).toBe(2);
    expect(detectRankFocus('你好')).toBeNull();

    const first = await assistant.chat(db, { message: '哪个组织亏得最多', context: { year: 2026, budgetVersionId: version.id } });
    expect(first.text).toMatch(/第 1 名/);
    const second = await assistant.chat(db, { conversationId: first.conversationId, message: '那第二名呢' });
    expect(second.intents.inheritedRead).toContain('attribution');
    expect(second.text).toMatch(/第 2 名/);
    expect(second.text).not.toBe(first.text);
  });
});

/* ------------------------------------------------------------------ *
 * P1-7 会话与洞察管理 / P2-9 限流与度量
 * ------------------------------------------------------------------ */

describe('AI 助手:会话与洞察管理、限流与度量', () => {
  it('会话可重命名与删除，洞察可删除，业务痕迹保留', async () => {
    const { db, version } = fixtureWithActual();
    const chat = await assistant.chat(db, { message: '2026 年执行完成情况如何', context: { year: 2026, budgetVersionId: version.id } });
    const renamed: any = assistant.renameConversation(db, chat.conversationId, '2026 执行复盘', 'tester');
    expect(renamed.title).toBe('2026 执行复盘');

    const insight = assistant.saveInsight(db, { conversationId: chat.conversationId, kind: 'execution', params: { versionId: version.id }, title: '执行洞察' }, 'tester');
    const removedInsight = assistant.deleteInsight(db, insight.id, 'tester');
    expect(removedInsight).toMatchObject({ id: insight.id, deleted: true });
    expect(() => assistant.insight(db, insight.id)).toThrow();

    const kept = assistant.saveInsight(db, { conversationId: chat.conversationId, kind: 'execution', params: { versionId: version.id }, title: '保留洞察' }, 'tester');
    const removed = assistant.deleteConversation(db, chat.conversationId, 'tester');
    expect(removed.deleted).toBe(true);
    expect(removed.messageCount).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM ai_message WHERE conversation_id=?').get(chat.conversationId)).toEqual({ n: 0 });
    // 洞察保留，只解绑会话
    const stillThere: any = assistant.insight(db, kept.id);
    expect(stillThere.id).toBe(kept.id);
    const actions = queryLogs(db, { action: 'ai.conversation.delete' });
    expect(actions.total).toBe(1);
  });

  it('每轮返回模型调用度量并写入 ai.chat 操作日志', async () => {
    const { db, version } = fixtureWithActual();
    const answer = await assistant.chat(db, { message: '2026 年执行完成情况如何', context: { year: 2026, budgetVersionId: version.id } }, 'tester');
    expect(answer.metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(answer.metrics.modelCalls).toBe(0);
    const logs = queryLogs(db, { action: 'ai.chat' });
    expect(logs.total).toBe(1);
    const detail = JSON.parse((logs.items[0] as any).detail_json);
    expect(detail).toMatchObject({ actor: 'tester', routing: 'rules', model: 'template' });
    expect(detail.factTypes).toContain('execution');
    expect(typeof detail.durationMs).toBe('number');
  });

  it('/api/assistant/chat 超过每分钟上限时返回 429', async () => {
    const { dbPath, db, dir } = tempFileDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx, 2026, 'V1');
    budget.lockVersion(db, version.id);
    budget.setCurrentVersion(db, version.id);
    db.close();
    const previous = process.env.AI_RATE_LIMIT_PER_MIN;
    process.env.AI_RATE_LIMIT_PER_MIN = '2';
    resetAssistantRateLimit();
    const { app, holder } = await createApp({ dbPath, auth: { username: '', password: '' } });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const post = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '列出预算版本' }),
      });
      return { status: response.status, body: await response.json() as any };
    };
    try {
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      const third = await post();
      expect(third.status).toBe(429);
      expect(third.body.code).toBe('AI_RATE_LIMITED');
      expect(third.body.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      server.close();
      holder.getDb().close();
      process.env.AI_RATE_LIMIT_PER_MIN = previous;
      resetAssistantRateLimit();
      try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
    }
  });

  it('会话重命名与删除、洞察删除都有 HTTP 入口', async () => {
    const { dbPath, db, dir } = tempFileDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx, 2026, 'V1');
    budget.lockVersion(db, version.id);
    budget.setCurrentVersion(db, version.id);
    db.close();
    resetAssistantRateLimit();
    const { app, holder } = await createApp({ dbPath, auth: { username: '', password: '' } });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as any };
    };
    try {
      const chat = await call('POST', '/api/assistant/chat', { message: '列出预算版本', context: { year: 2026 } });
      expect(chat.status).toBe(200);
      const conversationId = chat.body.conversationId;
      const renamed = await call('PATCH', `/api/assistant/conversations/${conversationId}`, { title: '版本盘点' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.title).toBe('版本盘点');
      const insight = await call('POST', '/api/assistant/insights', { conversationId, kind: 'execution', params: { versionId: version.id }, title: '执行洞察' });
      expect(insight.status).toBe(201);
      expect((await call('DELETE', `/api/assistant/insights/${insight.body.id}`)).body).toMatchObject({ deleted: true });
      expect((await call('DELETE', `/api/assistant/conversations/${conversationId}`)).body).toMatchObject({ deleted: true });
      expect((await call('GET', `/api/assistant/conversations/${conversationId}`)).status).toBe(404);
    } finally {
      server.close();
      holder.getDb().close();
      try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
    }
  });
});
