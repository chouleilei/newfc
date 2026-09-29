import type ExcelJS from 'exceljs';
import type { DB } from '../../../db/connection';
import { Errors } from '../../../core/errors';
import { centsToYuanString, displayToSignedCents, isQuantityType, quantityStringToScaled, safeIntegerAdd, scaledToQuantityString, signOfType, yuanStringToCents, type AccountType } from '../../../core/money';
import { isAccountVisibleForScope } from '../../../core/accountScope';
import * as budget from '../../budget/budget.service';
import * as actual from '../../actual/actual.service';
import { importedAmountToYuan, normalizeImportedNumber } from '../import-values';
import { MAX_IMPORT_ERRORS } from '../import-limits';
import { cellHasFormula, displayCellValue } from './workbook';
import { assertTargetMatchesPlan, columnIndex, type CleaningPlan, type CleaningTarget } from './plan';
import { createMatchingContext, loadAliasMaps, manualMappingMaps, matchEntity, type MatchCandidate, type MatchingContext, type MatchingTarget } from './matching';

export interface CleaningIssue {
  sheetName: string;
  row: number;
  field: string;
  code: string;
  message: string;
}

export interface CleaningAnalysisRow {
  sheetName: string;
  rowNumber: number;
  hidden: boolean;
  excluded: boolean;
  exclusionReason?: string;
  suspectedReason?: string;
  sourceOrgText: string;
  sourceAccountText: string;
  sourceValueText: string;
  targetOrgId?: number;
  targetOrgCode?: string;
  targetAccountId?: number;
  targetAccountCode?: string;
  targetAccountType?: string;
  normalizedValue: string;
  expectedSignedCents?: number;
  quantityScaled?: number;
  note: string;
  warnings: string[];
}

export interface UnresolvedNameGroup {
  kind: 'org' | 'account';
  sourceText: string;
  rows: { sheetName: string; row: number }[];
  candidates: MatchCandidate[];
  staleAliasTarget?: string;
}

export interface CleaningApplyResult {
  target: CleaningTarget;
  plan: CleaningPlan;
  valueKind: 'amount' | 'quantity';
  rows: CleaningAnalysisRow[];
  entries: (budget.BudgetEntryInput | actual.ActualEntryInput)[];
  errors: CleaningIssue[];
  warnings: CleaningIssue[];
  unresolved: UnresolvedNameGroup[];
  targets: { orgs: MatchingTarget[]; accounts: MatchingTarget[] };
  exclusionSummary: {
    amount?: { sourceAmountCents: number };
    quantity?: { groups: { accountCode: string; unit: string; quantityScaled: number }[] };
  };
  counts: { selected: number; effective: number; excluded: number; errors: number; warnings: number; unresolved: number };
}

function issue(sheetName: string, row: number, field: string, code: string, message: string): CleaningIssue {
  return { sheetName, row, field, code, message };
}

function capIssues(issues: CleaningIssue[]): CleaningIssue[] {
  if (issues.length <= MAX_IMPORT_ERRORS) return issues;
  const omitted = issues.length - (MAX_IMPORT_ERRORS - 1);
  return [...issues.slice(0, MAX_IMPORT_ERRORS - 1), issue('', 0, 'file', 'MORE_ISSUES', `另有 ${omitted} 条问题未展示` )];
}

function mappedText(row: ExcelJS.Row, column: number | undefined): string {
  return column == null ? '' : displayCellValue(row.getCell(column));
}

function isTruthyIgnore(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase('zh-CN');
  return Boolean(normalized) && !['0', 'false', '否', 'no', 'n'].includes(normalized);
}

function rowHasContent(row: ExcelJS.Row): boolean {
  let hasContent = false;
  row.eachCell({ includeEmpty: false }, (cell) => {
    if (cellHasFormula(cell) || displayCellValue(cell).trim()) hasContent = true;
  });
  return hasContent;
}

function suspectedReason(values: Record<string, string>, row: ExcelJS.Row, mappedColumns: number[]): string | undefined {
  const all = Object.values(values);
  // “完全空行”必须检查整行，而不能只看用户已映射的列。未映射列里的数据也可能是
  // 识别布局错误的重要证据，不能在无提示的情况下自动排除。
  if (!rowHasContent(row)) return '完全空行';
  if (!values.orgCode && !values.orgName && !values.accountCode && !values.accountName) return '组织和科目均为空';
  if (all.some((value) => /(小计|合计|总计|汇总)/.test(value))) return '疑似小计或合计行';
  if (values.note && Object.entries(values).every(([key, value]) => key === 'note' || !value)) return '整行只有备注文本';
  if (mappedColumns.some((column) => row.getCell(column).isMerged)) return '合并单元格形成的标题行';
  return undefined;
}

