/**
 * 投资可行性标准模型 standard-1.0 计算器(T-5,AC-F12)。
 *
 * 口径为 standard-1.0，来源记录见 docs/source-provenance.md，
 * 见 specs/implementation.md「投资可行性测算」。金额单位万元;每个中间结果按 6 位小数 HALF_UP
 * 量化(money),与 Python Decimal quantize 一致。数值全程为 bigint 定点(core/fixed),不经过浮点。
 * 纯函数:不读库、不写库;调用方负责校验输入(contracts/investment-feasibility)与持久化。
 */
import {
  type Fx, FX_ONE, FX_ZERO, abs, add, div, divRound, fx, fxInt, max as fxMax, min as fxMin, mul, powInt, quantize, sign, toFixed,
} from '../../core/fixed';
import { INVESTMENT_FIELDS, type FeasibilityAssumptions, type FeasCheckDto, type FeasIndicatorDto, type FeasResultDto, type SensitivityCode } from '../../contracts/investment-feasibility';
import { canonicalHash } from '../../core/canonical';

export const MODEL_VERSION = 'standard-1.0' as const;
export const ROUNDING_RULE = 'ROUND_HALF_UP, 6 decimal places';

export interface FeasProjectYears {
  construction_start_year: number;
  operation_start_year: number;
}

export class FeasCalcError extends Error {}

const money = (v: Fx): Fx => quantize(v, 6);
const M = (v: Fx): string => toFixed(v, 6);
const D = (s: string | null | undefined): Fx => (s == null ? FX_ZERO : fx(s));
const TWO = fxInt(2);
const CENT_TOLERANCE = fx('0.01');

function check(code: string, passed: boolean, message: string, evidence: Record<string, unknown>): FeasCheckDto {
  return { code, passed, severity: passed ? 'info' : 'error', message, evidence };
}

export function investmentTotal(item: FeasibilityAssumptions['investment_plan'][number]): Fx {
  return money(add(...INVESTMENT_FIELDS.map((f) => D(item[f]))));
}

interface DebtRow { drawdown: Fx; equity: Fx; capitalized_interest: Fx; principal: Fx; interest: Fx; balance: Fx }

function debtRow(drawdown: Fx, equity: Fx, capitalized: Fx, principal: Fx, interest: Fx, balance: Fx): DebtRow {
  return { drawdown: money(drawdown), equity: money(equity), capitalized_interest: money(capitalized), principal: money(principal), interest: money(interest), balance: money(balance) };
}

