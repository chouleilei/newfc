/**
 * 可行性测算标准模板 xlsx(AC-F12):模板导出、方案导入解析、结果导出。
 *
 * 模板工作表固定:说明(忽略)、方案参数、建设投资、融资计划、经营收入、经营成本、年度进项税。
 * 输入区禁止公式;未知工作表、表头不符、未知参数编码都是错误。解析结果交给
 * feasibilityAssumptions 契约校验,契约错误按路径映射回“工作表/行”。
 */
import ExcelJS from 'exceljs';
import type { ZodIssue } from 'zod';
import type { RowError } from '../../core/errors';
import { assertSafeXlsx } from '../io/xlsx-guard';
import {
  feasibilityAssumptions, INVESTMENT_FIELDS, type FeasibilityAssumptions, type FeasResultDto, type FeasSensitivityItemDto,
} from '../../contracts/investment-feasibility';

const MAX_ROWS = 500;

type ParamKind = 'decimal' | 'int' | 'text' | 'enum';
interface ParamDef { code: string; label: string; kind: ParamKind; options?: Record<string, string> }
/** 标量参数:编码为 assumptions 内的点路径。 */
export const FEAS_PARAMS: ParamDef[] = [
  { code: 'basis.preparation_basis', label: '编制依据', kind: 'text' },
  { code: 'basis.data_source', label: '数据来源', kind: 'text' },
  { code: 'basis.scope_note', label: '测算范围说明', kind: 'text' },
  { code: 'basis.notes', label: '备注', kind: 'text' },
  { code: 'financing.debt_ratio', label: '债务资金比例', kind: 'decimal' },
  { code: 'financing.loan_interest_rate', label: '贷款年利率', kind: 'decimal' },
  { code: 'financing.total_loan_years', label: '贷款总期限(年)', kind: 'int' },
  { code: 'financing.operation_repayment_years', label: '运营期还款年限(年)', kind: 'int' },
  { code: 'financing.repayment_method', label: '还款方式', kind: 'enum', options: { equal_principal: '等额本金', equal_payment: '等额本息', bullet: '到期一次还本' } },
  { code: 'financing.other_funding_note', label: '其他资金来源说明', kind: 'text' },
  { code: 'tax.vat_rate', label: '增值税税率', kind: 'decimal' },
  { code: 'tax.opening_input_vat_credit', label: '期初进项留抵(万元)', kind: 'decimal' },
  { code: 'tax.water_resource_tax_yuan_per_kwh', label: '水资源税(元/kWh)', kind: 'decimal' },
  { code: 'tax.water_construction_fund_rate', label: '水利建设基金费率', kind: 'decimal' },
  { code: 'tax.surcharge_rate', label: '附加税费率', kind: 'decimal' },
  { code: 'tax.income_tax_rate', label: '所得税税率', kind: 'decimal' },
  { code: 'tax.loss_carryforward_years', label: '亏损结转年限(年)', kind: 'int' },
  { code: 'tax.note', label: '税费说明', kind: 'text' },
  { code: 'depreciation.depreciable_base', label: '折旧基数(万元,空=自动)', kind: 'decimal' },
  { code: 'depreciation.residual_rate', label: '残值率', kind: 'decimal' },
  { code: 'depreciation.useful_life_years', label: '折旧年限(年)', kind: 'int' },
  { code: 'evaluation.discount_rate', label: '折现率', kind: 'decimal' },
  { code: 'evaluation.benchmark_irr', label: '基准收益率', kind: 'decimal' },
  { code: 'evaluation.min_dscr', label: '最低偿债备付率', kind: 'decimal' },
  { code: 'evaluation.horizon_years', label: '计算期(年)', kind: 'int' },
  { code: 'evaluation.terminal_recovery', label: '期末回收(万元)', kind: 'decimal' },
  { code: 'evaluation.affordability_warning_score', label: '承受能力预警分', kind: 'decimal' },
];

const INVESTMENT_LABELS: Record<(typeof INVESTMENT_FIELDS)[number], string> = {
  engineering_cost: '工程费', equipment_cost: '设备费', land_resettlement_cost: '征地移民费', preliminary_cost: '前期费',
  design_supervision_cost: '设计监理费', other_cost: '其他费用', contingency: '预备费', working_capital: '流动资金',
};
const REVENUE_MODE: Record<string, string> = { power: '发电收入', fixed_amount: '固定金额' };
const COST_MODE: Record<string, string> = { fixed_amount: '固定金额', revenue_rate: '收入比例', yearly_amount: '分年金额' };
const TAX_MODE: Record<string, string> = { tax_inclusive: '含税', tax_exclusive: '不含税' };
const YES_NO: Record<string, string> = { true: '是', false: '否' };
const SENS_MODE: Record<string, string> = { relative: '相对变动', percentage_point: '百分点', year_delta: '年数' };

