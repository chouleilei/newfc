import { describe, expect, it } from 'vitest';
import { account, actual, budget, buildFixture, org, standardBudgetVersion, testDb } from './helpers';
import { budgetQualityReport } from '../src/modules/check/budget-quality';
import { listRules, previewRule, saveRule } from '../src/modules/calculation/calculation.service';
import * as imports from '../src/modules/import/import.service';
import { budgetCellEvidence, actualCellEvidence } from '../src/modules/evidence/evidence.service';

describe('轻量测算与定稿体检', () => {
  it('量价税模板在后端按缩放整数精确试算，并返回可解释输入', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const q101 = account.createAccount(db, { parentId: null, code: 'Q101', name: '上网电量', type: 'quantity', unit: '万度' }).id;
    const q2 = account.createAccount(db, { parentId: null, code: 'Q2', name: '含税电价', type: 'quantity', unit: '元/度', quantityAgg: 'none' }).id;
    const q3 = account.createAccount(db, { parentId: null, code: 'Q3', name: '税率', type: 'quantity', unit: '%', quantityAgg: 'none' }).id;
    const output = account.createAccount(db, { parentId: null, code: 'I1101', name: '上网电量收入', type: 'income' }).id;
    const version = budget.createVersion(db, { year: 2026, name: '测算稿' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: q101, quantity: '100' },
      { orgId: fx.orgIds.shanghai, accountId: q2, quantity: '0.3' },
      { orgId: fx.orgIds.shanghai, accountId: q3, quantity: '13' },
    ]);
    const rule = listRules(db).find((item) => item.code === 'POWER_GRID_REVENUE')!;
    const preview = previewRule(db, version.id, rule.id);
    const item = preview.items.find((row) => row.orgId === fx.orgIds.shanghai)!;
    expect(item.outputAccountId).toBe(output);
    expect(item.displayAmountCents).toBe(26_548_673);
    expect(item.inputs.map((input) => input.accountCode)).toEqual(['Q101', 'Q2', 'Q3']);
  });

  it('测算依据穿透按科目类型判别数量与金额输入,直接构成带单位', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const q101 = account.createAccount(db, { parentId: null, code: 'Q101', name: '上网电量', type: 'quantity', unit: '万度' }).id;
    account.createAccount(db, { parentId: null, code: 'Q2', name: '含税电价', type: 'quantity', unit: '元/度', quantityAgg: 'none' });
    account.createAccount(db, { parentId: null, code: 'Q3', name: '税率', type: 'quantity', unit: '%', quantityAgg: 'none' });
    const output = account.createAccount(db, { parentId: null, code: 'I1101', name: '上网电量收入', type: 'income' }).id;
    // 版本绑定创建时刻的科目树快照,穿透用的新增科目必须先于 createVersion
    const qParent = account.createAccount(db, { parentId: null, code: 'QP', name: '数量汇总', type: 'quantity', unit: '万度' }).id;
    const qChild = account.createAccount(db, { parentId: qParent, code: 'QP01', name: '子电量', type: 'quantity', unit: '度' }).id;
    const version = budget.createVersion(db, { year: 2026, name: '测算稿' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: q101, quantity: '100' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
      { orgId: fx.orgIds.shanghai, accountId: output, amount: '1000.00' },
      { orgId: fx.orgIds.shanghai, accountId: qChild, quantity: '5' },
    ]);
    // 混合输入规则:数量 + 金额各一项,验证 valueKind 判别不再混用 quantity ?? amount_cents
    saveRule(db, {
      code: 'MIXED_INPUTS',
      name: '混合输入规则',
      ruleType: 'multiply',
      config: { leftAccountCode: 'Q101', rightAccountCode: 'I01', outputAccountCode: 'I1101' },
    });
    const evidence = budgetCellEvidence(db, version.id, output, fx.orgIds.shanghai);
    const quantityRule = evidence.calculationSources.find((s) => s.ruleName === '上网电费测算')!;
    const quantityInput = quantityRule.inputs.find((input) => input.code === 'Q101')!;
    expect(quantityInput).toMatchObject({ valueKind: 'quantity', value: 1_000_000, unit: '万度', accountType: 'quantity' });
    // 未填写的数量输入:value 为 null,但判别与单位仍如实返回
    expect(quantityRule.inputs.find((input) => input.code === 'Q2')).toMatchObject({ valueKind: 'quantity', value: null, unit: '元/度' });
    const mixedRule = evidence.calculationSources.find((s) => s.ruleName === '混合输入规则')!;
    expect(mixedRule.inputs.find((input) => input.code === 'I01')).toMatchObject({ valueKind: 'amount', value: 10_000, accountType: 'income', unit: null });
    expect(mixedRule.inputs.find((input) => input.code === 'Q101')).toMatchObject({ valueKind: 'quantity', value: 1_000_000 });
    // 直接构成的数量子科目带自身单位(不再依赖前端冒用父科目单位)
    const parentEvidence = budgetCellEvidence(db, version.id, qParent, fx.orgIds.shanghai);
    expect(parentEvidence.directComponents[0]).toMatchObject({ code: 'QP01', unit: '度', quantity: 50_000 });
  });

  it('测算预览跳过输出科目不适用的组织', () => {
    const db = testDb();
    const hydro = org.createOrg(db, { parentId: null, code: '010102', name: '江垭电站' }).id;
    const hotSpring = org.createOrg(db, { parentId: null, code: '010603', name: '江垭温泉' }).id;
    const factorA = account.createAccount(db, { parentId: null, code: 'FACTOR_A', name: '通用乘数一', type: 'quantity', unit: '个' }).id;
    const factorB = account.createAccount(db, { parentId: null, code: 'FACTOR_B', name: '通用乘数二', type: 'quantity', unit: '元/个', quantityAgg: 'none' }).id;
    account.createAccount(db, { parentId: null, code: 'I1101', name: '上网电量收入', type: 'income' });
    const version = budget.createVersion(db, { year: 2026, name: '范围测算稿' });
    budget.saveEntries(db, version.id, [
      ...[hydro, hotSpring].flatMap((orgId) => [
        { orgId, accountId: factorA, quantity: '100' },
        { orgId, accountId: factorB, quantity: '0.3' },
      ]),
    ]);
    const rule = saveRule(db, {
      code: 'SCOPE_TEST',
      name: '适用范围测试',
      ruleType: 'multiply',
      config: { leftAccountCode: 'FACTOR_A', rightAccountCode: 'FACTOR_B', outputAccountCode: 'I1101' },
    });
    const preview = previewRule(db, version.id, rule.id);
    expect(preview.items.some((item) => item.orgId === hydro)).toBe(true);
    expect(preview.items.some((item) => item.orgId === hotSpring)).toBe(false);
    expect(preview.skipped).toContainEqual({ orgId: hotSpring, reason: '输出科目 I1101 不适用于该组织' });
  });

  it('科目必填和依据要求随版本树快照固化，并阻止不完整草稿定稿', () => {
    const db = testDb();
    const fx = buildFixture(db);
    account.updateAccount(db, fx.accIds.incomeMain, { budgetRequired: true, basisRequired: true });
    const version = budget.createVersion(db, { year: 2026, name: '质量稿' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    ]);
    const report = budgetQualityReport(db, version.id);
    expect(report.canFinalize).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'BASIS_MISSING' && issue.orgId === fx.orgIds.shanghai)).toBe(true);
    expect(report.issues.some((issue) => issue.code === 'REQUIRED_VALUE_MISSING' && issue.orgId === fx.orgIds.hangzhou)).toBe(true);
    expect(() => budget.lockVersion(db, version.id)).toThrow(/定稿前检查未通过/);
  });

  it('非末级科目不能启用质量要求', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() => account.updateAccount(db, fx.accIds.incomeRoot, { budgetRequired: true })).toThrow(/只有末级科目/);
    expect(() => account.updateAccount(db, fx.accIds.costMain, { basisRequired: true })).toThrow(/只有末级科目/);
  });
});