export function buildFinancingSchedule(a: FeasibilityAssumptions, years: number[], operationYear: number): { schedule: Map<number, DebtRow>; checks: FeasCheckDto[] } {
  const investment = new Map(a.investment_plan.map((i) => [i.fiscal_year, investmentTotal(i)]));
  const f = a.financing;
  const rate = D(f.loan_interest_rate);
  const manual = new Map(f.plan.map((p) => [p.fiscal_year, p]));
  const constructionYears = years.filter((y) => y < operationYear);
  const checks: FeasCheckDto[] = [];

  if (manual.size) {
    const cy = new Set(constructionYears);
    const missing = constructionYears.filter((y) => !manual.has(y)).sort((x, y) => x - y);
    const extra = [...manual.keys()].filter((y) => !cy.has(y)).sort((x, y) => x - y);
    checks.push(check('financing_plan_complete', !missing.length && !extra.length, '人工融资计划覆盖全部且仅覆盖建设年份', { missing_years: missing, extra_years: extra }));
  } else {
    checks.push(check('financing_plan_complete', true, '融资表为空，系统按投资计划自动生成', {}));
  }

  const schedule = new Map<number, DebtRow>();
  let balance = FX_ZERO;
  for (const year of constructionYears) {
    const yearly = investment.get(year) ?? FX_ZERO;
    let drawdown: Fx; let equity: Fx; let capitalized: Fx;
    const row = manual.get(year);
    if (manual.size && row) {
      drawdown = D(row.debt_drawdown); equity = D(row.equity_contribution); capitalized = D(row.capitalized_interest);
    } else if (manual.size) {
      drawdown = equity = capitalized = FX_ZERO;
    } else {
      drawdown = money(mul(yearly, D(f.debt_ratio)));
      equity = money(yearly - drawdown);
      capitalized = money(mul(balance + div(drawdown, TWO), rate));
    }
    const expected = money(mul(balance + div(drawdown, TWO), rate));
    const fundingDiff = money(equity + drawdown - yearly);
    checks.push(check(`funding_balance_${year}`, abs(fundingDiff) <= CENT_TOLERANCE, `${year} 年投资与资金来源平衡`, { difference: M(fundingDiff) }));
    if (manual.size) {
      const diff = money(capitalized - expected);
      checks.push(check(`capitalized_interest_${year}`, abs(diff) <= CENT_TOLERANCE, `${year} 年资本化利息与期初余额加平均提款口径一致`,
        { planned: M(capitalized), expected: M(expected), difference: M(diff) }));
    }
    balance = money(balance + drawdown + capitalized);
    schedule.set(year, debtRow(drawdown, equity, capitalized, FX_ZERO, FX_ZERO, balance));
  }

  const openingDebt = balance;
  const n = f.operation_repayment_years;
  const operationYears = years.filter((y) => y >= operationYear);
  const annualPrincipal = n ? money(div(openingDebt, fxInt(n))) : FX_ZERO;
  let equalPayment: Fx;
  if (rate !== FX_ZERO && n) {
    equalPayment = money(div(mul(openingDebt, rate), FX_ONE - powInt(FX_ONE + rate, -n)));
  } else {
    equalPayment = n ? money(div(openingDebt, fxInt(n))) : FX_ZERO;
  }
  operationYears.forEach((year, index) => {
    const interest = balance > FX_ZERO ? money(mul(balance, rate)) : FX_ZERO;
    let principal = FX_ZERO;
    if (balance > FX_ZERO && index < n) {
      if (f.repayment_method === 'bullet') principal = index === n - 1 ? balance : FX_ZERO;
      else if (f.repayment_method === 'equal_payment') principal = fxMin(balance, money(equalPayment - interest));
      else principal = fxMin(balance, annualPrincipal);
    }
    balance = money(fxMax(FX_ZERO, balance - principal));
    schedule.set(year, debtRow(FX_ZERO, FX_ZERO, FX_ZERO, principal, interest, balance));
  });

  const constructionYearCount = Math.max(0, operationYear - Math.min(...years));
  checks.push(check('loan_term_split', f.total_loan_years === constructionYearCount + n, '贷款总期限等于建设期与运营偿还期之和',
    { total_loan_years: f.total_loan_years, construction_years: constructionYearCount, operation_repayment_years: n }));
  checks.push(check('debt_closing_balance', abs(balance) <= CENT_TOLERANCE, '测算期末债务余额清零', { closing_balance: M(balance) }));
  const totalPrincipal = add(...[...schedule.values()].map((r) => r.principal));
  checks.push(check('debt_principal_closure', abs(totalPrincipal - openingDebt) <= CENT_TOLERANCE, '运营期还本合计与运营期初债务一致',
    { opening_debt: M(openingDebt), principal_total: M(totalPrincipal) }));
  return { schedule, checks };
}

interface RevenueYear { including_vat: Fx; excluding_vat: Fx; output_vat: Fx; power_generation: Fx }

function revenueSchedule(a: FeasibilityAssumptions, years: number[]): Map<number, RevenueYear> {
  const schedule = new Map<number, RevenueYear>(years.map((y) => [y, { including_vat: FX_ZERO, excluding_vat: FX_ZERO, output_vat: FX_ZERO, power_generation: FX_ZERO }]));
  const vat = D(a.tax.vat_rate);
  for (const item of a.revenue_items) {
    for (const year of years) {
      if (year < item.start_year || (item.end_year != null && year > item.end_year)) continue;
      const s = schedule.get(year)!;
      const factor = powInt(FX_ONE + D(item.growth_rate), year - item.start_year);
      let raw: Fx;
      if (item.mode === 'power') {
        const generation = money(mul(D(item.power_generation_10k_kwh), factor));
        raw = money(mul(generation, D(item.electricity_price_yuan_per_kwh)));
        s.power_generation += generation;
      } else {
        raw = money(mul(D(item.annual_amount), factor));
      }
      let including: Fx; let excluding: Fx; let outputVat: Fx;
      if (item.taxable_for_vat) {
        if (item.price_tax_mode === 'tax_inclusive') {
          excluding = money(div(raw, FX_ONE + vat));
          including = raw;
        } else {
          excluding = raw;
          including = money(mul(excluding, FX_ONE + vat));
        }
        outputVat = money(including - excluding);
      } else {
        including = excluding = raw;
        outputVat = FX_ZERO;
      }
      s.including_vat += including; s.excluding_vat += excluding; s.output_vat += outputVat;
    }
  }
  for (const s of schedule.values()) {
    s.including_vat = money(s.including_vat); s.excluding_vat = money(s.excluding_vat); s.output_vat = money(s.output_vat); s.power_generation = money(s.power_generation);
  }
  return schedule;
}

