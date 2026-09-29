import { EnvChatModel, modelConfigured } from '../../../assistant/model';
import { CLEANING_STRUCTURE_PROMPT } from '../../../assistant/prompts';
import type { CleaningColumnField, CleaningTargetKind } from './plan';
import type { WorkbookInspection } from './workbook';
import { CLEANING_AI_ENABLED } from '../import-limits';

export interface CleaningAiColumnSuggestion {
  col: number;
  field: CleaningColumnField;
  confidence: number;
  reason?: string;
}

export interface CleaningAiSuggestion {
  sheet: string;
  headerRow: number;
  dataStartRow: number;
  dataEndRow?: number;
  columns: CleaningAiColumnSuggestion[];
  suspectedExcludedRows: number[];
  warnings: string[];
  /** 行级识别建议(AI 功能增强计划阶段四):疑似合计/表头合并/跨页表尾等,逐条可采纳/拒绝。 */
  rowHints: CleaningAiRowHint[];
}

export type CleaningRowHintKind = 'subtotal' | 'header' | 'trailer' | 'note' | 'blank';

export interface CleaningAiRowHint {
  row: number;
  kind: CleaningRowHintKind;
  reason: string;
}

const ROW_HINT_KINDS = new Set<CleaningRowHintKind>(['subtotal', 'header', 'trailer', 'note', 'blank']);
const MAX_ROW_HINTS = 200;

const FIELDS = new Set<CleaningColumnField>(['orgCode', 'orgName', 'accountCode', 'accountName', 'amount', 'quantity', 'note', 'ignore']);

/**
 * 数字脱敏。整格数字换成结构占位符(位数信息足够判断列类型),
 * 其余文本保留标签但把嵌入的数字串一并换成 <num>——原实现只处理整格数字,
 * 「合计 1,234.56 元」「2026年6月」这类混合文本会把真实金额与期间原样送出去。
 * 全角数字先归一到半角再处理,避免用全角写的金额绕过脱敏。
 */
export function numericPlaceholder(value: string): string {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return '<date>';
  const halfWidth = text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  const normalized = halfWidth.replace(/[,，\s¥￥]/g, '').replace(/^[（(](.*)[）)]$/, '-$1');
  const match = /^[+-]?(\d+)(?:\.(\d+))?%?$/.exec(normalized);
  if (match) {
    return `${halfWidth.endsWith('%') ? '<percent' : match[2] ? '<decimal' : '<integer'}:${match[1].length}${match[2] ? `,${match[2].length}` : ''}>`;
  }
  // 混合文本:保留标签,数字串(含千分位与小数)一律折叠成 <num>
  return halfWidth.slice(0, 80).replace(/\d+(?:[,，]\d{3})*(?:\.\d+)?/g, '<num>');
}

/** 每列样本数上限:判断列类型需要看到足够多的取值形态,行覆盖扩大后一并上调。 */
const MAX_COLUMN_SAMPLES = 8;

export function safeInput(inspection: WorkbookInspection, targetKind: CleaningTargetKind): Record<string, unknown> {
  return {
    targetKind,
    standardFields: [...FIELDS],
    sheets: inspection.sheets.filter((sheet) => sheet.state === 'visible').map((sheet) => {
      const columnSamples = new Map<number, string[]>();
      const sampledRows: { row: number; cells: string[] }[] = [];
      for (const row of sheet.sampleRows.filter((item) => !item.hidden)) {
        for (const cell of row.cells) {
          if (!cell.text) continue;
          const values = columnSamples.get(cell.column) ?? [];
          if (values.length < MAX_COLUMN_SAMPLES) values.push(numericPlaceholder(cell.text));
          columnSamples.set(cell.column, values);
        }
        // 行级覆盖(阶段四):识别合计/小计/表尾靠行标签文本,数字一律脱敏为占位符。
        sampledRows.push({ row: row.row, cells: row.cells.map((cell) => (cell.text ? numericPlaceholder(cell.text) : '')) });
      }
      return {
        name: sheet.name,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        mergedRangeCount: sheet.mergedRangeCount,
        columns: [...columnSamples.entries()].map(([column, samples]) => ({ column, samples })),
        sampledRows,
      };
    }),
  };
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function aiColumnNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Number.NaN;
  const text = value.trim().toUpperCase();
  if (/^[A-Z]{1,3}$/.test(text)) return [...text].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
  return Number(text);
}

