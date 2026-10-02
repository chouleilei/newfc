import { Space, Button, Select, Input, TreeSelect, Grid, Tag } from 'antd';
import type { SheetDef } from '../../utils/sheets';
import { useThemeMode, statusColor } from '../../theme';
import { GridShortcutHelp } from '../../components/GridAddons';

interface OrgTreeItem { value: number; title: string; children: OrgTreeItem[] }

/** 预算编制页筛选工具栏:预设表 / 组织范围 / 关键字 / 仅看有数据 / 层级展开 / 撤销重做 / 行密度 */
export function GridFilterBar(props: {
  sheetKey: string;
  onSheetKeyChange: (k: string) => void;
  sheetOptions: SheetDef[];
  hasDataInSheet: (k: string) => boolean;
  orgTreeData: OrgTreeItem[];
  effectiveOrgScope: number | null;
  onOrgScopeChange: (id: number) => void;
  keyword: string;
  onKeywordChange: (v: string) => void;
  nonZeroOnly: boolean;
  onNonZeroOnlyChange: (v: boolean) => void;
  collapseLevel: number | null;
  onCollapseLevelChange: (v: number | null) => void;
  editable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  density: 'compact' | 'standard' | 'relaxed';
  onDensityChange: (v: 'compact' | 'standard' | 'relaxed') => void;
  fullscreen: boolean;
  onFullscreenChange: (v: boolean) => void;
}) {
  const screens = Grid.useBreakpoint();
  const { mode } = useThemeMode();
  /**
   * 窄屏收窄组织范围选择器。
   *
   * 手机视口下内容区只有 ~240px,而「组织范围」标签 + 230px 的 TreeSelect 合起来是一个
   * 不可再拆的 flex 项:它比整行还宽,换行也躲不掉,只能把整页撑出横向滚动条。
   * 其余控件(表格 170、搜索 160、层级 116、行高 96)加上标签都在行宽内,不必动。
   */
  const orgSelectWidth = screens.sm === false ? 150 : 230;
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
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '10px 14px',
        background: 'var(--newfc-header)',
        borderRadius: 8,
        border: '1px solid var(--newfc-border-subtle)',
        marginBottom: 12,
      }}
    >
      <Space size="middle" wrap>
        <Space size="small">
          <span style={{ fontSize: 13, color: 'var(--newfc-text-tertiary)', fontWeight: 500 }}>表格</span>
          <Select
            id="budget-sheet-select"
            style={{ width: 170 }}
            value={props.sheetKey}
            onChange={props.onSheetKeyChange}
            options={props.sheetOptions.map((s) => ({
              value: s.key,
              label: (
                <span>
                  <span style={{ color: props.hasDataInSheet(s.key) ? statusColor(mode).good : 'var(--newfc-text-tertiary)', marginRight: 6 }}>●</span>
                  {s.name}
                </span>
              ),
            }))}
          />
        </Space>
        <Space size="small">
          <span style={{ fontSize: 13, color: 'var(--newfc-text-tertiary)', fontWeight: 500 }}>组织范围</span>
          <TreeSelect
            style={{ width: orgSelectWidth }}
            treeData={props.orgTreeData}
            value={props.effectiveOrgScope ?? undefined}
            allowClear={false}
            treeDefaultExpandAll
            onChange={(val) => props.onOrgScopeChange(val as number)}
          />
        </Space>
        <Input.Search
          placeholder="搜索科目编码/名称"
          style={{ width: 160 }}
          value={props.keyword}
          onChange={(e) => props.onKeywordChange(e.target.value)}
          allowClear
        />
        <Button type={props.nonZeroOnly ? 'primary' : 'default'} onClick={() => props.onNonZeroOnlyChange(!props.nonZeroOnly)}>仅看有数据</Button>
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
        <Button
          icon={props.fullscreen ? <i className="ri-fullscreen-exit-line" aria-hidden /> : <i className="ri-fullscreen-line" aria-hidden />}
          onClick={() => props.onFullscreenChange(!props.fullscreen)}
          title={props.fullscreen ? '退出全屏(Esc)' : '全屏显示表格(Esc 退出)'}
        >{props.fullscreen ? '退出全屏(Esc)' : '全屏'}</Button>
      </Space>

      <Space size="small">
        {props.editable && (
          <Space.Compact>
            <Button icon={<i className="ri-arrow-go-back-line" aria-hidden />} disabled={!props.canUndo} onClick={props.onUndo} title="撤销(Ctrl+Z)">撤销</Button>
            <Button icon={<i className="ri-arrow-go-forward-line" aria-hidden />} disabled={!props.canRedo} onClick={props.onRedo} title="重做(Ctrl+Y)">重做</Button>
          </Space.Compact>
        )}
        <GridShortcutHelp variant="budget" />
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
      </Space>
    </div>
  );
}