function sourceLabel(code: string, name: string): string {
  return name.trim() || code.trim();
}

function addUnresolved(
  map: Map<string, UnresolvedNameGroup>,
  kind: 'org' | 'account',
  sourceText: string,
  coordinate: { sheetName: string; row: number },
  candidates: MatchCandidate[],
  staleAliasTarget?: string,
): void {
  const key = `${kind}:${sourceText.normalize('NFKC').trim().replace(/\s+/g, '').toLocaleLowerCase('zh-CN')}`;
  const current = map.get(key);
  if (current) current.rows.push(coordinate);
  else map.set(key, { kind, sourceText, rows: [coordinate], candidates, staleAliasTarget });
}

function validateWorkbookPlan(workbook: ExcelJS.Workbook, plan: CleaningPlan): void {
  for (const range of plan.sheets) {
    const sheet = workbook.getWorksheet(range.sheetName);
    if (!sheet) throw Errors.validation(`工作表“${range.sheetName}”不存在`);
    if (range.headerRow > sheet.rowCount || range.dataEndRow > sheet.rowCount) throw Errors.validation(`工作表“${range.sheetName}”的所选行超出使用范围 ${sheet.rowCount}`);
    for (const column of plan.columns) {
      if (column.sourceColumn > Math.max(sheet.columnCount, 1)) throw Errors.validation(`工作表“${range.sheetName}”不存在第 ${column.sourceColumn} 列`);
      if (sheet.getRow(range.headerRow).getCell(column.sourceColumn).isMerged) throw Errors.validation(`工作表“${range.sheetName}”的表头包含合并单元格；首期只支持单层、未合并表头`);
    }
  }
}

function existingBudgetMap(db: DB, versionId: number): Map<string, ReturnType<typeof budget.getEditMatrix>['entries'][number]> {
  const matrix = budget.getEditMatrix(db, versionId);
  return new Map(matrix.entries.map((entry) => [`${entry.orgId}:${entry.accountId}`, entry]));
}

function assertActualTargetOpen(db: DB, target: CleaningTarget): void {
  if (target.targetKind !== 'actual-current') return;
  const state = actual.getYearState(db, target.year!);
  if (state?.status === 'frozen') throw Errors.conflict(`${target.year} 年度已冻结，不能更新当前实际数`);
  actual.assertSnapshotDateNotBeforeCurrent(db, target.year!, target.snapshotDate!);
}

