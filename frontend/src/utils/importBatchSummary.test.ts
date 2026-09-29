/**
 * UX-19 导入批次业务摘要/筛选/结果追溯纯函数测试:
 * - 统一摘要(UX-14 unifiedPreview)优先,标准/清洗/财务三种来源各自业务化;
 * - legacy 摘要(financeConversionId / cleaning actions / versionId / years)可识别;
 * - 不可识别摘要 recognized=false,不编造业务口径;
 * - URL 筛选解析:非法 year/kind/status 忽略并记录,不静默替换;
 * - 结果分组行与不可撤销更正路径。
 */
import { describe, expect, it } from 'vitest';
import type { ImportBatchDetail, UnifiedPreviewSummary } from '../api/importBatch';
import {
  describeImportResult,
  importBatchMatchesFilter,
  parseImportBatchFilters,
  rollbackCorrectionAdvice,
  summarizeImportBatch,
  yearsOfImportBatch,
} from './importBatchSummary';

function unifiedPreview(overrides: Partial<UnifiedPreviewSummary> = {}): UnifiedPreviewSummary {
  return {
    schemaVersion: 1,
    kind: 'actual',
    source: 'standard',
    history: false,
    target: { year: 2026, years: [2026] },
    periods: [{ year: 2026, snapshotDate: '2026-08-31', entryCount: 12 }],
    orgScope: { count: 2, codes: ['A01', 'A02'] },
    amountUnit: 'yuan',
    signConvention: 'profit_direction',
    actions: { insert: 3, overwrite: 2, clear: 1, unchanged: 9, noteChange: 0, excluded: 0, skipped: 0 },
    warnings: 0,
    updatesCurrent: true,
    createsSnapshot: true,
    comparisonBasis: 'actual_current',
    resultLocation: 'actual_current_and_snapshot',
    ...overrides,
  };
}

