/**
 * 表格手感组件集(与 useGridInteraction 配套):
 * GridStatusBar 状态栏 / GridFormulaBar 公式栏 / GridFindReplace 查找替换 /
 * PasteSpecialModal 选择性粘贴 / GridContextMenu 右键菜单 / 列宽拖拽与密度辅助
 */
import { readBrowserStorage } from '../utils/browserStorage';
import { useEffect, useRef, useState, useCallback } from 'react';
import type { CSSProperties, ReactNode, MouseEvent as ReactMouseEvent } from 'react';
import { App, Button, Checkbox, Input, Modal, Space, Typography, Dropdown, Tooltip } from 'antd';
import type { InputRef } from 'antd';
import type { MenuProps } from 'antd';
import type { FindMatch, PasteOptions, SelectionStats } from '../hooks/useGridInteraction';
import { useThemeMode, NUMERIC_FONT_FAMILY, statusColor, financeColor } from '../theme';

/* ============ 会话级持久化小工具(筛选/密度/列宽/位置记忆) ============ */
export function loadSession<T>(key: string, fallback: T): T {
  try {
    const raw = readBrowserStorage(sessionStorage, key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function saveSession(key: string, value: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略 */ }
}
export function useSessionState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [state, setState] = useState<T>(() => loadSession(key, initial));
  const set = (v: T) => { setState(v); saveSession(key, v); };
  return [state, set];
}

/* ============ 状态栏:改动格数 + 选区聚合 + 撤销深度 ============ */
const fmtNum = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

export function GridStatusBar({ dirtyCount, hiddenDirtyCount, onShowAllDirty, canUndo, undoDepth, stats, saving, extra, activeCell }: {
  dirtyCount: number; canUndo: boolean; undoDepth: number; stats: SelectionStats | null;
  /** 不在当前视图的待保存项数(UX-09);提供时展示「其中 M 项不在当前视图」及查看入口 */
  hiddenDirtyCount?: number;
  /** 一键查看全部待保存项 */
  onShowAllDirty?: () => void;
  /** 保存中显示轻量指示;不做呼吸光晕(那属被排除的表演性动效) */
  saving?: boolean;
  /** 当前活动格完整对象(UX-23-3):组织名 · 科目名 + 单位,滚动/全屏后仍可确认输入对象 */
  activeCell?: { label: string; unit?: string | null } | null;
  extra?: ReactNode;
}) {
  const { mode } = useThemeMode();
  const sc = statusColor(mode);
  const fc = financeColor(mode);
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        padding: '6px 12px',
        marginTop: 8,
        background: 'var(--newfc-header)',
        border: '1px solid var(--newfc-border-subtle)',
        borderRadius: 6,
        fontSize: 12,
        color: 'var(--newfc-text-secondary)',
      }}
    >
      {/* UX-23-3:活动格完整组织 · 科目 · 单位(长名称悬浮可读全文) */}
      {activeCell && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--newfc-text)', maxWidth: '46%' }} title={`${activeCell.label}${activeCell.unit ? ` · 单位：${activeCell.unit}` : ''}`}>
          <i className="ri-focus-2-line" style={{ color: 'var(--newfc-primary)' }} aria-hidden />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            当前格 <b>{activeCell.label}</b>{activeCell.unit ? <span style={{ color: 'var(--newfc-text-tertiary)' }}> · 单位 {activeCell.unit}</span> : null}
          </span>
        </span>
      )}
      {/* 三档层次: 未保存(警告档状态圆图标) / 保存中(轻量指示) / 无修改(次级灰) */}
      {saving ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--newfc-text-secondary)' }}>
          <i className="ri-loader-4-line" aria-hidden />
          保存中…
        </span>
      ) : dirtyCount > 0 ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: sc.warn, fontWeight: 500 }}>
          <span className="newfc-status-icon newfc-status-icon-warn"><i className="ri-error-warning-line" aria-hidden /></span>
          待保存修改共 {dirtyCount} 项
          {hiddenDirtyCount != null && hiddenDirtyCount > 0 && (
            <>
              ，其中 <b>{hiddenDirtyCount}</b> 项不在当前视图
              {onShowAllDirty && (
                <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }} onClick={onShowAllDirty}>
                  查看全部待保存项
                </Button>
              )}
            </>
          )}
        </span>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--newfc-text-tertiary)' }}>
          <span className="newfc-status-icon newfc-status-icon-ok"><i className="ri-check-line" aria-hidden /></span>
          无未保存修改
        </span>
      )}
      {stats && stats.count > 1 && (
        <>
          <span style={{ color: 'var(--newfc-border)' }}>|</span>
          <span style={{ color: 'var(--newfc-text-tertiary)' }}>选区 <b>{stats.count}</b> 格:</span>
          {stats.moneyCount > 0 && <span>求和 <b>{fmtNum(stats.sum)}</b> 万元</span>}
          {stats.moneyCount > 0 && <span>利润方向合计 <b>{fmtNum(stats.directional)}</b> 万元</span>}
          {stats.moneyCount > 0 && stats.avg != null && <span>均值 <b>{fmtNum(stats.avg)}</b> 万元</span>}
          <span>非空 <b>{stats.nonEmpty}</b></span>
          {stats.qtyCount > 0 && (
            <Tooltip title="数量按各自计量单位读取，单位可能不同，不并入金额求和，也不跨科目合计">
              <span style={{ color: fc.expense }}>数量 <b>{stats.qtyCount}</b> 格（不参与金额求和）</span>
            </Tooltip>
          )}
          {stats.invalidCount > 0 && <Typography.Text type="danger">{stats.invalidCount} 格未计入(非法)</Typography.Text>}
        </>
      )}
      <span style={{ marginLeft: 'auto', color: 'var(--newfc-text-tertiary)', fontSize: 12 }}>
        {canUndo ? `可撤销 ${undoDepth} 步 (Ctrl+Z)` : '撤销栈空'}
      </span>
      {extra}
    </div>
  );
}

