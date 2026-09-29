/**
 * EAS 导出文件解析与全量校验(AC-F05)。纯函数:不读写数据库,在写事务之外完成。
 *
 * 规则(与 specs/implementation.md T-3「EAS」一致):
 * - 按表头别名定位列;必填列缺失直接拒绝。
 * - 金额为元、最多两位小数,解析为整数分(bigint);空值不当作 0(零请填 0)。
 * - 单一公司、单一期间;凭证日期属于该期间;凭证单边记账且同一凭证借贷平衡;
 *   余额期初 + 本期 = 期末;辅助核算期初 + 借 − 贷 = 期末;业务键文件内唯一。
 * - 任何一行错误都整体拒绝(IMPORT_VALIDATION_FAILED,附行号),不产生部分结果。
 */
import { AppError, Errors, type RowError } from '../../core/errors';
import { isValidDate } from '../../core/dates';
import { parseDecimalToCents } from '../../core/decimal';
import { normalizeImportedNumber } from '../io/import-values';
import { MAX_IMPORT_ERRORS } from '../io/import-limits';
import type { ReadTable } from '../io/table-reader';
import type { EasDataType } from '../../contracts/eas';

export const EAS_PARSER_VERSION = 'eas-2026-09-v1';
const TOLERANCE_CENTS = 1n;

type FieldSpec = { key: string; label: string; aliases: string[]; required: boolean };
const F = (key: string, label: string, aliases: string[], required = true): FieldSpec => ({ key, label, aliases: [label, ...aliases], required });

const COMMON = [F('company', '公司', ['公司名称', '核算组织', '组织名称', '公司编码']), F('period', '期间', ['会计期间'])];
const FIELDS: Record<EasDataType, FieldSpec[]> = {
  voucher: [
    ...COMMON,
    F('voucherDate', '凭证日期', ['记账日期', '业务日期']),
    F('voucherNo', '凭证号', ['凭证字号', '凭证编号']),
    F('entryNo', '分录号', ['分录序号', '行号']),
    F('accountCode', '科目编码', ['科目代码']),
    F('accountName', '科目名称', []),
    F('debit', '借方金额', ['借方']),
    F('credit', '贷方金额', ['贷方']),
    F('summary', '摘要', [], false),
    F('projectCode', '项目编码', [], false),
    F('projectName', '项目名称', [], false),
    F('deptName', '部门', ['部门名称'], false),
    F('supplierName', '供应商', ['供应商名称', '往来单位'], false),
    F('fundSource', '资金来源', [], false),
  ],
  balance: [
    ...COMMON,
    F('accountCode', '科目编码', ['科目代码']),
    F('accountName', '科目名称', []),
    F('beginDebit', '期初借方', ['期初借方余额']),
    F('beginCredit', '期初贷方', ['期初贷方余额']),
    F('debit', '本期借方', ['本期借方发生额']),
    F('credit', '本期贷方', ['本期贷方发生额']),
    F('endDebit', '期末借方', ['期末借方余额']),
    F('endCredit', '期末贷方', ['期末贷方余额']),
    F('projectCode', '项目编码', [], false),
    F('projectName', '项目名称', [], false),
    F('deptName', '部门', ['部门名称'], false),
    F('supplierName', '供应商', ['供应商名称', '往来单位'], false),
  ],
  auxiliary: [
    ...COMMON,
    F('auxType', '辅助类型', ['核算类型']),
    F('auxCode', '辅助编码', ['核算项目编码']),
    F('auxName', '辅助名称', ['核算项目名称']),
    F('accountCode', '科目编码', ['科目代码']),
    F('accountName', '科目名称', []),
    F('begin', '期初余额', []),
    F('debit', '借方金额', ['借方发生额', '借方']),
    F('credit', '贷方金额', ['贷方发生额', '贷方']),
    F('end', '期末余额', []),
    F('supplierName', '供应商', ['供应商名称', '往来单位'], false),
  ],
};

export interface VoucherLine {
  sourceRow: number; voucherDate: string; voucherNo: string; entryNo: string; accountCode: string; accountName: string;
  summary: string | null; debit: bigint; credit: bigint; projectCode: string | null; projectName: string | null;
  deptName: string | null; supplierName: string | null; fundSource: string | null;
}
export interface BalanceLine {
  sourceRow: number; accountCode: string; accountName: string; beginDebit: bigint; beginCredit: bigint; debit: bigint; credit: bigint;
  endDebit: bigint; endCredit: bigint; projectCode: string | null; projectName: string | null; deptName: string | null; supplierName: string | null;
}
export interface AuxLine {
  sourceRow: number; auxType: string; auxCode: string; auxName: string; accountCode: string; accountName: string;
  begin: bigint; debit: bigint; credit: bigint; end: bigint; supplierName: string | null;
}