function costSchedule(a: FeasibilityAssumptions, years: number[], revenues: Map<number, RevenueYear>): Map<number, { excluding_vat: Fx; input_vat: Fx }> {
  const schedule = new Map(years.map((y) => [y, { excluding_vat: FX_ZERO, input_vat: FX_ZERO }]));
  for (const item of a.cost_items) {
    const yearly = new Map(item.yearly_amounts.map((r) => [r.fiscal_year, D(r.amount)]));
    const vatRate = D(item.input_vat_rate);
    for (const year of years) {
      if (year < item.start_year || (item.end_year != null && year > item.end_year)) continue;
      let raw: Fx;
      if (item.mode === 'revenue_rate') raw = money(mul(revenues.get(year)!.excluding_vat, D(item.revenue_rate)));
      else if (item.mode === 'yearly_amount') raw = yearly.get(year) ?? FX_ZERO;
      else raw = money(mul(D(item.annual_amount), powInt(FX_ONE + D(item.growth_rate), year - item.start_year)));
      let excluding: Fx; let inputVat: Fx;
      if (item.amount_tax_mode === 'tax_inclusive' && vatRate !== FX_ZERO) {
        excluding = money(div(raw, FX_ONE + vatRate));
        inputVat = money(raw - excluding);
      } else {
        excluding = raw;
        inputVat = money(mul(raw, vatRate));
      }
      const s = schedule.get(year)!;
      s.excluding_vat += excluding; s.input_vat += inputVat;
    }
  }
  for (const s of schedule.values()) { s.excluding_vat = money(s.excluding_vat); s.input_vat = money(s.input_vat); }
  return schedule;
}

function depreciationSchedule(a: FeasibilityAssumptions, years: number[], operationYear: number, investments: Map<number, Fx>, financing: Map<number, DebtRow>): Map<number, Fx> {
  let base: Fx;
  if (a.depreciation.depreciable_base != null) {
    base = D(a.depreciation.depreciable_base);
  } else {
    const workingCapital = add(...a.investment_plan.map((i) => D(i.working_capital)));
    // 常规基建财务评价口径：建设期资本化利息计入固定资产原值后一并计提折旧。
    const capitalized = add(...[...financing.values()].map((r) => r.capitalized_interest));
    base = fxMax(FX_ZERO, add(...investments.values()) + capitalized - workingCapital);
  }
  const life = a.depreciation.useful_life_years;
  const annual = money(div(mul(base, FX_ONE - D(a.depreciation.residual_rate)), fxInt(life)));
  return new Map(years.map((y) => [y, operationYear <= y && y < operationYear + life ? annual : FX_ZERO]));
}

function incomeTax(taxableBeforeLoss: Fx, year: number, losses: [number, Fx][], rate: Fx, carryYears: number): [Fx, Fx] {
  const kept = losses.filter(([origin, amount]) => year - origin <= carryYears && amount > FX_ZERO);
  losses.splice(0, losses.length, ...kept);
  if (taxableBeforeLoss < FX_ZERO) {
    losses.push([year, -taxableBeforeLoss]);
    return [FX_ZERO, money(add(...losses.map(([, v]) => v)))];
  }
  let taxable = taxableBeforeLoss;
  const remaining: [number, Fx][] = [];
  for (const [origin, amount0] of losses) {
    const used = fxMin(taxable, amount0);
    taxable -= used;
    const amount = amount0 - used;
    if (amount > FX_ZERO) remaining.push([origin, amount]);
  }
  losses.splice(0, losses.length, ...remaining);
  return [money(mul(taxable, rate)), money(add(...losses.map(([, v]) => v)))];
}