describe('预算、预测与初稿生成', () => {
  it('同年度当前预算和当前预测相互独立', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const annual = standardBudgetVersion(fx, 2026, '年度预算');
    budget.lockVersion(db, annual.id);
    budget.setCurrentVersion(db, annual.id);
    const forecast = budget.createVersion(db, { year: 2026, name: '全年预测', kind: 'forecast' });
    budget.saveEntries(db, forecast.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }]);
    budget.lockVersion(db, forecast.id);
    budget.setCurrentVersion(db, forecast.id);
    expect(budget.getVersion(db, annual.id).is_current).toBe(1);
    expect(budget.getVersion(db, forecast.id).is_current).toBe(1);
    expect(budget.getVersion(db, forecast.id).kind).toBe('forecast');
  });

  it('生成前给出来源和变化预览，缺少来源时不创建空壳草稿', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const source = standardBudgetVersion(fx, 2025, '2025 生效版');
    budget.lockVersion(db, source.id);
    budget.setCurrentVersion(db, source.id);
    const preview = budget.previewVersionGeneration(db, { year: 2026, name: '2026 初稿', baseFrom: 'budget', growthRate: '0.05' });
    expect(preview.sourceId).toBe(source.id);
    expect(preview.generatedCount).toBe(6);
    const generated = budget.createVersion(db, { year: 2026, name: '2026 初稿', baseFrom: 'budget', growthRate: '0.05' });
    const income = db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id = ? AND org_id = ? AND account_id = ?').get(generated.id, fx.orgIds.shanghai, fx.accIds.incomeMain) as { amount_cents: number };
    expect(income.amount_cents).toBe(10_500);
    expect(() => budget.createVersion(db, { year: 2028, name: '空壳', baseFrom: 'actual', baseYear: 2027 })).toThrow(/没有可用于生成初稿/);
  });
});

