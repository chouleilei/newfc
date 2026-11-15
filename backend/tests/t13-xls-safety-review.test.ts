import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { OLE2_MAGIC, readXlsWorkbookSheets } from '../src/modules/io/xls-reader';
import { readWorkbookSheets } from '../src/modules/io/table-reader';
import { parsePlanWorkbook } from '../src/modules/plan-execution/plan.parse';
vi.mock('xlsx', async () => ({ ...await vi.importActual<typeof import('xlsx')>('xlsx'), read: vi.fn() }));
function parserResult(ws: XLSX.WorkSheet) { vi.mocked(XLSX.read).mockReturnValue({ SheetNames: ['计划'], Sheets: { '计划': ws }, Workbook: { Sheets: [] } }); }
describe('AC-T13-05 .xls 解析器边界复核', () => {
  it('无缓存/错误公式在正式导入阻断，显式历史容缺模式必须给出告警', () => {
    parserResult({ A1: { t: 's', v: '计划' }, B2: { t: 'n', f: 'SUM(C2:D2)' }, '!ref': 'A1:D2' });
    expect(() => readXlsWorkbookSheets(OLE2_MAGIC)).toThrow(/缺少缓存/);
    const warnings: string[] = [];
    expect(readXlsWorkbookSheets(OLE2_MAGIC, 100, 40, { allowUncachedFormulas: true, warnings })).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    parserResult({ A1: { t: 'e', v: 7, f: '1/0' }, '!ref': 'A1:A1' });
    expect(() => readXlsWorkbookSheets(OLE2_MAGIC)).toThrow(/计算错误/);
  });
  it('稀疏大范围只读取实际单元格，保持行号且不展开整个空网格', () => {
    let cellReads = 0;
    const ws = new Proxy({ A1: { t: 's', v: '表头' }, A65536: { t: 's', v: '末行' }, '!ref': 'A1:IV65536' } as XLSX.WorkSheet, { get(target,key) { cellReads++; return target[key as string]; } });
    parserResult(ws);
    const result = readXlsWorkbookSheets(OLE2_MAGIC, 100);
    expect(result[0].rows.map((r) => r.rowNo)).toEqual([1,65536]);
    expect(cellReads).toBeLessThan(20);
  });
  it('实际计划只对映射取数列阻断，辅助列公式错误告警且不替代计划值；缺缓存不能变成空事实', async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('固定资产购置计划');
    ws.addRow(['序号','设备名称','年度计划','承办单位','辅助比率']);
    ws.addRow(['1','合成设备',1060000,'合成单位',{ formula: '1/0', result: { error: '#DIV/0!' } }]);
    const read = async () => readWorkbookSheets(Buffer.from(await wb.xlsx.writeBuffer()), 100, 40, { allowUncachedFormulas: true });
    const good = parsePlanWorkbook(await read(), 2026);
    expect(good.errors).toEqual([]);
    expect(good.warnings.some((w) => w.code === 'FORMULA_CACHE_ISSUE')).toBe(true);
    expect(good.sheets[0].items[0].facts[0].amount).toBe(1060000000000n);
    ws.getCell('C2').value = { formula: 'SUM(C3:C4)' };
    const missing = parsePlanWorkbook(await read(), 2026);
    expect(missing.errors.some((e) => e.message.includes('缺少公式缓存'))).toBe(true);
    ws.getCell('C2').value = { formula: '1/0', result: { error: '#DIV/0!' } };
    expect(parsePlanWorkbook(await read(), 2026).errors.some((e) => e.message.includes('缓存为错误值'))).toBe(true);
  });
});