describe('summarizeImportBatch(UX-19)', () => {
  it('统一摘要:实际标准导入,多年度分组与动作计数业务化', () => {
    const preview = unifiedPreview({
      target: { year: 2026, years: [2025, 2026] },
      periods: [
        { year: 2025, snapshotDate: '2025-12-31', entryCount: 5 },
        { year: 2026, snapshotDate: '2026-08-31', entryCount: 12 },
      ],
    });
    const s = summarizeImportBatch({ kind: 'actual', history: false, summary: { unifiedPreview: preview } });
    expect(s.recognized).toBe(true);
    expect(s.source).toBe('standard');
    expect(s.sourceLabel).toBe('标准模板导入');
    expect(s.targetLabel).toBe('更新当前实际');
    expect(s.yearsLabel).toBe('2025、2026 年');
    expect(s.periodsLabel).toBe('2025 年截止 2025-12-31(5 条);2026 年截止 2026-08-31(12 条)');
    expect(s.actionsLabel).toBe('新增 3 · 覆盖 2 · 清零 1 · 不变 9');
  });

  it('统一摘要:历史补录目标与预算版本名', () => {
    const history = summarizeImportBatch({
      kind: 'actual', history: true,
      summary: { unifiedPreview: unifiedPreview({ history: true, comparisonBasis: 'history_snapshot', resultLocation: 'actual_history_snapshot' }) },
    });
    expect(history.targetLabel).toBe('补录历史快照（不更新当前累计）');

    const budget = summarizeImportBatch({
      kind: 'budget', history: false,
      summary: {
        unifiedPreview: unifiedPreview({
          kind: 'budget', source: 'cleaning',
          target: { versionId: 7, versionName: '年初预算', year: 2026 },
          periods: [], comparisonBasis: 'budget_entry', resultLocation: 'budget_entry',
        }),
      },
    });
    expect(budget.sourceLabel).toBe('非标准 Excel 清洗');
    expect(budget.targetLabel).toBe('年初预算（预算版本）');
    expect(budget.yearsLabel).toBe('2026 年');
    expect(budget.periodsLabel).toBeNull();
  });

  it('legacy 财务转换摘要:来源/新增/修改/清零/条数', () => {
    const s = summarizeImportBatch({
      kind: 'actual', history: false,
      summary: { financeConversionId: 9, count: 20, added: 4, modified: 3, cleared: 1, reconciled: true },
    });
    expect(s.recognized).toBe(true);
    expect(s.source).toBe('finance');
    expect(s.sourceLabel).toBe('财务系统转换');
    expect(s.actionsLabel).toBe('新增 4 · 覆盖 3 · 清零 1');
    expect(s.countLabel).toBe('共 20 条');
  });

  it('legacy 清洗摘要:actions 对象 + 生效条数', () => {
    const s = summarizeImportBatch({
      kind: 'budget', history: false,
      summary: { targetKind: 'budget', valueKind: 'amount', amountUnit: 'yuan', actions: { insert: 2, overwrite: 1, clear: 0, unchanged: 5, excluded: 1 }, counts: { selected: 9, effective: 8, excluded: 1, errors: 0, warnings: 0, unresolved: 0 } },
      versionName: '年初预算',
    });
    expect(s.recognized).toBe(true);
    expect(s.source).toBe('cleaning');
    expect(s.actionsLabel).toBe('新增 2 · 覆盖 1 · 不变 5 · 排除 1');
    expect(s.countLabel).toBe('共 8 条生效');
    expect(s.targetLabel).toBe('年初预算（预算版本）');
  });

  it('legacy 标准实际(years)/预算(versionId)摘要', () => {
    const actual = summarizeImportBatch({ kind: 'actual', history: true, summary: { years: [2025, 2026], count: 30, history: true } });
    expect(actual.source).toBe('standard');
    expect(actual.yearsLabel).toBe('2025、2026 年');
    expect(actual.countLabel).toBe('共 30 条');
    expect(actual.targetLabel).toBe('补录历史快照（不更新当前累计）');

    const budget = summarizeImportBatch({ kind: 'budget', history: false, summary: { versionId: 3, count: 10 }, target: { versionId: 3, year: 2026 } });
    expect(budget.source).toBe('standard');
    expect(budget.yearsLabel).toBe('2026 年');
    expect(budget.countLabel).toBe('共 10 条');
  });

  it('不可识别摘要:recognized=false,不编造业务口径', () => {
    const s = summarizeImportBatch({ kind: 'actual', history: false, summary: { somethingElse: 1 } });
    expect(s.recognized).toBe(false);
    expect(s.actionsLabel).toBeNull();
  });

  it('零值动作不进入计数文案', () => {
    const s = summarizeImportBatch({
      kind: 'actual', history: false,
      summary: { unifiedPreview: unifiedPreview({ actions: { insert: 0, overwrite: 0, clear: 0, unchanged: 0, noteChange: 0, excluded: 0, skipped: 0 } }) },
    });
    expect(s.actionsLabel).toBeNull();
  });
});

describe('yearsOfImportBatch(UX-19)', () => {
  it('统一摘要年度并集;legacy years;预算经版本年度映射', () => {
    expect(yearsOfImportBatch({
      kind: 'actual',
      summary: { unifiedPreview: unifiedPreview({ target: { year: 2026, years: [2025, 2026] }, periods: [{ year: 2024, snapshotDate: '2024-12-31', entryCount: 1 }] }) },
    }).sort()).toEqual([2024, 2025, 2026]);
    expect(yearsOfImportBatch({ kind: 'actual', summary: { years: [2025] } })).toEqual([2025]);
    expect(yearsOfImportBatch({ kind: 'budget', summary: { versionId: 3 } }, new Map([[3, 2026]]))).toEqual([2026]);
    expect(yearsOfImportBatch({ kind: 'budget', summary: {} })).toEqual([]);
  });
});