export type ParsedEas =
  | { dataType: 'voucher'; company: string; period: string; lines: VoucherLine[]; debitTotal: bigint; creditTotal: bigint }
  | { dataType: 'balance'; company: string; period: string; lines: BalanceLine[]; debitTotal: bigint; creditTotal: bigint }
  | { dataType: 'auxiliary'; company: string; period: string; lines: AuxLine[]; debitTotal: bigint; creditTotal: bigint };

function locateColumns(table: ReadTable, dataType: EasDataType): Record<string, string> {
  const available = new Set(table.headers);
  const cols: Record<string, string> = {};
  const missing: string[] = [];
  for (const spec of FIELDS[dataType]) {
    const found = spec.aliases.filter((a) => available.has(a.replace(/\s+/g, '')));
    if (found.length > 1) throw Errors.validation(`表头“${spec.label}”匹配到多个列:${found.join('、')}`);
    if (found.length === 1) cols[spec.key] = found[0];
    else if (spec.required) missing.push(spec.label);
  }
  if (missing.length) throw new AppError('EAS_COLUMNS_MISSING', `文件缺少必填列:${missing.join('、')}`, 400);
  return cols;
}

class RowReader {
  constructor(private values: Record<string, string>, private cols: Record<string, string>, private rowNo: number, private errors: RowError[]) {}
  raw(key: string): string { const col = this.cols[key]; return col ? (this.values[col] ?? '').trim() : ''; }
  text(key: string, label: string): string {
    const v = this.raw(key);
    if (!v) this.errors.push({ row: this.rowNo, field: label, message: `${label}不能为空` });
    else if (v.length > 200) this.errors.push({ row: this.rowNo, field: label, message: `${label}超过 200 字符` });
    return v;
  }
  optional(key: string): string | null { const v = this.raw(key); return v ? v.slice(0, 200) : null; }
  money(key: string, label: string): bigint {
    const normalized = normalizeImportedNumber(this.raw(key));
    if (!normalized) { this.errors.push({ row: this.rowNo, field: label, message: `${label}不能为空(零请填写 0)` }); return 0n; }
    try {
      return parseDecimalToCents(normalized, { label });
    } catch (err) {
      this.errors.push({ row: this.rowNo, field: label, message: err instanceof Error ? err.message : `${label}格式不正确` });
      return 0n;
    }
  }
}