interface SheetDef { name: string; headers: string[] }
const SHEETS = {
  params: { name: '方案参数', headers: ['参数编码', '参数名称', '值'] },
  investment: { name: '建设投资', headers: ['年份', ...INVESTMENT_FIELDS.map((f) => `${INVESTMENT_LABELS[f]}(万元)`)] },
  financing: { name: '融资计划', headers: ['年份', '贷款提款(万元)', '资本金投入(万元)', '资本化利息(万元)'] },
  revenue: { name: '经营收入', headers: ['名称', '模式', '开始年份', '结束年份', '发电量(万kWh)', '电价(元/kWh)', '电价口径', '年度金额(万元)', '年增长率', '计增值税', '备注'] },
  cost: { name: '经营成本', headers: ['名称', '模式', '开始年份', '结束年份', '年度金额(万元)', '收入比例', '分年金额(万元)', '年增长率', '金额口径', '进项税率', '备注'] },
  inputVat: { name: '年度进项税', headers: ['年份', '进项税额(万元)'] },
  sensitivity: { name: '敏感性变量', headers: ['变量编码', '方式', '变动值'] },
} satisfies Record<string, SheetDef>;
const README = '说明';
const KNOWN_SHEETS = new Set([README, ...Object.values(SHEETS).map((s) => s.name)]);

// ---------------- 模板导出 ----------------

const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

function addTable(wb: ExcelJS.Workbook, def: SheetDef, rows: (string | number | null)[][]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(def.name);
  ws.addRow(def.headers).font = { bold: true };
  for (const r of rows) ws.addRow(r.map((v) => v ?? ''));
  ws.columns.forEach((c, i) => { c.width = Math.max(12, def.headers[i]?.length * 2 + 4); });
  // 数值以文本写入,避免 Excel 显示格式改变小数位
  ws.eachRow((row, n) => { if (n > 1) row.eachCell((cell) => { cell.numFmt = '@'; }); });
  return ws;
}

/** 生成模板;传入 assumptions 时预填(用于导出现有方案再导入)。 */
export async function feasibilityTemplateBuffer(a?: FeasibilityAssumptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const readme = wb.addWorksheet(README);
  [
    '投资可行性测算标准模板(standard-1.0)',
    '金额单位万元,最多 6 位小数;比率填 0~1 的小数(如 0.09),最多 6 位小数;年份为 4 位整数。',
    '输入区不允许公式;不要增删工作表或修改表头。未列出的参数取标准默认值。',
    `模式:收入 ${Object.values(REVENUE_MODE).join('/')};成本 ${Object.values(COST_MODE).join('/')};口径 含税/不含税;计增值税 是/否。`,
    '分年金额写成“年份:金额”并用分号分隔,如 2028:1800;2029:1500。融资计划留空表示按债务比例自动生成。',
    `敏感性变量:编码 ${['construction_investment', 'electricity_price', 'power_generation', 'operating_cost', 'construction_delay', 'loan_interest_rate', 'opening_input_vat_credit'].join('/')};方式 相对变动/百分点(仅贷款利率)/年数(仅建设延期);变动值用分号分隔,如 -0.1;0.1。`,
  ].forEach((t) => readme.addRow([t]));
  readme.getColumn(1).width = 100;

  const paramValue = (p: ParamDef): string => {
    const v = a ? get(a, p.code) : undefined;
    if (v == null) return '';
    if (p.kind === 'enum') return p.options?.[String(v)] ?? String(v);
    return String(v);
  };
  addTable(wb, SHEETS.params, FEAS_PARAMS.map((p) => [p.code, p.label, paramValue(p)]));
  addTable(wb, SHEETS.investment, (a?.investment_plan ?? []).map((r) => [String(r.fiscal_year), ...INVESTMENT_FIELDS.map((f) => r[f])]));
  addTable(wb, SHEETS.financing, (a?.financing.plan ?? []).map((r) => [String(r.fiscal_year), r.debt_drawdown, r.equity_contribution, r.capitalized_interest]));
  addTable(wb, SHEETS.revenue, (a?.revenue_items ?? []).map((r) => [
    r.name, REVENUE_MODE[r.mode], String(r.start_year), r.end_year == null ? '' : String(r.end_year), r.power_generation_10k_kwh ?? '', r.electricity_price_yuan_per_kwh ?? '',
    TAX_MODE[r.price_tax_mode], r.annual_amount ?? '', r.growth_rate, YES_NO[String(r.taxable_for_vat)], r.note ?? '',
  ]));
  addTable(wb, SHEETS.cost, (a?.cost_items ?? []).map((r) => [
    r.name, COST_MODE[r.mode], String(r.start_year), r.end_year == null ? '' : String(r.end_year), r.annual_amount ?? '', r.revenue_rate ?? '',
    r.yearly_amounts.map((y) => `${y.fiscal_year}:${y.amount}`).join(';'), r.growth_rate, TAX_MODE[r.amount_tax_mode], r.input_vat_rate, r.note ?? '',
  ]));
  addTable(wb, SHEETS.inputVat, (a?.tax.annual_input_vat ?? []).map((r) => [String(r.fiscal_year), r.input_vat]));
  addTable(wb, SHEETS.sensitivity, (a?.sensitivity.variables ?? []).map((v) => [v.code, SENS_MODE[v.mode], v.changes.join(';')]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------- 导入解析 ----------------

class TemplateCellError extends Error {}

/** 单元格 → 文本;公式单元格报错(输入区禁止公式)。 */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) throw new TemplateCellError('输入区不允许公式,请粘贴为数值');
    if ('error' in o) throw new TemplateCellError('单元格为错误值');
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('').trim();
    if ('text' in o) return String(o.text).trim();
    if (v instanceof Date) throw new TemplateCellError('不支持日期格式,请填写年份或数值');
    throw new TemplateCellError('无法识别的单元格内容');
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TemplateCellError('数值无效');
    const t = String(v);
    if (/e/i.test(t)) throw new TemplateCellError('数值过大或过小(科学计数),请以文本填写');
    return t;
  }
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v).trim();
}