/**
 * 精确 NPV:Σ v_i/(1+r)^(i+1),按有理数一次性计算后在 18 位舍入。
 * 利率接近 -1 时 (1+r)^n 极小,定点幂会下溢为 0,故用整数分子/分母避免任何中间舍入。
 */
export function npvExact(values: Fx[], rate: Fx): Fx {
  const d = FX_ONE + rate; // (1+r)·10^18
  if (d <= 0n) throw new FeasCalcError('利率必须大于 -1');
  const n = values.length;
  // 缩放 S=10^18:V_i=v_i·S,d=(1+r)·S;NPV·S = Σ V_i·S^(i+1)·d^(n-i-1) / d^n
  let numerator = 0n;
  let dPow = 1n; // d^(n-i-1),从 i=n-1 开始向前累乘
  let sPow = FX_ONE ** BigInt(n); // S^(i+1) for i=n-1
  for (let i = n - 1; i >= 0; i -= 1) {
    numerator += values[i] * sPow * dPow;
    dPow *= d;
    sPow /= FX_ONE;
  }
  return divRound(numerator, dPow);
}

function irrTolerance(values: Fx[]): Fx {
  const scale = values.reduce((m, v) => fxMax(m, abs(v)), FX_ZERO);
  return fxMax(fx('0.000001'), mul(scale, fx('0.0000001')));
}

export function irr(values: Fx[]): { value: Fx | null; status: 'success' | 'no_solution' | 'no_convergence' } {
  if (!values.some((v) => v < FX_ZERO) || !values.some((v) => v > FX_ZERO)) return { value: null, status: 'no_solution' };
  let low = fx('-0.999');
  let high = FX_ONE;
  let lowNpv = npvExact(values, low);
  let highNpv = npvExact(values, high);
  let bracketed = false;
  for (let i = 0; i < 20; i += 1) {
    if (sign(lowNpv) * sign(highNpv) <= 0) { bracketed = true; break; }
    high *= 2n;
    highNpv = npvExact(values, high);
  }
  if (!bracketed) return { value: null, status: 'no_solution' };
  const tolerance = irrTolerance(values);
  for (let i = 0; i < 200; i += 1) {
    const middle = div(low + high, TWO);
    const middleNpv = npvExact(values, middle);
    if (abs(middleNpv) <= tolerance) return { value: money(middle), status: 'success' };
    if (sign(lowNpv) * sign(middleNpv) <= 0) high = middle;
    else { low = middle; lowNpv = middleNpv; }
  }
  const final = div(low + high, TWO);
  // 二分循环耗尽后必须带残差判定，不再无条件当成功上报。
  return { value: money(final), status: abs(npvExact(values, final)) <= tolerance ? 'success' : 'no_convergence' };
}

function payback(values: Fx[]): Fx | null {
  let cumulative = FX_ZERO;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const previous = cumulative;
    cumulative += value;
    // 首年即回本是合法结果。
    if (cumulative >= FX_ZERO && value > FX_ZERO) {
      const fraction = previous < FX_ZERO ? div(-previous, value) : FX_ZERO;
      return money(fxInt(index) + fraction);
    }
  }
  return null;
}

function signChanges(values: Fx[]): number {
  let changes = 0;
  let previous = 0;
  for (const v of values) {
    const s = sign(v);
    if (s && previous && s !== previous) changes += 1;
    if (s) previous = s;
  }
  return changes;
}

export interface FeasCalcOutput {
  result: FeasResultDto;
  /** 供风险规则/敏感性使用的数值指标(Fx) */
  values: Record<string, Fx | null>;
}