export function applyCleaningPlan(
  db: DB,
  workbook: ExcelJS.Workbook,
  target: CleaningTarget,
  plan: CleaningPlan,
): CleaningApplyResult {
  assertTargetMatchesPlan(target, plan);
  validateWorkbookPlan(workbook, plan);
  assertActualTargetOpen(db, target);
  const matching = createMatchingContext(db, target);
  const aliases = loadAliasMaps(db, target.targetKind);
  const manual = manualMappingMaps(plan.mappings);
  const existingBudget = target.targetKind === 'budget' ? existingBudgetMap(db, target.versionId!) : new Map();
  const existingActual = target.targetKind === 'actual-current'
    ? new Set((db.prepare('SELECT org_id, account_id FROM actual_current WHERE year = ?').all(target.year!) as { org_id: number; account_id: number }[]).map((row) => `${row.org_id}:${row.account_id}`))
    : new Set<string>();
  const excluded = new Map(plan.excludedRows.map((row) => [`${row.sheetName}:${row.row}`, row.reason]));
  const errors: CleaningIssue[] = [];
  const warnings: CleaningIssue[] = [];
  const rows: CleaningAnalysisRow[] = [];
  const entries: (budget.BudgetEntryInput | actual.ActualEntryInput)[] = [];
  const unresolved = new Map<string, UnresolvedNameGroup>();
  const seen = new Map<string, { sheetName: string; row: number }>();
  const mappedColumns = plan.columns.map((column) => column.sourceColumn);
  const columns = {
    orgCode: columnIndex(plan, 'orgCode'), orgName: columnIndex(plan, 'orgName'),
    accountCode: columnIndex(plan, 'accountCode'), accountName: columnIndex(plan, 'accountName'),
    value: columnIndex(plan, plan.valueKind), note: columnIndex(plan, 'note'), ignore: columnIndex(plan, 'ignore'),
  };

  for (const range of plan.sheets) {
    const sheet = workbook.getWorksheet(range.sheetName)!;
    for (let rowNumber = range.dataStartRow; rowNumber <= range.dataEndRow; rowNumber++) {
      const excelRow = sheet.getRow(rowNumber);
      const values = Object.fromEntries(plan.columns.map((column) => [column.field, mappedText(excelRow, column.sourceColumn)])) as Record<string, string>;
      const sourceOrgText = sourceLabel(values.orgCode ?? '', values.orgName ?? '');
      const sourceAccountText = sourceLabel(values.accountCode ?? '', values.accountName ?? '');
      const sourceValueText = values[plan.valueKind] ?? '';
      const note = values.note ?? '';
      const suspected = suspectedReason(values, excelRow, mappedColumns);
      const explicitReason = excluded.get(`${range.sheetName}:${rowNumber}`);
      const automaticEmpty = suspected === '完全空行';
      const ignoredByColumn = columns.ignore != null && isTruthyIgnore(values.ignore ?? '');
      const exclusionReason = explicitReason ?? (automaticEmpty ? '完全空行' : ignoredByColumn ? '忽略列标记' : undefined);
      const rowWarnings: string[] = [];
      if (excelRow.hidden) rowWarnings.push('隐藏行被纳入');
      if (suspected && !automaticEmpty && !exclusionReason) rowWarnings.push(suspected);
      const resultRow: CleaningAnalysisRow = {
        sheetName: range.sheetName,
        rowNumber,
        hidden: excelRow.hidden === true,
        excluded: Boolean(exclusionReason),
        exclusionReason,
        suspectedReason: suspected,
        sourceOrgText,
        sourceAccountText,
        sourceValueText,
        normalizedValue: '',
        note,
        warnings: rowWarnings,
      };
      rows.push(resultRow);
      if (exclusionReason) {
        // 排除行不参与业务校验，但尽量解析其目标和值，供“排除金额/按科目与单位排除数量”汇总。
        const excludedOrg = sourceOrgText ? matchEntity('org', { codeText: values.orgCode ?? '', nameText: values.orgName ?? '' }, matching, manual, aliases).target : undefined;
        const excludedAccount = sourceAccountText ? matchEntity('account', { codeText: values.accountCode ?? '', nameText: values.accountName ?? '' }, matching, manual, aliases).target : undefined;
        if (excludedOrg && excludedAccount) {
          resultRow.targetOrgId = excludedOrg.id;
          resultRow.targetOrgCode = excludedOrg.code;
          resultRow.targetAccountId = excludedAccount.id;
          resultRow.targetAccountCode = excludedAccount.code;
          resultRow.targetAccountType = excludedAccount.type;
          try {
            if (sourceValueText.trim() && !cellHasFormula(excelRow.getCell(columns.value!))) {
              if (plan.valueKind === 'quantity' && isQuantityType(excludedAccount.type)) {
                resultRow.quantityScaled = quantityStringToScaled(normalizeImportedNumber(sourceValueText));
                resultRow.normalizedValue = scaledToQuantityString(resultRow.quantityScaled);
              } else if (plan.valueKind === 'amount' && !isQuantityType(excludedAccount.type)) {
                const sourceYuan = importedAmountToYuan(sourceValueText, plan.amountUnit!);
                const sourceCents = yuanStringToCents(sourceYuan);
                const accountType = (excludedAccount.type ?? 'expense') as Exclude<AccountType, 'quantity'>;
                const displayCents = plan.signConvention === 'profit_signed' ? sourceCents * signOfType(accountType) : sourceCents;
                resultRow.normalizedValue = centsToYuanString(displayCents);
                resultRow.expectedSignedCents = displayToSignedCents(resultRow.normalizedValue, accountType);
              }
            }
          } catch { /* 排除行的非法值只保留原文，不阻断 */ }
        }
        continue;
      }
      if (excelRow.hidden) warnings.push(issue(range.sheetName, rowNumber, 'row', 'HIDDEN_ROW_INCLUDED', '隐藏行被纳入导入'));
      if (suspected && !automaticEmpty) warnings.push(issue(range.sheetName, rowNumber, 'row', 'SUSPECTED_SUMMARY_ROW', suspected));

      if (!sourceOrgText) errors.push(issue(range.sheetName, rowNumber, 'organization', 'ORG_EMPTY', '组织编码和名称均为空；如为标题或合计行请明确排除'));
      if (!sourceAccountText) errors.push(issue(range.sheetName, rowNumber, 'account', 'ACCOUNT_EMPTY', '科目编码和名称均为空；如为标题或合计行请明确排除'));
      const orgMatch = sourceOrgText ? matchEntity('org', { codeText: values.orgCode ?? '', nameText: values.orgName ?? '' }, matching, manual, aliases) : undefined;
      const accountMatch = sourceAccountText ? matchEntity('account', { codeText: values.accountCode ?? '', nameText: values.accountName ?? '' }, matching, manual, aliases) : undefined;
      for (const [kind, match] of [['org', orgMatch], ['account', accountMatch]] as const) {
        if (!match) continue;
        if (match.conflictingExactTargets) {
          errors.push(issue(range.sheetName, rowNumber, kind, 'CODE_NAME_CONFLICT', `编码与名称分别命中不同目标：${match.conflictingExactTargets}`));
        } else if (match.invalidManualTarget) {
          errors.push(issue(range.sheetName, rowNumber, kind, 'MANUAL_TARGET_INVALID', `人工映射目标 ${match.invalidManualTarget} 不在当前目标树可录入叶子中`));
        } else if (!match.target) {
          addUnresolved(unresolved, kind, match.sourceText, { sheetName: range.sheetName, row: rowNumber }, match.candidates, match.staleAliasTarget);
        }
      }
      const orgTarget = orgMatch?.target;
      const accountTarget = accountMatch?.target;
      if (!orgTarget || !accountTarget) continue;
      resultRow.targetOrgId = orgTarget.id;
      resultRow.targetOrgCode = orgTarget.code;
      resultRow.targetAccountId = accountTarget.id;
      resultRow.targetAccountCode = accountTarget.code;
      resultRow.targetAccountType = accountTarget.type;
      if (orgMatch?.method !== 'code' || accountMatch?.method !== 'code') {
        const text = '使用名称或别名完成匹配';
        rowWarnings.push(text);
        warnings.push(issue(range.sheetName, rowNumber, 'mapping', 'NON_CODE_MATCH', text));
      }
      const key = `${orgTarget.id}:${accountTarget.id}`;
      const alreadyExists = target.targetKind === 'budget' ? existingBudget.has(key) : existingActual.has(key);
      if (target.targetKind === 'actual-current' && !alreadyExists && (orgTarget.status !== 'active' || accountTarget.status !== 'active')) {
        errors.push(issue(range.sheetName, rowNumber, 'mapping', 'INACTIVE_TARGET_FOR_INSERT', `停用节点 ${orgTarget.code}/${accountTarget.code} 仅允许更正已有实际数，不能新增组合`));
      }
      if (!isAccountVisibleForScope(accountTarget.code, new Set([orgTarget.code]))) {
        errors.push(issue(range.sheetName, rowNumber, 'mapping', 'ACCOUNT_NOT_APPLICABLE', `科目 ${accountTarget.code} 不适用于组织 ${orgTarget.code}`));
      }
      const accountType = (accountTarget.type ?? 'expense') as AccountType;
      if (plan.valueKind === 'amount' && isQuantityType(accountType)) {
        errors.push(issue(range.sheetName, rowNumber, 'amount', 'AMOUNT_FOR_QUANTITY_ACCOUNT', `金额列命中数量科目 ${accountTarget.code}`));
        continue;
      }
      if (plan.valueKind === 'quantity' && !isQuantityType(accountType)) {
        errors.push(issue(range.sheetName, rowNumber, 'quantity', 'QUANTITY_FOR_AMOUNT_ACCOUNT', `数量列命中金额科目 ${accountTarget.code}`));
        continue;
      }
      const valueCell = excelRow.getCell(columns.value!);
      if (cellHasFormula(valueCell)) {
        errors.push(issue(range.sheetName, rowNumber, plan.valueKind, 'VALUE_FORMULA_NOT_ALLOWED', '金额或数量单元格为公式，请复制并粘贴为值后重新上传'));
        continue;
      }
      if (!sourceValueText.trim()) {
        errors.push(issue(range.sheetName, rowNumber, plan.valueKind, 'VALUE_EMPTY', `${plan.valueKind === 'amount' ? '金额' : '数量'}为空；清零请明确填写 0`));
        continue;
      }

      try {
        let entry: budget.BudgetEntryInput | actual.ActualEntryInput;
        if (plan.valueKind === 'amount') {
          const sourceYuan = importedAmountToYuan(sourceValueText, plan.amountUnit!);
          const sourceCents = yuanStringToCents(sourceYuan);
          const displayCents = plan.signConvention === 'profit_signed' ? sourceCents * signOfType(accountType) : sourceCents;
          const displayAmount = centsToYuanString(displayCents);
          resultRow.normalizedValue = displayAmount;
          resultRow.expectedSignedCents = displayToSignedCents(displayAmount, accountType as Exclude<AccountType, 'quantity'>);
          entry = { orgId: orgTarget.id, accountId: accountTarget.id, amount: displayAmount };
        } else {
          const normalized = normalizeImportedNumber(sourceValueText);
          const scaled = quantityStringToScaled(normalized);
          resultRow.normalizedValue = scaledToQuantityString(scaled);
          resultRow.quantityScaled = scaled;
          entry = { orgId: orgTarget.id, accountId: accountTarget.id, quantity: resultRow.normalizedValue };
          if (scaled < 0) {
            const text = '数量为负数，请确认其代表冲销或更正';
            rowWarnings.push(text);
            warnings.push(issue(range.sheetName, rowNumber, 'quantity', 'NEGATIVE_QUANTITY', text));
          }
        }
        if (target.targetKind === 'budget') {
          const old = existingBudget.get(key);
          (entry as budget.BudgetEntryInput).formula = old?.formula ?? '';
          (entry as budget.BudgetEntryInput).note = columns.note == null
            ? old?.note ?? ''
            : note.trim() || (!plan.clearBlankNotes ? old?.note ?? '' : '');
        } else {
          (entry as actual.ActualEntryInput).memo = note;
        }
        const prior = seen.get(key);
        if (prior) {
          errors.push(issue(range.sheetName, rowNumber, 'mapping', 'DUPLICATE_TARGET', `组织—科目组合重复；首次出现在 ${prior.sheetName}!${prior.row}`));
          continue;
        }
        seen.set(key, { sheetName: range.sheetName, row: rowNumber });
        entries.push(entry);
      } catch (error) {
        errors.push(issue(range.sheetName, rowNumber, plan.valueKind, 'VALUE_INVALID', error instanceof Error ? error.message : '数值格式不正确'));
      }
    }
  }
  const unresolvedGroups = [...unresolved.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceText.localeCompare(b.sourceText));
  let excludedAmountCents = 0;
  const excludedQuantity = new Map<string, { accountCode: string; unit: string; quantityScaled: number }>();
  for (const row of rows.filter((item) => item.excluded && item.sourceValueText.trim())) {
    try {
      if (plan.valueKind === 'amount') {
        excludedAmountCents = safeIntegerAdd(excludedAmountCents, yuanStringToCents(importedAmountToYuan(row.sourceValueText, plan.amountUnit!)), '排除金额合计');
      } else {
        const targetAccount = matching.accountTargets.find((item) => item.id === row.targetAccountId);
        const accountCode = targetAccount?.code ?? (row.sourceAccountText || '未匹配科目');
        const group = excludedQuantity.get(accountCode) ?? { accountCode, unit: targetAccount?.unit ?? '', quantityScaled: 0 };
        group.quantityScaled = safeIntegerAdd(group.quantityScaled, row.quantityScaled ?? quantityStringToScaled(normalizeImportedNumber(row.sourceValueText)), '排除数量合计');
        excludedQuantity.set(accountCode, group);
      }
    } catch { /* 排除行的原始值仍展示，但不因汇总失败阻断 */ }
  }
  return {
    target,
    plan,
    valueKind: plan.valueKind,
    rows,
    entries,
    errors: capIssues(errors),
    warnings: capIssues(warnings),
    unresolved: unresolvedGroups,
    targets: { orgs: matching.orgTargets, accounts: matching.accountTargets },
    exclusionSummary: plan.valueKind === 'amount'
      ? { amount: { sourceAmountCents: excludedAmountCents } }
      : { quantity: { groups: [...excludedQuantity.values()] } },
    counts: {
      selected: rows.length,
      effective: entries.length,
      excluded: rows.filter((row) => row.excluded).length,
      errors: errors.length,
      warnings: warnings.length,
      unresolved: unresolvedGroups.reduce((sum, group) => sum + group.rows.length, 0),
    },
  };
}