interface ParsedTemplate {
  assumptions: FeasibilityAssumptions | null;
  errors: RowError[];
}

const where = (sheet: string, row: number, field: string) => ({ row, field: `${sheet}/${field}` });

/** 解析标准模板;不抛业务错误,全部收集为逐行错误(文件级错误 row=0)。 */
export async function parseFeasibilityTemplate(buffer: Buffer): Promise<ParsedTemplate> {
  await assertSafeXlsx(buffer, MAX_ROWS, 10);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return { assumptions: null, errors: [{ row: 0, field: '文件', message: '不是有效的 xlsx 文件' }] };
  }
  const errors: RowError[] = [];
  const sheets = new Map<string, ExcelJS.Worksheet>();
  wb.eachSheet((ws) => {
    if (!KNOWN_SHEETS.has(ws.name.trim())) errors.push({ row: 0, field: '工作表', message: `未知工作表“${ws.name}”,请使用标准模板` });
    else sheets.set(ws.name.trim(), ws);
  });

  /** 读取表格区:核对表头,返回数据行(行号 + 文本单元格);空行跳过。 */
  const table = (def: SheetDef, required: boolean): { rowNo: number; cells: string[] }[] => {
    const ws = sheets.get(def.name);
    if (!ws) {
      if (required) errors.push({ row: 0, field: '工作表', message: `缺少工作表“${def.name}”` });
      return [];
    }
    const header = ws.getRow(1);
    const got = def.headers.map((_, i) => { try { return cellText(header.getCell(i + 1)); } catch { return '#'; } });
    if (got.some((h, i) => h !== def.headers[i])) {
      errors.push({ row: 1, field: def.name, message: `表头应为:${def.headers.join(' | ')}` });
      return [];
    }
    if (ws.actualColumnCount > def.headers.length) {
      for (let c = def.headers.length + 1; c <= ws.columnCount; c += 1) {
        let hasValue = false;
        ws.eachRow((row) => { if (row.getCell(c).value != null && String(row.getCell(c).value).trim() !== '') hasValue = true; });
        if (hasValue) { errors.push({ row: 1, field: def.name, message: `第 ${c} 列不在模板中,请删除多余列` }); return []; }
      }
    }
    const out: { rowNo: number; cells: string[] }[] = [];
    ws.eachRow((row, rowNo) => {
      if (rowNo === 1) return;
      const cells: string[] = [];
      let bad = false;
      def.headers.forEach((h, i) => {
        try { cells.push(cellText(row.getCell(i + 1))); } catch (e) {
          if (!(e instanceof TemplateCellError)) throw e;
          errors.push({ ...where(def.name, rowNo, h), message: e.message }); bad = true; cells.push('');
        }
      });
      if (!bad && cells.every((c) => c === '')) return;
      if (out.length >= MAX_ROWS) { if (out.length === MAX_ROWS) errors.push({ row: rowNo, field: def.name, message: `行数超过 ${MAX_ROWS}` }); return; }
      out.push({ rowNo, cells });
    });
    return out;
  };

  const intCell = (sheet: string, rowNo: number, field: string, v: string, optional = false): number | null => {
    if (v === '') {
      if (!optional) errors.push({ ...where(sheet, rowNo, field), message: `${field}不能为空` });
      return null;
    }
    if (!/^\d{1,4}$/.test(v)) { errors.push({ ...where(sheet, rowNo, field), message: `${field}应为整数` }); return null; }
    return Number(v);
  };
  const choose = (sheet: string, rowNo: number, field: string, v: string, options: Record<string, string>, dflt?: string): string | undefined => {
    if (v === '') return dflt;
    const hit = Object.entries(options).find(([code, label]) => v === code || v === label);
    if (!hit) { errors.push({ ...where(sheet, rowNo, field), message: `${field}应为:${Object.values(options).join('/')}` }); return undefined; }
    return hit[0];
  };
  const opt = (v: string) => (v === '' ? undefined : v);

  // 方案参数
  const raw: Record<string, unknown> = { schema_version: 'standard-1.0' };
  /** 契约路径 → 出处(工作表/行),用于回填契约错误 */
  const origin = new Map<string, { sheet: string; row: number }>();
  const paramRows = table(SHEETS.params, true);
  const seenParams = new Set<string>();
  for (const { rowNo, cells: [code, , value] } of paramRows) {
    const def = FEAS_PARAMS.find((p) => p.code === code);
    if (!def) { errors.push({ ...where(SHEETS.params.name, rowNo, '参数编码'), message: `未知参数编码“${code}”` }); continue; }
    if (seenParams.has(code)) { errors.push({ ...where(SHEETS.params.name, rowNo, '参数编码'), message: `参数编码重复:${code}` }); continue; }
    seenParams.add(code);
    if (value === '') continue;
    let parsed: unknown = value;
    if (def.kind === 'int') parsed = intCell(SHEETS.params.name, rowNo, def.label, value);
    if (def.kind === 'enum') parsed = choose(SHEETS.params.name, rowNo, def.label, value, def.options!);
    if (parsed == null) continue;
    const [group, key] = code.split('.');
    raw[group] = { ...(raw[group] as object | undefined), [key]: parsed };
    origin.set(code, { sheet: SHEETS.params.name, row: rowNo });
  }

  // 建设投资
  raw.investment_plan = table(SHEETS.investment, true).map(({ rowNo, cells }, i) => {
    origin.set(`investment_plan.${i}`, { sheet: SHEETS.investment.name, row: rowNo });
    const item: Record<string, unknown> = { fiscal_year: intCell(SHEETS.investment.name, rowNo, '年份', cells[0]) ?? 0 };
    INVESTMENT_FIELDS.forEach((f, j) => { if (cells[j + 1] !== '') item[f] = cells[j + 1]; });
    return item;
  });

  // 融资计划
  const plan = table(SHEETS.financing, false).map(({ rowNo, cells }, i) => {
    origin.set(`financing.plan.${i}`, { sheet: SHEETS.financing.name, row: rowNo });
    return {
      fiscal_year: intCell(SHEETS.financing.name, rowNo, '年份', cells[0]) ?? 0,
      debt_drawdown: cells[1] || '0', equity_contribution: cells[2] || '0', capitalized_interest: cells[3] || '0',
    };
  });
  if (plan.length) raw.financing = { ...(raw.financing as object | undefined), plan };

  // 经营收入
  raw.revenue_items = table(SHEETS.revenue, false).map(({ rowNo, cells }, i) => {
    const s = SHEETS.revenue.name;
    origin.set(`revenue_items.${i}`, { sheet: s, row: rowNo });
    return {
      name: cells[0], mode: choose(s, rowNo, '模式', cells[1], REVENUE_MODE, 'fixed_amount'),
      start_year: intCell(s, rowNo, '开始年份', cells[2]) ?? 0, end_year: intCell(s, rowNo, '结束年份', cells[3], true),
      power_generation_10k_kwh: opt(cells[4]), electricity_price_yuan_per_kwh: opt(cells[5]),
      price_tax_mode: choose(s, rowNo, '电价口径', cells[6], TAX_MODE, 'tax_inclusive'),
      annual_amount: opt(cells[7]), growth_rate: opt(cells[8]),
      taxable_for_vat: choose(s, rowNo, '计增值税', cells[9], YES_NO, 'true') !== 'false',
      note: opt(cells[10]),
    };
  });

  // 经营成本
  raw.cost_items = table(SHEETS.cost, false).map(({ rowNo, cells }, i) => {
    const s = SHEETS.cost.name;
    origin.set(`cost_items.${i}`, { sheet: s, row: rowNo });
    const yearly: { fiscal_year: number; amount: string }[] = [];
    if (cells[6] !== '') {
      for (const part of cells[6].split(/[;；]/).map((p) => p.trim()).filter(Boolean)) {
        const m = /^(\d{4})\s*[:：]\s*(\S+)$/.exec(part);
        if (!m) { errors.push({ ...where(s, rowNo, '分年金额'), message: `“${part}”应写成 年份:金额` }); continue; }
        yearly.push({ fiscal_year: Number(m[1]), amount: m[2] });
      }
    }
    return {
      name: cells[0], mode: choose(s, rowNo, '模式', cells[1], COST_MODE, 'fixed_amount'),
      start_year: intCell(s, rowNo, '开始年份', cells[2]) ?? 0, end_year: intCell(s, rowNo, '结束年份', cells[3], true),
      annual_amount: opt(cells[4]), revenue_rate: opt(cells[5]), yearly_amounts: yearly, growth_rate: opt(cells[7]),
      amount_tax_mode: choose(s, rowNo, '金额口径', cells[8], TAX_MODE, 'tax_exclusive'), input_vat_rate: opt(cells[9]), note: opt(cells[10]),
    };
  });

  // 年度进项税
  const inputVat = table(SHEETS.inputVat, false).map(({ rowNo, cells }, i) => {
    origin.set(`tax.annual_input_vat.${i}`, { sheet: SHEETS.inputVat.name, row: rowNo });
    return { fiscal_year: intCell(SHEETS.inputVat.name, rowNo, '年份', cells[0]) ?? 0, input_vat: cells[1] || '0' };
  });
  if (inputVat.length) raw.tax = { ...(raw.tax as object | undefined), annual_input_vat: inputVat };

  // 敏感性变量
  const variables = table(SHEETS.sensitivity, false).map(({ rowNo, cells }, i) => {
    origin.set(`sensitivity.variables.${i}`, { sheet: SHEETS.sensitivity.name, row: rowNo });
    return {
      code: cells[0], mode: choose(SHEETS.sensitivity.name, rowNo, '方式', cells[1], SENS_MODE, 'relative'),
      changes: cells[2] === '' ? undefined : cells[2].split(/[;；]/).map((c) => c.trim()).filter(Boolean),
    };
  });
  if (variables.length) raw.sensitivity = { variables };

  if (errors.length) return { assumptions: null, errors };
  const strip = (o: unknown): unknown => (Array.isArray(o) ? o.map(strip) : o && typeof o === 'object'
    ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, strip(v)])) : o);
  const parsed = feasibilityAssumptions.safeParse(strip(raw));
  if (!parsed.success) return { assumptions: null, errors: parsed.error.issues.map((i) => issueToRowError(i, origin)) };
  return { assumptions: parsed.data, errors: [] };
}

