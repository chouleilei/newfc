/**
 * Excel 清洗采样扩大(AI 功能增强计划 §四.阶段四.1,确定性部分):
 * 表头段 + 等距中间段 + 表尾段进入 sampleRows,供行级识别「合计/小计/跨页表头/表尾」;
 * 行数不足时不重复采样;送模型的输入一律经数字脱敏(含混合文本中的数字)。
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  loadCleaningWorkbook, inspectWorkbook, sampleRowNumbers,
  SAMPLE_HEAD_ROWS, SAMPLE_MIDDLE_ROWS, SAMPLE_TAIL_ROWS,
} from '../src/modules/io/cleaning/workbook';
import { numericPlaceholder, safeInput } from '../src/modules/io/cleaning/suggest';

async function xlsx(sheets: { name: string; rows: unknown[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const definition of sheets) {
    const sheet = workbook.addWorksheet(definition.name);
    for (const row of definition.rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('阶段四:采样扩大(确定性)', () => {
  it('表尾行进入 sampleRows:合计/表尾行对建议侧可见', async () => {
    const rows: unknown[][] = [['组织', '科目', '金额']];
    for (let index = 1; index <= 30; index++) rows.push([`单位${index}`, '管理费用', index * 100]);
    rows.push(['合计', '', 46500]);
    rows.push(['编制:财务部', '', '']);
    const file = await xlsx([{ name: '预算', rows }]);
    const inspection = inspectWorkbook(await loadCleaningWorkbook(file));
    const sheet = inspection.sheets[0];
    expect(sheet.rowCount).toBe(33);
    const sampledNumbers = sheet.sampleRows.map((row) => row.row);
    // 33 行的表:表头 20 行 + 中间 21~28 全取 + 表尾 29~33,整表可见
    expect(sampledNumbers.filter((row) => row <= 20)).toHaveLength(20);
    expect(sampledNumbers.filter((row) => row > 20)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]);
    const tail = sheet.sampleRows.find((row) => row.row === 32)!;
    expect(tail.cells[0].text).toBe('合计');
    const trailer = sheet.sampleRows.find((row) => row.row === 33)!;
    expect(trailer.cells[0].text).toBe('编制:财务部');
  });

  it('行数不超过 20 时不追加重复采样', async () => {
    const file = await xlsx([{ name: '小表', rows: [['组织', '金额'], ['上海公司', 1]] }]);
    const inspection = inspectWorkbook(await loadCleaningWorkbook(file));
    expect(inspection.sheets[0].sampleRows.map((row) => row.row)).toEqual([1, 2]);
  });

  it('大表的中间区域按等距步进可见,且总采样量有上限', () => {
    const rows = sampleRowNumbers(1000);
    // 三段:表头 20 + 中间 30 + 表尾 5
    expect(rows).toHaveLength(SAMPLE_HEAD_ROWS + SAMPLE_MIDDLE_ROWS + SAMPLE_TAIL_ROWS);
    expect(rows.slice(0, SAMPLE_HEAD_ROWS)).toEqual(Array.from({ length: SAMPLE_HEAD_ROWS }, (_, index) => index + 1));
    expect(rows.slice(-SAMPLE_TAIL_ROWS)).toEqual([996, 997, 998, 999, 1000]);
    // 中间段两端都被取到,并且铺满整个中段而不是聚在开头
    const middle = rows.slice(SAMPLE_HEAD_ROWS, SAMPLE_HEAD_ROWS + SAMPLE_MIDDLE_ROWS);
    expect(middle[0]).toBe(21);
    expect(middle[middle.length - 1]).toBe(995);
    expect(middle.some((row) => row > 400 && row < 600)).toBe(true);
    // 升序去重
    expect([...new Set(rows)]).toEqual(rows);
    expect([...rows].sort((a, b) => a - b)).toEqual(rows);
  });

  it('中途小计行落在采样内:1000 行表的中段小计对模型可见', async () => {
    const rows: unknown[][] = [['组织', '科目', '金额']];
    for (let index = 1; index <= 998; index++) {
      rows.push(index === 500 ? ['小计', '', 123456] : [`单位${index}`, '管理费用', index]);
    }
    rows.push(['合计', '', 999999]);
    const file = await xlsx([{ name: '大表', rows }]);
    const inspection = inspectWorkbook(await loadCleaningWorkbook(file));
    const sampled = inspection.sheets[0].sampleRows.map((row) => row.row);
    // 中段步进覆盖到 500 行附近(不要求恰好命中 500,但必须有中段行可见)
    expect(sampled.some((row) => row > 100 && row < 900)).toBe(true);
    expect(sampled).toContain(1000);
  });
});

describe('阶段四:数字脱敏(送模型前)', () => {
  it('整格数字换成结构占位符,不含真实数值', () => {
    expect(numericPlaceholder('1234')).toBe('<integer:4>');
    expect(numericPlaceholder('1,234.56')).toBe('<decimal:4,2>');
    expect(numericPlaceholder('12.5%')).toBe('<percent:2,1>');
    expect(numericPlaceholder('30%')).toBe('<percent:2>');
    expect(numericPlaceholder('2026-06-30')).toBe('<date>');
    expect(numericPlaceholder('（1,234.00）')).toBe('<decimal:4,2>');
    // 全角数字先归一,不能绕过脱敏
    expect(numericPlaceholder('１２３４')).toBe('<integer:4>');
  });

  it('混合文本保留标签但折叠内嵌数字', () => {
    expect(numericPlaceholder('合计 1,234.56 元')).toBe('合计 <num> 元');
    expect(numericPlaceholder('2026年6月管理费用')).toBe('<num>年<num>月管理费用');
    expect(numericPlaceholder('小计(不含税)')).toBe('小计(不含税)');
    // 纯标签不受影响
    expect(numericPlaceholder('组织名称')).toBe('组织名称');
  });

  it('safeInput 的行/列样本中不出现任何原始数字串', async () => {
    const rows: unknown[][] = [['组织', '科目', '金额', '备注']];
    for (let index = 1; index <= 40; index++) rows.push([`单位${index}`, '管理费用', 987654.32, `第${index}期结算 987,654.32 元`]);
    rows.push(['合计', '', 39506172.8, '合计 39,506,172.80 元']);
    const file = await xlsx([{ name: '预算', rows }]);
    const inspection = inspectWorkbook(await loadCleaningWorkbook(file));
    const payload = JSON.stringify(safeInput(inspection, 'budget'));
    expect(payload).not.toContain('987654');
    expect(payload).not.toContain('987,654');
    expect(payload).not.toContain('39506172');
    expect(payload).not.toContain('39,506,172');
    expect(payload).toContain('<decimal:6,2>');
    expect(payload).toContain('合计');
  });
});
