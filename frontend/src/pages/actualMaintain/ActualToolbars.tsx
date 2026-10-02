import { Space, Button, Select, Input, TreeSelect, DatePicker, Divider, Segmented, Tag, Grid } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { SheetDef } from '../../utils/sheets';
import { GridShortcutHelp } from '../../components/GridAddons';

interface OrgTreeItem { value: number; title: string; children: OrgTreeItem[] }

/**
 * 历史数据维护页双层工具栏:
 * 第一层 = 编辑任务(更新当前/补录历史) / 视图模式 / 组织范围 / 报表 / 维护年度(+添加历史年份) / 重开年度;
 * 第二层 = 关键字过滤 / 仅看有数据 / 层级展开 / 累计截至日期 / 撤销重做 / 行密度。
 * UX-08:任务用可见 Segmented 表达(替代隐蔽复选框);截止日带「累计截至」标签与所选年度月末快捷选择,
 * 绝不默认今天或最新月份(默认由页面按任务与服务端截止日解析)。
 */
export function ActualToolbars(props: {
  viewMode: 'orgs' | 'years';
  onViewModeChange: (v: 'orgs' | 'years') => void;
  orgTreeData: OrgTreeItem[];
  effectiveScopeId: number | null;
  onOrgScopeChange: (v: number | null) => void;
  sheetKey: string;
  onSheetKeyChange: (k: string) => void;
  dbSheets: SheetDef[];
  editYear: number;
  onYearChange: (y: number) => void;
  years: number[];
  onAddYear: () => void;
  frozen: boolean;
  onReopen: () => void;
  keyword: string;
  onKeywordChange: (v: string) => void;
  nonZeroOnly: boolean;
  onNonZeroOnlyChange: (v: boolean) => void;
  collapseLevel: number | null;
  onCollapseLevelChange: (v: number | null) => void;
  cutoff: Dayjs | null;
  onCutoffChange: (d: Dayjs | null) => void;
  historyMode: boolean;
  onHistoryModeChange: (v: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  density: 'compact' | 'standard' | 'relaxed';
  onDensityChange: (v: 'compact' | 'standard' | 'relaxed') => void;
  fullscreen: boolean;
  onFullscreenChange: (v: boolean) => void;
}) {
  /* 视图切换 Segmented 的完整文案约 272px,比手机上工具栏可用宽度(约 228px)还宽,
     且 Segmented 是不可收缩的整体,只能在窄屏收短文案。 */
  const narrowScreen = Grid.useBreakpoint().md === false;
  /* UX-23-4:筛选状态可见 + 一键清除,避免忘记空白待填项被隐藏 */
  const filterParts: string[] = [];
  if (props.nonZeroOnly) filterParts.push('仅看有数据');
  if (props.keyword.trim()) filterParts.push(`关键字“${props.keyword.trim()}”`);
  if (props.collapseLevel != null) filterParts.push('按层级收起');
  const clearFilters = () => {
    if (props.keyword) props.onKeywordChange('');
    if (props.nonZeroOnly) props.onNonZeroOnlyChange(false);
    if (props.collapseLevel != null) props.onCollapseLevelChange(null);
  };
  /* 所选年度的月末快捷选择(UX-08):快捷项只减少点击,不做任何默认 */
  const monthEndPresets = Array.from({ length: 12 }, (_, i) => ({
    label: `${i + 1} 月末`,
    value: dayjs(`${props.editYear}-${String(i + 1).padStart(2, '0')}-01`).endOf('month'),
  }));
  return (
    <>
      {/* 结构化工具栏第一层: 编辑任务、核心维度与模式切换 */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 14px',
          background: 'var(--newfc-header)',
          borderRadius: 8,
          border: '1px solid var(--newfc-border-subtle)',
          marginBottom: 10,
        }}
      >
        <Space size="middle" wrap>
          <Segmented
            value={props.historyMode ? 'history' : 'current'}
            onChange={(v) => props.onHistoryModeChange(v === 'history')}
            disabled={props.frozen}
            options={[
              { label: narrowScreen ? '更新当前' : '更新当前实际', value: 'current' },
              { label: narrowScreen ? '补录历史' : '补录历史快照', value: 'history' },
            ]}
          />
          <Divider type="vertical" style={{ borderColor: 'var(--newfc-border)', margin: '0 4px' }} />
          <Segmented
            value={props.viewMode}
            onChange={(v) => props.onViewModeChange(v as 'orgs' | 'years')}
            options={[
              { label: narrowScreen ? '🏢 多组织' : '🏢 多组织横向展开', value: 'orgs' },
              { label: narrowScreen ? '📅 多年趋势' : '📅 多年趋势对比', value: 'years' },
            ]}
          />
          <Divider type="vertical" style={{ borderColor: 'var(--newfc-border)', margin: '0 4px' }} />
          <Space size="small" wrap>
            <span style={{ fontSize: 13, color: 'var(--newfc-text-tertiary)', fontWeight: 500 }}>预算组织</span>
            <TreeSelect
              aria-label="实际数组织"
              style={{ width: 230 }}
              treeData={props.orgTreeData}
              value={props.effectiveScopeId ?? undefined}
              allowClear={false}
              treeDefaultExpandAll
              onChange={(v) => props.onOrgScopeChange((v as number | null) ?? null)}
            />
          </Space>
          <Space size="small" wrap>
            <span style={{ fontSize: 13, color: 'var(--newfc-text-tertiary)', fontWeight: 500 }}>报表</span>
            <Select
              aria-label="实际数报表"
              style={{ width: 140 }}
              value={props.sheetKey}
              onChange={props.onSheetKeyChange}
              options={[{ value: 'profit', label: '利润表' }, { value: 'overview', label: '一级汇总' }, ...props.dbSheets.map((s) => ({ value: s.key, label: s.name }))]}
            />
          </Space>
          <Space size="small" wrap>
            <span style={{ fontSize: 13, color: 'var(--newfc-text-tertiary)', fontWeight: 500 }}>维护年度</span>
            <Space.Compact>
              <Select aria-label="实际数年度" style={{ width: 96 }} value={props.editYear} onChange={props.onYearChange} options={props.years.map((y) => ({ value: y, label: `${y} 年` }))} />
              <Button icon={<i className="ri-add-line" aria-hidden />} title="添加历史年份" onClick={props.onAddYear} />
            </Space.Compact>
          </Space>
        </Space>

        {props.frozen && (
          <Button
            danger
            size="small"
            onClick={props.onReopen}
          >
            重开 {props.editYear} 年度
          </Button>
        )}
      </div>

      {/* 结构化工具栏第二层: 快捷过滤、快照日期与表格操作 */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 12,
        }}
      >
        <Space size="small" wrap>
          <Input.Search
            placeholder="搜索科目编码/名称"
            style={{ width: 170 }}
            value={props.keyword}
            onChange={(e) => props.onKeywordChange(e.target.value)}
            allowClear
          />
          <Button
            type={props.nonZeroOnly ? 'primary' : 'default'}
            size="middle"
            onClick={() => props.onNonZeroOnlyChange(!props.nonZeroOnly)}
          >
            仅看有数据
          </Button>
          {filterParts.length > 0 && (
            <Space size={4} wrap>
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>已筛选：{filterParts.join('、')}，部分行列被隐藏</Tag>
              <Button size="small" type="link" style={{ padding: 0 }} onClick={clearFilters}>清除筛选</Button>
            </Space>
          )}
          <Select
            style={{ width: 116 }}
            placeholder="层级展开"
            value={props.collapseLevel ?? 'all'}
            onChange={(v) => props.onCollapseLevelChange(v === 'all' ? null : Number(v))}
            options={[
              { value: 'all', label: '全部展开' },
              { value: 0, label: '仅一级科目' },
              { value: 1, label: '展开至二级' },
              { value: 2, label: '展开至三级' },
            ]}
          />
          <Space size={4} wrap>
            <span style={{ fontSize: 13, color: 'var(--newfc-text-tertiary)', fontWeight: 500 }}>累计截至</span>
            <DatePicker
              style={{ width: 140 }}
              value={props.cutoff}
              onChange={props.onCutoffChange}
              placeholder={props.historyMode ? '选择历史截止日' : '选择累计截止日'}
              presets={monthEndPresets}
              allowClear={false}
              disabledDate={(d) => d.year() !== props.editYear}
              disabled={props.frozen}
            />
          </Space>
          {props.historyMode && (
            <Tag color="gold" style={{ marginInlineEnd: 0 }}>
              仅补充这个日期的历史记录，不更新当前累计
            </Tag>
          )}
        </Space>

        <Space size="small" wrap>
          <Space.Compact>
            <Button icon={<i className="ri-arrow-go-back-line" aria-hidden />} disabled={props.frozen || !props.canUndo} onClick={props.onUndo} title="撤销(Ctrl+Z)">撤销</Button>
            <Button icon={<i className="ri-arrow-go-forward-line" aria-hidden />} disabled={props.frozen || !props.canRedo} onClick={props.onRedo} title="重做(Ctrl+Y)">重做</Button>
          </Space.Compact>
          <GridShortcutHelp variant="actual" />
          <Select
            style={{ width: 96 }}
            value={props.density}
            onChange={props.onDensityChange}
            options={[
              { value: 'compact', label: '紧凑行高' },
              { value: 'standard', label: '标准行高' },
              { value: 'relaxed', label: '宽松行高' },
            ]}
          />
          <Button
            icon={props.fullscreen ? <i className="ri-fullscreen-exit-line" aria-hidden /> : <i className="ri-fullscreen-line" aria-hidden />}
            onClick={() => props.onFullscreenChange(!props.fullscreen)}
            title={props.fullscreen ? '退出全屏(Esc)' : '全屏显示表格(Esc 退出)'}
          >{props.fullscreen ? '退出全屏(Esc)' : '全屏'}</Button>
        </Space>
      </div>
    </>
  );
}
