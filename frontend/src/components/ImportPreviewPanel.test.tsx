// @vitest-environment jsdom
/**
 * ImportPreviewPanel(UX-15)静态渲染与纯函数测试:
 * - 摘要:目标/期间(多年度按组)/组织范围/单位与负数口径/动作统计/更新累计/生成快照/基线/结果位置;
 * - 明细行表:源行定位、万元概览 + 精确元入口、动作标签、分页总数(非 20 行示例);
 * - 确认门禁:已取消/失效批次不能确认并展示原因;
 * - 结果入口链接:预算版本/实际页/分析页快照/导入批次记录。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider } from 'antd';
import type { ImportBatchDetail, ImportPreviewRow, UnifiedPreviewSummary } from '../api/importBatch';
import {
  ImportSummaryView,
  ImportPreviewRowsTable,
  confirmBlockReason,
  importResultLinks,
} from './ImportPreviewPanel';

const render = (node: React.ReactElement) => renderToStaticMarkup(<ConfigProvider>{node}</ConfigProvider>);
const noop = () => {};

function makePreview(overrides: Partial<UnifiedPreviewSummary> = {}): UnifiedPreviewSummary {
  return {
    schemaVersion: 1,
    kind: 'budget',
    source: 'standard',
    history: false,
    target: { versionId: 12, versionName: 'V1草稿', year: 2026 },
    periods: [],
    orgScope: { count: 3, codes: ['G001', 'G002', 'G003'] },
    amountUnit: 'yuan',
    signConvention: 'profit_direction',
    actions: { insert: 5, overwrite: 2, clear: 1, unchanged: 40, noteChange: 3, excluded: 0, skipped: 0 },
    warnings: 1,
    updatesCurrent: false,
    createsSnapshot: false,
    comparisonBasis: 'budget_entry',
    resultLocation: 'budget_entry',
    ...overrides,
  };
}

function makeDetail(overrides: Partial<ImportBatchDetail> = {}): ImportBatchDetail {
  return {
    id: 7,
    kind: 'budget',
    status: 'pending',
    history: false,
    originalName: '预算导入.xlsx',
    sha256: 'ab'.repeat(32),
    createdAt: '2026-09-20T00:00:00.000Z',
    committedAt: null,
    rolledBackAt: null,
    target: { versionId: 12, versionName: 'V1草稿', year: 2026 },
    preview: makePreview(),
    summary: {},
    result: null,
    detailCapability: 'frozen-detail',
    actions: {
      confirm: { allowed: true },
      cancel: { allowed: true },
      rollback: { allowed: false, reason: '批次尚未确认，可取消而非撤销' },
    },
    ...overrides,
  };
}

function makeRow(overrides: Partial<ImportPreviewRow> = {}): ImportPreviewRow {
  return {
    id: 1,
    groupYear: null,
    groupDate: null,
    sourceSheet: '预算表',
    sourceRow: 3,
    orgId: 1,
    orgCode: 'G001',
    accountId: 9,
    accountCode: '6001',
    valueKind: 'amount',
    oldCents: null,
    newCents: 123_456_789,
    oldQuantity: null,
    newQuantity: null,
    oldText: '',
    newText: '',
    oldFormula: '',
    newFormula: '',
    oldValue: null,
    newValue: '1,234,567.89',
    action: 'insert',
    warning: '',
    ...overrides,
  };
}

describe('ImportSummaryView(统一核对信息)', () => {
  it('预算批次:写入目标/组织范围/单位与负数口径/动作统计/不更新累计/不生成快照', () => {
    const html = render(<ImportSummaryView detail={makeDetail()} />);
    expect(html).toContain('2026 年 · V1草稿');
    expect(html).toContain('3 个组织');
    expect(html).toContain('利润方向');
    expect(html).toContain('万元');
    expect(html).toContain('更新当前累计');
    expect(html).toContain('生成快照');
    expect(html).toContain('差异比较基线');
    expect(html).toContain('预算版本明细');
    expect(html).toContain('备注变更');
    expect(html).toContain('警告行');
  });

  it('多年度实际批次:期间按 年度×截止日 分组展示真实写入范围,不折叠为入口年度', () => {
    const detail = makeDetail({
      kind: 'actual',
      target: { year: 2025, years: [2025, 2026], periods: [
        { year: 2025, snapshotDate: '2025-12-31', entryCount: 10 },
        { year: 2026, snapshotDate: '2026-08-31', entryCount: 6 },
      ] },
      preview: makePreview({
        kind: 'actual',
        target: { year: 2025, years: [2025, 2026] },
        periods: [
          { year: 2025, snapshotDate: '2025-12-31', entryCount: 10 },
          { year: 2026, snapshotDate: '2026-08-31', entryCount: 6 },
        ],
        updatesCurrent: true,
        createsSnapshot: true,
        comparisonBasis: 'actual_current',
        resultLocation: 'actual_current_and_snapshot',
      }),
    });
    const html = render(<ImportSummaryView detail={detail} />);
    expect(html).toContain('2025 年（截止 2025-12-31）');
    expect(html).toContain('2026 年（截止 2026-08-31）');
    expect(html).toContain('当前累计实际数');
  });

  it('历史补录批次:不更新当前累计,比较基线为同日历史快照', () => {
    const detail = makeDetail({
      kind: 'actual',
      history: true,
      preview: makePreview({
        kind: 'actual',
        history: true,
        periods: [{ year: 2024, snapshotDate: '2024-06-30', entryCount: 4 }],
        updatesCurrent: false,
        createsSnapshot: true,
        comparisonBasis: 'history_snapshot',
        resultLocation: 'actual_history_snapshot',
      }),
      target: { year: 2024, years: [2024], periods: [{ year: 2024, snapshotDate: '2024-06-30', entryCount: 4 }] },
    });
    const html = render(<ImportSummaryView detail={detail} />);
    expect(html).toContain('不更新当前累计');
    expect(html).toContain('同日历史快照');
    expect(html).toContain('仅追加历史快照');
  });

  it('旧批次(legacy-summary):标注能力范围,仅提供摘要', () => {
    const detail = makeDetail({
      preview: null,
      detailCapability: 'legacy-summary',
      detailNote: '该批次创建于统一预览明细冻结能力启用前，仅提供已有摘要；需要完整逐行差异请重新预览',
    });
    const html = render(<ImportSummaryView detail={detail} />);
    expect(html).toContain('仅提供摘要');
    expect(html).toContain('统一预览明细冻结能力启用前');
    expect(html).toContain('没有统一预览摘要');
  });
});

describe('ImportPreviewRowsTable(冻结明细)', () => {
  const baseProps = {
    rows: [makeRow()],
    total: 137,
    page: 1,
    warningOnly: false,
    orgOptions: [{ value: 1, label: 'G001' }],
    onPageChange: noop,
    onActionFilterChange: noop,
    onOrgFilterChange: noop,
    onWarningOnlyChange: noop,
  };

  it('源工作表+行号定位;金额万元概览并带精确元入口', () => {
    const html = render(<ImportPreviewRowsTable {...baseProps} />);
    expect(html).toContain('预算表!第 3 行');
    expect(html).toContain('万元');
    // 123456789 分 = 123.46 万元(MoneyText 整数/小数分段渲染)
    expect(html).toContain('>123<');
    expect(html).toContain('>.46<');
    expect(html).toContain('精确值 1,234,567.89 元（利润方向）');
    expect(html).toContain('新增');
  });

  it('源行不可追溯时明确标记,不伪造行号', () => {
    const html = render(<ImportPreviewRowsTable {...baseProps} rows={[makeRow({ sourceSheet: '', sourceRow: null })]} />);
    expect(html).toContain('无法定位源行');
  });

  it('分页展示总数(分页读取,不是部分示例),并提供组织/动作/警告筛选', () => {
    const html = render(<ImportPreviewRowsTable {...baseProps} />);
    expect(html).toContain('共 137 条（分页读取）');
    expect(html).toContain('按组织筛选');
    expect(html).toContain('按动作筛选');
    expect(html).toContain('仅看警告行');
  });

  it('动作与警告按行呈现(覆盖/清零/备注变更)', () => {
    const rows = [
      makeRow({ id: 2, action: 'overwrite' }),
      makeRow({ id: 3, action: 'clear', newCents: 0, newValue: '0.00', warning: '当前累计记录将被清零并删除' }),
      makeRow({ id: 4, action: 'note_change' }),
    ];
    const html = render(<ImportPreviewRowsTable {...baseProps} rows={rows} total={3} />);
    expect(html).toContain('覆盖');
    expect(html).toContain('清零');
    expect(html).toContain('备注变更');
    expect(html).toContain('当前累计记录将被清零并删除');
  });
});

describe('confirmBlockReason(确认门禁)', () => {
  it('待确认且服务端允许:可确认', () => {
    expect(confirmBlockReason(makeDetail())).toBeNull();
  });

  it('已取消/失效批次不能确认,并展示服务端原因', () => {
    const cancelled = makeDetail({
      status: 'cancelled',
      actions: {
        confirm: { allowed: false, reason: '预览已取消或过期' },
        cancel: { allowed: false, reason: '预览已取消或过期' },
        rollback: { allowed: false, reason: '预览已取消或过期' },
      },
    });
    expect(confirmBlockReason(cancelled)).toBe('预览已取消或过期');
  });

  it('批次详情未加载完成时不可确认;路径额外门禁优先展示', () => {
    expect(confirmBlockReason(null)).toBe('批次详情加载中');
    expect(confirmBlockReason(makeDetail(), '上传后表格出现了未保存修改')).toBe('上传后表格出现了未保存修改');
  });
});

describe('importResultLinks(结果位置入口)', () => {
  it('预算批次:链接到预算版本与导入批次记录', () => {
    const links = importResultLinks(makeDetail());
    expect(links.some((l) => l.to === '/budget/12')).toBe(true);
    expect(links.some((l) => l.to === '/data?tab=imports')).toBe(true);
  });

  it('实际批次:每个写入年度给实际页与分析页(快照)入口', () => {
    const detail = makeDetail({
      kind: 'actual',
      result: { count: 16, results: [
        { year: 2025, snapshotDate: '2025-12-31', count: 10, batchId: 101 },
        { year: 2026, snapshotDate: '2026-08-31', count: 6, batchId: 102 },
      ] },
    });
    const links = importResultLinks(detail);
    expect(links.some((l) => l.to === '/actual?year=2025')).toBe(true);
    expect(links.some((l) => l.to === '/actual?year=2026')).toBe(true);
    const analysis = links.filter((l) => l.to.startsWith('/analysis?'));
    expect(analysis).toHaveLength(2);
    expect(analysis.some((l) => l.to.includes('actualSnapshotId=101') || l.to.includes('101'))).toBe(true);
    expect(links.some((l) => l.to === '/data?tab=imports')).toBe(true);
  });
});
