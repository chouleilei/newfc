import { Alert, Button, Input, Tag, Tooltip, Typography, theme, Space } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { centsToWan } from '../../utils/money';
import { typeTagConfig, type OrgColDef } from '../../utils/grid';
import { useThemeMode, NUMERIC_FONT_FAMILY, financeColor, statusColor } from '../../theme';
import { useColumnWidths, ColResizeGrip } from '../../components/GridAddons';
import { useGridInteraction } from '../../hooks/useGridInteraction';
import { useGridCrosshair } from '../../hooks/useGridCrosshair';
import { MatrixColumnConfig } from '../../components/MatrixColumnConfig';
import type { GridRow, Row } from './types';

type Grid = ReturnType<typeof useGridInteraction>;

/**
 * 预算编制网格表格:科目行(缩进+汇总)× 多级组织列。
 * 三类行渲染:指标计算行(只读勾稽)/ 利润表取数行(只读带符号)/ 普通科目行(叶子可编辑)。
 * 列宽持久化状态内聚在本组件(仅此处消费)。
 */
export function BudgetGridTable(props: {
  visibleRows: GridRow[];
  isMetricSheet: boolean;
  sheetName?: string;
  orgDisplayCols: OrgColDef[];
  collapsedOrgCols: Set<number>;
  onToggleCollapseOrgCol: (orgId: number) => void;
  onVisibleLeafIdsChange: (orgIds: number[]) => void;
  values: Map<string, string>;
  formulas: Map<string, string>;
  notes: Map<string, string>;
  /** 汇总格备注(非叶子组织列/非叶子科目行),键与 values 同为 `orgId:accountId` */
  summaryNotes: Map<string, string>;
  /** 汇总格备注是否可编辑(草稿且无冲突);只读时仍可悬浮查看 */
  canEditSummary: boolean;
  invalidCells: Set<string>;
  activeCell: { orgId: number; rowId: number } | null;
  formulaPreview: Grid['formulaPreview'];
  grid: Grid;
  gridRowIdx: Map<number, number>;
  gridColIdx: Map<number, number>;
  cellEditable: (row: Row | undefined, orgId: number) => boolean;
  totalCache: (rowId: number, orgId: number) => number;
  orgAccTotals: Map<number, Map<number, number>>;
  metricValue: (metricId: number, totals: Map<number, number>) => number;
  displayTotal: (row: Row, v: number) => string;
  density: 'compact' | 'standard' | 'relaxed';
  onOpenNote: (rowId: number, orgId: number) => void;
  historyCount?: (orgId: number, accountId: number) => number;
  onOpenCellHistory?: (orgId: number, accountId: number) => void;
  onCtxMenu: (s: { open: boolean; x: number; y: number; r: number; c: number }) => void;
  fullscreen?: boolean;
  /** UX-23-1:整表只读原因(定稿/归档/冲突暂停),只读格悬浮可读到原因 */
  readonlyReason?: string | null;
  /** UX-23-1:定稿(只读)版本在网格区的「基于此版继续编制」入口(复制为新草稿,走现有复制流程) */
  continueEntry?: { label: string; onClick: () => void } | null;
  /** UX-23-1:「层级展开」筛选正在隐藏子行;汇总行给「展开子项」入口 */
  rowsCollapsedByFilter?: boolean;
  onShowAllRowLevels?: () => void;
  /** UX-23-2:新草稿首次进入的一次性短提示(localStorage 标记,非强制弹窗) */
  firstDraftHint?: boolean;
}) {
  const { token } = theme.useToken();
  const { mode } = useThemeMode();
  const typeChips = typeTagConfig(mode);
  const fc = financeColor(mode);
  const sc = statusColor(mode);
  /* 主色派生:焦点格底色比「当前列」再深一档;类型 chip 描边取主色 30%。
     不新增色相,全部由 --bd-primary 的透明度派生(沿用既有 color-mix 手法)。 */
  const primaryFocusBg = 'color-mix(in srgb, var(--bd-primary) 18%, transparent)';
  const primaryChipBorder = 'color-mix(in srgb, var(--bd-primary) 30%, transparent)';
  const accentSoftBorder = 'color-mix(in srgb, var(--bd-accent) 45%, transparent)';
  const { widthOf, startResize } = useColumnWidths('bd-budget-colwidths');
  const cellH = props.density === 'compact' ? 24 : props.density === 'relaxed' ? 34 : 28;

  const thStyle = (extra?: React.CSSProperties): React.CSSProperties => ({
    position: 'sticky', top: 0, zIndex: 2,
    background: 'var(--bd-header)',
    border: '1px solid var(--bd-border)',
    color: 'var(--bd-text)',
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 8px', ...extra,
  });

  const { visibleRows, orgDisplayCols: allOrgDisplayCols, collapsedOrgCols, grid, values, formulas, notes, invalidCells, activeCell, formulaPreview, gridRowIdx, gridColIdx } = props;
  const defaultKeys = useMemo(() => allOrgDisplayCols.map(c => c.key), [allOrgDisplayCols]);
  const [columnKeys, setColumnKeys] = useState<string[]>(() => defaultKeys);
  const [firstFixed, setFirstFixed] = useState(true);
  /* 3.3①②:十字准星与冻结列阴影只加视觉层,不参与交互逻辑 */
  const crosshair = useGridCrosshair(firstFixed);
  const [hoverCard, setHoverCard] = useState<{ x: number; y: number; rowId: number; orgId: number; note: string; formula: string; historyCount: number } | null>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openHoverCard = (e: React.MouseEvent, rowId: number, orgId: number, note: string, formula: string, historyCount: number) => {
    if (!note && !formula && historyCount <= 0) return;
    if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
    setHoverCard({ x: e.clientX, y: e.clientY, rowId, orgId, note, formula, historyCount });
  };
  const openHoverFromFocus = (e: React.FocusEvent, rowId: number, orgId: number, note: string, formula: string, historyCount: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!note && !formula && historyCount <= 0) return;
    if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
    setHoverCard({ x: rect.left + rect.width / 2, y: rect.bottom, rowId, orgId, note, formula, historyCount });
  };
  const moveHoverCard = (e: React.MouseEvent) => setHoverCard((v) => v ? { ...v, x: e.clientX, y: e.clientY } : v);
  const scheduleHoverClose = () => { if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current); hoverCloseTimer.current = setTimeout(() => setHoverCard(null), 180); };
  const keepHoverCard = () => { if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current); };
  useEffect(() => () => { if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current); }, []);
  const orgDisplayCols = useMemo(() => columnKeys.map(k => allOrgDisplayCols.find(c => c.key === k)).filter(Boolean) as typeof allOrgDisplayCols, [columnKeys, allOrgDisplayCols]);
  const visibleLeafIds = useMemo(() => orgDisplayCols.filter((column) => column.isLeaf).map((column) => column.id), [orgDisplayCols]);
  useEffect(() => { props.onVisibleLeafIdsChange(visibleLeafIds); }, [props.onVisibleLeafIdsChange, visibleLeafIds]);
  const activeFormulaPreview = formulaPreview;
  /* UX-23-2:新草稿首次进入的一次性短提示;关闭后 localStorage 打标,不再出现 */
  const FIRST_HINT_KEY = 'bd-ux23-first-draft-hint';
  const [firstHintDismissed, setFirstHintDismissed] = useState(() => {
    try { return localStorage.getItem(FIRST_HINT_KEY) === '1'; } catch { return true; }
  });
  const dismissFirstHint = () => {
    setFirstHintDismissed(true);
    try { localStorage.setItem(FIRST_HINT_KEY, '1'); } catch { /* 忽略 */ }
  };

  return (
    <div
      className={`matrix-container ${crosshair.frozenProps.className}`}
      style={{ overflow: 'auto', maxHeight: props.fullscreen ? 'none' : 620, position: 'relative' }}
      data-scrolled={crosshair.frozenProps['data-scrolled']}
      onScroll={crosshair.frozenProps.onScroll}
      data-crosshair-r={crosshair.crosshairProps['data-crosshair-r']}
      data-crosshair-c={crosshair.crosshairProps['data-crosshair-c']}
      onMouseMove={crosshair.crosshairProps.onMouseMove}
      onMouseLeave={crosshair.crosshairProps.onMouseLeave}
    >
      {/* UX-23-1:定稿(只读)版本在网格区给出明确的下一步入口,而非仅控件变灰;sticky 保证横滚后仍可见 */}
      {props.continueEntry && (
        <div
          style={{
            position: 'sticky', left: 0, zIndex: 7,
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
            padding: '6px 10px', marginBottom: 4,
            background: 'var(--bd-header)',
            border: '1px solid var(--bd-border)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--bd-text-secondary)',
          }}
        >
          <i className="ri-lock-line" style={{ color: 'var(--bd-text-tertiary)' }} aria-hidden />
          <span>{props.readonlyReason ?? '此版本内容为只读。'}</span>
          <Button type="primary" size="small" onClick={props.continueEntry.onClick}>{props.continueEntry.label}</Button>
        </div>
      )}
      {props.firstDraftHint && !firstHintDismissed && (
        <div style={{ position: 'sticky', left: 0, zIndex: 7, marginBottom: 4 }}>
          <Alert
            type="info"
            showIcon
            closable
            onClose={dismissFirstHint}
            message="直接在「末级科目 × 组织」单元格中填写金额（万元）；汇总格自动计算。双击格子可写附注与公式，Ctrl+Z 撤销，点工具栏「快捷键」查看全部操作。"
          />
        </div>
      )}
      <Space style={{ padding: '4px 0' }}><MatrixColumnConfig storageKey="budget-matrix" columns={allOrgDisplayCols.map(c => ({ key: c.key, label: `${c.code} ${c.name}` }))} onChange={(keys, fixed) => { setColumnKeys(keys); setFirstFixed(fixed); }} /><span style={{ fontSize: 12, color: 'var(--bd-text-tertiary)' }}>{firstFixed ? '首列已固定' : '首列未固定'}</span></Space>
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12 }}>
        <colgroup>
          <col style={{ minWidth: 280 }} />
          {orgDisplayCols.map((col) => (
            <col key={col.key} style={{ width: widthOf(col.key, col.isRootTotal || col.isSubtotal ? 120 : 96) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th style={thStyle({ left: 0, zIndex: 6, textAlign: 'left', minWidth: 280, background: 'var(--bd-header)' })}>
              科目{props.sheetName ? ` (${props.sheetName})` : ''}
            </th>
            {orgDisplayCols.map((col) => {
              const isTotalCol = col.isRootTotal || col.isSubtotal;
              const isCollapsed = collapsedOrgCols.has(col.id);
              return (
                <th
                  key={col.key}
                  data-gc={gridColIdx.get(col.id) ?? undefined}
                  style={thStyle({
                    minWidth: isTotalCol ? 120 : 96,
                    background: isTotalCol ? 'var(--bd-fill)' : 'var(--bd-header)',
                    borderTop: isTotalCol ? '2px solid var(--bd-primary)' : '1px solid var(--bd-border)',
                  })}
                  title={`${col.code} ${col.name}`}
                >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                      <span style={{ fontWeight: 700, color: isTotalCol ? 'var(--bd-primary)' : 'var(--bd-text-secondary)', whiteSpace: 'nowrap' }}>{col.code}</span>
                    {col.isSubtotal && (
                      <Tooltip title={isCollapsed ? '展开下级电站/项目' : '收起下级电站/项目'}>
                        <Button
                          type="text"
                          size="small"
                          style={{ padding: 0, width: 16, height: 16, minWidth: 16, fontSize: 12, color: 'var(--bd-text-tertiary)' }}
                          icon={isCollapsed ? <i className="ri-add-box-line" aria-hidden /> : <i className="ri-checkbox-indeterminate-line" aria-hidden />}
                          onClick={() => props.onToggleCollapseOrgCol(col.id)}
                        />
                      </Tooltip>
                    )}
                  </div>
                  <div style={{ fontWeight: isTotalCol ? 650 : 400, color: isTotalCol ? 'var(--bd-text)' : 'var(--bd-text-secondary)' }}>{col.name}</div>
                  <ColResizeGrip onStart={(e) => startResize(e, col.key, widthOf(col.key, isTotalCol ? 120 : 96))} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => {
            if (row.kind === 'metric') {
              /* 计算行: 只读, 按组织列由科目明细实时勾稽 */
              const fmt = (v: number) => (v !== 0 ? centsToWan(v) : <span style={{ color: 'var(--bd-text-tertiary)' }}>—</span>);
              return (
                <tr key={`m${row.id}`} style={{ background: 'var(--bd-header)' }}>
                  <td style={{ position: firstFixed ? 'sticky' : 'static', left: 0, zIndex: 1, background: 'var(--bd-header)', border: '1px solid var(--bd-border)', padding: '3px 8px', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-block', width: (row.indent ?? 0) * 20 }} />
                    <span
                      style={{
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: 'var(--bd-primary-bg)',
                        color: 'var(--bd-primary)',
                        border: `1px solid ${primaryChipBorder}`,
                        fontFamily: NUMERIC_FONT_FAMILY,
                        fontWeight: 600,
                        fontSize: 12,
                        marginRight: 4,
                      }}
                    >
                      {row.code}
                    </span>{' '}
                    <span style={{ fontWeight: 650, color: 'var(--bd-text)' }}>{row.label ?? row.name}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}> 计算</Typography.Text>
                  </td>
                  {orgDisplayCols.map((col) => {
                    const colTotals = new Map<number, number>();
                    for (const lid of col.leafIds) {
                      const sub = props.orgAccTotals.get(lid);
                      if (sub) {
                        for (const [aid, val] of sub.entries()) {
                          colTotals.set(aid, (colTotals.get(aid) ?? 0) + val);
                        }
                      }
                    }
                    return (
                      <td
                        key={col.key}
                        style={{
                          border: '1px solid var(--bd-border)',
                          padding: '2px 8px',
                          textAlign: 'right',
                          fontFamily: NUMERIC_FONT_FAMILY,
                          fontWeight: 650,
                          background: 'var(--bd-header)',
                          color: 'var(--bd-text)',
                        }}
                      >
                        {fmt(props.metricValue(row.id, colTotals))}
                      </td>
                    );
                  })}
                </tr>
              );
            }
            if (props.isMetricSheet) {
              /* 利润表科目取数行: 只读, 子树带符号汇总 */
              const fmt = (v: number) => (v !== 0 ? centsToWan(v) : <span style={{ color: 'var(--bd-text-tertiary)' }}>—</span>);
              const tagCfg = typeChips[row.type] ?? { color: 'var(--bd-text-tertiary)', bg: 'var(--bd-fill)', border: 'var(--bd-border)' };
              return (
                <tr key={row.id} style={{ background: row.bold ? 'var(--bd-header)' : undefined }}>
                  <td style={{ position: firstFixed ? 'sticky' : 'static', left: 0, zIndex: 1, background: row.bold ? 'var(--bd-header)' : 'var(--bd-bg-container)', border: '1px solid var(--bd-border)', padding: '3px 8px', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-block', width: (row.indent ?? 0) * 20 }} />
                    <span
                      style={{
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: tagCfg.bg,
                        color: tagCfg.color,
                        border: `1px solid ${tagCfg.border}`,
                        fontFamily: NUMERIC_FONT_FAMILY,
                        fontWeight: 600,
                        fontSize: 12,
                        marginRight: 4,
                      }}
                    >
                      {row.code}
                    </span>{' '}
                    <span style={{ fontWeight: row.bold ? 650 : 400, color: row.bold ? 'var(--bd-text)' : 'var(--bd-text-secondary)' }}>{row.label ?? row.name}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}> 取数</Typography.Text>
                  </td>
                  {orgDisplayCols.map((col) => {
                    const sumSigned = col.leafIds.reduce((s, lid) => s + (props.orgAccTotals.get(lid)?.get(row.id) ?? 0), 0);
                    return (
                      <td
                        key={col.key}
                        style={{
                          border: '1px solid var(--bd-border)',
                          padding: '2px 8px',
                          textAlign: 'right',
                          fontFamily: NUMERIC_FONT_FAMILY,
                          fontWeight: row.bold || col.isRootTotal || col.isSubtotal ? 650 : 400,
                          background: col.isRootTotal || col.isSubtotal ? 'var(--bd-header)' : undefined,
                          color: 'var(--bd-text)',
                        }}
                      >
                        {fmt(sumSigned)}
                      </td>
                    );
                  })}
                </tr>
              );
            }
            const tagCfg = typeChips[row.type] ?? { color: 'var(--bd-text-tertiary)', bg: 'var(--bd-fill)', border: 'var(--bd-border)' };
            const cleanName = row.type === 'quantity' && row.unit
              ? row.name.split(`(${row.unit})`).join('').split(`（${row.unit}）`).join('').trim()
              : row.name;
            const unitSuffix = row.type === 'quantity' && row.unit ? ` (${row.unit})` : '';
            const rowActive = activeCell?.rowId === row.id;
            return (
              <tr key={row.id} style={{ background: rowActive ? 'var(--bd-primary-bg)' : !row.isLeaf ? 'var(--bd-header)' : undefined }}>
                <td style={{ position: firstFixed ? 'sticky' : 'static', left: 0, zIndex: 1, background: rowActive ? 'var(--bd-primary-bg)' : !row.isLeaf ? 'var(--bd-header)' : 'var(--bd-bg-container)', border: '1px solid var(--bd-border)', padding: '3px 8px', whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'inline-block', width: row.depth * 16 }} />
                  <span
                    style={{
                      padding: '1px 5px',
                      borderRadius: 4,
                      background: tagCfg.bg,
                      color: tagCfg.color,
                      border: `1px solid ${tagCfg.border}`,
                      fontFamily: NUMERIC_FONT_FAMILY,
                      fontWeight: 600,
                      fontSize: 12,
                      marginRight: 4,
                    }}
                  >
                    {row.code}
                  </span>{' '}
                  <span style={{ fontWeight: row.isLeaf && !row.collapsedHere ? (rowActive ? 600 : 400) : 650, color: !row.isLeaf ? 'var(--bd-text)' : 'var(--bd-text-secondary)' }}>
                    {cleanName}{unitSuffix}
                  </span>
                  {row.collapsedHere ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}> 汇总(见专属表)</Typography.Text>
                  ) : !row.isLeaf ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}> 汇总</Typography.Text>
                  ) : null}
                  {/* UX-23-1:层级筛选收起子行时,汇总行给出明确的「展开子项」入口 */}
                  {!row.isLeaf && !row.collapsedHere && props.rowsCollapsedByFilter && props.onShowAllRowLevels && (
                    <Button type="link" size="small" style={{ padding: 0, fontSize: 12, marginLeft: 4 }} onClick={props.onShowAllRowLevels}>展开子项</Button>
                  )}
                  {row.status === 'inactive' && <Tag style={{ marginLeft: 4 }}>停</Tag>}
                </td>
                {orgDisplayCols.map((col) => {
                  // A. 汇总列与小计列: 聚合所有下属叶子节点(只读数值);汇总格备注独立存放,双击编辑
                  if (col.isRootTotal || col.isSubtotal) {
                    const sumCentsOrQty = col.leafIds.reduce((s, lid) => s + props.totalCache(row.id, lid), 0);
                    const displayVal = props.displayTotal(row, sumCentsOrQty);
                    const sumNote = props.summaryNotes.get(`${col.id}:${row.id}`)?.trim() ?? '';
                    const sumHistory = props.historyCount?.(col.id, row.id) ?? 0;
                    /* UX-23-1:汇总格给出明确的只读原因与「查看明细/展开子项」路径 */
                    const colCollapsed = col.isSubtotal && collapsedOrgCols.has(col.id);
                    const sumTitle = [
                      row.type === 'quantity' && row.quantityAgg === 'none'
                        ? '该数量科目设为「不汇总」(如电价/税率/平均人数)，跨组织与上级不显示合计，仅叶子单元格录值'
                        : '汇总值，随明细自动计算',
                      props.canEditSummary ? '双击编辑汇总备注' : null,
                      colCollapsed ? '该小计列已折叠：点列表头 + 或格内「展开下级」查看明细' : null,
                      props.readonlyReason ?? null,
                    ].filter(Boolean).join('；');
                    return (
                      <td
                        key={col.key}
                        id={`note-cell-${col.id}-${row.id}`}
                        title={sumTitle}
                        onDoubleClick={() => { if (props.canEditSummary) props.onOpenNote(row.id, col.id); }}
                        onMouseEnter={(e) => openHoverCard(e, row.id, col.id, sumNote, '', sumHistory)}
                        onMouseMove={moveHoverCard}
                        onMouseLeave={scheduleHoverClose}
                        style={{
                          border: '1px solid var(--bd-border)',
                          padding: '2px 8px',
                          textAlign: 'right',
                          fontFamily: NUMERIC_FONT_FAMILY,
                          fontWeight: 650,
                          background: 'var(--bd-header)',
                          color: 'var(--bd-text)',
                          position: 'relative',
                        }}
                      >
                        {displayVal || <span style={{ color: 'var(--bd-text-tertiary)' }}>—</span>}
                        {colCollapsed && (
                          <Button
                            type="link"
                            size="small"
                            style={{ padding: 0, fontSize: 12, marginLeft: 2 }}
                            onClick={() => props.onToggleCollapseOrgCol(col.id)}
                          >
                            展开下级
                          </Button>
                        )}
                        {(sumNote || sumHistory > 0) && (
                          <div
                            tabIndex={0}
                            role="button"
                            aria-label={sumNote ? `汇总格备注: ${sumNote}` : `查看此格变动历史，共 ${sumHistory} 次`}
                            title={sumNote ? `汇总格备注: ${sumNote}` : undefined}
                            onKeyDown={(e) => { if (e.key === 'Enter' && sumHistory > 0) { e.preventDefault(); props.onOpenCellHistory?.(col.id, row.id); } }}
                            onClick={() => { if (sumHistory > 0) props.onOpenCellHistory?.(col.id, row.id); }}
                            style={{
                              position: 'absolute', top: 0, right: 0, width: 0, height: 0,
                              borderTop: `6px solid ${fc.cost}`, borderLeft: '6px solid transparent',
                              cursor: sumHistory > 0 ? 'pointer' : 'default',
                            }}
                          />
                        )}
                      </td>
                    );
                  }

                  // B. 叶子组织列: 支持编辑录入
                  const oid = col.id;
                  const key = `${oid}:${row.id}`;
                  const canEdit = props.cellEditable(row, oid);
                  const cellFocused = activeCell?.rowId === row.id && activeCell?.orgId === oid;
                  const inActiveCol = activeCell?.orgId === oid;
                  // 非叶子科目行的附注在汇总格备注里;叶子行仍在明细行 notes 上
                  const noteText = (row.isLeaf ? notes.get(key) : props.summaryNotes.get(key))?.trim() ?? '';
                  const formulaText = formulas.get(key)?.trim() ?? '';
                  const hasNote = Boolean(noteText);
                  const hasFormula = Boolean(formulaText);

                  if (!canEdit) {
                    const shown = row.isLeaf ? (values.get(key) ?? '') : props.displayTotal(row, props.totalCache(row.id, oid));
                    const historyCount = props.historyCount?.(oid, row.id) ?? 0;
                    /* UX-23-1:只读格必须能解释原因(整表定稿/冲突 > 汇总自动计算 > 停用/不适用) */
                    const cellTitle = !row.isLeaf
                      ? [
                          row.type === 'quantity' && row.quantityAgg === 'none'
                            ? '该数量科目设为「不汇总」(如电价/税率/平均人数)，上级不显示合计，仅叶子单元格录值'
                            : '汇总值，随明细自动计算',
                          props.canEditSummary ? '双击编辑汇总备注' : null,
                          props.rowsCollapsedByFilter ? '子行被「层级展开」筛选收起：点行首「展开子项」查看明细' : null,
                          props.readonlyReason ?? null,
                        ].filter(Boolean).join('；')
                      : (props.readonlyReason ?? (row.status === 'inactive' ? '科目已停用，不可填写' : '该科目不适用于此组织的编制范围，不可填写'));
                    return (
                      <td key={col.key} id={row.isLeaf ? undefined : `note-cell-${oid}-${row.id}`} data-gr={gridRowIdx.get(row.id) ?? undefined} data-gc={gridColIdx.get(oid) ?? undefined} title={cellTitle} onDoubleClick={() => { if (!row.isLeaf && props.canEditSummary) props.onOpenNote(row.id, oid); }} onMouseEnter={(e) => openHoverCard(e, row.id, oid, noteText, formulaText, historyCount)} onMouseMove={moveHoverCard} onMouseLeave={scheduleHoverClose} style={{ border: '1px solid var(--bd-border)', padding: '2px 8px', textAlign: 'right', fontFamily: NUMERIC_FONT_FAMILY, background: inActiveCol ? 'var(--bd-primary-bg)' : props.readonlyReason ? 'var(--bd-fill)' : undefined, color: props.readonlyReason ? 'var(--bd-text-tertiary)' : undefined, position: 'relative' }}>
                        {shown || <span style={{ color: 'var(--bd-text-tertiary)' }}>—</span>}
                        {(hasNote || historyCount > 0) && (
                            <div
                              tabIndex={0}
                              role="button"
                              aria-label={`查看此格变动历史，共 ${historyCount} 次`}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onOpenCellHistory?.(oid, row.id); } }}
                              onClick={() => props.onOpenCellHistory?.(oid, row.id)}
                              style={{
                                position: 'absolute', top: 0, right: 0, width: 0, height: 0,
                                borderTop: `6px solid ${fc.cost}`, borderLeft: '6px solid transparent',
                                cursor: 'pointer',
                              }}
                            />
                        )}
                      </td>
                    );
                  }

                  const historyCount = props.historyCount?.(oid, row.id) ?? 0;
                  return (
                    <td
                      key={col.key}
                      data-gr={gridRowIdx.get(row.id) ?? undefined}
                      data-gc={gridColIdx.get(oid) ?? undefined}
                      style={{
                        border: '1px solid var(--bd-border)',
                        padding: 1,
                        position: 'relative',
                        background: cellFocused
                          ? primaryFocusBg
                          : grid.isInSelection(gridRowIdx.get(row.id) ?? -1, gridColIdx.get(oid) ?? -1)
                            ? 'var(--bd-primary-bg)'
                            : inActiveCol ? 'var(--bd-primary-bg)' : undefined,
                      }}
                      onContextMenu={(e) => {
                        const ri = gridRowIdx.get(row.id);
                        const ci = gridColIdx.get(oid);
                        if (ri == null || ci == null) return;
                        e.preventDefault();
                        grid.focusCell(ri, ci);
                        props.onCtxMenu({ open: true, x: e.clientX, y: e.clientY, r: ri, c: ci });
                      }}
                      onDoubleClick={() => props.onOpenNote(row.id, oid)}
                      onMouseEnter={(e) => openHoverCard(e, row.id, oid, noteText, formulaText, historyCount)}
                      onMouseMove={moveHoverCard}
                      onMouseLeave={scheduleHoverClose}
                    >
                      <div onFocus={(e) => openHoverFromFocus(e, row.id, oid, noteText, formulaText, historyCount)} onBlur={scheduleHoverClose}>
                        <div style={{ position: 'relative', width: '100%' }}>
                          <Input
                            id={`cell-${oid}-${row.id}`}
                            size="small"
                            title={row.type === 'quantity'
                              ? `数量单位：${row.unit || '按科目设置'}，最多四位小数`
                              : '金额单位：万元（1.00 万元 = 10,000 元，最多两位小数）；成本费用按正数填写，负数表示冲回'}
                            style={{
                              width: '100%',
                              height: cellH,
                              padding: '0 6px',
                              textAlign: 'right',
                              fontFamily: NUMERIC_FONT_FAMILY,
                              fontSize: 12,
                              background: cellFocused ? 'var(--bd-bg-container)' : 'transparent',
                              borderColor: invalidCells.has(key) ? sc.bad : cellFocused ? 'var(--bd-primary)' : row.type === 'quantity' ? accentSoftBorder : 'var(--bd-border)',
                              boxShadow: cellFocused ? '0 0 0 2px rgba(var(--bd-primary-rgb), 0.25)' : undefined,
                            }}
                            value={values.get(key) ?? ''}
                            onFocus={() => grid.handleCellFocus(gridRowIdx.get(row.id)!, gridColIdx.get(oid)!)}
                            onBlur={() => grid.commitCell(gridRowIdx.get(row.id)!, gridColIdx.get(oid)!)}
                            onChange={(e) => grid.setCellInput(gridRowIdx.get(row.id)!, gridColIdx.get(oid)!, e.target.value)}
                            onKeyDown={(e) => grid.handleCellKeyDown(e, gridRowIdx.get(row.id)!, gridColIdx.get(oid)!)}
                            onPaste={(e) => grid.handleCellPaste(e, gridRowIdx.get(row.id)!, gridColIdx.get(oid)!)}
                            onCopy={(e) => grid.handleCopy(e)}
                            onMouseDown={(e) => grid.handleCellMouseDown(e, gridRowIdx.get(row.id)!, gridColIdx.get(oid)!)}
                          />
                          {/* 填充柄: 焦点格右下角 */}
                          {cellFocused && gridRowIdx.get(row.id) != null && gridColIdx.get(oid) != null && (
                            <div
                              onMouseDown={(e) => grid.beginFillDrag(e, gridRowIdx.get(row.id)!, gridColIdx.get(oid)!)}
                              title="拖拽填充(向下/向右)"
                              style={{ position: 'absolute', right: 0, bottom: 0, width: 8, height: 8, background: 'var(--bd-primary)', border: '1px solid var(--bd-bg-container)', cursor: 'crosshair', zIndex: 3 }}
                            />
                          )}
                          {/* 橙色右上角标: 附注 */}
                          {hasNote && (
                            <div
                              title={`测算依据: ${noteText}`}
                              style={{
                                position: 'absolute', top: 1, right: 1, width: 0, height: 0,
                                borderTop: `6px solid ${fc.cost}`, borderLeft: '6px solid transparent',
                                pointerEvents: 'none', zIndex: 1,
                              }}
                            />
                          )}
                          {/* 蓝色右下角标: 公式 */}
                          {hasFormula && (
                            <div
                              title={`行内公式: ${formulaText}`}
                              style={{
                                position: 'absolute', bottom: 1, right: 1, width: 0, height: 0,
                                borderBottom: '5px solid var(--bd-primary)', borderLeft: '5px solid transparent',
                                pointerEvents: 'none', zIndex: 1,
                              }}
                            />
                          )}
                          {/* 公式即时计算悬浮提示 */}
                          {activeFormulaPreview && activeFormulaPreview.key === key && (
                            <div
                              style={{
                                position: 'absolute', top: 26, right: 0, zIndex: 100,
                                background: token.colorBgSpotlight, color: '#fff', padding: '3px 8px', borderRadius: 6,
                                fontSize: 12, whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                                border: '1px solid rgba(255,255,255,0.1)',
                              }}
                            >
                              {activeFormulaPreview.res.ok ? (
                                <span>📐 即时计算: <b style={{ color: 'var(--bd-primary)' }}>{activeFormulaPreview.res.display}</b> {row.type === 'quantity' ? (row.unit ?? '') : '万元'}</span>
                              ) : (
                                <span style={{ color: sc.bad }}>⚠ {activeFormulaPreview.res.error}</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {visibleRows.length === 0 && (
            <tr><td colSpan={1 + orgDisplayCols.length} style={{ padding: 16, textAlign: 'center', color: token.colorTextTertiary }}>当前筛选条件下没有行</td></tr>
          )}
        </tbody>
      </table>
      {hoverCard && (
        <div role="tooltip" onMouseEnter={keepHoverCard} onMouseLeave={scheduleHoverClose} style={{ position: 'fixed', zIndex: 2000, left: Math.min(hoverCard.x + 12, window.innerWidth - 340), top: Math.min(hoverCard.y + 14, window.innerHeight - 220), maxWidth: 320, padding: '8px 10px', borderRadius: 6, background: token.colorBgSpotlight, color: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,.25)', fontSize: 12 }}>
          {hoverCard.formula && <div style={{ color: 'var(--bd-primary)', marginBottom: hoverCard.note ? 5 : 0 }}><strong>📐 计算公式:</strong> <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{hoverCard.formula}</span></div>}
          <div><strong>📝 测算依据:</strong> <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{hoverCard.note || '无附注'}</span></div>
          {hoverCard.historyCount > 0 && <Button type="link" size="small" style={{ padding: 0, color: 'var(--bd-primary)' }} onClick={() => props.onOpenCellHistory?.(hoverCard.orgId, hoverCard.rowId)}>📜 查看此格变动历史（共 {hoverCard.historyCount} 次）</Button>}
        </div>
      )}
    </div>
  );
}
