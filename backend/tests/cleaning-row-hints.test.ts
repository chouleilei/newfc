/**
 * Excel 清洗行级智能识别(AI 功能增强计划 §四.阶段四)验收:
 * - 采样扩大:表尾行进入 sampleRows;safeInput 行级覆盖且数字保持脱敏;
 * - 行级建议:sanitizeAiSuggestion 白名单校验 rowHints(行号必须在数据区、kind 白名单、整份丢弃口径不变);
 * - 建议落点:采纳行只写回 plan.excludedRows,随后 cancel → 重新 analyze/preview 整轮重跑,
 *   与手动改 plan 完全同一通道;preview/pending 生命周期不变;
 * - 确认接口拒绝客户端 entries 的既有测试(cleaning-import.test.ts)保持原样通过。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { testDb, buildFixture, budget } from './helpers';
import { loadCleaningWorkbook, inspectWorkbook } from '../src/modules/io/cleaning/workbook';
import { applyCleaningPlan } from '../src/modules/io/cleaning/apply';
import { createPendingCleaningPreview } from '../src/modules/io/cleaning/preview';
import { sanitizeAiSuggestion } from '../src/modules/io/cleaning/suggest';
import * as imports from '../src/modules/import/import.service';
import type { CleaningPlan } from '../src/modules/io/cleaning/plan';

async function xlsx(sheets: { name: string; rows: unknown[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const definition of sheets) {
    const sheet = workbook.addWorksheet(definition.name);
    for (const row of definition.rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function plan(input: Partial<CleaningPlan> & Pick<CleaningPlan, 'targetKind' | 'sheets' | 'columns' | 'valueKind'>): CleaningPlan {
  return {
    version: 1,
    excludedRows: [],
    mappings: [],
    ...(input.valueKind === 'amount' ? { amountUnit: 'yuan' as const, signConvention: 'display_positive' as const } : {}),
    ...input,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.AI_BASE_URL = '';
  process.env.AI_API_KEY = '';
});

describe('阶段四:行级建议白名单', () => {
  async function inspection33() {
    const rows: unknown[][] = [['组织', '科目', '金额']];
    for (let index = 1; index <= 30; index++) rows.push([`单位${index}`, '管理费用', index * 100]);
    rows.push(['合计', '', 46500]);
    rows.push(['编制:财务部', '', '']);
    return inspectWorkbook(await loadCleaningWorkbook(await xlsx([{ name: '预算', rows }])));
  }

  it('合法 rowHints 通过校验并可截断理由', async () => {
    const inspection = await inspection33();
    const suggestion = sanitizeAiSuggestion({
      sheet: '预算', headerRow: 1, dataStartRow: 2, dataEndRow: 33,
      columns: [{ col: 1, field: 'orgName', confidence: 0.9 }, { col: 2, field: 'accountName', confidence: 0.9 }, { col: 3, field: 'amount', confidence: 0.9 }],
      suspectedExcludedRows: [32],
      warnings: [],
      rowHints: [
        { row: 32, kind: 'subtotal', reason: `行标签为「合计」,金额等于上方之和${'长'.repeat(300)}` },
        { row: 33, kind: 'trailer', reason: '编制说明行,跨页表尾' },
        { row: 32, kind: 'subtotal', reason: '重复行号去重' },
      ],
    }, inspection);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.rowHints).toHaveLength(2);
    expect(suggestion!.rowHints[0]).toMatchObject({ row: 32, kind: 'subtotal' });
    expect(suggestion!.rowHints[0].reason.length).toBeLessThanOrEqual(200);
    expect(suggestion!.rowHints[1]).toMatchObject({ row: 33, kind: 'trailer' });
  });

  it('越界行号/非法 kind/未知字段整份丢弃(与列建议同口径)', async () => {
    const inspection = await inspection33();
    const base = {
      sheet: '预算', headerRow: 1, dataStartRow: 2,
      columns: [{ col: 3, field: 'amount', confidence: 0.9 }],
      suspectedExcludedRows: [], warnings: [],
    };
    // 行号在数据区之前(表头行)
    expect(sanitizeAiSuggestion({ ...base, rowHints: [{ row: 1, kind: 'subtotal', reason: 'x' }] }, inspection)).toBeNull();
    // 行号超出工作表
    expect(sanitizeAiSuggestion({ ...base, rowHints: [{ row: 999, kind: 'subtotal', reason: 'x' }] }, inspection)).toBeNull();
    // 非法 kind
    expect(sanitizeAiSuggestion({ ...base, rowHints: [{ row: 5, kind: 'merge', reason: 'x' }] }, inspection)).toBeNull();
    // 未知顶层字段
    expect(sanitizeAiSuggestion({ ...base, rowHints: [], autoApply: true }, inspection)).toBeNull();
    // 未知 rowHints 项字段
    expect(sanitizeAiSuggestion({ ...base, rowHints: [{ row: 5, kind: 'subtotal', reason: 'x', amount: 1 }] }, inspection)).toBeNull();
  });

  it('省略 rowHints 时向后兼容为空数组', async () => {
    const inspection = await inspection33();
    const suggestion = sanitizeAiSuggestion({
      sheet: '预算', headerRow: 1, dataStartRow: 2,
      columns: [{ col: 3, field: 'amount', confidence: 0.9 }],
      suspectedExcludedRows: [], warnings: [],
    }, inspection);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.rowHints).toEqual([]);
  });
});

describe('阶段四:建议落点与重跑路径', () => {
  it('采纳建议行 = plan.excludedRows,重跑 analyze/preview 与手动改 plan 完全同一通道', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '行级识别预算' });
    const file = await xlsx([{
      name: '预算',
      rows: [
        ['组织', '科目', '金额'],
        ['上海公司', '主营业务收入', 100],
        ['杭州公司', '主营业务收入', 50],
        ['合计', '', 150],
        ['编制:财务部', '', ''],
      ],
    }]);
    const columns = [
      { sourceColumn: 1, field: 'orgName' as const },
      { sourceColumn: 2, field: 'accountName' as const },
      { sourceColumn: 3, field: 'amount' as const },
    ];
    // 未采纳:合计行进分析,产生未解析/错误
    const initialPlan = plan({
      targetKind: 'budget', valueKind: 'amount',
      sheets: [{ sheetName: '预算', headerRow: 1, dataStartRow: 2, dataEndRow: 5 }],
      columns,
    });
    const workbook = await loadCleaningWorkbook(file);
    const initial = applyCleaningPlan(db, workbook, { targetKind: 'budget', versionId: version.id }, initialPlan);
    // 合计行「合计」无法匹配组织,进入 unresolved;表尾行同理
    expect(initial.unresolved.some((group) => group.kind === 'org' && group.sourceText === '合计' && group.rows.some((row) => row.row === 4))).toBe(true);
    // 预览门禁不变:存在错误/未决映射的分析不能创建待确认批次
    expect(() => createPendingCleaningPreview(db, { analysis: initial, originalName: 'rows.xlsx', file })).toThrow(/不能创建待确认批次/);

    // 采纳行级建议:仅写回 plan.excludedRows(与手动勾选排除同一字段、同一服务)
    const adoptedPlan = plan({
      targetKind: 'budget', valueKind: 'amount',
      sheets: [{ sheetName: '预算', headerRow: 1, dataStartRow: 2, dataEndRow: 5 }],
      columns,
      excludedRows: [
        { sheetName: '预算', row: 4, reason: 'AI 建议:合计行' },
        { sheetName: '预算', row: 5, reason: 'AI 建议:跨页表尾' },
      ],
    });
    const rerun = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, adoptedPlan);
    expect(rerun.errors).toEqual([]);
    expect(rerun.unresolved).toEqual([]);
    expect(rerun.rows.find((row) => row.rowNumber === 4)).toMatchObject({ excluded: true });
    expect(rerun.rows.find((row) => row.rowNumber === 5)).toMatchObject({ excluded: true });
    const secondPreview = createPendingCleaningPreview(db, { analysis: rerun, originalName: 'rows.xlsx', file });
    imports.commitBatch(db, secondPreview.importBatchId);
    const shanghai = db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id = ? AND org_id = ? AND account_id = ?')
      .get(version.id, fx.orgIds.shanghai, fx.accIds.incomeMain) as { amount_cents: number };
    expect(shanghai.amount_cents).toBe(10_000);
    db.close();
  });
});
