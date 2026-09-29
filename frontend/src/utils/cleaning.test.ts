import { describe, expect, it } from 'vitest';
import { checkReupload, excelColumnLetter, mappingStorageKey, planToWizardState, rowCoordinateKey, templateConfigFromPlan, templateInitialState } from './cleaning';
import { reopenExpiredDetails, type CleaningPlan } from '../api/cleaning';
import { ApiError } from '../api/client';

describe('清洗导入向导纯函数', () => {
  it('Excel 列号转换支持超过 Z 的列', () => {
    expect([1, 26, 27, 52, 53].map(excelColumnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA']);
  });

  it('模板只保存结构，不保存绝对结束行、排除行、目标和名称映射', () => {
    const config = templateConfigFromPlan({
      version: 1, targetKind: 'budget',
      sheets: [{ sheetName: '预算', headerRow: 5, dataStartRow: 6, dataEndRow: 999 }],
      columns: [{ sourceColumn: 2, field: 'orgName' }, { sourceColumn: 3, field: 'accountName' }, { sourceColumn: 6, field: 'amount' }],
      valueKind: 'amount', amountUnit: 'wan', signConvention: 'display_positive',
      excludedRows: [{ sheetName: '预算', row: 10, reason: '合计' }], mappings: [{ kind: 'org', sourceText: '总部', targetCode: '001' }],
    });
    expect(config).toMatchObject({ preferredSheetName: '预算', headerRow: 5, dataStartRow: 6, amountUnit: 'wan' });
    expect(config).not.toHaveProperty('dataEndRow');
    expect(config).not.toHaveProperty('excludedRows');
    expect(config).not.toHaveProperty('mappings');
  });

  it('模板复用时结束行取新文件实际行数', () => {
    const state = templateInitialState({
      preferredSheetName: '月报', headerRow: 2, dataStartRow: 3,
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 5, field: 'amount' }],
      valueKind: 'amount', amountUnit: 'yuan', signConvention: 'display_positive',
    }, {
      token: 'x', originalName: 'x.xlsx', sha256: '0'.repeat(64), size: 1, aiAvailable: false, aiSuggestion: null,
      sheets: [{ name: '月报', state: 'visible', rowCount: 123, columnCount: 5, mergedRangeCount: 0, formulaCellCount: 0, hiddenRowCount: 0, hiddenColumnCount: 0, sampleRows: [] }],
    });
    expect(state.ranges['月报']).toEqual({ headerRow: 2, dataStartRow: 3, dataEndRow: 123 });
  });
});

describe('UX-17 清洗返回修改:计划恢复与重传核验', () => {
  const plan: CleaningPlan = {
    version: 1, targetKind: 'actual-current',
    sheets: [{ sheetName: '月报', headerRow: 2, dataStartRow: 3, dataEndRow: 500 }],
    columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 5, field: 'amount' }],
    valueKind: 'amount', amountUnit: 'wan', signConvention: 'profit_signed',
    excludedRows: [{ sheetName: '月报', row: 500, reason: '用户排除' }],
    mappings: [{ kind: 'org', sourceText: '总部', targetCode: '001' }, { kind: 'account', sourceText: '电费', targetCode: 'E01' }],
    clearBlankNotes: true, templateId: 7,
  };

  it('无工作簿时按计划原样恢复全部配置(含名称映射、排除行、单位、模板)', () => {
    const state = planToWizardState(plan, null);
    expect(state.selectedSheets).toEqual(['月报']);
    expect(state.ranges['月报']).toEqual({ headerRow: 2, dataStartRow: 3, dataEndRow: 500 });
    expect(state.mappings).toEqual({ 1: 'orgCode', 2: 'accountCode', 5: 'amount' });
    expect(state.valueKind).toBe('amount');
    expect(state.amountUnit).toBe('wan');
    expect(state.signConvention).toBe('profit_signed');
    expect(state.clearBlankNotes).toBe(true);
    expect(state.templateId).toBe(7);
    expect(state.excludedRowKeys).toEqual([rowCoordinateKey('月报', 500)]);
    // 恢复的人工映射键必须与向导 buildPlan 的拆分键一致(可直接还原回 plan.mappings)
    expect(Object.keys(state.manualMappings).sort()).toEqual([mappingStorageKey('account', '电费'), mappingStorageKey('org', '总部')].sort());
    expect(state.manualMappings[mappingStorageKey('org', '总部')]).toBe('001');
    const roundTrip = Object.entries(state.manualMappings).map(([key, targetCode]) => {
      const [kind, sourceText] = key.split('\u0000') as ['org' | 'account', string];
      return { kind, sourceText, targetCode };
    });
    expect(roundTrip).toEqual(expect.arrayContaining(plan.mappings));
  });

  it('提供工作簿时收敛到允许范围:缺失工作表剔除、行号收敛且保持范围合法', () => {
    const shrunk = planToWizardState({
      ...plan,
      sheets: [
        { sheetName: '月报', headerRow: 20, dataStartRow: 30, dataEndRow: 999 },
        { sheetName: '已删除表', headerRow: 1, dataStartRow: 2, dataEndRow: 10 },
      ],
    }, { sheets: [{ name: '月报', state: 'visible', rowCount: 10, columnCount: 5, mergedRangeCount: 0, formulaCellCount: 0, hiddenRowCount: 0, hiddenColumnCount: 0, sampleRows: [] }] });
    expect(shrunk.selectedSheets).toEqual(['月报']);
    expect(shrunk.ranges['月报'].dataEndRow).toBe(10);
    expect(shrunk.ranges['月报'].headerRow).toBeLessThan(shrunk.ranges['月报'].dataStartRow);
    expect(shrunk.ranges['月报'].dataStartRow).toBeLessThanOrEqual(shrunk.ranges['月报'].dataEndRow);
  });

  it('重传核验:指纹一致判定 same,不同判定 changed(变化文件必须重新核对)', () => {
    expect(checkReupload('a'.repeat(64), 'a'.repeat(64)).kind).toBe('same');
    expect(checkReupload('a'.repeat(64), 'b'.repeat(64)).kind).toBe('changed');
  });

  it('410 CLEANING_SOURCE_EXPIRED 提取可恢复的 plan/target/sha256,其他错误返回 null', () => {
    const details = { sourceBatchId: 42, originalName: '月报.xlsx', sha256: 'f'.repeat(64), plan, target: { targetKind: 'actual-current', year: 2026, snapshotDate: '2026-08-31' } };
    const recovered = reopenExpiredDetails(new ApiError({ code: 'CLEANING_SOURCE_EXPIRED', message: '已过期', details }, 410));
    expect(recovered).toMatchObject({ sourceBatchId: 42, originalName: '月报.xlsx', sha256: 'f'.repeat(64) });
    expect(recovered?.plan?.columns).toHaveLength(3);
    expect(recovered?.target?.snapshotDate).toBe('2026-08-31');

    expect(reopenExpiredDetails(new ApiError({ code: 'CONFLICT', message: '状态不允许' }, 409))).toBeNull();
    expect(reopenExpiredDetails(new ApiError({ code: 'NOT_FOUND', message: '不存在' }, 404))).toBeNull();
    expect(reopenExpiredDetails(new ApiError({ code: 'CLEANING_SOURCE_EXPIRED', message: '已过期' }, 410))).toBeNull();
    expect(reopenExpiredDetails(new Error('network'))).toBeNull();
    expect(reopenExpiredDetails('410')).toBeNull();
  });
});
