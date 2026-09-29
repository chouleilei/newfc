/**
 * UX-20/UX-21 冲突恢复纯函数测试:
 * - 三方比较分类(仅本地/仅服务器/双方同格/双方一致收敛)
 * - 精确值比较:显示相同(0.00 万)但原始分值不同也算差异;未编辑格直通基线精确分
 * - 公式/附注/汇总备注/删除意图纳入比较
 * - 恢复文件生成/解析/版本与格式校验/内容校验
 * - 恢复方案:默认保留服务器值、只应用选定本地修改、非法内容拦截
 */
import { describe, expect, it } from 'vitest';
import type { MatrixResponse } from './types';
import {
  captureBaseline,
  baselineFromSave,
  computeThreeWayDiff,
  buildRecoveryFile,
  parseRecoveryFile,
  validateRecoveryContent,
  overlayFromRecovery,
  buildResolutionPlan,
  displayOfExact,
  type DraftMaps,
} from './conflictRecovery';

type Entry = MatrixResponse['entries'][number];

function matrix(entries: Entry[], cellNotes: MatrixResponse['cellNotes'] = [], revision = 7): MatrixResponse {
  return {
    version: { id: 1, year: 2026, name: '年初预算', status: 'draft', is_current: 0, kind: 'budget', note: '', org_tree_snapshot_id: 1, account_tree_snapshot_id: 1, revision },
    orgNodes: [{ id: 101, parent_id: null, code: 'X1', name: '组织一', status: 'active' }],
    accountNodes: [
      { id: 1, parent_id: null, code: 'A1', name: '差旅费', type: 'expense', status: 'active' },
      { id: 2, parent_id: null, code: 'Q1', name: '电量', type: 'quantity', status: 'active' },
    ],
    leafOrgIds: [101],
    leafAccountIds: [1, 2],
    entries,
    cellNotes,
  };
}

/** 费用科目:raw 为利润方向(费用为负),display 元为正 */
function expenseEntry(amountCentsRaw: number, extra: Partial<Entry> = {}): Entry {
  return { orgId: 101, accountId: 1, amountCents: amountCentsRaw, amountDisplay: `${(-amountCentsRaw / 100).toFixed(2)}`, quantity: null, formula: '', note: '', ...extra };
}

function quantityEntry(scaledText: string, extra: Partial<Entry> = {}): Entry {
  return { orgId: 101, accountId: 2, amountCents: 0, amountDisplay: '', quantity: scaledText, formula: '', note: '', ...extra };
}

function draft(partial: Partial<DraftMaps> = {}): DraftMaps {
  return {
    values: new Map(), formulas: new Map(), notes: new Map(), summaryNotes: new Map(),
    ...partial,
  };
}

const accountTypeOf = (accountId: number) => (accountId === 1 ? 'expense' : accountId === 2 ? 'quantity' : undefined);

describe('captureBaseline', () => {
  it('金额按原始分(利润方向)、数量按缩放整数、附注公式原样捕获', () => {
    const b = captureBaseline(matrix([expenseEntry(-1000000, { formula: '=1+1', note: 'n' }), quantityEntry('12.34')], [{ orgId: 101, accountId: 0, note: '汇总说明' }], 7));
    expect(b.revision).toBe(7);
    expect(b.cells.get('101:1')).toEqual({ amountCents: -1000000, quantityScaled: null, formula: '=1+1', note: 'n' });
    expect(b.cells.get('101:2')).toEqual({ amountCents: null, quantityScaled: 123400, formula: '', note: '' });
    expect(b.summaryNotes.get('101:0')).toBe('汇总说明');
  });
});

describe('baselineFromSave', () => {
  it('整包保存 payload 推进基线:显示元转利润方向分、数量显示转缩放', () => {
    const b = baselineFromSave(8, {
      entries: [
        { orgId: 101, accountId: 1, amount: '1234.00', formula: '=2*2' },
        { orgId: 101, accountId: 2, quantity: '56.78' },
      ],
      cellNotes: [{ orgId: 101, accountId: 0, note: 'x' }],
    }, accountTypeOf);
    expect(b.revision).toBe(8);
    expect(b.cells.get('101:1')?.amountCents).toBe(-123400);
    expect(b.cells.get('101:2')?.quantityScaled).toBe(567800);
    expect(b.summaryNotes.get('101:0')).toBe('x');
  });
});

