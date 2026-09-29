import { Errors } from '../../../core/errors';
import { isValidDate, yearOfDate } from '../../../core/dates';
import { MAX_CLEANING_COLUMNS, MAX_CLEANING_SHEETS, MAX_IMPORT_ROWS } from '../import-limits';

export type CleaningTargetKind = 'budget' | 'actual-current';
export type CleaningValueKind = 'amount' | 'quantity';
export type CleaningAmountUnit = 'yuan' | 'wan';
export type CleaningSignConvention = 'display_positive' | 'profit_signed';
export type CleaningColumnField = 'orgCode' | 'orgName' | 'accountCode' | 'accountName' | 'amount' | 'quantity' | 'note' | 'ignore';

export interface CleaningTarget {
  targetKind: CleaningTargetKind;
  versionId?: number;
  year?: number;
  snapshotDate?: string;
}

export interface CleaningSheetPlan {
  sheetName: string;
  headerRow: number;
  dataStartRow: number;
  dataEndRow: number;
}

export interface CleaningColumnMapping {
  sourceColumn: number;
  field: CleaningColumnField;
}

export interface CleaningExcludedRow {
  sheetName: string;
  row: number;
  reason: string;
}

export interface CleaningNameMapping {
  kind: 'org' | 'account';
  sourceText: string;
  targetCode: string;
}

export interface CleaningPlan {
  version: 1;
  targetKind: CleaningTargetKind;
  sheets: CleaningSheetPlan[];
  columns: CleaningColumnMapping[];
  valueKind: CleaningValueKind;
  amountUnit?: CleaningAmountUnit;
  signConvention?: CleaningSignConvention;
  excludedRows: CleaningExcludedRow[];
  mappings: CleaningNameMapping[];
  clearBlankNotes?: boolean;
  templateId?: number;
  aiSuggested?: boolean;
}

const TARGET_KINDS = new Set<CleaningTargetKind>(['budget', 'actual-current']);
const VALUE_KINDS = new Set<CleaningValueKind>(['amount', 'quantity']);
const FIELDS = new Set<CleaningColumnField>(['orgCode', 'orgName', 'accountCode', 'accountName', 'amount', 'quantity', 'note', 'ignore']);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Errors.validation(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw Errors.validation(`${label} 必须是正整数`);
  return parsed;
}

function shortString(value: unknown, label: string, max = 255): string {
  if (typeof value !== 'string' || !value.trim()) throw Errors.validation(`${label} 不能为空`);
  if (value.trim().length > max) throw Errors.validation(`${label} 不能超过 ${max} 字符`);
  return value.trim();
}

export function parseCleaningTarget(raw: unknown): CleaningTarget {
  const input = object(raw, 'target');
  const targetKind = input.targetKind;
  if (typeof targetKind !== 'string' || !TARGET_KINDS.has(targetKind as CleaningTargetKind)) {
    throw Errors.validation('targetKind 必须为 budget 或 actual-current');
  }
  if (targetKind === 'budget') {
    return { targetKind, versionId: positiveInteger(input.versionId, 'versionId') };
  }
  const year = positiveInteger(input.year, 'year');
  if (year < 1900 || year > 9999) throw Errors.validation('year 必须在 1900 到 9999 之间');
  const snapshotDate = shortString(input.snapshotDate, 'snapshotDate', 10);
  if (!isValidDate(snapshotDate) || yearOfDate(snapshotDate) !== year) throw Errors.validation('snapshotDate 必须是目标年度内的有效日期');
  return { targetKind: targetKind as CleaningTargetKind, year, snapshotDate };
}