describe('parseImportBatchFilters(UX-19)', () => {
  it('合法参数解析;缺失参数为空筛选', () => {
    const { filter, issues } = parseImportBatchFilters('year=2026&kind=actual_history&status=committed');
    expect(filter).toEqual({ year: 2026, kind: 'actual_history', status: 'committed' });
    expect(issues).toEqual([]);
    expect(parseImportBatchFilters('').filter).toEqual({});
  });

  it('非法值忽略并记录原因,不静默替换', () => {
    const { filter, issues } = parseImportBatchFilters('year=abc&kind=whatever&status=done');
    expect(filter).toEqual({});
    expect(issues).toHaveLength(3);
    expect(issues.join()).toContain('年度');
    expect(issues.join()).toContain('类型');
    expect(issues.join()).toContain('状态');
  });
});

describe('importBatchMatchesFilter(UX-19)', () => {
  const budgetRow = { kind: 'budget' as const, history: false, status: 'committed' as const, years: [2026] };
  const actualRow = { kind: 'actual' as const, history: false, status: 'pending' as const, years: [2025, 2026] };
  const historyRow = { kind: 'actual' as const, history: true, status: 'committed' as const, years: [2025] };

  it('类型筛选区分预算/更新当前累计/历史补录', () => {
    expect(importBatchMatchesFilter(budgetRow, { kind: 'budget' })).toBe(true);
    expect(importBatchMatchesFilter(actualRow, { kind: 'budget' })).toBe(false);
    expect(importBatchMatchesFilter(actualRow, { kind: 'actual' })).toBe(true);
    expect(importBatchMatchesFilter(historyRow, { kind: 'actual' })).toBe(false);
    expect(importBatchMatchesFilter(historyRow, { kind: 'actual_history' })).toBe(true);
  });

  it('年度与状态组合筛选;无年度信息时年度筛选不命中', () => {
    expect(importBatchMatchesFilter(actualRow, { year: 2025 })).toBe(true);
    expect(importBatchMatchesFilter(historyRow, { year: 2026 })).toBe(false);
    expect(importBatchMatchesFilter(actualRow, { year: 2026, status: 'pending' })).toBe(true);
    expect(importBatchMatchesFilter(actualRow, { year: 2026, status: 'committed' })).toBe(false);
    expect(importBatchMatchesFilter({ ...budgetRow, years: [] }, { year: 2026 })).toBe(false);
  });
});

describe('describeImportResult / rollbackCorrectionAdvice(UX-19)', () => {
  const baseDetail: Pick<ImportBatchDetail, 'kind' | 'result' | 'target'> = { kind: 'actual', result: null, target: {} };

  it('实际结果按 年度×截止日×快照批次 分组', () => {
    const lines = describeImportResult({
      ...baseDetail,
      result: {
        count: 17,
        results: [
          { year: 2025, snapshotDate: '2025-12-31', count: 5, batchId: 41 },
          { year: 2026, snapshotDate: '2026-08-31', count: 12, batchId: 45 },
        ],
      },
    });
    expect(lines).toEqual([
      '2025 年(截止 2025-12-31):写入 5 条,生成快照批次 #41',
      '2026 年(截止 2026-08-31):写入 12 条,生成快照批次 #45',
    ]);
  });

  it('预算结果给出版本写入条数;无结果为空数组', () => {
    expect(describeImportResult({ kind: 'budget', target: { versionId: 7, versionName: '年初预算' }, result: { count: 10 } }))
      .toEqual(['已写入「年初预算」明细 10 条']);
    expect(describeImportResult(baseDetail)).toEqual([]);
  });

  it('更正路径:历史补录/当前实际/预算各自说明', () => {
    expect(rollbackCorrectionAdvice({ kind: 'actual', history: true })).toContain('补录历史快照任务');
    expect(rollbackCorrectionAdvice({ kind: 'actual', history: false })).toContain('更正导入');
    expect(rollbackCorrectionAdvice({ kind: 'budget', history: false })).toContain('预算草稿');
  });
});