function issueToRowError(issue: ZodIssue, origin: Map<string, { sheet: string; row: number }>): RowError {
  const path = issue.path.map(String);
  for (let n = path.length; n > 0; n -= 1) {
    const hit = origin.get(path.slice(0, n).join('.'));
    if (hit) return { row: hit.row, field: `${hit.sheet}/${path.slice(n).join('.') || path.join('.')}`, message: issue.message };
  }
  return { row: 0, field: path.join('.') || '方案', message: issue.message };
}

// ---------------- 结果导出 ----------------

/** 6 位小数字符串能被 double 精确往返时写数值单元格,否则写文本(保证与冻结结果逐项一致)。 */
function numCell(v: string | number | null | undefined): string | number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (!/^-?\d+(\.\d+)?$/.test(v)) return v;
  const n = Number(v);
  const canon = v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^-0$/, '0');
  return String(n) === canon ? n : v;
}

const CASHFLOW_COLUMNS: [string, string][] = [
  ['fiscal_year', '年份'], ['investment', '建设投资'], ['revenue', '收入(含税)'], ['revenue_excluding_vat', '收入(不含税)'], ['output_vat', '销项税'],
  ['input_vat', '进项税'], ['vat_paid', '实缴增值税'], ['vat_credit_closing', '期末留抵'], ['operating_cost', '经营成本'], ['depreciation', '折旧'],
  ['water_resource_tax', '水资源税'], ['water_construction_fund', '水利建设基金'], ['surcharge_tax', '附加税费'], ['project_income_tax', '所得税(项目)'],
  ['equity_income_tax', '所得税(资本金)'], ['tax', '税费合计'], ['cfads', '可用于偿债现金流'], ['project_net_cashflow', '项目净现金流'],
  ['project_discounted_cashflow', '项目折现现金流'], ['project_cumulative_cashflow', '项目累计现金流'], ['equity_net_cashflow', '资本金净现金流'],
  ['equity_discounted_cashflow', '资本金折现现金流'], ['equity_cumulative_cashflow', '资本金累计现金流'], ['cash_balance', '现金余额'], ['funding_gap', '资金缺口'], ['dscr', 'DSCR'],
];
const DEBT_COLUMNS: [string, string][] = [
  ['fiscal_year', '年份'], ['debt_drawdown', '贷款提款'], ['equity_contribution', '资本金投入'], ['capitalized_interest', '资本化利息'],
  ['debt_principal', '还本'], ['debt_interest', '付息'], ['debt_balance', '期末贷款余额'],
];

