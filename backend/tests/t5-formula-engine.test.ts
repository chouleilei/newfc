import { describe, expect, it } from 'vitest';
import { parseFormula, expandExponent } from '../src/modules/forecast/formula/parser';
import { runWorkbook, compileWorkbook, findCycle, type CellInput, type WorkbookJson } from '../src/modules/forecast/formula/engine';

/** AC-F11 预测公式引擎:bigint 定点、白名单函数、引用/区域/跨表、错误值、循环与步数上限。 */

const wb = (cells: Record<string, CellInput>, extra: WorkbookJson['sheets'] = []): WorkbookJson => ({ sheets: [{ name: '预测', cells }, ...extra] });
const f = (x: string): CellInput => ({ f: x });
const n = (x: string): CellInput => ({ n: x });
function calc(cells: Record<string, CellInput>, out = 'Z1', extra: WorkbookJson['sheets'] = [], overrides: Record<string, string> = {}) {
  const r = runWorkbook({ workbook: wb(cells, extra), overrides, outputs: [{ key: 'x', ref: `预测!${out}` }], maxSteps: 1_000_000 });
  return r.ok ? r.outputs.x[0] : r;
}
const one = (formula: string, cells: Record<string, CellInput> = {}) => calc({ ...cells, Z1: f(formula) });

