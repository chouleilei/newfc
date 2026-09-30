import { describe, expect, it } from 'vitest';
import fixture from './fixtures/investment_feasibility_yichongqiao.json';
import reference from './fixtures/feasibility-reference.json';
import { feasibilityAssumptions, type FeasibilityAssumptions } from '../src/contracts/investment-feasibility';
import { applySensitivity, calculateFeasibility, feasibilityRiskHits, irr, npvExact } from '../src/modules/investment/feasibility-calc';
import { fx, toFixed, div, quantize } from '../src/core/fixed';

const project = { construction_start_year: fixture.project.construction_start_year, operation_start_year: fixture.project.operation_start_year };
const base = (): FeasibilityAssumptions => feasibilityAssumptions.parse(structuredClone(fixture.assumptions));
const variant = (mutate: (a: any) => void) => { const raw = structuredClone(fixture.assumptions) as any; mutate(raw); return feasibilityAssumptions.parse(raw); };
const num = (v: unknown) => (v == null ? null : toFixed(fx(String(v)), 6));

/** 与独立 Python Decimal 参照实现逐字段比对(数值相等,字符串位数不同不影响)。 */
function expectMatchesReference(caseName: string, out: ReturnType<typeof calculateFeasibility>) {
  const ref = (reference as any).cases[caseName];
  expect(out.result.cashflows.length).toBe(ref.cashflows.length);
  out.result.cashflows.forEach((row, i) => {
    const r = ref.cashflows[i];
    for (const [k, v] of Object.entries(row)) {
      if (k === 'evidence') {
        expect(num((v as any).ebit), `${caseName} ${row.fiscal_year} ebit`).toBe(num(r.evidence.ebit));
        continue;
      }
      if (k === 'year_index' || k === 'fiscal_year') { expect(v).toBe(r[k]); continue; }
      expect(num(v), `${caseName} ${row.fiscal_year} ${k}`).toBe(num(r[k]));
    }
  });
  for (const ind of out.result.indicators) {
    const r = ref.indicators[ind.code];
    expect(num(ind.value), `${caseName} ${ind.code}`).toBe(num(r.value));
    expect(ind.status, `${caseName} ${ind.code} status`).toBe(r.status);
  }
  const checks = Object.fromEntries(out.result.checks.map((c) => [c.code, c.passed]));
  expect(checks).toEqual(ref.checks);
}

