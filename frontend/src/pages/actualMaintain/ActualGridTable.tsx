import { Fragment, useEffect, useMemo, useState } from 'react';
import { Button, Input, Tooltip, Typography, Space } from 'antd';
import { typeTagConfig, type OrgColDef } from '../../utils/grid';
import { useThemeMode, NUMERIC_FONT_FAMILY, statusColor, financeColor } from '../../theme';
import { useColumnWidths, ColResizeGrip } from '../../components/GridAddons';
import { useGridInteraction } from '../../hooks/useGridInteraction';
import { useGridCrosshair } from '../../hooks/useGridCrosshair';
import { MatrixColumnConfig } from '../../components/MatrixColumnConfig';
import type { GridRow, YearData, AccRow } from './types';

type Grid = ReturnType<typeof useGridInteraction>;

/**
 * 历史数据维护网格表格:
 * 多组织横向展开视图(行=科目,列=多级组织)与多年趋势对比视图(列=各年度 预算/实际 成对)。
 * 列宽持久化状态内聚在本组件(仅此处消费)。
 */
export function ActualGridTable(props: {
  viewMode: 'orgs' | 'years';
  visibleRows: GridRow[];
  years: number[];
  editYear: number;
  yearData: Record<number, YearData>;
  sheetName?: string;
  orgDisplayCols: OrgColDef[];
  collapsedOrgCols: Set<number>;
  onToggleCollapseOrgCol: (orgId: number) => void;
  onVisibleLeafIdsChange: (orgIds: number[]) => void;
  values: Map<string, string>;
  notes: Map<string, string>;
  /** 汇总格备注(非叶子组织列/非叶子科目行),键与 values 同为 `orgId:accountId` */
  summaryNotes: Map<string, string>;
  /** 汇总格备注是否可编辑(当前实际模式且年度未冻结);只读时仍可悬浮查看 */
  canEditSummaryMemo: boolean;
  onOpenMemo: (orgId: number, accountId: number, summary?: boolean) => void;
  invalidCells: Set<string>;
  grid: Grid;
  gridRowIdx: Map<number, number>;
  gridColIdx: Map<number, number>;
  cellEditable: (row: GridRow, orgId?: number) => boolean;
  displayOf: (row: GridRow, y: number, side: 'budget' | 'actual') => string;
  displayOfOrg: (row: GridRow, y: number, leafIds: number[], side: 'budget' | 'actual') => string;
  density: 'compact' | 'standard' | 'relaxed';
  activeRowId: number | null;
  onActiveRowChange: (id: number) => void;
  singleLeafScope: number | null;
  onCtxMenu: (s: { open: boolean; x: number; y: number; r: number; c: number }) => void;
  fullscreen?: boolean;
  /** UX-23-1:整表只读原因(年度冻结/历史补录边界/保存锁定),只读格悬浮可读到原因 */
  readonlyReason?: string | null;
}) {
  const { mode } = useThemeMode();
  const sc = statusColor(mode);
  const fc = financeColor(mode);
  /* 主色派生:焦点格底色比「当前列」再深一档,不新增色相 */
  const primaryFocusBg = 'color-mix(in srgb, var(--bd-primary) 18%, transparent)';
  const accentSoftBorder = 'color-mix(in srgb, var(--bd-accent) 45%, transparent)';
  const typeChips = typeTagConfig(mode);
  const { widthOf, startResize } = useColumnWidths('bd-actual-colwidths');
  const firstHeaderH = 26;

  const thStyle = (extra?: React.CSSProperties): React.CSSProperties => ({
    position: 'sticky',
    background: 'var(--bd-header)',
    border: '1px solid var(--bd-border)',
    color: 'var(--bd-text-secondary)',
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 8px',
    ...extra,
  });

  const { viewMode, visibleRows, years, editYear, yearData, orgDisplayCols: allOrgDisplayCols, collapsedOrgCols, grid, gridRowIdx, gridColIdx, values, notes, invalidCells } = props;
  const defaultKeys = useMemo(() => allOrgDisplayCols.map(c => c.key), [allOrgDisplayCols]);
  const [columnKeys, setColumnKeys] = useState<string[]>(() => defaultKeys);
  const [firstFixed, setFirstFixed] = useState(true);
  /* 3.3①②:十字准星与冻结列阴影只加视觉层,不参与交互逻辑 */
  const crosshair = useGridCrosshair(firstFixed);
  const orgDisplayCols = useMemo(() => columnKeys.map(k => allOrgDisplayCols.find(c => c.key === k)).filter(Boolean) as typeof allOrgDisplayCols, [columnKeys, allOrgDisplayCols]);
  const visibleLeafIds = useMemo(() => orgDisplayCols.filter((column) => column.isLeaf).map((column) => column.id), [orgDisplayCols]);
  useEffect(() => { props.onVisibleLeafIdsChange(visibleLeafIds); }, [props.onVisibleLeafIdsChange, visibleLeafIds]);

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
      {viewMode === 'orgs' && <Space style={{ padding: '4px 0' }}><MatrixColumnConfig storageKey="actual-matrix" columns={allOrgDisplayCols.map(c => ({ key: c.key, label: `${c.code} ${c.name}` }))} onChange={(keys, fixed) => { setColumnKeys(keys); setFirstFixed(fixed); }} /><span style={{ fontSize: 12, color: 'var(--bd-text-tertiary)' }}>{firstFixed ? '首列已固定' : '首列未固定'}</span></Space>}
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12 }}>
        {viewMode === 'orgs' && (
          <colgroup>
            <col style={{ minWidth: 280 }} />
            {orgDisplayCols.map((col) => (
              <col key={col.key} style={{ width: widthOf(col.key, col.isRootTotal || col.isSubtotal ? 120 : 100) }} />
            ))}
          </colgroup>
        )}
        <thead>
          {viewMode === 'orgs' ? (
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
                    style={thStyle({
                      minWidth: isTotalCol ? 120 : 100,
                      background: isTotalCol ? 'var(--bd-fill)' : 'var(--bd-header)',
                      borderTop: isTotalCol ? '2px solid var(--bd-primary)' : '1px solid var(--bd-border)',
                    })}
                    title={`${col.code} ${col.name}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                      <span style={{ fontWeight: 700, color: isTotalCol ? 'var(--bd-primary)' : 'var(--bd-text-secondary)', whiteSpace: 'nowrap' }}>
                        {col.code}
                      </span>
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
                    <div style={{ fontWeight: isTotalCol ? 650 : 400, color: isTotalCol ? 'var(--bd-text)' : 'var(--bd-text-secondary)' }}>
                      {col.name}
                    </div>
                    <ColResizeGrip onStart={(e) => startResize(e, col.key, widthOf(col.key, isTotalCol ? 120 : 100))} />
                  </th>
                );
              })}
            </tr>
          ) : (
            <>
              <tr>
                <th rowSpan={2} style={{ position: 'sticky', left: 0, zIndex: 5, top: 0, background: 'var(--bd-header)', border: '1px solid var(--bd-border)', padding: '6px 8px', minWidth: 280, textAlign: 'left', color: 'var(--bd-text-secondary)', fontWeight: 600 }}>
                  科目{props.sheetName ? ` (${props.sheetName})` : ''}
                </th>
                {years.map((y) => (
                  <th key={y} colSpan={2} style={thStyle({ top: 0, zIndex: 3, textAlign: 'center', minWidth: 200, background: y === editYear ? 'var(--bd-primary-bg)' : 'var(--bd-header)', borderTop: y === editYear ? '2px solid var(--bd-primary)' : '1px solid var(--bd-border)', color: y === editYear ? 'var(--bd-primary)' : 'var(--bd-text-secondary)' })}>
                    {y} 年
                    {yearData[y]?.budgetVersion ? <span style={{ fontWeight: 400, marginLeft: 4, fontSize: 12, color: 'var(--bd-text-tertiary)' }}>({yearData[y]!.budgetVersion!.name})</span> : null}
                  </th>
                ))}
              </tr>
              <tr>
                {years.map((y) => (
                  <Fragment key={y}>
                    <th style={thStyle({ top: firstHeaderH, zIndex: 3, minWidth: 100, background: y === editYear ? 'var(--bd-primary-bg)' : 'var(--bd-header)', color: 'var(--bd-text-tertiary)' })}>预算数</th>
                    <th style={thStyle({ top: firstHeaderH, zIndex: 3, minWidth: 100, background: y === editYear ? 'var(--bd-primary-bg)' : 'var(--bd-header)', color: y === editYear ? 'var(--bd-primary)' : 'var(--bd-text-tertiary)' })}>实际数</th>
                  </Fragment>
                ))}
              </tr>
            </>
          )}
        </thead>
        <tbody>
          {visibleRows.map((row) => {
            const rowKey = row.kind === 'account' ? `a${row.id}` : `m${row.id}`;
            const t = row.kind === 'account' ? row.type : 'metric';
            const tagCfg = typeChips[t] ?? { color: 'var(--bd-text-tertiary)', bg: 'var(--bd-fill)', border: 'var(--bd-border)' };
            const inTpl = row.label != null; /* 模板行:利润表 15 行 / 收入成本表计算行 */
            const isSummaryRow = (inTpl && row.bold) || row.kind === 'metric' || (row.kind === 'account' && !row.isLeaf);
            const rawName = (inTpl ? row.label : row.name) ?? '';
            const cleanName = row.kind === 'account' && row.type === 'quantity' && row.unit
              ? rawName.replace(new RegExp(`[(（]${row.unit}[)）]`, 'g'), '').trim()
              : rawName;
            const unitSuffix = row.kind === 'account' && row.type === 'quantity' && row.unit ? ` (${row.unit})` : '';
            const rowActive = row.kind === 'account' && props.activeRowId === row.id;

            return (
              <tr key={rowKey} style={{ background: isSummaryRow ? 'var(--bd-header)' : rowActive ? 'var(--bd-primary-bg)' : undefined }}>
                <td
                  style={{
                    position: firstFixed ? 'sticky' : 'static',
                    left: 0,
                    zIndex: 1,
                    background: isSummaryRow ? 'var(--bd-header)' : rowActive ? 'var(--bd-primary-bg)' : 'var(--bd-bg-container)',
                    border: '1px solid var(--bd-border)',
                    padding: '3px 8px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ display: 'inline-block', width: inTpl ? (row.indent ?? 0) * 20 : row.kind === 'account' ? row.depth * 16 : 0 }} />
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
                  <span style={{ fontWeight: isSummaryRow ? 650 : 400, color: isSummaryRow ? 'var(--bd-text)' : 'var(--bd-text-secondary)' }}>
                    {cleanName}{unitSuffix}
                  </span>
                  {inTpl ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>{row.kind === 'metric' ? ' 计算' : ' 取数'}</Typography.Text>
                  ) : row.kind === 'account' && row.collapsedHere ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}> 汇总(见专属表)</Typography.Text>
                  ) : row.kind === 'account' && !row.isLeaf ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}> 汇总</Typography.Text>
                  ) : null}
                </td>

                {viewMode === 'orgs' ? (
                  orgDisplayCols.map((col) => {
                    const isTotalCol = col.isRootTotal || col.isSubtotal;
                    if (isTotalCol) {
                      const val = props.displayOfOrg(row, editYear, col.leafIds, 'actual');
                      // 汇总列备注:独立存放,双击编辑;指标计算行不支持
                      const sumMemo = row.kind === 'account' ? (props.summaryNotes.get(`${col.id}:${row.id}`)?.trim() ?? '') : '';
                      const canEditSum = row.kind === 'account' && props.canEditSummaryMemo;
                      const isCollapsedCol = col.isSubtotal && collapsedOrgCols.has(col.id);
                      return (
                        <td
                          key={col.key}
                          title={row.kind === 'account' && row.type === 'quantity' && row.quantityAgg === 'none' ? '该数量科目设为「不汇总」(如电价/税率/平均人数)，跨组织不显示合计，仅叶子单元格录值' : undefined}
                          onDoubleClick={() => { if (canEditSum) props.onOpenMemo(col.id, row.id, true); }}
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
                          {/* UX-23-1:汇总格说明只读原因与展开路径 */}
                          <Tooltip title={<><strong>汇总值</strong>，随明细自动计算{isCollapsedCol && <><br /><span>该小计列已折叠：点列表头 + 或格内「展开下级」查看明细</span></>}{sumMemo ? <><br /><strong>📝 备注：</strong>{sumMemo}{canEditSum && <><br /><span>双击编辑备注</span></>}</> : (canEditSum ? <><br />双击添加备注</> : null)}</>}>
                            <span>{val || <span style={{ color: 'var(--bd-text-tertiary)' }}>—</span>}</span>
                          </Tooltip>
                          {isCollapsedCol && (
                            <Button
                              type="link"
                              size="small"
                              style={{ padding: 0, fontSize: 12, marginLeft: 2 }}
                              onClick={() => props.onToggleCollapseOrgCol(col.id)}
                            >
                              展开下级
                            </Button>
                          )}
                          {sumMemo && (
                            <div
                              title={`备注: ${sumMemo}`}
                              style={{
                                position: 'absolute', top: 0, right: 0, width: 0, height: 0,
                                borderTop: `6px solid ${fc.cost}`, borderLeft: '6px solid transparent',
                                pointerEvents: 'none',
                              }}
                            />
                          )}
                        </td>
                      );
                    }

                    const oid = col.id;
                    const editable = props.cellEditable(row, oid);
                    const key = `${oid}:${row.id}`;
                    // 汇总科目行(非叶子)的备注在汇总格备注里;叶子行仍在明细行 notes 上;指标行无备注
                    const memo = row.kind !== 'account'
                      ? ''
                      : (row.isLeaf ? notes.get(key) : props.summaryNotes.get(key))?.trim() ?? '';
                    // 汇总科目行在当前实际模式下可双击编辑汇总备注
                    const canEditRowSummary = row.kind === 'account' && !row.isLeaf && props.canEditSummaryMemo;
                    const actualV = editable && row.kind === 'account'
                      ? (values.get(key) ?? '')
                      : props.displayOfOrg(row, editYear, [oid], 'actual');
                    const ri = gridRowIdx.get(row.id);
                    const ci = gridColIdx.get(oid);
                    const cellFocused = grid.activeIds?.rowId === row.id && grid.activeIds?.colId === oid;
                    const cellH = props.density === 'compact' ? 24 : props.density === 'relaxed' ? 34 : 28;
                    /* UX-23-1:只读格给出可解释的原因(整表只读 > 汇总自动计算 > 不适用/停用) */
                    const readonlyTitle = row.kind !== 'account'
                      ? '计算/取数行，只读'
                      : !row.isLeaf
                        ? `汇总值，随明细自动计算${canEditRowSummary ? '；双击编辑汇总备注' : ''}`
                        : (props.readonlyReason ?? '该科目不适用于此组织或已停用，不可填写');

                    return (
                      <td
                        key={col.key}
                        data-gr={ri ?? undefined}
                        data-gc={ci ?? undefined}
                        style={{
                          border: '1px solid var(--bd-border)',
                          padding: editable ? 1 : '2px 8px',
                          textAlign: 'right',
                          fontFamily: NUMERIC_FONT_FAMILY,
                          position: 'relative',
                          background: cellFocused
                            ? primaryFocusBg
                            : ri != null && ci != null && grid.isInSelection(ri, ci)
                              ? 'var(--bd-primary-bg)'
                              : isSummaryRow ? 'var(--bd-header)' : rowActive ? 'var(--bd-primary-bg)' : undefined,
                        }}
                        onContextMenu={(e) => {
                          if (ri == null || ci == null) return;
                          e.preventDefault();
                          grid.focusCell(ri, ci);
                          props.onCtxMenu({ open: true, x: e.clientX, y: e.clientY, r: ri, c: ci });
                        }}
                        // 可编辑叶子格打开明细备注;汇总科目行打开汇总格备注;其余只读格不弹窗
                        onDoubleClick={() => {
                          if (editable) { props.onOpenMemo(oid, row.id); return; }
                          if (canEditRowSummary) props.onOpenMemo(oid, row.id, true);
                        }}
                      >
                        {editable && ri != null && ci != null ? (
                          <div style={{ position: 'relative', width: '100%' }}>
                            <Input
                              id={`actual-cell-${oid}-${row.id}`}
                              size="small"
                              title={(row as AccRow).type === 'quantity'
                                ? `数量单位：${(row as AccRow).unit || '按科目设置'}，最多四位小数`
                                : '金额单位：万元（1.00 万元 = 10,000 元，最多两位小数）；成本费用按正数填写，负数表示冲回'}
                              style={{
                                width: '100%',
                                height: cellH,
                                padding: '0 6px',
                                textAlign: 'right',
                                fontFamily: NUMERIC_FONT_FAMILY,
                                fontSize: 12,
                                background: cellFocused ? 'var(--bd-bg-container)' : 'transparent',
                                borderColor: invalidCells.has(key) ? sc.bad : cellFocused ? 'var(--bd-primary)' : (row as AccRow).type === 'quantity' ? accentSoftBorder : 'var(--bd-border)',
                                boxShadow: cellFocused ? '0 0 0 2px rgba(37, 99, 235, 0.25)' : undefined,
                              }}
                              value={values.get(key) ?? ''}
                              onFocus={() => { props.onActiveRowChange(row.id); grid.handleCellFocus(ri, ci); }}
                              onBlur={() => grid.commitCell(ri, ci)}
                              onChange={(e) => grid.setCellInput(ri, ci, e.target.value)}
                              onKeyDown={(e) => grid.handleCellKeyDown(e, ri, ci)}
                              onPaste={(e) => grid.handleCellPaste(e, ri, ci)}
                              onCopy={(e) => grid.handleCopy(e)}
                              onMouseDown={(e) => grid.handleCellMouseDown(e, ri, ci)}
                            />
                            {cellFocused && (
                              <div
                                onMouseDown={(e) => grid.beginFillDrag(e, ri, ci)}
                                title="拖拽填充(向下/向右)"
                                style={{ position: 'absolute', right: 0, bottom: 0, width: 8, height: 8, background: 'var(--bd-primary)', border: '1px solid var(--bd-bg-container)', cursor: 'crosshair', zIndex: 3 }}
                              />
                            )}
                          </div>
                          ) : (
                          <Tooltip title={<><span>{readonlyTitle}</span>{memo ? <><br /><strong>📝 备注：</strong>{memo}{canEditRowSummary && <><br /><span>双击编辑备注</span></>}</> : (canEditRowSummary ? <><br />双击添加备注</> : null)}</>}>{actualV || <span style={{ color: 'var(--bd-text-tertiary)' }}>—</span>}</Tooltip>
                        )}
                        {!editable && memo && (
                          <div
                            style={{
                              position: 'absolute', top: 0, right: 0, width: 0, height: 0,
                              borderTop: `6px solid ${fc.cost}`, borderLeft: '6px solid transparent',
                              pointerEvents: 'none',
                            }}
                          />
                        )}
                      </td>
                    );
                  })
                ) : (
                  years.map((y) => {
                    // 可编辑仅限"当前维护年度"列:多年视图其余年份列为只读展示,
                    // 否则编辑年的录入值会同步显示到每个历史年份列
                    const editable = y === editYear && props.cellEditable(row);
                    const budgetV = props.displayOf(row, y, 'budget');
                    const actualV = editable && row.kind === 'account' ? (values.get(`${props.singleLeafScope}:${row.id}`) ?? '') : props.displayOf(row, y, 'actual');
                    const isCurrentEditYear = y === editYear;
                    const cellBg = isCurrentEditYear ? 'var(--bd-primary-bg)' : isSummaryRow ? 'var(--bd-header)' : rowActive ? 'var(--bd-header)' : undefined;
                    const yrRi = gridRowIdx.get(row.id);
                    const yrCi = isCurrentEditYear && props.singleLeafScope != null ? 0 : undefined;
                    const yrFocused = grid.activeIds?.rowId === row.id && viewMode === 'years';
                    const yrH = props.density === 'compact' ? 24 : props.density === 'relaxed' ? 34 : 28;
                    return (
                      <Fragment key={y}>
                        <td style={{ border: '1px solid var(--bd-border)', padding: '2px 8px', textAlign: 'right', fontFamily: NUMERIC_FONT_FAMILY, background: cellBg }}>
                          {budgetV || <span style={{ color: 'var(--bd-text-tertiary)' }}>—</span>}
                        </td>
                        <td
                          data-gr={yrRi ?? undefined}
                          data-gc={yrCi ?? undefined}
                          style={{ border: '1px solid var(--bd-border)', padding: editable ? 1 : '2px 8px', textAlign: 'right', fontFamily: NUMERIC_FONT_FAMILY, background: cellBg, position: 'relative' }}
                          onContextMenu={(e) => {
                            if (yrRi == null || yrCi == null) return;
                            e.preventDefault();
                            grid.focusCell(yrRi, yrCi);
                            props.onCtxMenu({ open: true, x: e.clientX, y: e.clientY, r: yrRi, c: yrCi });
                          }}
                        >
                          {editable && yrRi != null && yrCi != null ? (
                            <div style={{ position: 'relative', width: '100%' }}>
                              <Input
                                id={`actual-cell-${props.singleLeafScope}-${row.id}`}
                                size="small"
                                style={{
                                  width: '100%',
                                  height: yrH,
                                  padding: '0 6px',
                                  textAlign: 'right',
                                  fontFamily: NUMERIC_FONT_FAMILY,
                                  fontSize: 12,
                                  borderColor: invalidCells.has(`${props.singleLeafScope}:${row.id}`) ? sc.bad : yrFocused ? 'var(--bd-primary)' : 'var(--bd-border)',
                                  boxShadow: yrFocused ? '0 0 0 2px rgba(37, 99, 235, 0.25)' : undefined,
                                }}
                                value={values.get(`${props.singleLeafScope}:${row.id}`) ?? ''}
                                onFocus={() => { props.onActiveRowChange(row.id); grid.handleCellFocus(yrRi, yrCi); }}
                                onBlur={() => grid.commitCell(yrRi, yrCi)}
                                onChange={(e) => grid.setCellInput(yrRi, yrCi, e.target.value)}
                                onKeyDown={(e) => grid.handleCellKeyDown(e, yrRi, yrCi)}
                                onPaste={(e) => grid.handleCellPaste(e, yrRi, yrCi)}
                                onCopy={(e) => grid.handleCopy(e)}
                                onMouseDown={(e) => grid.handleCellMouseDown(e, yrRi, yrCi)}
                              />
                              {yrFocused && (
                                <div
                                  onMouseDown={(e) => grid.beginFillDrag(e, yrRi, yrCi)}
                                  title="拖拽填充"
                                  style={{ position: 'absolute', right: 0, bottom: 0, width: 8, height: 8, background: 'var(--bd-primary)', border: '1px solid var(--bd-bg-container)', cursor: 'crosshair', zIndex: 3 }}
                                />
                              )}
                            </div>
                          ) : (
                            <span title={!isCurrentEditYear ? `${y} 年为历史年度，只读；当前维护 ${editYear} 年` : (props.readonlyReason ?? (row.kind === 'account' && row.isLeaf ? '该科目不可填写' : '汇总值，随明细自动计算'))}>{actualV || <span style={{ color: 'var(--bd-text-tertiary)' }}>—</span>}</span>
                          )}
                        </td>
                      </Fragment>
                    );
                  })
                )}
              </tr>
            );
          })}
          {visibleRows.length === 0 && (
            <tr><td colSpan={viewMode === 'orgs' ? 1 + orgDisplayCols.length : 1 + years.length * 2} style={{ padding: 16, textAlign: 'center', color: 'var(--bd-text-tertiary)' }}>当前筛选条件下没有行</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