describe('T-5 预测公式引擎(AC-F11)', () => {
  it('四则、优先级、一元负号、百分号、整数幂、定点精度', () => {
    expect(one('=0.1+0.2')).toBe('0.300000');
    expect(one('=10+20*3')).toBe('70.000000');
    expect(one('=(10+20)*3')).toBe('90.000000');
    expect(one('=-2^2')).toBe('4.000000');
    expect(one('=2^-2')).toBe('0.250000');
    expect(one('=300/(1+13%)')).toBe('265.486726');
    expect(one('=1/3*3')).toBe('1.000000');
    expect(one('=2^0.5')).toMatchObject({ ok: false, code: 'FORECAST_FORMULA_ERROR' });
    expect(one('=1/0')).toMatchObject({ ok: false, code: 'FORECAST_FORMULA_ERROR', diagnostics: [{ cell: '预测!Z1', error: '#DIV/0!' }] });
    expect(one('=99999999999.99*100')).toBe('9999999999999.000000');
    expect(expandExponent('1.5e-7')).toBe('0.00000015');
    expect(expandExponent('2E3')).toBe('2000');
  });

  it('引用、区域、跨表引用与函数', () => {
    const cells = { A1: n('100'), A2: n('200'), A3: n('300'), B1: n('0.5'), B2: n('2'), B3: { s: '文本' } as CellInput, C1: { b: true } as CellInput };
    expect(one('=SUM(A1:A3)', cells)).toBe('600.000000');
    expect(one('=AVERAGE(A1:A3)', cells)).toBe('200.000000');
    expect(one('=MIN(A1:A3)+MAX(A1:A3)', cells)).toBe('400.000000');
    expect(one('=COUNT(A1:B3)', cells)).toBe('5.000000');
    expect(one('=SUMPRODUCT(A1:A2,B1:B2)', cells)).toBe('450.000000');
    expect(one('=SUMPRODUCT(A1:A3,B1:B2)', cells)).toMatchObject({ ok: false });
    expect(one('=ROUND(2.5,0)+ROUND(-2.5,0)', cells)).toBe('0.000000');
    expect(one('=ROUND(1234.5678,-2)', cells)).toBe('1200.000000');
    expect(one('=ROUNDUP(1.231,2)', cells)).toBe('1.240000');
    expect(one('=ROUNDDOWN(-1.239,2)', cells)).toBe('-1.230000');
    expect(one('=ABS(-3)', cells)).toBe('3.000000');
    expect(one('=IF(A1>150,1,2)', cells)).toBe('2.000000');
    expect(one('=IF(AND(A1<A2,OR(C1,FALSE)),1,0)', cells)).toBe('1.000000');
    expect(one('=IF(NOT(A1=100),1,0)', cells)).toBe('0.000000');
    expect(one('=IFERROR(A1/0,-1)', cells)).toBe('-1.000000');
    expect(one('=IF(A1>0,5,1/0)', cells)).toBe('5.000000');
    expect(one('=IF(B3="文本",7,8)', cells)).toBe('7.000000');
    expect(one('=IF(A1&"元"="100元",1,0)', cells)).toBe('1.000000');
    expect(one('=B3+1', cells)).toMatchObject({ ok: false, diagnostics: [{ error: '#VALUE!' }] });
  });

  it('跨表引用(含带空格的引号表名)、参数覆盖、一行区域输出', () => {
    const extra = [{ name: '参数', cells: { B2: n('1.5') } }, { name: '收入 预测', cells: { A1: n('10'), B1: n('20'), C1: n('30') } }];
    const cells = { A1: f("='收入 预测'!A1*参数!B2"), B1: f("='收入 预测'!B1*参数!B2"), C1: f("=SUM('收入 预测'!A1:C1)") };
    const r = runWorkbook({ workbook: wb(cells, extra), overrides: {}, outputs: [{ key: 'row', ref: '预测!A1:C1' }], maxSteps: 10_000 });
    expect(r).toMatchObject({ ok: true, outputs: { row: ['15.000000', '30.000000', '60.000000'] } });
    const o = runWorkbook({ workbook: wb(cells, extra), overrides: { '参数!B2': '2' }, outputs: [{ key: 'row', ref: '预测!A1:C1' }], maxSteps: 10_000 });
    expect(o).toMatchObject({ ok: true, outputs: { row: ['20.000000', '40.000000', '60.000000'] } });
    expect(one('=未知表!A1')).toMatchObject({ ok: false, diagnostics: [{ error: '#REF!' }] });
  });

  it('NPV / IRR / PMT', () => {
    expect(one('=NPV(0.1,-100,60,60)')).toBe('3.756574');
    const cells = { A1: n('-100'), A2: n('60'), A3: n('60') };
    expect(Number(one('=IRR(A1:A3)', cells))).toBeCloseTo(0.130662, 5);
    expect(Number(one('=PMT(0.05/12,360,100000)'))).toBeCloseTo(-536.821623, 5);
    expect(one('=PMT(0,10,1000)')).toBe('-100.000000');
    expect(one('=IRR(A2:A3)', cells)).toMatchObject({ ok: false, diagnostics: [{ error: '#NUM!' }] });
  });

  it('诊断:不支持函数、外部引用、#REF!、语法错误;循环引用;步数上限', () => {
    expect(parseFormula('=VLOOKUP(A1,B1:C3,2)').issues).toEqual([expect.objectContaining({ code: 'UNSUPPORTED_FUNCTION' })]);
    expect(parseFormula('=[1]Sheet1!A1+1').issues).toEqual([expect.objectContaining({ code: 'EXTERNAL_REF' })]);
    expect(parseFormula('=#REF!+1').issues).toEqual([expect.objectContaining({ code: 'REF_ERROR' })]);
    expect(parseFormula('=Sheet1!#REF!*2').issues).toEqual([expect.objectContaining({ code: 'REF_ERROR' })]);
    expect(parseFormula('=SUM(A1').issues).toEqual([expect.objectContaining({ code: 'PARSE' })]);
    expect(parseFormula('=myRange*2').issues).toEqual([expect.objectContaining({ code: 'NAME' })]);
    expect(one('=VLOOKUP(1,A1:B2,2)')).toMatchObject({ ok: false, diagnostics: [{ error: '#NAME?' }] });

    const cyc = { A1: f('=B1+1'), B1: f('=C1'), C1: f('=A1'), Z1: f('=A1') };
    expect(calc(cyc)).toMatchObject({ ok: false, code: 'FORECAST_CYCLE' });
    expect(findCycle(compileWorkbook(wb(cyc)))).toEqual(expect.arrayContaining(['预测!A1', '预测!B1', '预测!C1']));
    expect(findCycle(compileWorkbook(wb({ A1: f('=B1'), B1: n('1') })))).toBeNull();

    const big: Record<string, CellInput> = { Z1: f('=SUM(A1:A1000)') };
    for (let i = 1; i <= 1000; i += 1) big[`A${i}`] = n(String(i));
    expect(runWorkbook({ workbook: wb(big), overrides: {}, outputs: [{ key: 'x', ref: '预测!Z1' }], maxSteps: 100 })).toMatchObject({ ok: false, code: 'FORECAST_RESOURCE_LIMIT' });
    expect(calc(big)).toBe('500500.000000');
  });

  it('长依赖链不递归爆栈(拓扑序求值)', () => {
    const chain: Record<string, CellInput> = { A1: n('1') };
    for (let i = 2; i <= 20_000; i += 1) chain[`A${i}`] = f(`=A${i - 1}+1`);
    chain.Z1 = f('=A20000');
    expect(calc(chain)).toBe('20000.000000');
  });
});
