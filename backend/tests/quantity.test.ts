import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  quantityStringToScaled, scaledToQuantityString, QuantityFormatError, isQuantityType, signOfType,
} from '../src/core/money';
import { rollup, quantityCellOf } from '../src/core/rollup';
import { testDb, buildFixture, org, account, budget, actual, metric } from './helpers';
import * as io from '../src/modules/io/excel';
import * as report from '../src/modules/report/report.service';
import type { TreeNodeRow } from '../src/core/tree';

describe('数量字符串解析(10^4 缩放,十进制)', () => {
  it('基本转换', () => {
    expect(quantityStringToScaled('12345.6789')).toBe(123456789);
    expect(quantityStringToScaled('12345')).toBe(123450000);
    expect(quantityStringToScaled('0.0001')).toBe(1);
    expect(quantityStringToScaled('0.35')).toBe(3500);
    expect(quantityStringToScaled('13')).toBe(130000);
  });
  it('负数与往返', () => {
    expect(quantityStringToScaled('-1.5')).toBe(-15000);
    expect(scaledToQuantityString(123456789)).toBe('12345.6789');
    expect(scaledToQuantityString(123450000)).toBe('12345');
    expect(scaledToQuantityString(1)).toBe('0.0001');
    expect(scaledToQuantityString(-15000)).toBe('-1.5');
    expect(scaledToQuantityString(0)).toBe('0');
  });
  it('非法格式抛错', () => {
    expect(() => quantityStringToScaled('1.23456')).toThrow(QuantityFormatError); // 五位小数
    expect(() => quantityStringToScaled('abc')).toThrow(QuantityFormatError);
    expect(() => quantityStringToScaled('')).toThrow(QuantityFormatError);
    expect(() => quantityStringToScaled('1,000')).toThrow(QuantityFormatError);
  });
  it('类型谓词与展示符号', () => {
    expect(isQuantityType('quantity')).toBe(true);
    expect(isQuantityType('income')).toBe(false);
    expect(signOfType('cost')).toBe(-1);
    expect(signOfType('quantity')).toBe(1);
  });
});

describe('数量汇总(rollup.quantityCell)', () => {
  const orgRows: TreeNodeRow[] = [
    { id: 1, parent_id: null, code: 'G', name: '集团', sort_order: 1, status: 'active' },
    { id: 2, parent_id: 1, code: 'A', name: '甲电站', sort_order: 1, status: 'active' },
    { id: 3, parent_id: 1, code: 'B', name: '乙电站', sort_order: 2, status: 'active' },
  ];
  const q = (id: number, parent: number | null, agg: string): TreeNodeRow => ({
    id, parent_id: parent, code: `Q${id}`, name: `q${id}`, type: 'quantity', quantity_agg: agg, sort_order: id, status: 'active',
  });
  const accRows: TreeNodeRow[] = [
    q(11, null, 'sum'),      // Q1 电量指标根(sum)
    q(12, 11, 'sum'),        // 上网电量(sum)
    q(13, null, 'none'),     // Q2 电价根(none)
    q(14, 13, 'none'),       // 含税上网电价(none)
  ];
  it('sum 科目沿组织/科目祖先累计,none 科目完全不汇总', () => {
    const result = rollup(orgRows, accRows, [
      { orgId: 2, accountId: 12, amountCents: 0, quantity: quantityStringToScaled('100.5') },
      { orgId: 3, accountId: 12, amountCents: 0, quantity: quantityStringToScaled('50') },
      { orgId: 2, accountId: 14, amountCents: 0, quantity: quantityStringToScaled('0.35') },
    ]);
    expect(quantityCellOf(result, 1, 12)).toBe(quantityStringToScaled('150.5')); // 集团×上网电量
    expect(quantityCellOf(result, 2, 12)).toBe(quantityStringToScaled('100.5'));
    expect(quantityCellOf(result, 1, 11)).toBe(quantityStringToScaled('150.5')); // 科目根汇总
    expect(result.quantityCell.get(1)?.get(14)).toBeUndefined();               // none 不汇总
    expect(result.quantityCell.get(2)?.get(14)).toBeUndefined();
    expect(result.cell.get(1)?.get(12) ?? 0).toBe(0);                          // 金额通道不含数量
  });
});