function normalizePeriod(raw: string): string | null {
  const m = /^(\d{4})[-./年](\d{1,2})月?$/.exec(raw.trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}`;
}

function normalizeDate(raw: string): string | null {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(raw.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isValidDate(iso) ? iso : null;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

export function parseEasTable(table: ReadTable, dataType: EasDataType): ParsedEas {
  if (table.rows.length === 0) throw Errors.validation('文件没有数据行');
  const cols = locateColumns(table, dataType);
  const errors: RowError[] = [];
  const companies = new Set<string>();
  const periods = new Set<string>();
  const keys = new Map<string, number>();
  const lines: (VoucherLine | BalanceLine | AuxLine)[] = [];
  let debitTotal = 0n;
  let creditTotal = 0n;

  const uniqueKey = (rowNo: number, key: string, label: string) => {
    const k = key.toLocaleLowerCase('zh-CN');
    const prior = keys.get(k);
    if (prior) errors.push({ row: rowNo, field: label, message: `与第 ${prior} 行业务键重复` });
    else keys.set(k, rowNo);
  };

  for (const { rowNo, values } of table.rows) {
    const r = new RowReader(values, cols, rowNo, errors);
    const company = r.text('company', '公司');
    const periodRaw = r.text('period', '期间');
    const period = periodRaw ? normalizePeriod(periodRaw) : null;
    if (periodRaw && !period) errors.push({ row: rowNo, field: '期间', message: '期间必须是 YYYY-MM 格式' });
    if (company) companies.add(company);
    if (period) periods.add(period);
    const accountCode = r.text('accountCode', '科目编码');
    const accountName = r.text('accountName', '科目名称');

    if (dataType === 'voucher') {
      const dateRaw = r.text('voucherDate', '凭证日期');
      const voucherDate = dateRaw ? normalizeDate(dateRaw) : null;
      if (dateRaw && !voucherDate) errors.push({ row: rowNo, field: '凭证日期', message: '凭证日期无效' });
      if (voucherDate && period && voucherDate.slice(0, 7) !== period) errors.push({ row: rowNo, field: '凭证日期', message: '凭证日期与期间不属于同一月份' });
      const voucherNo = r.text('voucherNo', '凭证号');
      const entryNo = r.text('entryNo', '分录号');
      const debit = r.money('debit', '借方金额');
      const credit = r.money('credit', '贷方金额');
      if (debit < 0n || credit < 0n) errors.push({ row: rowNo, field: '金额', message: '借贷金额不能为负数(冲销请用反方向记账)' });
      else if ((debit === 0n) === (credit === 0n)) errors.push({ row: rowNo, field: '金额', message: '凭证分录必须且只能填写借方或贷方一侧' });
      uniqueKey(rowNo, `${voucherNo}|${entryNo}`, '凭证号/分录号');
      debitTotal += debit; creditTotal += credit;
      lines.push({
        sourceRow: rowNo, voucherDate: voucherDate ?? '', voucherNo, entryNo, accountCode, accountName, summary: r.optional('summary'),
        debit, credit, projectCode: r.optional('projectCode'), projectName: r.optional('projectName'), deptName: r.optional('deptName'),
        supplierName: r.optional('supplierName'), fundSource: r.optional('fundSource'),
      });
    } else if (dataType === 'balance') {
      const v = {
        beginDebit: r.money('beginDebit', '期初借方'), beginCredit: r.money('beginCredit', '期初贷方'),
        debit: r.money('debit', '本期借方'), credit: r.money('credit', '本期贷方'),
        endDebit: r.money('endDebit', '期末借方'), endCredit: r.money('endCredit', '期末贷方'),
      };
      if (Object.values(v).some((x) => x < 0n)) errors.push({ row: rowNo, field: '金额', message: '余额与发生额不能为负数' });
      if (v.beginDebit && v.beginCredit) errors.push({ row: rowNo, field: '期初', message: '期初借贷余额不能同时有值' });
      if (v.endDebit && v.endCredit) errors.push({ row: rowNo, field: '期末', message: '期末借贷余额不能同时有值' });
      const lhs = v.beginDebit - v.beginCredit + v.debit - v.credit;
      if (abs(lhs - (v.endDebit - v.endCredit)) > TOLERANCE_CENTS) errors.push({ row: rowNo, field: '期末', message: '期初余额 + 本期发生额 不等于期末余额' });
      const projectCode = r.optional('projectCode'); const supplierName = r.optional('supplierName'); const deptName = r.optional('deptName');
      uniqueKey(rowNo, `${accountCode}|${projectCode ?? ''}|${supplierName ?? ''}|${deptName ?? ''}`, '科目/项目/供应商/部门');
      debitTotal += v.debit; creditTotal += v.credit;
      lines.push({ sourceRow: rowNo, accountCode, accountName, ...v, projectCode, projectName: r.optional('projectName'), deptName, supplierName });
    } else {
      const auxType = r.text('auxType', '辅助类型');
      const auxCode = r.text('auxCode', '辅助编码');
      const auxName = r.text('auxName', '辅助名称');
      const begin = r.money('begin', '期初余额');
      const debit = r.money('debit', '借方金额');
      const credit = r.money('credit', '贷方金额');
      const end = r.money('end', '期末余额');
      if (debit < 0n || credit < 0n) errors.push({ row: rowNo, field: '金额', message: '辅助核算借贷发生额不能为负数' });
      if (abs(begin + debit - credit - end) > TOLERANCE_CENTS) errors.push({ row: rowNo, field: '期末余额', message: '期初余额 + 借方 − 贷方 不等于期末余额' });
      uniqueKey(rowNo, `${auxType}|${auxCode}|${accountCode}`, '辅助类型/编码/科目');
      debitTotal += debit; creditTotal += credit;
      lines.push({ sourceRow: rowNo, auxType, auxCode, auxName, accountCode, accountName, begin, debit, credit, end, supplierName: r.optional('supplierName') });
    }
    if (errors.length >= MAX_IMPORT_ERRORS) break;
  }

  if (!errors.length && (companies.size !== 1 || periods.size !== 1)) {
    throw new AppError('EAS_FILE_SCOPE_INVALID', `每个 EAS 文件只能包含一个公司和一个期间(实际 ${companies.size} 个公司、${periods.size} 个期间)`, 400);
  }
  if (dataType === 'voucher' && !errors.length) {
    const byVoucher = new Map<string, { debit: bigint; credit: bigint; row: number }>();
    for (const l of lines as VoucherLine[]) {
      const t = byVoucher.get(l.voucherNo) ?? { debit: 0n, credit: 0n, row: l.sourceRow };
      t.debit += l.debit; t.credit += l.credit;
      byVoucher.set(l.voucherNo, t);
    }
    for (const [no, t] of byVoucher) {
      if (abs(t.debit - t.credit) > TOLERANCE_CENTS) errors.push({ row: t.row, field: '凭证号', message: `凭证 ${no} 借贷不平衡` });
    }
  }
  if (errors.length) throw Errors.importValidation(`EAS 文件校验失败(${errors.length} 处),未写入任何数据`, errors.slice(0, MAX_IMPORT_ERRORS));
  const company = [...companies][0];
  const period = [...periods][0];
  return { dataType, company, period, lines, debitTotal, creditTotal } as ParsedEas;
}