describe('T-5 可行性标准模型 standard-1.0(AC-F12)', () => {
  it('宜冲桥样本 2028 年税费拆分与留抵滚动(确认基准)', () => {
    const out = calculateFeasibility(project, base());
    const r = out.result.cashflows.find((c) => c.fiscal_year === 2028)!;
    expect(r.revenue).toBe('2100.000000');
    expect(r.revenue_excluding_vat).toBe('1934.862385');
    expect(r.output_vat).toBe('165.137615');
    expect(r.vat_credit_opening).toBe('500.000000');
    expect(r.vat_paid).toBe('0.000000');
    expect(r.vat_credit_closing).toBe('352.862385');
    expect(r.water_resource_tax).toBe('5.000000');
    expect(r.water_construction_fund).toBe('9.674312');
    expect(out.result.allChecksPassed).toBe(true);
    expect(out.result.modelVersion).toBe('standard-1.0');
    const irrInd = out.result.indicators.find((i) => i.code === 'project_irr')!;
    expect(irrInd.evidence?.calculation_status).toBe('success');
    expect(out.result.indicators.find((i) => i.code === 'project_npv')!.value).not.toBe(out.result.indicators.find((i) => i.code === 'equity_npv')!.value);
  });

  it('全部逐年字段与指标和 Python Decimal 参照实现一致', () => {
    expectMatchesReference('base', calculateFeasibility(project, base()));
    for (const m of ['equal_payment', 'bullet']) expectMatchesReference(m, calculateFeasibility(project, variant((a) => { a.financing.repayment_method = m; })));
    expectMatchesReference('manual_plan', calculateFeasibility(project, variant((a) => {
      a.financing.plan = [
        { fiscal_year: 2026, debt_drawdown: '3000', equity_contribution: '2000', capitalized_interest: '60' },
        { fiscal_year: 2027, debt_drawdown: '3000', equity_contribution: '2000', capitalized_interest: '182.4' },
      ];
    })));
    expectMatchesReference('no_debt', calculateFeasibility(project, variant((a) => { a.financing.debt_ratio = '0'; })));
    expectMatchesReference('benchmark_099', calculateFeasibility(project, variant((a) => { a.evaluation.benchmark_irr = '0.99'; })));
    expectMatchesReference('mixed', calculateFeasibility(project, variant((a) => {
      a.cost_items.push({ name: '含税材料', mode: 'fixed_amount', start_year: 2029, end_year: 2040, annual_amount: '88.8', growth_rate: '0.02', amount_tax_mode: 'tax_inclusive', input_vat_rate: '0.13' });
      a.revenue_items.push({ name: '供水收入', mode: 'fixed_amount', start_year: 2030, annual_amount: '321.123456', price_tax_mode: 'tax_exclusive', growth_rate: '0.015', taxable_for_vat: true });
      a.tax.annual_input_vat = [{ fiscal_year: 2028, input_vat: '12.5' }];
      a.depreciation.depreciable_base = '9000';
    })));
  });

  it('亏损结转分口径且逐年消耗', () => {
    const out = calculateFeasibility(project, variant((a) => {
      a.tax.opening_input_vat_credit = '0';
      a.revenue_items = [{ name: '收入', mode: 'fixed_amount', start_year: 2028, annual_amount: '1000', price_tax_mode: 'tax_exclusive', growth_rate: '0', taxable_for_vat: false }];
      a.cost_items = [{ name: '分年成本', mode: 'yearly_amount', start_year: 2028, amount_tax_mode: 'tax_exclusive', input_vat_rate: '0', growth_rate: '0',
        yearly_amounts: [{ fiscal_year: 2028, amount: '1800' }, { fiscal_year: 2029, amount: '1500' }] }];
    }));
    expectMatchesReference('loss_carry', out);
    const rows = Object.fromEntries(out.result.cashflows.map((r) => [r.fiscal_year, r]));
    expect(Number(rows[2028].project_loss_balance)).toBeGreaterThan(0);
    expect(rows[2030].project_income_tax).toBe('0.000000');
    expect(Number(rows[2030].project_loss_balance)).toBeLessThan(Number(rows[2029].project_loss_balance));
  });

  it.each(['equal_principal', 'equal_payment', 'bullet'])('还款方式 %s:期末债务清零,建设期无 DSCR', (m) => {
    const out = calculateFeasibility(project, variant((a) => { a.financing.repayment_method = m; }));
    const cf = out.result.cashflows;
    expect(cf[cf.length - 1].debt_balance).toBe('0.000000');
    expect(cf.filter((r) => (r.fiscal_year as number) < 2028).every((r) => r.dscr === null)).toBe(true);
    expect(cf.every((r) => r.dscr === null || Number(r.debt_principal) + Number(r.debt_interest) > 0)).toBe(true);
  });

  it('首年折现下标为 1;延期降低 NPV;IRR 求解状态与基准达标分离', () => {
    const out = calculateFeasibility(project, base());
    const first = out.result.cashflows[0];
    expect(first.project_discounted_cashflow).toBe(toFixed(quantize(div(fx(first.project_net_cashflow as string), fx('1.08')), 6), 6));
    const npv = (o: ReturnType<typeof calculateFeasibility>) => Number(o.values.project_npv) ;
    for (const d of [1, 2, 3]) {
      const p = { ...project };
      const a = base();
      applySensitivity(p, a, 'construction_delay', String(d), 'year_delta');
      const delayed = calculateFeasibility(p, a, { discountBaseYear: project.construction_start_year });
      expectMatchesReference(`delay_${d}`, delayed);
      expect(npv(delayed)).toBeLessThan(npv(out));
    }
    const high = calculateFeasibility(project, variant((a) => { a.evaluation.benchmark_irr = '0.99'; }));
    const irrInd = high.result.indicators.find((i) => i.code === 'project_irr')!;
    expect(irrInd.evidence).toMatchObject({ calculation_status: 'success', benchmark_met: false });
    expect(irrInd.status).toBe('warning');
    expect(feasibilityRiskHits(high.result).map((h) => h.code)).toContain('FEAS_IRR_LOW');
  });

  it('无债务与有债务的项目现金流差额恰为所得税差额(融资只经税盾影响项目口径)', () => {
    const noDebt = calculateFeasibility(project, variant((a) => { a.financing.debt_ratio = '0'; })).result.cashflows;
    const withDebt = calculateFeasibility(project, base()).result.cashflows;
    noDebt.forEach((r, i) => {
      const w = withDebt[i];
      expect(fx(r.project_net_cashflow as string) - fx(w.project_net_cashflow as string)).toBe(fx(w.project_income_tax as string) - fx(r.project_income_tax as string));
    });
  });

  it('人工融资计划的资本化利息与资金平衡检查;缺年份时检查失败并产生模型风险', () => {
    const ok = calculateFeasibility(project, variant((a) => {
      a.financing.plan = [
        { fiscal_year: 2026, debt_drawdown: '3000', equity_contribution: '2000', capitalized_interest: '60' },
        { fiscal_year: 2027, debt_drawdown: '3000', equity_contribution: '2000', capitalized_interest: '182.4' },
      ];
    }));
    const checks = Object.fromEntries(ok.result.checks.map((c) => [c.code, c.passed]));
    expect(checks).toMatchObject({ capitalized_interest_2026: true, capitalized_interest_2027: true, funding_balance_2026: true, debt_closing_balance: true });
    const partial = calculateFeasibility(project, variant((a) => {
      a.financing.plan = [{ fiscal_year: 2026, debt_drawdown: '3000', equity_contribution: '2000', capitalized_interest: '60' }];
    }));
    expect(partial.result.allChecksPassed).toBe(false);
    expect(feasibilityRiskHits(partial.result).some((h) => h.code === 'FEAS_MODEL_CHECK' && h.sub === 'financing_plan_complete')).toBe(true);
  });

  it('契约:旧 schema、越界比率、超精度、发电收入缺字段被拒;敏感性变动保持契约精度', () => {
    expect(feasibilityAssumptions.safeParse({ ...fixture.assumptions, schema_version: '5.2.2' }).success).toBe(false);
    expect(feasibilityAssumptions.safeParse({ ...fixture.assumptions, tax: { ...fixture.assumptions.tax, vat_rate: '1.5' } }).success).toBe(false);
    expect(feasibilityAssumptions.safeParse({ ...fixture.assumptions, tax: { ...fixture.assumptions.tax, opening_input_vat_credit: '1.0000001' } }).success).toBe(false);
    expect(feasibilityAssumptions.safeParse({ ...fixture.assumptions, revenue_items: [{ name: 'x', mode: 'power', start_year: 2028, power_generation_10k_kwh: '1' }] }).success).toBe(false);
    expect(feasibilityAssumptions.safeParse({ ...fixture.assumptions, tax: { ...fixture.assumptions.tax, vat_rate: '1e-2' } }).success).toBe(false);
    for (const [code, mode, change] of [['electricity_price', 'relative', '0.1'], ['power_generation', 'relative', '-0.1'], ['operating_cost', 'relative', '0.1'],
      ['construction_investment', 'relative', '0.1'], ['loan_interest_rate', 'percentage_point', '0.01'], ['opening_input_vat_credit', 'relative', '0.1']] as const) {
      const a = base();
      const before = JSON.stringify(a);
      applySensitivity({ ...project }, a, code, change, mode);
      expect(JSON.stringify(a)).not.toBe(before);
      expect(feasibilityAssumptions.safeParse(a).success).toBe(true);
    }
  });

  it('IRR:无正负转换为 no_solution;精确 NPV 在利率接近 -1 时不下溢', () => {
    expect(irr([fx('100'), fx('50')]).status).toBe('no_solution');
    const r = irr([fx('-100'), fx('110')]);
    expect(r).toEqual({ value: fx('0.1'), status: 'success' });
    expect(npvExact(Array.from({ length: 60 }, (_, i) => fx(i === 0 ? '-1' : '1')), fx('-0.999')) > 0n).toBe(true);
  });
});