describe('数量型科目服务', () => {
  it('创建要求数量型必须填单位;单位与汇总方式可改', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() => account.createAccount(db, { parentId: null, code: 'Q1', name: '电量', type: 'quantity' })).toThrow(/计量单位/);
    const q = account.createAccount(db, { parentId: null, code: 'Q1', name: '电量', type: 'quantity', unit: '万度', quantityAgg: 'sum' });
    expect(q.type).toBe('quantity');
    expect(q.unit).toBe('万度');
    const leaf = account.createAccount(db, { parentId: q.id, code: 'Q101', name: '上网电量', type: 'quantity', unit: '万度' });
    expect(leaf.quantity_agg).toBe('sum'); // 默认 sum
    const upd = account.updateAccount(db, leaf.id, { quantityAgg: 'none' });
    expect(upd.quantity_agg).toBe('none');
    // 金额科目不能设置单位
    expect(() => account.updateAccount(db, fx.accIds.incomeMain, { unit: '元' })).toThrow(/数量型/);
  });
  it('类型一致性:数量型子科目不能挂到金额科目下', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() => account.createAccount(db, { parentId: fx.accIds.incomeRoot, code: 'Q9', name: 'X', type: 'quantity', unit: '万度' })).toThrow(/类型不一致/);
  });
  it('指标公式不能引用数量型科目', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const q = account.createAccount(db, { parentId: null, code: 'Q1', name: '电量', type: 'quantity', unit: '万度' });
    expect(() => metric.createMetric(db, {
      code: 'BAD', name: '错', terms: [{ sourceType: 'account', sourceAccountId: q.id, coefficient: 1 }],
    })).toThrow(/数量型/);
  });
});

describe('预算数量明细(保存/矩阵/汇总/复制)', () => {
  it('数量型科目走数量通道,金额科目走金额通道', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const qRoot = account.createAccount(db, { parentId: null, code: 'Q1', name: '电量指标', type: 'quantity', unit: '万度', quantityAgg: 'sum' });
    const qLeaf = account.createAccount(db, { parentId: qRoot.id, code: 'Q101', name: '上网电量', type: 'quantity', unit: '万度' });
    const v = budget.createVersion(db, { year: 2026, name: 'QV' });
    const saved = budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: qLeaf.id, quantity: '100.5' },
      { orgId: fx.orgIds.hangzhou, accountId: qLeaf.id, quantity: '50' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    ]);
    expect(saved.saved).toBe(3);
    // 金额科目缺金额报错;数量科目缺数量报错
    expect(() => budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, quantity: '1' }])).toThrow(/金额不能为空/);
    expect(() => budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: qLeaf.id, amount: '1.00' }])).toThrow(/数量不能为空/);
    // 矩阵回读
    const matrix = budget.getEditMatrix(db, v.id);
    const qe = matrix.entries.find((e) => e.accountId === qLeaf.id && e.orgId === fx.orgIds.shanghai);
    expect(qe?.quantity).toBe('100.5');
    expect(qe?.amountDisplay).toBe('');
    const me = matrix.entries.find((e) => e.accountId === fx.accIds.incomeMain);
    expect(me?.amountDisplay).toBe('100.00');
    expect(me?.quantity).toBeNull();
    // 汇总:数量进 quantityCell,不进金额 cell / 指标
    const sum = budget.versionSummary(db, v.id);
    expect(sum.rollup.quantityCell.get(fx.orgIds.root)?.get(qLeaf.id)).toBe(quantityStringToScaled('150.5'));
    expect(sum.rollup.cell.get(fx.orgIds.root)?.get(qLeaf.id) ?? 0).toBe(0);
    expect(sum.rollup.metrics.get(fx.metricIds.gross)).toBe(10_000); // 收入 100 元 = 10000 分
    // 零数量视为清空
    const cleared = budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: qLeaf.id, quantity: '0' },
      { orgId: fx.orgIds.hangzhou, accountId: qLeaf.id, quantity: '50' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    ]);
    expect(cleared.saved).toBe(2);
    expect(budget.getEditMatrix(db, v.id).entries.some((e) => e.accountId === qLeaf.id && e.orgId === fx.orgIds.shanghai)).toBe(false);
    // 版本复制携带数量
    budget.lockVersion(db, v.id);
    const copy = budget.copyVersion(db, v.id, 'V2');
    const copyMatrix = budget.getEditMatrix(db, copy.id);
    expect(copyMatrix.entries.find((e) => e.accountId === qLeaf.id && e.orgId === fx.orgIds.hangzhou)?.quantity).toBe('50');
  });
});