export function calculateFeasibility(project: FeasProjectYears, a: FeasibilityAssumptions, opts: { discountBaseYear?: number } = {}): FeasCalcOutput {
  const startYear = project.construction_start_year;
  const operationYear = project.operation_start_year;
  const horizon = a.evaluation.horizon_years;
  const years = Array.from({ length: horizon }, (_, i) => startYear + i);
  if (!years.includes(operationYear)) throw new FeasCalcError('运营起年必须位于测算周期内');
  // 折现基准年固定在方案原始建设起始年：敏感性整体平移年份后，延期才会真正拉低 NPV。
  const discountBase = opts.discountBaseYear ?? startYear;

  const investments = new Map(a.investment_plan.map((i) => [i.fiscal_year, investmentTotal(i)]));
  const { schedule: financing, checks } = buildFinancingSchedule(a, years, operationYear);
  const allowed = new Set(years.filter((y) => y < operationYear));
  const invalidYears = [...investments.keys()].filter((y) => !allowed.has(y)).sort((x, y) => x - y);
  const investmentSum = add(...investments.values());
  checks.push(check('investment_years', invalidYears.length === 0, '建设投资年份均位于建设期', { invalid_years: invalidYears }));
  checks.push(check('investment_positive', investmentSum > FX_ZERO, '方案分年投资合计大于零', { total: M(investmentSum) }));
  const revenues = revenueSchedule(a, years);
  const costs = costSchedule(a, years, revenues);
  const depreciation = depreciationSchedule(a, years, operationYear, investments, financing);
  const annualInputVat = new Map(a.tax.annual_input_vat.map((r) => [r.fiscal_year, D(r.input_vat)]));

  const tax = a.tax;
  const incomeRate = D(tax.income_tax_rate);
  const discountRate = D(a.evaluation.discount_rate);
  const terminal = D(a.evaluation.terminal_recovery);
  let vatCredit = D(tax.opening_input_vat_credit);
  const projectLosses: [number, Fx][] = [];
  const equityLosses: [number, Fx][] = [];
  let projectCumulative = FX_ZERO;
  let equityCumulative = FX_ZERO;
  let cashBalance = FX_ZERO;
  const projectValues: Fx[] = [];
  const equityValues: Fx[] = [];
  const projectDiscounted: Fx[] = [];
  const equityDiscounted: Fx[] = [];
  const dscrs: Fx[] = [];
  const fundingGaps: Fx[] = [];
  const cashflows: FeasResultDto['cashflows'] = [];
  const lastYear = years[years.length - 1];

  years.forEach((year, yearIndex) => {
    const investment = investments.get(year) ?? FX_ZERO;
    const revenue = revenues.get(year)!;
    const cost = costs.get(year)!;
    const debt = financing.get(year)!;
    const vatOpening = vatCredit;
    const inputVat = money(cost.input_vat + (annualInputVat.get(year) ?? FX_ZERO));
    const vatAvailable = money(vatOpening + inputVat);
    const vatPaid = money(fxMax(FX_ZERO, revenue.output_vat - vatAvailable));
    vatCredit = money(fxMax(FX_ZERO, vatAvailable - revenue.output_vat));
    const waterResourceTax = money(mul(revenue.power_generation, D(tax.water_resource_tax_yuan_per_kwh)));
    const waterFund = money(mul(revenue.excluding_vat, D(tax.water_construction_fund_rate)));
    const surcharge = money(mul(vatPaid, D(tax.surcharge_rate)));
    const ebit = money(revenue.excluding_vat - cost.excluding_vat - depreciation.get(year)! - waterResourceTax - waterFund - surcharge);
    const [projectTax, projectLossBalance] = incomeTax(ebit, year, projectLosses, incomeRate, tax.loss_carryforward_years);
    const equityTaxable = money(ebit - debt.interest);
    const [equityTax, equityLossBalance] = incomeTax(equityTaxable, year, equityLosses, incomeRate, tax.loss_carryforward_years);
    const operatingCash = money(revenue.including_vat - cost.excluding_vat - inputVat - vatPaid - waterResourceTax - waterFund - surcharge);
    const cfads = money(operatingCash - equityTax);
    const terminalRecovery = year === lastYear ? terminal : FX_ZERO;
    const projectNet = money(-investment + operatingCash - projectTax + terminalRecovery);
    const equityNet = money(-debt.equity + cfads - debt.interest - debt.principal + terminalRecovery);
    const factor = powInt(FX_ONE + discountRate, year - discountBase + 1);
    const projectDisc = money(div(projectNet, factor));
    const equityDisc = money(div(equityNet, factor));
    projectCumulative = money(projectCumulative + projectNet);
    equityCumulative = money(equityCumulative + equityNet);
    const cashDelta = year < operationYear
      ? money(debt.equity + debt.drawdown - investment)
      : money(cfads - debt.interest - debt.principal + terminalRecovery);
    cashBalance = money(cashBalance + cashDelta);
    const fundingGap = money(fxMax(FX_ZERO, -cashBalance));
    const debtService = debt.principal + debt.interest;
    const dscr = year >= operationYear && debtService > FX_ZERO ? money(div(cfads, debtService)) : null;
    const totalTax = money(vatPaid + waterResourceTax + waterFund + surcharge + projectTax);
    cashflows.push({
      year_index: yearIndex,
      fiscal_year: year,
      investment: M(investment),
      revenue: M(revenue.including_vat),
      revenue_excluding_vat: M(revenue.excluding_vat),
      output_vat: M(revenue.output_vat),
      input_vat: M(inputVat),
      vat_credit_opening: M(vatOpening),
      vat_paid: M(vatPaid),
      vat_credit_closing: M(vatCredit),
      operating_cost: M(cost.excluding_vat),
      depreciation: M(depreciation.get(year)!),
      water_resource_tax: M(waterResourceTax),
      water_construction_fund: M(waterFund),
      surcharge_tax: M(surcharge),
      project_income_tax: M(projectTax),
      equity_income_tax: M(equityTax),
      project_loss_balance: M(projectLossBalance),
      equity_loss_balance: M(equityLossBalance),
      tax: M(totalTax),
      debt_drawdown: M(debt.drawdown),
      equity_contribution: M(debt.equity),
      capitalized_interest: M(debt.capitalized_interest),
      debt_principal: M(debt.principal),
      debt_interest: M(debt.interest),
      debt_balance: M(debt.balance),
      cfads: M(cfads),
      project_net_cashflow: M(projectNet),
      project_discounted_cashflow: M(projectDisc),
      project_cumulative_cashflow: M(projectCumulative),
      equity_net_cashflow: M(equityNet),
      equity_discounted_cashflow: M(equityDisc),
      equity_cumulative_cashflow: M(equityCumulative),
      funding_gap: M(fundingGap),
      cash_balance: M(cashBalance),
      dscr: dscr == null ? null : M(dscr),
      evidence: { ebit: M(ebit), equity_taxable_profit_before_loss: M(equityTaxable), cashflow_timing: a.evaluation.cashflow_timing },
    });
    projectValues.push(projectNet);
    equityValues.push(equityNet);
    projectDiscounted.push(projectDisc);
    equityDiscounted.push(equityDisc);
    if (dscr != null) dscrs.push(dscr);
    fundingGaps.push(fundingGap);
  });

  const projectIrr = irr(projectValues);
  const equityIrr = irr(equityValues);
  const projectNpv = money(add(...projectDiscounted));
  const equityNpv = money(add(...equityDiscounted));
  const staticPayback = payback(projectValues);
  const dynamicPayback = payback(projectDiscounted);
  const minDscr = dscrs.length ? dscrs.reduce((m, v) => fxMin(m, v)) : null;
  const maxFundingGap = fundingGaps.reduce((m, v) => fxMax(m, v), FX_ZERO);
  const benchmark = D(a.evaluation.benchmark_irr);
  const minDscrThreshold = D(a.evaluation.min_dscr);
  let score = fxInt(100);
  if (projectNpv < FX_ZERO) score -= fxInt(30);
  if (projectIrr.value == null || projectIrr.value < benchmark) score -= fxInt(25);
  if (minDscr != null && minDscr < minDscrThreshold) score -= fxInt(25);
  if (maxFundingGap > FX_ZERO) score -= fxInt(20);
  score = money(fxMax(FX_ZERO, score));

  const ind = (code: string, name: string, value: Fx | null, unit: string, status: FeasIndicatorDto['status'], evidence: Record<string, unknown> | null = null): FeasIndicatorDto =>
    ({ code, name, value: value == null ? null : M(value), unit, status, evidence });
  const irrInd = (code: string, name: string, r: ReturnType<typeof irr>, changes: number): FeasIndicatorDto => {
    const met = r.value != null && r.value >= benchmark;
    return ind(code, name, r.value, 'ratio', r.status !== 'success' ? 'no_solution' : met ? 'ok' : 'warning', {
      calculation_status: r.status, benchmark: a.evaluation.benchmark_irr, benchmark_met: met,
      // 现金流多次变号时 IRR 存在多个根，二分结果只是其中一个，须显式留痕。
      non_conventional_cashflow: changes > 1,
    });
  };
  const indicators: FeasIndicatorDto[] = [
    ind('project_npv', '项目净现值', projectNpv, '万元', projectNpv >= FX_ZERO ? 'ok' : 'warning'),
    irrInd('project_irr', '项目内部收益率', projectIrr, signChanges(projectValues)),
    ind('equity_npv', '股权净现值', equityNpv, '万元', equityNpv >= FX_ZERO ? 'ok' : 'warning'),
    irrInd('equity_irr', '股权内部收益率', equityIrr, signChanges(equityValues)),
    ind('static_payback_years', '静态投资回收期', staticPayback, '年', staticPayback != null ? 'ok' : 'no_solution'),
    ind('dynamic_payback_years', '动态投资回收期', dynamicPayback, '年', dynamicPayback != null ? 'ok' : 'no_solution'),
    ind('min_dscr', '最低偿债覆盖率', minDscr, '倍', minDscr == null || minDscr >= minDscrThreshold ? 'ok' : 'warning', { threshold: a.evaluation.min_dscr }),
    ind('peak_funding_gap', '峰值资金缺口', maxFundingGap, '万元', maxFundingGap === FX_ZERO ? 'ok' : 'warning'),
    ind('affordability_score', '财务可承受能力评分', score, '分', score >= D(a.evaluation.affordability_warning_score) ? 'ok' : 'warning'),
  ];
  return {
    result: {
      modelVersion: MODEL_VERSION,
      roundingRule: ROUNDING_RULE,
      parameterHash: canonicalHash({ project, assumptions: a }),
      discountBaseYear: discountBase,
      allChecksPassed: checks.every((c) => c.severity !== 'error' || c.passed),
      checks,
      indicators,
      cashflows,
    },
    values: {
      project_npv: projectNpv, project_irr: projectIrr.value, equity_npv: equityNpv, equity_irr: equityIrr.value,
      static_payback_years: staticPayback, dynamic_payback_years: dynamicPayback, min_dscr: minDscr, peak_funding_gap: maxFundingGap, affordability_score: score,
    },
  };
}

