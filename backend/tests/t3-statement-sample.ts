/** 财务报表测试样本(按 lishui 四表模板布局):总资产 1,000,000、负债 420,000、权益 580,000、营业总收入 300,000、净利润 60,000(元)。 */
import ExcelJS from 'exceljs';

type Cell = string | number | null | { formula: string; result?: number };

export async function statementWorkbook(opts: { unbalanced?: boolean; netProfit?: number; extra?: (ws: Record<string, ExcelJS.Worksheet>) => void } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const put = (ws: ExcelJS.Worksheet, addr: string, v: Cell) => { ws.getCell(addr).value = v as ExcelJS.CellValue; };
  const bs = wb.addWorksheet('资产负债表');
  bs.addRow(['资 产', '行次', '期末余额', '年初余额', '负债和所有者权益(或股东权益)', '行次', '期末余额', '年初余额']);
  put(bs, 'A2', '货币资金'); put(bs, 'B2', '1'); put(bs, 'C2', 200000); put(bs, 'D2', 180000);
  put(bs, 'A20', '流动资产合计'); put(bs, 'B20', '19'); put(bs, 'C20', 450000);
  put(bs, 'A43', '非流动资产合计'); put(bs, 'B43', '42'); put(bs, 'C43', 550000);
  put(bs, 'A44', '资产总计'); put(bs, 'B44', '43'); put(bs, 'C44', { formula: 'C20+C43', result: 1000000 });
  put(bs, 'E32', '负债合计'); put(bs, 'F32', '74'); put(bs, 'G32', 420000);
  put(bs, 'E43', '所有者权益（或股东权益）合计'); put(bs, 'F43', '85'); put(bs, 'G43', 580000);
  put(bs, 'E44', '负债和所有者（或股东权益）合计'); put(bs, 'F44', '86'); put(bs, 'G44', opts.unbalanced ? 990000 : 1000000);

  const is = wb.addWorksheet('利润表');
  is.addRow(['项         目', '行次', '本月金额', '本年累计', '上年同期', '上年累计']);
  put(is, 'A2', ' 一、营业总收入'); put(is, 'B2', '1'); put(is, 'D2', 300000);
  put(is, 'A5', '二、营业总成本'); put(is, 'B5', '4'); put(is, 'D5', 220000);
  put(is, 'A22', '三、营业利润（亏损以－号填列）'); put(is, 'B22', '21'); put(is, 'D22', 80000);
  put(is, 'A26', '四、利润总额（亏损总额以－号填列）'); put(is, 'B26', '25'); put(is, 'D26', 80000);
  put(is, 'A31', '五、净利润（净亏损以－号填列）'); put(is, 'B31', '30'); put(is, 'D31', opts.netProfit ?? 60000);

  const cf = wb.addWorksheet('现金流量表');
  cf.addRow(['项      目', '行次', '本期发生额', '本年累计数']);
  put(cf, 'A12', '经营活动产生的现金流量净额'); put(cf, 'B12', '11'); put(cf, 'D12', 72000);
  put(cf, 'A25', '投资活动产生的现金流量净额'); put(cf, 'B25', '24'); put(cf, 'D25', -30000);
  put(cf, 'A36', '筹资活动产生的现金流量净额'); put(cf, 'B36', '35'); put(cf, 'D36', 15000);
  put(cf, 'A39', '现金及现金等价物净增加额'); put(cf, 'B39', '38'); put(cf, 'D39', 57000);

  const eq = wb.addWorksheet('所有者权益变动表');
  eq.addRow(['项目', '行次', '本年金额', '', '', '', '', '', '', '', '', '', '', '上年金额']);
  eq.addRow(['', '', '归属于母公司所有者权益']);
  eq.addRow(['', '', '实收资本', '资本公积', '减:库存股', '专项储备', '盈余公积', '一般风险准备', '未分配利润', '其他', '小计', '少数股东权益', '所有者权益合计']);
  eq.addRow(['栏次', '—', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
  eq.addRow(['一、上年年末余额', '1', 0, 0, 0, 0, 0, 0, 520000, 0, 520000, 0, 520000]);
  eq.addRow(['（一）综合收益总额', '8', 0, 0, 0, 0, 0, 0, 60000, 0, 60000, 0, 60000]);
  eq.addRow(['四、本年年末余额', '33', 0, 0, 0, 0, 0, 0, 580000, 0, 580000, 0, 580000]);
  wb.addWorksheet('说明').addRow(['本表为测试样本']);
  opts.extra?.({ bs, is, cf, eq });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