describe('computeThreeWayDiff 分类', () => {
  it('服务器未变 + 本地独改 -> 仅本地修改', () => {
    const server = matrix([expenseEntry(-1000000)]);
    const result = computeThreeWayDiff({
      baseline: captureBaseline(server),
      local: draft({ values: new Map([['101:1', '2.00']]) }),
      server,
      accountTypeOf,
    });
    expect(result.diffs).toHaveLength(1);
    const d = result.diffs[0];
    expect(d.category).toBe('local_only');
    expect(d.baseline?.amountCents).toBe(-1000000);
    expect(d.local?.amountCents).toBe(-2000000);
    expect(d.server?.amountCents).toBe(-1000000);
    expect(d.aspects).toEqual(['金额']);
  });

  it('本地未动 + 服务器独改 -> 仅服务器修改;未编辑格直通基线精确分', () => {
    const baseline = captureBaseline(matrix([expenseEntry(-1000000)]));
    const server = matrix([expenseEntry(-1500000)], [], 8);
    const result = computeThreeWayDiff({
      baseline,
      // 网格显示与基线一致(用户没动过这格)
      local: draft({ values: new Map([['101:1', '1.00']]) }),
      server,
      accountTypeOf,
    });
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].category).toBe('server_only');
    expect(result.diffs[0].server?.amountCents).toBe(-1500000);
  });

  it('双方改同一格且结果不同 -> 双方都修改;结果一致 -> 收敛不入清单', () => {
    const baseline = captureBaseline(matrix([expenseEntry(-1000000)]));
    const server = matrix([expenseEntry(-1500000)], [], 8);
    const both = computeThreeWayDiff({
      baseline,
      local: draft({ values: new Map([['101:1', '2.00']]) }),
      server,
      accountTypeOf,
    });
    expect(both.diffs[0]?.category).toBe('both');

    const converged = computeThreeWayDiff({
      baseline,
      local: draft({ values: new Map([['101:1', '1.50']]) }),
      server,
      accountTypeOf,
    });
    expect(converged.diffs).toHaveLength(0);
    expect(converged.convergedCount).toBe(1);
  });

  it('显示值相同(0.00 万)但原始分值不同也算差异', () => {
    // 基线 0.49 元、服务器 0.51 元,万元两位小数都显示 0.00
    const baseline = captureBaseline(matrix([expenseEntry(-49)]));
    const server = matrix([expenseEntry(-51)], [], 8);
    const result = computeThreeWayDiff({
      baseline,
      local: draft({ values: new Map([['101:1', '0.00']]) }),
      server,
      accountTypeOf,
    });
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].category).toBe('server_only');
    expect(result.diffs[0].baseline?.amountCents).toBe(-49);
    expect(result.diffs[0].server?.amountCents).toBe(-51);
  });

  it('未编辑格显示相同但基线分值非整百元:直通基线精确分,不制造假差异', () => {
    const server = matrix([expenseEntry(-49)]);
    const result = computeThreeWayDiff({
      baseline: captureBaseline(server),
      local: draft({ values: new Map([['101:1', '0.00']]) }),
      server,
      accountTypeOf,
    });
    expect(result.diffs).toHaveLength(0);
    expect(result.convergedCount).toBe(0);
  });

  it('公式/附注/数量/汇总备注/删除意图全部纳入比较', () => {
    const baseline = captureBaseline(matrix(
      [expenseEntry(-1000000, { formula: '=1+1', note: '旧' }), quantityEntry('12.34')],
      [{ orgId: 101, accountId: 0, note: '汇总旧' }],
    ));
    const server = matrix(
      [expenseEntry(-1000000, { formula: '=1+1', note: '旧' }), quantityEntry('12.34')],
      [{ orgId: 101, accountId: 0, note: '汇总旧' }],
    );
    const result = computeThreeWayDiff({
      baseline,
      local: draft({
        values: new Map([['101:1', '1.00'], ['101:2', '99.5']]),
        formulas: new Map([['101:1', '=2+2']]),
        notes: new Map([['101:1', '新']]),
        summaryNotes: new Map([['101:0', '汇总新']]),
      }),
      server,
      accountTypeOf,
    });
    const byKey = new Map(result.diffs.map((d) => [`${d.kind}:${d.key}`, d]));
    expect(byKey.get('detail:101:1')?.category).toBe('local_only');
    expect(byKey.get('detail:101:1')?.aspects).toEqual(['公式', '附注']);
    expect(byKey.get('detail:101:2')?.aspects).toEqual(['数量']);
    expect(byKey.get('summary_note:101:0')?.category).toBe('local_only');

    // 删除意图:本地清空基线有内容的格
    const del = computeThreeWayDiff({
      baseline,
      local: draft({ summaryNotes: new Map([['101:0', '汇总旧']]) }),
      server,
      accountTypeOf,
    });
    const amountDel = del.diffs.find((d) => d.key === '101:1');
    expect(amountDel?.category).toBe('local_only');
    expect(amountDel?.localDelete).toBe(true);
    expect(amountDel?.local).toBeNull();
  });

  it('本地显示值非法:标记 localInvalid 但仍参与分类', () => {
    const baseline = captureBaseline(matrix([expenseEntry(-1000000)]));
    const server = matrix([expenseEntry(-1000000)]);
    const result = computeThreeWayDiff({
      baseline,
      local: draft({ values: new Map([['101:1', 'abc']]) }),
      server,
      accountTypeOf,
    });
    expect(result.diffs[0]?.category).toBe('local_only');
    expect(result.diffs[0]?.localInvalid).toBe(true);
  });
});