describe('实际数数量明细', () => {
  it('保存数量并生成含数量的全量快照', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const qRoot = account.createAccount(db, { parentId: null, code: 'Q1', name: '电量指标', type: 'quantity', unit: '万度' });
    const qLeaf = account.createAccount(db, { parentId: qRoot.id, code: 'Q101', name: '上网电量', type: 'quantity', unit: '万度' });
    const r = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: qLeaf.id, quantity: '88.8' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '70.00' },
      ],
    });
    const matrix = actual.getActualMatrix(db, 2026);
    expect(matrix.entries.find((e) => e.accountId === qLeaf.id)?.quantity).toBe('88.8');
    const snap = actual.getBatchEntries(db, r.batchId);
    expect(snap.find((e) => e.accountId === qLeaf.id)?.quantity).toBe(quantityStringToScaled('88.8'));
    expect(snap.find((e) => e.accountId === fx.accIds.incomeMain)?.quantity).toBeNull();
  });

  it('完成情况报表独立返回数量，sum 求和且 none 跨组织取平均', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const generation = account.createAccount(db, { parentId: null, code: 'Q101', name: '上网电量', type: 'quantity', unit: '万度' });
    const tariff = account.createAccount(db, { parentId: null, code: 'Q2', name: '含税电价', type: 'quantity', unit: '元/度', quantityAgg: 'none' });
    const v = budget.createVersion(db, { year: 2026, name: '量价分析预算' });
    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: generation.id, quantity: '100' },
      { orgId: fx.orgIds.hangzhou, accountId: generation.id, quantity: '50' },
      { orgId: fx.orgIds.shanghai, accountId: tariff.id, quantity: '0.4' },
      { orgId: fx.orgIds.hangzhou, accountId: tariff.id, quantity: '0.5' },
    ]);
    budget.lockVersion(db, v.id);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: generation.id, quantity: '90' },
        { orgId: fx.orgIds.hangzhou, accountId: generation.id, quantity: '45' },
        { orgId: fx.orgIds.shanghai, accountId: tariff.id, quantity: '0.42' },
        { orgId: fx.orgIds.hangzhou, accountId: tariff.id, quantity: '0.48' },
      ],
    });

    const completion = report.completionReport(db, { versionId: v.id });
    const generationCell = completion.byAccount.find((row) => row.accountId === generation.id)!.cell;
    const tariffCell = completion.byAccount.find((row) => row.accountId === tariff.id)!.cell;
    expect(generationCell.budgetQuantity).toBe(quantityStringToScaled('150'));
    expect(generationCell.actualQuantity).toBe(quantityStringToScaled('135'));
    expect(tariffCell.budgetQuantity).toBe(quantityStringToScaled('0.45'));
    expect(tariffCell.actualQuantity).toBe(quantityStringToScaled('0.45'));
    expect(generationCell.budgetCents).toBe(0);
    expect(tariffCell.actualCents).toBe(0);
  });

  it('预算叶子后来变成父节点时，实际子节点数量仍汇总到预算快照口径', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const generation = account.createAccount(db, { parentId: null, code: 'Q101', name: '上网电量', type: 'quantity', unit: '万度' });
    const v = budget.createVersion(db, { year: 2026, name: '树快照数量预算' });
    const shanghaiChild = org.createOrg(db, { parentId: fx.orgIds.shanghai, code: 'SH01', name: '上海一厂' });
    const generationChild = account.createAccount(db, {
      parentId: generation.id, code: 'Q10101', name: '上海一厂上网电量', type: 'quantity', unit: '万度',
    });
    // 版本创建时已绑定旧树快照，因此即使当前树增加了子节点，预算仍按旧叶子编制并锁定。
    budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: generation.id, quantity: '100' }]);
    budget.lockVersion(db, v.id);

    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: shanghaiChild.id, accountId: generationChild.id, quantity: '88.5' }],
    });

    const completion = report.completionReport(db, { versionId: v.id });
    expect(completion.byAccount.find((row) => row.accountId === generation.id)?.cell.actualQuantity)
      .toBe(quantityStringToScaled('88.5'));
  });
});

describe('Excel 导入数量列', () => {
  async function budgetWorkbook(rows: (string | number)[][]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('预算导入');
    ws.addRow(['组织编码', '科目编码', '金额(元)', '数量', '备注']);
    rows.forEach((r) => ws.addRow(r));
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }
  it('金额/数量二选一,数量型科目经数量通道入库', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const qRoot = account.createAccount(db, { parentId: null, code: 'Q1', name: '电量指标', type: 'quantity', unit: '万度' });
    const qLeaf = account.createAccount(db, { parentId: qRoot.id, code: 'Q101', name: '上网电量', type: 'quantity', unit: '万度' });
    const buf = await budgetWorkbook([
      ['SH', 'I01', '100.00', '', ''],
      ['SH', 'Q101', '', '66.6', ''],
      ['HZ', 'Q101', '', '1.23456', ''],
    ]);
    const parsed = await io.parseBudgetImport(buf);
    expect(parsed.ok).toBe(false); // 第三行五位小数
    expect(parsed.errors.some((e) => e.field === 'quantity')).toBe(true);
    const buf2 = await budgetWorkbook([
      ['SH', 'I01', '100.00', '', ''],
      ['SH', 'Q101', '', '66.6', ''],
    ]);
    const parsed2 = await io.parseBudgetImport(buf2);
    expect(parsed2.ok).toBe(true);
    const v = budget.createVersion(db, { year: 2026, name: 'V' });
    const entries = io.resolveBudgetImport(db, v.id, parsed2);
    budget.saveEntries(db, v.id, entries);
    const matrix = budget.getEditMatrix(db, v.id);
    expect(matrix.entries.find((e) => e.accountId === qLeaf.id)?.quantity).toBe('66.6');
    expect(matrix.entries.find((e) => e.accountId === fx.accIds.incomeMain)?.amountDisplay).toBe('100.00');
  });
});
