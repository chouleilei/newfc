import type { CleaningColumnField, CleaningPlan, CleaningTarget, CleaningTemplateConfig, CleaningValueKind, CleaningWorkbookUpload } from '../api/cleaning';

export const CLEANING_FIELD_LABELS: Record<CleaningColumnField, string> = {
  orgCode: '组织编码', orgName: '组织名称', accountCode: '科目编码', accountName: '科目名称',
  amount: '金额', quantity: '数量', note: '备注', ignore: '忽略标记',
};

export function excelColumnLetter(column: number): string {
  let value = column;
  let result = '';
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function templateConfigFromPlan(plan: CleaningPlan): CleaningTemplateConfig {
  const first = plan.sheets[0];
  return {
    preferredSheetName: first?.sheetName,
    headerRow: first?.headerRow,
    dataStartRow: first?.dataStartRow,
    columns: plan.columns,
    valueKind: plan.valueKind,
    amountUnit: plan.amountUnit,
    signConvention: plan.signConvention,
    multiSheet: plan.sheets.length > 1,
    clearBlankNotes: plan.clearBlankNotes,
  };
}

export function templateInitialState(config: CleaningTemplateConfig, workbook: CleaningWorkbookUpload): {
  selectedSheets: string[];
  ranges: Record<string, { headerRow: number; dataStartRow: number; dataEndRow: number }>;
  mappings: Record<number, CleaningColumnField>;
} {
  const visible = workbook.sheets.filter((sheet) => sheet.state === 'visible');
  const preferred = visible.find((sheet) => sheet.name === config.preferredSheetName) ?? visible[0];
  const selected = config.multiSheet ? visible.map((sheet) => sheet.name) : preferred ? [preferred.name] : [];
  const ranges = Object.fromEntries(selected.map((name) => {
    const sheet = workbook.sheets.find((item) => item.name === name)!;
    const headerRow = Math.min(sheet.rowCount, Math.max(1, config.headerRow ?? 1));
    const dataStartRow = Math.min(sheet.rowCount, Math.max(headerRow + 1, config.dataStartRow ?? headerRow + 1));
    return [name, { headerRow, dataStartRow, dataEndRow: sheet.rowCount }];
  }));
  return { selectedSheets: selected, ranges, mappings: Object.fromEntries(config.columns.map((column) => [column.sourceColumn, column.field])) };
}

/** 向导内人工映射的存储键(与 analyze 步骤按源文本分组的 key 一致) */
export function mappingStorageKey(kind: 'org' | 'account', sourceText: string): string {
  return `${kind}\u0000${sourceText}`;
}

/** 行坐标键(JSON 编码,与排除行/行级建议处置的 key 一致) */
export function rowCoordinateKey(sheetName: string, row: number): string {
  return JSON.stringify([sheetName, row]);
}

/** UX-17:从 reopen 返回的计划恢复出的向导配置 */
export interface CleaningWizardPlanState {
  selectedSheets: string[];
  ranges: Record<string, { headerRow: number; dataStartRow: number; dataEndRow: number }>;
  mappings: Record<number, CleaningColumnField>;
  valueKind: CleaningValueKind;
  amountUnit: 'yuan' | 'wan';
  signConvention: 'display_positive' | 'profit_signed';
  clearBlankNotes: boolean;
  templateId?: number;
  /** key 见 mappingStorageKey */
  manualMappings: Record<string, string>;
  /** key 见 rowCoordinateKey */
  excludedRowKeys: string[];
}

/**
 * UX-17:把冻结在批次中的 CleaningPlan 还原为向导各步骤的配置状态。
 * 提供 workbook 时按实际文件收敛到允许范围:仅保留仍存在的工作表,
 * 行号收敛到 rowCount 内且保持 表头 < 数据开始 ≤ 数据结束;不提供时按计划原样恢复。
 */
export function planToWizardState(plan: CleaningPlan, workbook?: Pick<CleaningWorkbookUpload, 'sheets'> | null): CleaningWizardPlanState {
  const sheets = plan.sheets.filter((sheet) => !workbook || workbook.sheets.some((item) => item.name === sheet.sheetName));
  const ranges = Object.fromEntries(sheets.map((sheet) => {
    const rowCount = workbook?.sheets.find((item) => item.name === sheet.sheetName)?.rowCount;
    const maxRow = Math.max(1, rowCount ?? Math.max(sheet.dataEndRow, sheet.dataStartRow, sheet.headerRow));
    // 保持 表头 < 数据开始 ≤ 数据结束:表头最多到 maxRow-1,为数据行留出一行
    const headerRow = Math.min(Math.max(1, maxRow - 1), Math.max(1, sheet.headerRow));
    const dataStartRow = Math.min(maxRow, Math.max(headerRow + 1, sheet.dataStartRow));
    const dataEndRow = Math.min(maxRow, Math.max(dataStartRow, sheet.dataEndRow));
    return [sheet.sheetName, { headerRow, dataStartRow, dataEndRow }];
  }));
  const manualMappings: Record<string, string> = {};
  for (const mapping of plan.mappings) manualMappings[mappingStorageKey(mapping.kind, mapping.sourceText)] = mapping.targetCode;
  return {
    selectedSheets: sheets.map((sheet) => sheet.sheetName),
    ranges,
    mappings: Object.fromEntries(plan.columns.map((column) => [column.sourceColumn, column.field])),
    valueKind: plan.valueKind,
    amountUnit: plan.amountUnit ?? 'yuan',
    signConvention: plan.signConvention ?? 'display_positive',
    clearBlankNotes: Boolean(plan.clearBlankNotes),
    templateId: plan.templateId,
    manualMappings,
    excludedRowKeys: plan.excludedRows.map((row) => rowCoordinateKey(row.sheetName, row.row)),
  };
}

/** UX-17:重传文件与失效原件的核对结论 */
export type ReuploadCheck =
  | { kind: 'same' }
  | { kind: 'changed' };

/** UX-17:核验重传文件指纹;与失效原件一致才可安全沿用行级排除与按源文本的映射 */
export function checkReupload(expectedSha256: string, uploadedSha256: string): ReuploadCheck {
  return expectedSha256 === uploadedSha256 ? { kind: 'same' } : { kind: 'changed' };
}
