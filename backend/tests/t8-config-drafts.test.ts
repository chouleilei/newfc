import { centsToDecimalString } from '../src/core/decimal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDb, buildFixture, org, account, metric, budget } from './helpers';
import { normalizeDraftInput } from '../src/assistant/draft-context';
import { chat } from '../src/assistant/service';
import { parseAssistantPageContext } from '../src/assistant/page-context';
import { pageSnapshot } from './assistant-context';
import * as calculation from '../src/modules/calculation/calculation.service';
import * as templates from '../src/modules/io/cleaning/template.service';
import * as aliases from '../src/modules/io/cleaning/alias.service';
import type { DraftDescriptor } from '../src/contracts/assistant';
import type { PageId } from '../src/contracts/page-catalog';

function readonlyDraft(db: ReturnType<typeof testDb>, draft: DraftDescriptor, versionId?: number) {
  const before = db.prepare('SELECT total_changes() count').get();
  const result = normalizeDraftInput(db, draft, { versionId });
  expect(db.prepare('SELECT total_changes() count').get()).toEqual(before);
  return result;
}

describe('T-8.4 配置草稿与正式保存同源校验', () => {
  it('多跳循环在只读草稿和正式保存都拒绝，原公式保持不变', () => {
    const db = testDb(); const fx = buildFixture(db);
    const a = metric.createMetric(db, { code: 'DA', name: 'A', terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeRoot, coefficient: 1 }] });
    const b = metric.createMetric(db, { code: 'DB', name: 'B', terms: [{ sourceType: 'metric', sourceMetricId: a.id, coefficient: 1 }] });
    const c = metric.createMetric(db, { code: 'DC', name: 'C', terms: [{ sourceType: 'metric', sourceMetricId: b.id, coefficient: 1 }] });
    const changes = { terms: [{ sourceType: 'metric' as const, sourceMetricId: c.id, coefficient: 1 as const }] };
    const result = readonlyDraft(db, { kind: 'metric_formula', base: { id: a.id, updatedAt: a.updated_at, operation: 'update' }, changes });
    expect(result.issues.join()).toContain('循环');
    expect(() => metric.updateMetric(db, a.id, changes)).toThrow(/循环/);
    expect(metric.getMetric(db, a.id).terms).toEqual(a.terms);
    db.close();
  });

  it('比率分子分母、不可汇总数量、停用来源与方向字段受同源规则约束', () => {
    const db = testDb(); const fx = buildFixture(db);
    const quantity = account.createAccount(db, { parentId: null, code: 'DQ', name: '单价', type: 'quantity', unit: '元', quantityAgg: 'none' });
    for (const changes of [
      { code: 'DR', name: '比率', kind: 'ratio' as const, terms: [{ sourceType: 'account' as const, sourceAccountId: fx.accIds.incomeRoot, coefficient: 1 as const, role: 'numerator' as const }] },
      { code: 'DR', name: '比率', kind: 'ratio' as const, terms: [{ sourceType: 'account' as const, sourceAccountId: quantity.id, coefficient: 1 as const, role: 'numerator' as const }, { sourceType: 'account' as const, sourceAccountId: fx.accIds.incomeRoot, coefficient: 1 as const, role: 'denominator' as const }] },
    ]) {
      const result = readonlyDraft(db, { kind: 'metric_formula', base: { clientKey: 'ratio', operation: 'create' }, changes });
      expect(result.issues).not.toEqual([]);
      expect(() => metric.createMetric(db, changes)).toThrow(result.issues[0]);
    }
    account.setAccountStatus(db, quantity.id, 'inactive');
    expect(() => metric.createMetric(db, { code: 'DQ2', name: '失效来源', kind: 'ratio', direction: 'lower_better', terms: [{ sourceType: 'account', sourceAccountId: quantity.id, coefficient: 1, role: 'numerator' }, { sourceType: 'account', sourceAccountId: fx.accIds.incomeRoot, coefficient: 1, role: 'denominator' }] })).toThrow(/停用/);
    db.close();
  });

  it('只改名称不误报编码或公式缺失，完整依赖影响来自服务器', () => {
    const db = testDb(); const fx = buildFixture(db);
    const a = metric.createMetric(db, { code: 'DXA', name: 'A', terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeRoot, coefficient: 1 }] });
    const b = metric.createMetric(db, { code: 'DXB', name: 'B', terms: [{ sourceType: 'metric', sourceMetricId: a.id, coefficient: 1 }] });
    const result = readonlyDraft(db, { kind: 'metric_formula', base: { id: a.id, updatedAt: a.updated_at, operation: 'update' }, changes: { name: '新名称' } });
    expect(result.issues).toEqual([]); expect(result.analysis?.affectedIds).toEqual([a.id, b.id]);
    metric.updateMetric(db, a.id, { name: '新名称' });
    expect(metric.getMetric(db, a.id).name).toBe('新名称'); db.close();
  });

  it('组织与科目按具体操作校验，循环移动和不可变字段不能混入改名', () => {
    const db = testDb(); const fx = buildFixture(db);
    const organization = org.getOrg(db, fx.orgIds.root);
    const patch = readonlyDraft(db, { kind: 'org_form', base: { id: organization.id, updatedAt: organization.updated_at, operation: 'update' }, changes: { name: '组织新名称' } });
    expect(patch.issues).toEqual([]);
    const move = readonlyDraft(db, { kind: 'org_form', base: { id: organization.id, updatedAt: organization.updated_at, operation: 'move' }, changes: { parentId: fx.orgIds.shanghai } });
    expect(move.issues.join()).toContain('后代'); expect(() => org.moveOrg(db, organization.id, fx.orgIds.shanghai)).toThrow(/后代/);
    const acc = account.getAccount(db, fx.accIds.incomeRoot);
    const invalid = readonlyDraft(db, { kind: 'account_form', base: { id: acc.id, updatedAt: acc.updated_at, operation: 'update' }, changes: { code: 'REPLACE' } });
    expect(invalid.issues).not.toEqual([]); expect(invalid.analysis?.fieldIssues).toContainEqual(expect.objectContaining({ field: 'code' }));
    expect(() => account.updateAccount(db, acc.id, { code: 'REPLACE' } as never)).toThrow(/不允许/);
    expect(() => org.setOrgStatus(db, organization.id, 'deleted' as never)).toThrow(/状态|status/);
    db.close();
  });

  it('数量单位和指标引用限制一致；草稿基线过期拒绝', () => {
    const db = testDb(); buildFixture(db);
    const q = account.createAccount(db, { parentId: null, code: 'DQSUM', name: '数量', type: 'quantity', unit: '万度', quantityAgg: 'sum' });
    const r = metric.createMetric(db, { code: 'DQR', name: '数量比率', kind: 'ratio', terms: [{ sourceType: 'account', sourceAccountId: q.id, coefficient: 1, role: 'numerator' }, { sourceType: 'account', sourceAccountId: q.id, coefficient: 1, role: 'denominator' }] });
    expect(r).toBeTruthy();
    const result = readonlyDraft(db, { kind: 'account_form', base: { id: q.id, updatedAt: q.updated_at, operation: 'update' }, changes: { quantityAgg: 'none' } });
    expect(result.issues.join()).toContain('引用'); expect(() => account.updateAccount(db, q.id, { quantityAgg: 'none' })).toThrow(/引用/);
    expect(() => normalizeDraftInput(db, { kind: 'account_form', base: { id: q.id, updatedAt: 'old', operation: 'update' }, changes: { name: '新' } })).toThrow(/已被修改/);
    db.close();
  });

  it('测算草稿在指定版本上与正式规则同源试算，无版本明确不计算', () => {
    const db = testDb(); const fx = buildFixture(db);
    const left = account.createAccount(db, { parentId: null, code: 'DQL', name: '乘数一', type: 'quantity', unit: '量' });
    const right = account.createAccount(db, { parentId: null, code: 'DQR2', name: '乘数二', type: 'quantity', unit: '价' });
    const version = budget.createVersion(db, { year: 2026, name: '只读试算' });
    budget.saveEntries(db, version.id, [{ orgId: fx.orgIds.shanghai, accountId: left.id, quantity: '2' }, { orgId: fx.orgIds.shanghai, accountId: right.id, quantity: '3' }]);
    const input = { code: 'DMUL', name: '乘法', ruleType: 'multiply' as const, config: { leftAccountCode: left.code, rightAccountCode: right.code, outputAccountCode: 'I01' } };
    const draft: DraftDescriptor = { kind: 'calculation_rule', base: { clientKey: 'rule', operation: 'create' }, changes: input };
    expect(readonlyDraft(db, draft).analysis?.explanation.join()).toContain('未指定');
    const result = readonlyDraft(db, draft, version.id);
    expect(result.issues).toEqual([]);
    const saved = calculation.saveRule(db, input);
    expect(result.analysis?.preview?.items).toEqual(calculation.previewRule(db, version.id, saved.id).items.map(({ orgId, outputAccountId, amountCents }) => ({ orgId, outputAccountId, amount: centsToDecimalString(BigInt(amountCents)) })));
    const invalid = { ...input, code: 'DMUL_INVALID', config: { ...input.config, outputAccountCode: left.code } };
    expect(readonlyDraft(db, { ...draft, changes: invalid }).issues.join()).toContain('金额');
    expect(() => calculation.saveRule(db, invalid)).toThrow(/金额/);
    for (const defaultTaxRate of ['-100', '100.0001']) {
      const taxRule = { code: 'DTAX', name: '税率边界', ruleType: 'quantity_price_net_tax' as const, config: { quantityAccountCode: left.code, priceAccountCode: right.code, defaultTaxRate, outputAccountCode: 'I01' } };
      const checked = readonlyDraft(db, { ...draft, changes: taxRule });
      expect(checked.issues.join()).toContain('100%');
      expect(() => calculation.saveRule(db, taxRule)).toThrow(/100%/);
    }
    db.close();
  });

  it('模板部分更新、别名规范化冲突和目标有效性与正式保存一致', () => {
    const db = testDb(); buildFixture(db);
    const template = templates.createTemplate(db, { name: '模板', targetKind: 'budget', config: { headerRow: 1, dataStartRow: 2, columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount', amountUnit: 'yuan', signConvention: 'display_positive' } });
    expect(readonlyDraft(db, { kind: 'cleaning_template', base: { id: template.id, updatedAt: template.updated_at, operation: 'update' }, changes: { name: '新模板' } }).issues).toEqual([]);
    aliases.createAlias(db, { targetKind: 'budget', mappingKind: 'org', sourceText: '上海', targetCode: 'SH' });
    const duplicate = { targetKind: 'budget', mappingKind: 'org', sourceText: ' 上海 ', targetCode: 'SH' };
    const draft: DraftDescriptor = { kind: 'alias_rule', base: { clientKey: 'alias', operation: 'create' }, changes: duplicate };
    expect(readonlyDraft(db, draft).issues.join()).toContain('已存在'); expect(() => aliases.createAlias(db, duplicate)).toThrow(/已存在/);
    const unknown = { ...duplicate, sourceText: '其他', targetCode: 'UNKNOWN' };
    expect(readonlyDraft(db, { ...draft, changes: unknown }).issues.join()).toContain('目标'); expect(() => aliases.createAlias(db, unknown)).toThrow(/目标/); db.close();
  });

  it('字段白名单拒绝伪造说明，规则回答包含未保存和通过结论', async () => {
    const db = testDb(); buildFixture(db);
    const context = { ...pageSnapshot({ pageKey: 'metric' }), focus: { kind: 'form_field' as const, formKind: 'metric_formula', field: 'denominator' } };
    for (const field of ['secret', 'constructor', 'toString', '__proto__']) expect(() => parseAssistantPageContext({ ...context, focus: { kind: 'form_field', formKind: 'metric_formula', field } })).toThrow(/字段/);
    const result = await chat(db, { message: '解释当前字段', pageContext: context });
    expect(result.facts.some((f) => f.type === 'field_help')).toBe(true); expect(result.text).toContain('N/A');
    const draft: DraftDescriptor = { kind: 'metric_formula', base: { clientKey: 'new', operation: 'create' }, changes: { code: 'DOK', name: '新指标', terms: [{ sourceType: 'account', sourceAccountId: 1, coefficient: 1 }] } };
    const answer = await chat(db, { message: '检查当前修改', pageContext: { ...pageSnapshot({ pageKey: 'metric' }), draft } });
    expect(answer.text).toContain('未保存'); expect(answer.facts.find((f) => f.type === 'draft_validation')).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM report_metric WHERE code='DOK'").get()).toBeUndefined(); db.close();
  });
});

it('配置草稿的全组织授权先于目标和依赖读取', async () => {
  const { runWithContext } = await import('../src/core/request-context');
  const db = testDb(); const fx = buildFixture(db);
  try {
    const request = { message: '检查修改', pageContext: { ...pageSnapshot({ pageKey: 'org' }), draft: { kind: 'org_form', base: { id: fx.orgIds.root, updatedAt: 'guess', operation: 'update' }, changes: { name: '猜测对象' } } } };
    await expect(runWithContext({ requestId: 't8-scope', source: 'assistant', auth: { userId: 99, username: 'limited', displayName: '受限', permissions: new Set(['master:read']), allOrgs: false, orgRootIds: [fx.orgIds.shanghai] } }, () => chat(db, request))).rejects.toMatchObject({ code: 'SCOPE_RESTRICTED' });
    expect(db.prepare('SELECT COUNT(*) count FROM ai_message').get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

describe('T-8.4 六类草稿的模型与降级回答', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  for (const failure of [false, true]) {
    it(failure ? '受控上游失败仍保留六类校验与字段事实' : '受控模型及 onToken 包含六类校验与字段事实，原始表单不出网', async () => {
      const db = testDb(); const fx = buildFixture(db);
      const before = db.prepare('SELECT COUNT(*) count FROM tree_snapshot').get();
      const q = account.createAccount(db, { parentId: null, code: 'MODELQ', name: '数量', type: 'quantity', unit: '件' });
      const secret = 'PRIVATE_UNSAVED_FORM_VALUE';
      const entries = [
        { page: 'org', kind: 'org_form', changes: { code: 'MODELNEW', name: secret, parentId: null }, field: 'name' },
        { page: 'account', kind: 'account_form', changes: { code: 'MODELNEW', name: secret, parentId: null, type: 'quantity', unit: '件' }, field: 'unit' },
        { page: 'metric', kind: 'metric_formula', changes: { code: 'MODELNEW', name: secret, terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1 }] }, field: 'terms' },
        { page: 'calculations', kind: 'calculation_rule', changes: { code: 'MODELNEW', name: secret, ruleType: 'multiply', config: { leftAccountCode: q.code, rightAccountCode: q.code, outputAccountCode: 'I01' } }, field: 'config' },
        { page: 'cleaning_config', kind: 'cleaning_template', changes: { name: secret, targetKind: 'budget', config: { headerRow: 1, dataStartRow: 2, columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount', amountUnit: 'yuan', signConvention: 'display_positive' } }, field: 'headerRow' },
        { page: 'cleaning_config', kind: 'alias_rule', changes: { targetKind: 'budget', mappingKind: 'org', sourceText: secret, targetCode: 'SH' }, field: 'sourceText' },
      ];
      vi.stubEnv('AI_BASE_URL', 'http://model.test/v1'); vi.stubEnv('AI_API_KEY', 'synthetic'); vi.stubEnv('AI_STREAM', 'false');
      const bodies: unknown[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        if (failure) throw new Error('synthetic upstream failure');
        return { ok: true, json: async () => ({ choices: [{ message: { content: '请根据已核验的配置说明检查当前修改。' } }] }) };
      }));
      try {
        for (const entry of entries) {
          const chunks: string[] = [];
          const answer = await chat(db, { message: '解释当前修改和字段约束', pageContext: { ...pageSnapshot({ pageKey: entry.page as PageId }), draft: { kind: entry.kind, base: { operation: 'create', clientKey: 'model-new' }, changes: entry.changes }, focus: { kind: 'form_field', formKind: entry.kind, field: entry.field } } }, 'synthetic', { onToken: (chunk) => chunks.push(chunk) });
          expect(answer.routing).toBe(failure ? 'rules' : 'model');
          expect(answer.facts.find((f) => f.type === 'draft_validation')?.data).toMatchObject({ kind: entry.kind, unsaved: true, issues: [] });
          expect(answer.facts.find((f) => f.type === 'field_help')).toBeTruthy();
          expect(answer.text).toContain('尚未保存'); expect(chunks.join('')).toContain('尚未保存');
        }
        expect(bodies.length).toBeGreaterThanOrEqual(6);
        expect(JSON.stringify(bodies)).toContain('draft_validation');
        expect(JSON.stringify(bodies)).not.toContain(secret);
        expect(db.prepare('SELECT COUNT(*) count FROM tree_snapshot').get()).toEqual(before);
        expect(db.prepare("SELECT 1 FROM org WHERE code='MODELNEW'").get()).toBeUndefined();
        expect(db.prepare("SELECT 1 FROM report_metric WHERE code='MODELNEW'").get()).toBeUndefined();
      } finally { db.close(); }
    });
  }
});