export function parseCleaningPlan(raw: unknown): CleaningPlan {
  const input = object(raw, 'plan');
  if (input.version !== 1) throw Errors.validation('仅支持 CleaningPlan version=1');
  const targetKind = input.targetKind;
  if (typeof targetKind !== 'string' || !TARGET_KINDS.has(targetKind as CleaningTargetKind)) throw Errors.validation('plan.targetKind 不合法');
  if (!Array.isArray(input.sheets) || input.sheets.length < 1 || input.sheets.length > MAX_CLEANING_SHEETS) {
    throw Errors.validation(`必须选择 1 到 ${MAX_CLEANING_SHEETS} 个工作表`);
  }
  const seenSheets = new Set<string>();
  let selectedRows = 0;
  const sheets = input.sheets.map((rawSheet, index): CleaningSheetPlan => {
    const sheet = object(rawSheet, `sheets[${index}]`);
    const sheetName = shortString(sheet.sheetName, `sheets[${index}].sheetName`);
    if (seenSheets.has(sheetName)) throw Errors.validation(`工作表 ${sheetName} 重复选择`);
    seenSheets.add(sheetName);
    const headerRow = positiveInteger(sheet.headerRow, `${sheetName}.headerRow`);
    const dataStartRow = positiveInteger(sheet.dataStartRow, `${sheetName}.dataStartRow`);
    const dataEndRow = positiveInteger(sheet.dataEndRow, `${sheetName}.dataEndRow`);
    if (dataStartRow <= headerRow) throw Errors.validation(`${sheetName} 的数据开始行必须晚于表头行`);
    if (dataEndRow < dataStartRow) throw Errors.validation(`${sheetName} 的数据结束行不能早于开始行`);
    selectedRows += dataEndRow - dataStartRow + 1;
    return { sheetName, headerRow, dataStartRow, dataEndRow };
  });
  if (selectedRows > MAX_IMPORT_ROWS) throw Errors.validation(`选中区域合计超过 ${MAX_IMPORT_ROWS} 行`);

  if (!Array.isArray(input.columns) || input.columns.length < 3 || input.columns.length > MAX_CLEANING_COLUMNS) {
    throw Errors.validation(`列映射数量必须在 3 到 ${MAX_CLEANING_COLUMNS} 之间`);
  }
  const sourceColumns = new Set<number>();
  const fields = new Set<CleaningColumnField>();
  const columns = input.columns.map((rawColumn, index): CleaningColumnMapping => {
    const column = object(rawColumn, `columns[${index}]`);
    const sourceColumn = positiveInteger(column.sourceColumn, `columns[${index}].sourceColumn`);
    if (sourceColumn > MAX_CLEANING_COLUMNS) throw Errors.validation(`源列不能超过第 ${MAX_CLEANING_COLUMNS} 列`);
    if (typeof column.field !== 'string' || !FIELDS.has(column.field as CleaningColumnField)) throw Errors.validation(`columns[${index}].field 不合法`);
    const field = column.field as CleaningColumnField;
    if (sourceColumns.has(sourceColumn)) throw Errors.validation(`源列 ${sourceColumn} 被重复映射`);
    if (fields.has(field)) throw Errors.validation(`系统字段 ${field} 被重复映射`);
    sourceColumns.add(sourceColumn);
    fields.add(field);
    return { sourceColumn, field };
  });
  if (!fields.has('orgCode') && !fields.has('orgName')) throw Errors.validation('组织编码或组织名称至少映射一列');
  if (!fields.has('accountCode') && !fields.has('accountName')) throw Errors.validation('科目编码或科目名称至少映射一列');
  const valueKind = input.valueKind;
  if (typeof valueKind !== 'string' || !VALUE_KINDS.has(valueKind as CleaningValueKind)) throw Errors.validation('valueKind 必须为 amount 或 quantity');
  if (fields.has('amount') === fields.has('quantity')) throw Errors.validation('金额和数量列必须且只能映射一个');
  if (valueKind === 'amount' && !fields.has('amount')) throw Errors.validation('金额导入必须映射 amount 列');
  if (valueKind === 'quantity' && !fields.has('quantity')) throw Errors.validation('数量导入必须映射 quantity 列');

  let amountUnit: CleaningAmountUnit | undefined;
  let signConvention: CleaningSignConvention | undefined;
  if (valueKind === 'amount') {
    if (input.amountUnit !== 'yuan' && input.amountUnit !== 'wan') throw Errors.validation('金额导入必须明确选择元或万元');
    if (input.signConvention !== 'display_positive' && input.signConvention !== 'profit_signed') throw Errors.validation('金额导入必须明确选择负数口径');
    amountUnit = input.amountUnit;
    signConvention = input.signConvention;
  }

  const excludedRows: CleaningExcludedRow[] = [];
  const excludedKeys = new Set<string>();
  if (input.excludedRows !== undefined && !Array.isArray(input.excludedRows)) throw Errors.validation('excludedRows 必须是数组');
  for (const [index, rawExcluded] of (input.excludedRows as unknown[] | undefined ?? []).entries()) {
    const excluded = object(rawExcluded, `excludedRows[${index}]`);
    const sheetName = shortString(excluded.sheetName, `excludedRows[${index}].sheetName`);
    const row = positiveInteger(excluded.row, `excludedRows[${index}].row`);
    const range = sheets.find((item) => item.sheetName === sheetName);
    if (!range || row < range.dataStartRow || row > range.dataEndRow) throw Errors.validation(`排除行 ${sheetName}!${row} 不在所选数据区域`);
    const key = `${sheetName}:${row}`;
    if (excludedKeys.has(key)) throw Errors.validation(`排除行 ${sheetName}!${row} 重复`);
    excludedKeys.add(key);
    excludedRows.push({ sheetName, row, reason: typeof excluded.reason === 'string' && excluded.reason.trim() ? excluded.reason.trim().slice(0, 200) : '用户排除' });
  }

  const mappings: CleaningNameMapping[] = [];
  const mappingKeys = new Set<string>();
  if (input.mappings !== undefined && !Array.isArray(input.mappings)) throw Errors.validation('mappings 必须是数组');
  for (const [index, rawMapping] of (input.mappings as unknown[] | undefined ?? []).entries()) {
    const mapping = object(rawMapping, `mappings[${index}]`);
    if (mapping.kind !== 'org' && mapping.kind !== 'account') throw Errors.validation(`mappings[${index}].kind 不合法`);
    const sourceText = shortString(mapping.sourceText, `mappings[${index}].sourceText`, 500);
    const targetCode = shortString(mapping.targetCode, `mappings[${index}].targetCode`, 128);
    const key = `${mapping.kind}:${normalizeSourceText(sourceText)}`;
    if (mappingKeys.has(key)) throw Errors.validation(`源文本 ${sourceText} 存在重复人工映射`);
    mappingKeys.add(key);
    mappings.push({ kind: mapping.kind, sourceText, targetCode });
  }

  const templateId = input.templateId == null ? undefined : positiveInteger(input.templateId, 'templateId');
  return {
    version: 1,
    targetKind: targetKind as CleaningTargetKind,
    sheets,
    columns,
    valueKind: valueKind as CleaningValueKind,
    amountUnit,
    signConvention,
    excludedRows,
    mappings,
    clearBlankNotes: input.clearBlankNotes === true,
    templateId,
    aiSuggested: input.aiSuggested === true,
  };
}

export function assertTargetMatchesPlan(target: CleaningTarget, plan: CleaningPlan): void {
  if (target.targetKind !== plan.targetKind) throw Errors.validation('target 与 plan.targetKind 不一致');
}

export function normalizeSourceText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

export function columnIndex(plan: CleaningPlan, field: CleaningColumnField): number | undefined {
  return plan.columns.find((column) => column.field === field)?.sourceColumn;
}