// ---------------- 敏感性 ----------------

const clamp01 = (v: Fx): Fx => fxMin(FX_ONE, fxMax(FX_ZERO, v));
/** 缩放后的金额/比率回写为最多 6 位小数的字符串(HALF_UP),保证变动后的输入仍满足契约精度。 */
const S6 = (v: Fx): string => {
  const t = toFixed(v, 6);
  return t.replace(/\.?0+$/, '') || '0';
};

function scaleField(item: Record<string, unknown>, field: string, multiplier: Fx): void {
  const v = item[field];
  if (v == null) return;
  item[field] = S6(fxMax(FX_ZERO, mul(fx(String(v)), multiplier)));
}

/** 对深拷贝的项目年份与输入施加一个敏感性变动。 */
export function applySensitivity(project: FeasProjectYears, a: FeasibilityAssumptions, code: SensitivityCode, change: string, mode: 'relative' | 'percentage_point' | 'year_delta'): void {
  const delta = fx(change);
  if (mode === 'year_delta') {
    shiftYears(project, a, Number(change));
    return;
  }
  if (code === 'loan_interest_rate') {
    const current = D(a.financing.loan_interest_rate);
    a.financing.loan_interest_rate = S6(clamp01(mode === 'percentage_point' ? current + delta : mul(current, FX_ONE + delta)));
    return;
  }
  const m = FX_ONE + delta;
  if (code === 'construction_investment') {
    for (const item of a.investment_plan) for (const f of INVESTMENT_FIELDS) scaleField(item, f, m);
    for (const item of a.financing.plan) for (const f of ['debt_drawdown', 'equity_contribution', 'capitalized_interest']) scaleField(item, f, m);
  } else if (code === 'electricity_price') {
    for (const item of a.revenue_items) if (item.mode === 'power') scaleField(item, 'electricity_price_yuan_per_kwh', m);
  } else if (code === 'power_generation') {
    for (const item of a.revenue_items) if (item.mode === 'power') scaleField(item, 'power_generation_10k_kwh', m);
  } else if (code === 'operating_cost') {
    for (const item of a.cost_items) {
      scaleField(item, 'annual_amount', m);
      // revenue_rate 受 ≤1 约束，缩放后夹取。
      if (item.revenue_rate != null) item.revenue_rate = S6(clamp01(mul(fx(item.revenue_rate), m)));
      for (const y of item.yearly_amounts) scaleField(y, 'amount', m);
    }
  } else if (code === 'opening_input_vat_credit') {
    a.tax.opening_input_vat_credit = S6(fxMax(FX_ZERO, mul(D(a.tax.opening_input_vat_credit), m)));
  }
}

