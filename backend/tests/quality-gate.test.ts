/**
 * AI 功能增强计划 §四.阶段一(确定性部分)验收:
 * - STRUCTURE_INVALID 结构化(row/orgId/accountId),message 含编码+名称而非裸 ID;
 * - canFinalize 判定与阻断逻辑不变;
 * - 质量报告带归并分组与静态帮助文案。
 */
import { describe, expect, it } from 'vitest';
import { testDb, buildFixture, standardBudgetVersion } from './helpers';
import * as budget from '../src/modules/budget/budget.service';
import { budgetQualityReport, BUDGET_QUALITY_HELP } from '../src/modules/check/budget-quality';

describe('定稿质量门禁:STRUCTURE_INVALID 结构化', () => {
describe('定稿质量门禁:STRUCTURE_INVALID 结构化', () => {
  it('结构问题携带行号与 orgId/accountId,消息含编码+名称', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    // 绕过服务层直接写一条「非叶子组织」明细
    db.prepare('INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(v.id, fx.orgIds.east, fx.accIds.incomeMain, 1000, new Date().toISOString());
    const check = budget.validateForLock(db, v.id);
    expect(check.ok).toBe(false);
    const problem = check.problems.find((p) => p.orgId === fx.orgIds.east);
    expect(problem).toBeDefined();
    expect(problem!.code).toBe('STRUCTURE_INVALID');
    expect(problem!.severity).toBe('blocking');
    expect(problem!.row).toBe(1);
    // 编码+名称,不是裸数字 ID
    expect(problem!.message).toContain('EAST');
    expect(problem!.message).toContain('华东大区');
    expect(problem!.message).toContain('不是叶子组织');
    expect(problem!.message).not.toContain(`组织 ${fx.orgIds.east} `);
    // 状态机不变:阻断仍在,定稿仍然失败
    expect(() => budget.lockVersion(db, v.id)).toThrow(/定稿前检查未通过/);
  });

  it('合法版本 validateForLock 无问题;质量报告归并与帮助文案齐全', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    expect(budget.validateForLock(db, v.id).ok).toBe(true);
    const report = budgetQualityReport(db, v.id);
    expect(report.canFinalize).toBe(true);
    expect(report.blockingCount).toBe(0);
    // 迁移内置的测算模板引用了夹具中不存在的科目,固定产生一条提醒级问题
    expect(report.issues.every((issue) => issue.severity === 'warning')).toBe(true);
    const ruleGroup = report.groups.find((group) => group.code === 'CALCULATION_RULE_INVALID');
    expect(ruleGroup?.severity).toBe('warning');
    expect(report.help.CALCULATION_RULE_INVALID?.fix).toBeTruthy();
  });

  it('必填科目缺失按组织归并,帮助文案按 code 可查', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 把主营业务收入设为必填,则三个叶子组织全部缺失
    db.prepare('UPDATE account SET budget_required = 1 WHERE id = ?').run(fx.accIds.incomeMain);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    ]);
    const report = budgetQualityReport(db, v.id);
    expect(report.canFinalize).toBe(false);
    const group = report.groups.find((g) => g.code === 'REQUIRED_VALUE_MISSING');
    expect(group).toBeDefined();
    expect(group!.orgCount).toBe(2);
    expect(group!.count).toBe(2);
    expect(group!.summary).toContain('2 家单位');
    expect(report.help.REQUIRED_VALUE_MISSING.why).toBeTruthy();
    // 每条问题携带组织与科目定位
    const issue = report.issues.find((i) => i.code === 'REQUIRED_VALUE_MISSING' && i.orgId === fx.orgIds.hangzhou);
    expect(issue).toBeDefined();
    expect(issue!.accountId).toBe(fx.accIds.incomeMain);
    expect(BUDGET_QUALITY_HELP[issue!.code].fix).toBeTruthy();
  });
});

});