export async function feasibilityResultBuffer(input: {
  projectName: string; scenarioName: string; runId: number; createdAt: string; createdBy: string | null;
  assumptions: FeasibilityAssumptions; result: FeasResultDto; sensitivity?: FeasSensitivityItemDto[] | null;
}): Promise<Buffer> {
  const { result } = input;
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet('摘要');
  summary.addRows([
    ['项目', input.projectName], ['方案', input.scenarioName], ['运行编号', input.runId], ['运行时间', input.createdAt], ['运行人', input.createdBy ?? ''],
    ['模型版本', result.modelVersion], ['舍入规则', result.roundingRule], ['参数哈希', result.parameterHash], ['折现基准年', result.discountBaseYear],
    ['模型检查全部通过', result.allChecksPassed ? '是' : '否'], ['金额单位', '万元'], [],
    ['指标编码', '指标', '值', '单位', '状态'],
  ]);
  for (const i of result.indicators) summary.addRow([i.code, i.name, numCell(i.value), i.unit, i.status]);
  summary.getColumn(1).width = 24; summary.getColumn(2).width = 28; summary.getColumn(3).width = 20;

  const params = wb.addWorksheet('参数');
  params.addRow(['参数编码', '参数名称', '值']).font = { bold: true };
  for (const p of FEAS_PARAMS) {
    const v = get(input.assumptions, p.code);
    params.addRow([p.code, p.label, v == null ? '' : p.kind === 'enum' ? p.options?.[String(v)] ?? String(v) : p.kind === 'text' ? String(v) : numCell(String(v))]);
  }
  params.getColumn(1).width = 36; params.getColumn(2).width = 28;

  const table = (name: string, cols: [string, string][]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(cols.map(([, l]) => l)).font = { bold: true };
    for (const r of result.cashflows) ws.addRow(cols.map(([k]) => numCell(r[k] as string | number | null)));
    ws.columns.forEach((c) => { c.width = 16; });
  };
  table('现金流', CASHFLOW_COLUMNS);
  table('债务', DEBT_COLUMNS);

  const checks = wb.addWorksheet('检查');
  checks.addRow(['检查编码', '级别', '是否通过', '说明']).font = { bold: true };
  for (const c of result.checks) checks.addRow([c.code, c.severity, c.passed ? '是' : '否', c.message]);
  checks.getColumn(1).width = 30; checks.getColumn(4).width = 80;

  if (input.sensitivity?.length) {
    const ws = wb.addWorksheet('敏感性');
    ws.addRow(['变量', '方式', '变动', '状态', '指标', '值', '基准值', '变化']).font = { bold: true };
    for (const item of input.sensitivity) {
      if (item.status === 'failed') { ws.addRow([item.code, item.mode, item.change, '失败', item.error ?? '']); continue; }
      for (const i of item.indicators) ws.addRow([item.code, item.mode, item.change, '成功', i.code, numCell(i.value), numCell(i.baseValue), numCell(i.delta)]);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