describe('恢复文件', () => {
  function localOnlyDiff() {
    const server = matrix([expenseEntry(-1000000)]);
    return computeThreeWayDiff({
      baseline: captureBaseline(server),
      local: draft({ values: new Map([['101:1', '2.00']]), notes: new Map([['101:1', '说明']]) }),
      server,
      accountTypeOf,
    });
  }

  it('导出的本地待保存修改含精确值/公式/备注,可无损往返', () => {
    const diff = localOnlyDiff();
    const file = buildRecoveryFile({
      versionId: 1, versionName: '年初预算', year: 2026, baselineRevision: 7,
      diffs: diff.diffs,
      localDisplay: new Map([['101:1', '2.00']]),
      exportedAt: '2026-09-20T00:00:00.000Z',
    });
    expect(file.kind).toBe('budget-conflict-recovery');
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]).toMatchObject({ orgId: 101, accountId: 1, kind: 'money', amountCents: -2000000, note: '说明', delete: false, display: '2.00' });
    const text = JSON.stringify(file);
    // 不含认证信息字段
    expect(text).not.toMatch(/token|password|authorization/i);

    const parsed = parseRecoveryFile(text, 1);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.file.entries[0].amountCents).toBe(-2000000);
  });

  it('删除意图导出为 delete: true 的空值', () => {
    const server = matrix([expenseEntry(-1000000)]);
    const diff = computeThreeWayDiff({
      baseline: captureBaseline(server),
      local: draft(),
      server,
      accountTypeOf,
    });
    const file = buildRecoveryFile({
      versionId: 1, versionName: 'v', year: 2026, baselineRevision: 7,
      diffs: diff.diffs, localDisplay: new Map(),
    });
    expect(file.entries[0]).toMatchObject({ delete: true, amountCents: null });
  });

  it('版本不匹配/格式损坏/字段非法均明确拒绝', () => {
    const diff = localOnlyDiff();
    const file = buildRecoveryFile({
      versionId: 1, versionName: 'v', year: 2026, baselineRevision: 7,
      diffs: diff.diffs, localDisplay: new Map(),
    });
    expect(parseRecoveryFile('not json', 1)).toMatchObject({ ok: false });
    expect(parseRecoveryFile(JSON.stringify({ ...file, kind: 'other' }), 1)).toMatchObject({ ok: false });
    expect(parseRecoveryFile(JSON.stringify({ ...file, formatVersion: 99 }), 1)).toMatchObject({ ok: false });
    const wrongVersion = parseRecoveryFile(JSON.stringify({ ...file, versionId: 2 }), 1);
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.error).toContain('版本 #2');
    expect(parseRecoveryFile(JSON.stringify({ ...file, entries: [{ orgId: 'x' }] }), 1)).toMatchObject({ ok: false });
    expect(parseRecoveryFile(JSON.stringify({ ...file, entries: [{ ...file.entries[0], amountCents: 1.5 }] }), 1)).toMatchObject({ ok: false });
  });

  it('内容校验:科目不存在/公式无法求值被拒绝', () => {
    const diff = localOnlyDiff();
    const file = buildRecoveryFile({
      versionId: 1, versionName: 'v', year: 2026, baselineRevision: 7,
      diffs: diff.diffs, localDisplay: new Map(),
    });
    expect(validateRecoveryContent(file, accountTypeOf)).toEqual([]);
    const badFormula = { ...file, entries: [{ ...file.entries[0], formula: '=1+' }] };
    expect(validateRecoveryContent(badFormula, accountTypeOf)[0]).toContain('无法求值');
    const unknownAccount = { ...file, entries: [{ ...file.entries[0], accountId: 999 }] };
    expect(validateRecoveryContent(unknownAccount, accountTypeOf)[0]).toContain('不在当前版本的科目快照中');
  });

  it('导入恢复文件后经重叠参与同一三方比较', () => {
    const diff = localOnlyDiff();
    const file = buildRecoveryFile({
      versionId: 1, versionName: 'v', year: 2026, baselineRevision: 7,
      diffs: diff.diffs, localDisplay: new Map(),
    });
    const parsed = parseRecoveryFile(JSON.stringify(file), 1);
    if (!parsed.ok) throw new Error('parse failed');
    const overlay = overlayFromRecovery(parsed.file);
    // 网格已不含本地输入(如刷新后),导入文件恢复本地侧
    const server = matrix([expenseEntry(-1000000)]);
    const rediff = computeThreeWayDiff({
      baseline: captureBaseline(server),
      local: draft(),
      server,
      accountTypeOf,
      overlay,
    });
    expect(rediff.diffs).toHaveLength(1);
    expect(rediff.diffs[0].category).toBe('local_only');
    expect(rediff.diffs[0].local?.amountCents).toBe(-2000000);
  });
});