function shiftYears(project: FeasProjectYears, a: FeasibilityAssumptions, delta: number): void {
  project.construction_start_year += delta;
  project.operation_start_year += delta;
  for (const i of a.investment_plan) i.fiscal_year += delta;
  for (const i of a.financing.plan) i.fiscal_year += delta;
  for (const i of a.revenue_items) { i.start_year += delta; if (i.end_year != null) i.end_year += delta; }
  for (const i of a.cost_items) {
    i.start_year += delta; if (i.end_year != null) i.end_year += delta;
    for (const y of i.yearly_amounts) y.fiscal_year += delta;
  }
  for (const i of a.tax.annual_input_vat) i.fiscal_year += delta;
}

// ---------------- 风险规则(供风险扫描) ----------------

export interface FeasRiskHit {
  code: 'FEAS_NPV_NEGATIVE' | 'FEAS_IRR_LOW' | 'FEAS_DSCR_LOW' | 'FEAS_FUNDING_GAP' | 'FEAS_MODEL_CHECK';
  sub: string;
  level: 'high' | 'medium';
  title: string;
  description: string;
  metric: string | null;
  evidence: Record<string, unknown>;
}

/** 从冻结的测算结果生成风险命中(口径见 spec 风险规则表)。 */
export function feasibilityRiskHits(result: FeasResultDto): FeasRiskHit[] {
  const by = new Map(result.indicators.map((i) => [i.code, i]));
  const hits: FeasRiskHit[] = [];
  for (const [prefix, label] of [['project', '项目'], ['equity', '股权']] as const) {
    const npv = by.get(`${prefix}_npv`);
    if (npv?.value != null && npv.value.startsWith('-')) {
      hits.push({ code: 'FEAS_NPV_NEGATIVE', sub: prefix, level: 'high', title: `${label}净现值为负`, description: `${label}折现后净现金流为 ${npv.value} 万元。`, metric: npv.value, evidence: { npv: npv.value } });
    }
    const irrItem = by.get(`${prefix}_irr`);
    const ev = (irrItem?.evidence ?? {}) as Record<string, unknown>;
    if (ev.calculation_status !== 'success') {
      hits.push({ code: 'FEAS_IRR_LOW', sub: `${prefix}_no_solution`, level: 'high', title: `${label}内部收益率无解`, description: `${label}现金流没有形成可求解的正负转换(${String(ev.calculation_status ?? '未知')})。`, metric: null, evidence: { calculation_status: ev.calculation_status } });
    } else if (irrItem?.status === 'warning') {
      hits.push({ code: 'FEAS_IRR_LOW', sub: prefix, level: 'medium', title: `${label}内部收益率未达标`, description: `${label}内部收益率 ${irrItem.value} 低于基准 ${String(ev.benchmark)}。`, metric: irrItem.value, evidence: { irr: irrItem.value, benchmark: ev.benchmark } });
    }
  }
  const dscr = by.get('min_dscr');
  if (dscr?.value != null && dscr.status === 'warning') {
    const high = fx(dscr.value) < FX_ONE;
    hits.push({ code: 'FEAS_DSCR_LOW', sub: 'min', level: high ? 'high' : 'medium', title: '偿债覆盖率不足', description: `最低偿债覆盖率 ${dscr.value} 低于门槛 ${String((dscr.evidence as Record<string, unknown>)?.threshold)}。`, metric: dscr.value, evidence: { min_dscr: dscr.value, threshold: (dscr.evidence as Record<string, unknown>)?.threshold } });
  }
  const gap = by.get('peak_funding_gap');
  if (gap?.value != null && fx(gap.value) > FX_ZERO) {
    hits.push({ code: 'FEAS_FUNDING_GAP', sub: 'peak', level: 'medium', title: '存在资金缺口', description: `测算期峰值资金缺口为 ${gap.value} 万元。`, metric: gap.value, evidence: { peak_funding_gap: gap.value } });
  }
  for (const c of result.checks) {
    if (c.severity === 'error' && !c.passed) {
      hits.push({ code: 'FEAS_MODEL_CHECK', sub: c.code, level: 'high', title: '模型检查未通过', description: c.message, metric: null, evidence: c.evidence });
    }
  }
  return hits;
}
