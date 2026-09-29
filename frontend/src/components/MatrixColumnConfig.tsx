import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Modal, Space } from 'antd';
import { loadSession, saveSession } from './GridAddons';
import {
  mergeAvailableColumnOrder,
  reconcileMatrixColumnState,
  restoreMatrixColumnState,
  visibleMatrixColumnKeys,
  type LegacyMatrixColumnState,
  type MatrixColumnState,
} from '../utils/columnConfig';

export interface MatrixColumn { key: string; label: string }
export function MatrixColumnConfig({ storageKey, columns, onChange }: { storageKey: string; columns: MatrixColumn[]; onChange: (keys: string[], fixed: boolean) => void }) {
  const availableSignature = columns.map((column) => column.key).join('\0');
  const available = useMemo(() => columns.map((column) => column.key), [availableSignature]);
  const sessionKey = `bd-matrix-cols-${storageKey}`;
  const savedRef = useRef<LegacyMatrixColumnState>();
  if (savedRef.current === undefined) savedRef.current = loadSession<LegacyMatrixColumnState>(sessionKey, {});
  const legacyMigrationPendingRef = useRef(
    Array.isArray(savedRef.current.keys) && !Array.isArray(savedRef.current.order) && available.length === 0,
  );
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<MatrixColumnState>(() => restoreMatrixColumnState(
    savedRef.current ?? {},
    available,
  ));
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    setConfig((current) => {
      const next = legacyMigrationPendingRef.current && available.length > 0
        ? restoreMatrixColumnState(savedRef.current ?? {}, available)
        : reconcileMatrixColumnState(current, available);
      if (legacyMigrationPendingRef.current && available.length > 0) legacyMigrationPendingRef.current = false;
      if (next.order.join('\0') !== current.order.join('\0') || next.hidden.join('\0') !== current.hidden.join('\0')) {
        saveSession(sessionKey, next);
        return next;
      }
      return current;
    });
  }, [availableSignature, sessionKey]);

  useEffect(() => {
    onChangeRef.current(visibleMatrixColumnKeys(config, available), config.fixed);
  }, [availableSignature, config]);

  const apply = (next: MatrixColumnState) => {
    setConfig(next);
    saveSession(sessionKey, next);
  };
  const orderedAvailable = config.order.filter((key) => available.includes(key));
  const hidden = new Set(config.hidden);
  const move = (index: number, direction: -1 | 1) => {
    const nextAvailable = [...orderedAvailable];
    const target = index + direction;
    if (target < 0 || target >= nextAvailable.length) return;
    [nextAvailable[index], nextAvailable[target]] = [nextAvailable[target], nextAvailable[index]];
    apply({ ...config, order: mergeAvailableColumnOrder(config, available, nextAvailable) });
  };

  return <><Button size="small" icon={<i className="ri-settings-3-line" aria-hidden />} onClick={() => setOpen(true)}>列配置</Button><Modal title="矩阵列显示配置" open={open} onCancel={() => setOpen(false)} onOk={() => setOpen(false)}><Space direction="vertical" style={{ width: '100%' }}><Checkbox checked={config.fixed} onChange={e => apply({ ...config, fixed: e.target.checked })}>固定首列</Checkbox>{orderedAvailable.map((k, i) => { const c = columns.find(x => x.key === k); if (!c) return null; return <div key={k} style={{ display: 'flex', gap: 8 }}><Checkbox checked={!hidden.has(k)} onChange={(event) => apply({ ...config, hidden: event.target.checked ? config.hidden.filter((key) => key !== k) : [...config.hidden, k] })}>{c.label}</Checkbox><Button size="small" disabled={i === 0} onClick={() => move(i, -1)}>↑</Button><Button size="small" disabled={i === orderedAvailable.length - 1} onClick={() => move(i, 1)}>↓</Button></div>})}<Button onClick={() => apply({ order: available, hidden: [], fixed: true })}>恢复默认</Button></Space></Modal></>;
}