describe('导入批次、来源和安全撤销', () => {
  it('预算导入只覆盖命中单元格，保留其他草稿数据，并可在无后续修改时撤销', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    const row = imports.createBatch(db, {
      kind: 'budget', targetVersionId: version.id, originalName: 'budget.xlsx', file: Buffer.from('xlsx-budget'),
      payload: { versionId: version.id, entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '200.00' }] },
      summary: { count: 1 },
    });
    imports.commitBatch(db, row.id);
    expect((db.prepare('SELECT COUNT(*) c FROM budget_entry WHERE version_id = ?').get(version.id) as { c: number }).c).toBe(6);
    expect((db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id = ? AND org_id = ? AND account_id = ?').get(version.id, fx.orgIds.shanghai, fx.accIds.incomeMain) as { amount_cents: number }).amount_cents).toBe(20_000);
    const evidence = budgetCellEvidence(db, version.id, fx.accIds.incomeMain, fx.orgIds.shanghai);
    expect(evidence.importSources[0]?.id).toBe(row.id);
    imports.rollbackBatch(db, row.id);
    expect((db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id = ? AND org_id = ? AND account_id = ?').get(version.id, fx.orgIds.shanghai, fx.accIds.incomeMain) as { amount_cents: number }).amount_cents).toBe(10_000);
  });

  it('实际数导入批次关联快照，撤销生成新修订而不改写历史批次', () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, { year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'upsert', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }] });
    const row = imports.createBatch(db, {
      kind: 'actual', originalName: 'actual.xlsx', file: Buffer.from('xlsx-actual'),
      payload: { history: false, note: 'Excel 导入', batches: [{ year: 2026, snapshotDate: '2026-09-30', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '20.00' }] }] },
      summary: { count: 1 },
    });
    const committed = imports.commitBatch(db, row.id);
    const result = JSON.parse(committed.result_json) as { results: { batchId: number }[] };
    const evidence = actualCellEvidence(db, result.results[0].batchId, fx.accIds.incomeMain, fx.orgIds.shanghai);
    expect(evidence.importSource).toMatchObject({ id: row.id, original_name: 'actual.xlsx' });
    imports.rollbackBatch(db, row.id);
    expect((db.prepare('SELECT cumulative_amount_cents FROM actual_current WHERE year = 2026 AND org_id = ? AND account_id = ?').get(fx.orgIds.shanghai, fx.accIds.incomeMain) as { cumulative_amount_cents: number }).cumulative_amount_cents).toBe(1_000);
    expect((db.prepare('SELECT status FROM actual_snapshot_batch WHERE id = ?').get(result.results[0].batchId) as { status: string }).status).toBe('superseded');
  });
});