/* ============ 公式栏:活动单元格原始公式与附注常显 ============ */
export function GridFormulaBar({ cellLabel, value, formula, note, onOpenNote, unit }: {
  cellLabel: string | null; value: string; formula: string; note: string; onOpenNote?: () => void;
  /** 当前格单位(UX-23-3):金额=万元,数量=科目计量单位 */
  unit?: string | null;
}) {
  const fc = financeColor(useThemeMode().mode);
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '4px 10px',
        marginBottom: 8,
        border: '1px solid var(--newfc-border)',
        borderRadius: 6,
        fontSize: 12,
        background: 'var(--newfc-header)',
      }}
    >
      <span title={cellLabel ?? undefined} style={{ fontFamily: NUMERIC_FONT_FAMILY, fontWeight: 600, color: 'var(--newfc-primary)', minWidth: 160, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {cellLabel ?? '—'}
      </span>
      {unit && (
        <span style={{ whiteSpace: 'nowrap', color: 'var(--newfc-text-tertiary)' }}>单位 {unit}</span>
      )}
      <span style={{ fontFamily: NUMERIC_FONT_FAMILY, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--newfc-text-secondary)' }}>
        {formula ? <span style={{ color: 'var(--newfc-primary)', fontWeight: 500 }}>📐 {formula} = {value || '(空)'}</span> : <span>{value || ''}</span>}
      </span>
      {note && (
        <Tooltip title={note} placement="topLeft">
          {/* 附注浅底由警告色 12% 派生,亮暗自换挡(不新增色相) */}
          <span style={{ color: fc.cost, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%', background: `color-mix(in srgb, ${fc.cost} 12%, transparent)`, padding: '1px 6px', borderRadius: 4 }}>
            📝 {note}
          </span>
        </Tooltip>
      )}
      {onOpenNote && (
        <Button type="link" size="small" onClick={onOpenNote} style={{ padding: 0, fontSize: 12 }}>编辑(Shift+F2)</Button>
      )}
    </div>
  );
}

/* ============ 网格内查找/替换 ============ */
export interface FindScopes { label: boolean; value: boolean; formula: boolean; note: boolean }

export function GridFindReplace({ open, mode, onClose, hasFormulaNotes, onSearch, onJump, onReplaceAll }: {
  open: boolean;
  mode: 'find' | 'replace';
  onClose: () => void;
  hasFormulaNotes: boolean;
  onSearch: (query: string, scopes: FindScopes) => FindMatch[];
  onJump: (m: FindMatch) => void;
  onReplaceAll: (matches: FindMatch[], replacement: string, query: string) => number;
}) {
  const { modal } = App.useApp();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [scopes, setScopes] = useState<FindScopes>({ label: true, value: true, formula: hasFormulaNotes, note: hasFormulaNotes });
  const [matches, setMatches] = useState<FindMatch[]>([]);
  const [current, setCurrent] = useState(-1);
  const inputRef = useRef<InputRef>(null);

  useEffect(() => {
    if (!open) return;
    setMatches([]); setCurrent(-1);
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open, mode]);

  if (!open) return null;

  const doSearch = () => {
    const list = onSearch(query, scopes);
    setMatches(list);
    if (list.length > 0) { setCurrent(0); onJump(list[0]); }
    else setCurrent(-1);
  };
  const step = (d: number) => {
    if (matches.length === 0) return;
    const next = (current + d + matches.length) % matches.length;
    setCurrent(next);
    onJump(matches[next]);
  };
  const doReplaceAll = () => {
    if (!query) return;
    const targets = matches.filter((m) => m.kind !== 'label');
    if (targets.length === 0) return;
    const n = onReplaceAll(targets, replacement, query);
    modal.info({
      title: `替换完成: 共更新 ${n} 格`,
      content: '已作为一步操作入撤销栈,可 Ctrl+Z 一次回滚。',
      okText: '知道了',
      onOk: doSearch,
    });
  };

  return (
    <div
      style={{
        position: 'sticky',
        left: 0,
        zIndex: 30,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        padding: '8px 12px',
        marginBottom: 8,
        border: '1px solid var(--newfc-border)',
        borderRadius: 8,
        background: 'var(--newfc-bg-container)',
        boxShadow: '0 4px 16px -2px rgba(0, 0, 0, 0.08)',
      }}
    >
      <Input
        ref={inputRef}
        size="small" allowClear style={{ width: 210 }} placeholder="查找: 编码/名称/数值…"
        prefix={<i className="ri-search-line" style={{ color: 'var(--newfc-text-tertiary)' }} aria-hidden />}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onPressEnter={doSearch}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      />
      {mode === 'replace' && (
        <Input
          size="small" allowClear style={{ width: 190 }} placeholder="替换为…"
          prefix={<i className="ri-arrow-left-right-line" style={{ color: 'var(--newfc-text-tertiary)' }} aria-hidden />}
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
        />
      )}
      <Button size="small" type="primary" onClick={doSearch}>查找</Button>
      <Space.Compact size="small">
        <Button size="small" icon={<i className="ri-arrow-up-s-line" aria-hidden />} disabled={matches.length === 0} onClick={() => step(-1)} title="上一个(Shift+Enter)" />
        <Button size="small" icon={<i className="ri-arrow-down-s-line" aria-hidden />} disabled={matches.length === 0} onClick={() => step(1)} title="下一个(Enter)" />
      </Space.Compact>
      {mode === 'replace' && (
        <Button size="small" danger disabled={matches.filter((m) => m.kind !== 'label').length === 0} onClick={doReplaceAll}>
          替换命中的 {matches.filter((m) => m.kind !== 'label').length} 格
        </Button>
      )}
      <Space size={6} wrap style={{ marginLeft: 4 }}>
        <Checkbox checked={scopes.label} onChange={(e) => setScopes({ ...scopes, label: e.target.checked })}>科目</Checkbox>
        <Checkbox checked={scopes.value} onChange={(e) => setScopes({ ...scopes, value: e.target.checked })}>数值</Checkbox>
        {hasFormulaNotes && <Checkbox checked={scopes.formula} onChange={(e) => setScopes({ ...scopes, formula: e.target.checked })}>公式</Checkbox>}
        {hasFormulaNotes && <Checkbox checked={scopes.note} onChange={(e) => setScopes({ ...scopes, note: e.target.checked })}>附注</Checkbox>}
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {matches.length > 0 ? `${current + 1} / ${matches.length} 项: ${matches[current]?.preview ?? ''}` : query ? '无匹配' : '输入关键字后回车查找'}
      </Typography.Text>
      <Button size="small" type="text" icon={<i className="ri-close-line" aria-hidden />} onClick={onClose} style={{ marginLeft: 'auto' }} title="关闭(Esc)" />
    </div>
  );
}

/* ============ 选择性粘贴(Ctrl+Alt+V / 右键菜单) ============ */
export function PasteSpecialModal({ open, onClose, onApply, targetLabel }: {
  open: boolean; onClose: () => void; onApply: (text: string, opts: PasteOptions) => void; targetLabel: string | null;
}) {
  const [text, setText] = useState('');
  const [transpose, setTranspose] = useState(false);
  const [skipEmpty, setSkipEmpty] = useState(false);
  const [valuesOnly, setValuesOnly] = useState(false);
  const [clipboardErr, setClipboardErr] = useState(false);

  useEffect(() => {
    if (open) { setText(''); setClipboardErr(false); }
  }, [open]);

  const readClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setText(t);
      setClipboardErr(false);
    } catch {
      setClipboardErr(true); // 公网 http 等场景无剪贴板 API,降级为文本域手动粘贴
    }
  };

  return (
    <Modal
      title="选择性粘贴"
      open={open}
      onCancel={onClose}
      onOk={() => { onApply(text, { transpose, skipEmpty, valuesOnly }); onClose(); }}
      okText="粘贴"
      cancelText="取消"
      width={560}
      okButtonProps={{ disabled: !text.trim() }}
    >
      <div style={{ marginBottom: 8, fontSize: 12 }}>
        目标起始格: <b>{targetLabel ?? '(请先点击一个起始单元格)'}</b>
      </div>
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" onClick={readClipboard}>读取剪贴板</Button>
        {clipboardErr && <Typography.Text type="warning" style={{ fontSize: 12 }}>浏览器限制无法自动读取,请在下方文本域内 Ctrl+V</Typography.Text>}
      </Space>
      <Input.TextArea
        rows={7}
        placeholder="从 Excel 复制后在此 Ctrl+V(或点「读取剪贴板」)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ fontFamily: NUMERIC_FONT_FAMILY, fontSize: 12 }}
      />
      <Space size={16} style={{ marginTop: 10 }} wrap>
        <Checkbox checked={transpose} onChange={(e) => setTranspose(e.target.checked)}>转置(行列互换)</Checkbox>
        <Checkbox checked={skipEmpty} onChange={(e) => setSkipEmpty(e.target.checked)}>跳过空单元格(不清目标已有值)</Checkbox>
        <Checkbox checked={valuesOnly} onChange={(e) => setValuesOnly(e.target.checked)}>仅数值(保留目标格公式绑定)</Checkbox>
      </Space>
    </Modal>
  );
}

/* ============ 右键菜单(受控浮层) ============ */
export function GridContextMenu({ open, x, y, onClose, onAction, items }: {
  open: boolean; x: number; y: number; onClose: () => void; onAction?: (key: string) => void; items: MenuProps['items'];
}) {
  const anchorStyle: CSSProperties = { position: 'fixed', left: x, top: y, width: 0, height: 0, zIndex: 1000 };
  return (
    <Dropdown
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      menu={{ items, onClick: (info) => { onAction?.(info.key); onClose(); } }}
      trigger={[]}
    >
      <span style={anchorStyle} />
    </Dropdown>
  );
}

/* ============ 快捷键帮助(UX-23-7):表格附近随时可查,只列真实生效的快捷键 ============ */
export function GridShortcutHelp({ variant }: { variant: 'budget' | 'actual' }) {
  const [open, setOpen] = useState(false);
  const groups: { title: string; items: [string, string][] }[] = [
    {
      title: '保存与撤销',
      items: [
        ['Ctrl+S', '立即保存(不生成其他记录)'],
        ['Ctrl+Z', '撤销上一步(含整次粘贴、汇总格备注)'],
        ['Ctrl+Y 或 Ctrl+Shift+Z', '重做'],
      ],
    },
    {
      title: '移动与录入',
      items: [
        ['Enter / Tab', '提交本格并下移 / 右移(Shift 反向)'],
        ['方向键', '移动到相邻格(编辑中左右键先移动光标)'],
        ['Ctrl+方向键', '跳到连续数据区边界'],
        ['Home / End · PageUp / PageDown', '行首行尾 · 上下翻页'],
        ['Esc', '取消本次输入,恢复进入编辑前的值'],
      ],
    },
    {
      title: '选区与批量',
      items: [
        ['Shift+方向键 / Shift+点击', '扩展选区'],
        ['Ctrl+C', '复制选区(可直接粘到 Excel;Alt+C 含表头)'],
        ['Ctrl+V', '矩阵粘贴(越界/只读/格式错误如实计数)'],
        ['Ctrl+Alt+V', '选择性粘贴(转置/跳过空/仅数值)'],
        ['Ctrl+D / Ctrl+R', '向下 / 向右填充'],
        ['Delete', '清空选区数值(再 Ctrl+Z 可回退)'],
      ],
    },
    {
      title: '查找与附注',
      items: [
        ['Ctrl+F / Ctrl+H', '网格内查找 / 替换'],
        ...(variant === 'budget' ? [['Shift+F2', '编辑本格附注与公式'] as [string, string]] : []),
        ['双击单元格', variant === 'budget' ? '编辑附注与公式(汇总格编辑备注)' : '编辑备注(汇总格编辑汇总备注)'],
      ],
    },
  ];
  return (
    <>
      <Button
        icon={<i className="ri-keyboard-line" aria-hidden />}
        onClick={() => setOpen(true)}
        title="查看表格快捷键"
      >快捷键</Button>
      <Modal
        title="表格快捷键"
        open={open}
        onCancel={() => setOpen(false)}
        footer={<Button type="primary" onClick={() => setOpen(false)}>知道了</Button>}
        width={560}
      >
        {groups.map((g) => (
          <div key={g.title} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{g.title}</div>
            {g.items.map(([keys, desc]) => (
              <div key={keys} style={{ display: 'flex', gap: 12, padding: '2px 0', fontSize: 12 }}>
                <span style={{ minWidth: 190, fontFamily: NUMERIC_FONT_FAMILY, color: 'var(--newfc-primary)', fontWeight: 600 }}>{keys}</span>
                <span style={{ color: 'var(--newfc-text-secondary)' }}>{desc}</span>
              </div>
            ))}
          </div>
        ))}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          中文输入法选词期间的 Enter / 方向键不会触发跳格或提交，选词确认后再正常生效。
        </Typography.Text>
      </Modal>
    </>
  );
}

/* ============ 列宽拖拽 ============ */
export function useColumnWidths(storageKey: string) {
  const [widths, setWidths] = useState<Record<string, number>>(() => loadSession(storageKey, {}));
  /** 拖拽会话由 state 驱动:卸载组件时 effect 清理函数自动摘除 window 监听 */
  const [resizing, setResizing] = useState<{ colKey: string; startX: number; currentWidth: number } | null>(null);
  const widthOf = useCallback((colKey: string, defaultWidth: number) => widths[colKey] ?? defaultWidth, [widths]);

  const startResize = useCallback((e: ReactMouseEvent, colKey: string, currentWidth: number) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing({ colKey, startX: e.clientX, currentWidth });
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (ev: MouseEvent) => {
      /* 下限 84px:8 字符组织编码 ≈64px + 表头内边距。再窄列头编码会溢出被裁。 */
      const next = Math.max(84, Math.round(resizing.currentWidth + (ev.clientX - resizing.startX)));
      setWidths((prev) => ({ ...prev, [resizing.colKey]: next }));
    };
    const onUp = () => setResizing(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setWidths((prev) => { saveSession(storageKey, prev); return prev; });
    };
  }, [resizing, storageKey]);

  return { widthOf, startResize };
}

/** 表头列宽拖拽手柄(置于 th 内右侧) */
export function ColResizeGrip({ onStart }: { onStart: (e: ReactMouseEvent) => void }) {
  return (
    <span
      onMouseDown={onStart}
      title="拖拽调整列宽"
      style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <i className="ri-draggable" style={{ fontSize: 12, color: 'var(--newfc-text-tertiary)' }} aria-hidden />
    </span>
  );
}