export function sanitizeAiSuggestion(value: unknown, inspection: WorkbookInspection): CleaningAiSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ['sheet', 'headerRow', 'dataStartRow', 'dataEndRow', 'columns', 'suspectedExcludedRows', 'warnings', 'rowHints'])) return null;
  if (typeof input.sheet !== 'string') return null;
  const sheet = inspection.sheets.find((item) => item.name === input.sheet && item.state === 'visible');
  if (!sheet || !Number.isSafeInteger(input.headerRow) || !Number.isSafeInteger(input.dataStartRow)) return null;
  const headerRow = Number(input.headerRow);
  const dataStartRow = Number(input.dataStartRow);
  if (headerRow < 1 || headerRow > sheet.rowCount || dataStartRow <= headerRow || dataStartRow > sheet.rowCount) return null;
  let dataEndRow: number | undefined;
  if (input.dataEndRow !== undefined) {
    if (!Number.isSafeInteger(input.dataEndRow)) return null;
    dataEndRow = Number(input.dataEndRow);
    if (dataEndRow < dataStartRow || dataEndRow > sheet.rowCount) return null;
  }
  if (!Array.isArray(input.columns)) return null;
  const columns: CleaningAiColumnSuggestion[] = [];
  const seenFields = new Set<string>();
  const seenColumns = new Set<number>();
  for (const raw of input.columns) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (!exactKeys(item, ['col', 'field', 'confidence', 'reason'])) return null;
    const col = aiColumnNumber(item.col);
    if (!Number.isSafeInteger(col) || col < 1 || col > sheet.columnCount || typeof item.field !== 'string' || !FIELDS.has(item.field as CleaningColumnField)
      || typeof item.confidence !== 'number' || item.confidence < 0 || item.confidence > 1 || seenFields.has(item.field) || seenColumns.has(col)) return null;
    if (item.reason !== undefined && typeof item.reason !== 'string') return null;
    seenFields.add(item.field);
    seenColumns.add(col);
    columns.push({ col, field: item.field as CleaningColumnField, confidence: item.confidence, ...(item.reason ? { reason: item.reason.slice(0, 200) } : {}) });
  }
  if (!Array.isArray(input.suspectedExcludedRows) || input.suspectedExcludedRows.some((row) => !Number.isSafeInteger(row) || Number(row) < dataStartRow || Number(row) > (dataEndRow ?? sheet.rowCount))) return null;
  if (!Array.isArray(input.warnings) || input.warnings.some((warning) => typeof warning !== 'string')) return null;
  // 行级建议(阶段四):row 必须在数据区内、kind 白名单、去重;非法项整份丢弃(与列建议同口径)。
  const rowHints: CleaningAiRowHint[] = [];
  if (input.rowHints !== undefined) {
    if (!Array.isArray(input.rowHints)) return null;
    const seenRows = new Set<number>();
    for (const raw of input.rowHints) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const item = raw as Record<string, unknown>;
      if (!exactKeys(item, ['row', 'kind', 'reason'])) return null;
      const row = Number(item.row);
      if (!Number.isSafeInteger(row) || row < dataStartRow || row > (dataEndRow ?? sheet.rowCount)) return null;
      if (typeof item.kind !== 'string' || !ROW_HINT_KINDS.has(item.kind as CleaningRowHintKind)) return null;
      if (item.reason !== undefined && typeof item.reason !== 'string') return null;
      if (seenRows.has(row)) continue;
      seenRows.add(row);
      rowHints.push({ row, kind: item.kind as CleaningRowHintKind, reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '' });
      if (rowHints.length >= MAX_ROW_HINTS) break;
    }
  }
  return {
    sheet: sheet.name,
    headerRow,
    dataStartRow,
    ...(dataEndRow !== undefined ? { dataEndRow } : {}),
    columns,
    suspectedExcludedRows: (input.suspectedExcludedRows as number[]).slice(0, 200),
    warnings: (input.warnings as string[]).map((warning) => warning.slice(0, 300)).slice(0, 50),
    rowHints,
  };
}

export async function suggestCleaningStructure(
  inspection: WorkbookInspection,
  targetKind: CleaningTargetKind,
): Promise<{ available: boolean; suggestion: CleaningAiSuggestion | null }> {
  if (!CLEANING_AI_ENABLED || !modelConfigured()) return { available: false, suggestion: null };
  try {
    const model = new EnvChatModel('cleaning_suggest');
    const result = await model.complete({
      messages: [
        { role: 'system', content: CLEANING_STRUCTURE_PROMPT },
        { role: 'user', content: JSON.stringify(safeInput(inspection, targetKind)) },
      ],
    });
    let parsed: unknown;
    try { parsed = JSON.parse(result.text); } catch { return { available: true, suggestion: null }; }
    return { available: true, suggestion: sanitizeAiSuggestion(parsed, inspection) };
  } catch {
    return { available: true, suggestion: null };
  }
}