describe('buildResolutionPlan', () => {
  it('默认保留服务器值;选定项恢复本地值;服务器其他格新值保留', () => {
    const baseline = captureBaseline(matrix([expenseEntry(-1000000), quantityEntry('12.34')]));
    const server = matrix([expenseEntry(-1500000), quantityEntry('12.34')], [], 8);
    const diff = computeThreeWayDiff({
      baseline,
      local: draft({ values: new Map([['101:1', '2.00'], ['101:2', '99.5']]) }),
      server,
      accountTypeOf,
    });
    // 101:1 双方都改了(本地 2.00 / 服务器 1.50);101:2 本地独改
    const byKey = new Map(diff.diffs.map((d) => [d.key, d]));
    expect(byKey.get('101:1')?.category).toBe('both');
    expect(byKey.get('101:2')?.category).toBe('local_only');

    const current = draft({ values: new Map([['101:1', '2.00'], ['101:2', '99.5']]) });
    // 只选 101:2 -> 101:1 保留服务器 1.50,101:2 恢复本地 99.5
    const plan = buildResolutionPlan({ diffs: diff.diffs, selectedKeys: new Set(['101:2']), server, accountTypeOf, current });
    expect(plan.errors).toEqual([]);
    expect(plan.merged.values.get('101:1')).toBe('1.50');
    expect(plan.merged.values.get('101:2')).toBe('99.5');
    const updateByKey = new Map(plan.updates.map((u) => [u.key, u]));
    // 101:1 当前是本地 2.00,需要回写服务器 1.50;101:2 当前已是 99.5,无需写入
    expect(updateByKey.get('101:1')?.value).toBe('1.50');
    expect(updateByKey.has('101:2')).toBe(false);

    // 全不选 -> 全部采用服务器值
    const keepServer = buildResolutionPlan({ diffs: diff.diffs, selectedKeys: new Set(), server, accountTypeOf, current });
    expect(keepServer.merged.values.get('101:1')).toBe('1.50');
    expect(keepServer.merged.values.get('101:2')).toBe('12.34');
  });

  it('选定非法本地值时给出错误,不产生可提交方案', () => {
    const baseline = captureBaseline(matrix([expenseEntry(-1000000)]));
    const server = matrix([expenseEntry(-1000000)]);
    const diff = computeThreeWayDiff({
      baseline,
      local: draft({ values: new Map([['101:1', 'abc']]) }),
      server,
      accountTypeOf,
    });
    expect(diff.diffs[0].localInvalid).toBe(true);
    // 选定恢复非法本地值:明确报错,不进入保存链路
    const plan = buildResolutionPlan({ diffs: diff.diffs, selectedKeys: new Set(['101:1']), server, accountTypeOf, current: draft({ values: new Map([['101:1', 'abc']]) }) });
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]).toContain('不是合法金额格式');
    // 未选定该格:回写服务器值,正常可提交
    const keepServer = buildResolutionPlan({ diffs: diff.diffs, selectedKeys: new Set(), server, accountTypeOf, current: draft({ values: new Map([['101:1', 'abc']]) }) });
    expect(keepServer.errors).toEqual([]);
    expect(keepServer.merged.values.get('101:1')).toBe('1.00');
  });

  it('恢复公式经求值校验;非法公式进入错误清单', () => {
    const baseline = captureBaseline(matrix([expenseEntry(-1000000)]));
    const server = matrix([expenseEntry(-1500000)], [], 8);
    const diff = computeThreeWayDiff({
      baseline,
      local: draft({ values: new Map([['101:1', '2.00']]), formulas: new Map([['101:1', '=1+1']]) }),
      server,
      accountTypeOf,
    });
    const plan = buildResolutionPlan({ diffs: diff.diffs, selectedKeys: new Set(['101:1']), server, accountTypeOf, current: draft() });
    expect(plan.errors).toEqual([]);
    expect(plan.merged.formulas.get('101:1')).toBe('=1+1');
  });
});

describe('displayOfExact', () => {
  it('金额按万元显示(利润方向还原),数量按原值显示', () => {
    expect(displayOfExact({ amountCents: -2000000, quantityScaled: null, formula: '', note: '' }, 'expense')).toBe('2.00');
    expect(displayOfExact({ amountCents: null, quantityScaled: 123400, formula: '', note: '' }, 'quantity')).toBe('12.34');
    expect(displayOfExact(null, 'expense')).toBe('');
  });
});
