import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode, Key } from 'react';
import { Button, Checkbox, Grid, Modal, Segmented, Space, Table } from 'antd';
import type { TableProps } from 'antd';
import { loadSession, saveSession } from './GridAddons';
import { useFullscreenLayer } from '../hooks/useFullscreenLayer';
import { configuredItemsByKey, stableColumnKey } from '../utils/columnConfig';

type AnyColumn = NonNullable<TableProps<any>['columns']>[number] & { key?: Key; children?: AnyColumn[] };
type Config = { hidden: string[]; order: string[]; fixed: boolean; density: 'small' | 'middle' | 'large' };

export function columnKey(c: AnyColumn, i: number): string { return stableColumnKey(c, i); }

/** Ant Design Table with per-table fullscreen, column visibility/order and density controls. */
type EnhancedProps<T extends object> = Omit<TableProps<T>, 'title' | 'size' | 'columns'> & { tableKey?: string; title?: ReactNode; columns?: NonNullable<TableProps<T>['columns']>; size?: Config['density']; defaultFixed?: boolean; density?: Config['density']; onDensityChange?: (v: Config['density']) => void };
export function EnhancedTable<T extends object = any>(props: EnhancedProps<T>) {
  const { tableKey, title, defaultFixed = true, density, size, onDensityChange, columns = [], ...tableProps } = props;
  const storageKey = tableKey ?? `auto-${(columns as AnyColumn[]).map((c, i) => columnKey(c, i)).join('_')}`;
  const defaults = useMemo<Config>(() => ({ hidden: [], order: (columns as AnyColumn[]).map((c, i) => columnKey(c, i)), fixed: defaultFixed, density: density ?? size ?? 'middle' }), [columns, defaultFixed, density, size]);
  const [config, setConfig] = useState<Config>(() => ({ ...defaults, ...loadSession<Partial<Config>>(`bd-table-${storageKey}`, {}) }));
  const [fullscreen, setFullscreen] = useState(false);
  const exitFullscreen = useCallback(() => setFullscreen(false), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const screens = Grid.useBreakpoint();
  useFullscreenLayer(fullscreen, exitFullscreen);
  useEffect(() => { setConfig(c => ({ ...defaults, ...c, order: c.order.filter(k => defaults.order.includes(k)).concat(defaults.order.filter(k => !c.order.includes(k))) })); }, [defaults]);
  const update = (next: Partial<Config>) => { const value = { ...config, ...next }; setConfig(value); saveSession(`bd-table-${storageKey}`, value); };
  const entries = (columns as AnyColumn[]).map((column, index) => ({ key: columnKey(column, index), column }));
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const visible = configuredItemsByKey(entries, config.order, config.hidden).map(({ column }, index) => ({
    ...column,
    ...(config.fixed && index === 0 ? { fixed: 'left' as const } : {}),
  }));
  const all = config.order.map((key) => byKey.get(key)).filter((entry): entry is (typeof entries)[number] => Boolean(entry));
  const move = (key: string, dir: -1 | 1) => { const order = [...config.order]; const i = order.indexOf(key), j = i + dir; if (i < 0 || j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j], order[i]]; update({ order }); };
  /**
   * 窄屏(<md)才给表格横向滚动:此时 rc-table 给 <table> 加 `width: max-content; min-width: 100%`,
   * 列保持内容自然宽度、由表格自己横向滚动,不会被挤成一两个字。
   * 宽屏保持 antd 默认(表格铺满卡片、长文本换行)——一律开 max-content 会让宽屏表格反而溢出卡片,
   * 最右侧的操作按钮跑到卡片外面去。调用方显式传 scroll 时以调用方为准。
   */
  const scroll = tableProps.scroll ?? (screens.md === false ? { x: 'max-content' as const } : undefined);
  return <div className={fullscreen ? 'bd-table-fullscreen' : undefined}>
    <div className="bd-table-toolbar"><span>{title}</span><Space size="small" wrap><Segmented size="small" value={config.density} onChange={v => { const d = v as Config['density']; update({ density: d }); onDensityChange?.(d); }} options={[{ label: '紧凑', value: 'small' }, { label: '标准', value: 'middle' }, { label: '宽松', value: 'large' }]} /><Button size="small" icon={<i className="ri-settings-3-line" aria-hidden />} onClick={() => setSettingsOpen(true)}>列配置</Button><Button size="small" icon={fullscreen ? <i className="ri-fullscreen-exit-line" aria-hidden /> : <i className="ri-fullscreen-line" aria-hidden />} onClick={() => setFullscreen(v => !v)} title={fullscreen ? '退出全屏(Esc)' : '全屏显示表格(Esc 退出)'}>{fullscreen ? '退出全屏(Esc)' : '全屏'}</Button></Space></div>
    <Table {...tableProps} scroll={scroll} columns={visible} size={config.density} />
    <Modal title="列显示配置" open={settingsOpen} onCancel={() => setSettingsOpen(false)} onOk={() => setSettingsOpen(false)} footer={null}>
      <Space direction="vertical" style={{ width: '100%' }}><Checkbox checked={config.fixed} onChange={e => update({ fixed: e.target.checked })}>固定首列</Checkbox>{all.map(({ key: k, column: c }, i) => { const locked = k === 'selection' || k === 'action' || k === 'actions'; return <div key={k} draggable={!locked} onDragStart={e => e.dataTransfer.setData('text/plain', k)} onDragOver={e => e.preventDefault()} onDrop={e => { const from = e.dataTransfer.getData('text/plain'); if (!from || from === k) return; const order = [...config.order], a = order.indexOf(from), b = order.indexOf(k); if (a < 0 || b < 0) return; order.splice(a, 1); order.splice(b, 0, from); update({ order }); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: locked ? 'default' : 'grab' }}><Checkbox disabled={locked} checked={!config.hidden.includes(k)} onChange={e => update({ hidden: e.target.checked ? config.hidden.filter(x => x !== k) : [...config.hidden, k] })}>{String(c.title ?? k)}</Checkbox><span style={{ marginLeft: 'auto' }}><Button size="small" disabled={i === 0} onClick={() => move(k, -1)}>↑</Button><Button size="small" disabled={i === all.length - 1} onClick={() => move(k, 1)}>↓</Button></span></div>})}<Button onClick={() => update(defaults)}>恢复默认</Button></Space>
    </Modal>
  </div>;
}
