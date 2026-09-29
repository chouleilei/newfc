import { Alert, Button, Checkbox, Drawer, Space, Tag, Tooltip, Typography, Upload } from 'antd';
import { useMemo } from 'react';
import { EnhancedTable as Table } from '../../components/EnhancedTable';
import type { MatrixResponse } from './types';
import {
  CONFLICT_CATEGORY_LABEL,
  displayOfExact,
  exactTextOf,
  type CellDiff,
  type ExactCell,
} from './conflictRecovery';

/**
 * 并发冲突恢复抽屉(UX-20/UX-21):
 * 三方差异清单(编辑基线 / 本地未提交 / 服务器最新),默认保留服务器值,
 * 用户逐项勾选要恢复的本地修改;导出/导入本地待保存修改 JSON。
 */
export function ConflictRecoveryDrawer(props: {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  diffs: CellDiff[];
  convergedCount: number;
  baselineRevision: number | null;
  serverRevision: number | null;
  server: MatrixResponse | null;
  selectedKeys: ReadonlySet<string>;
  onSelectedKeysChange: (next: Set<string>) => void;
  onExportLocal: () => void;
  onImportFile: (file: File) => void;
  importError: string | null;
  applying: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const { diffs, selectedKeys } = props;

  const orgById = useMemo(() => new Map((props.server?.orgNodes ?? []).map((n) => [n.id, n])), [props.server]);
  const accountById = useMemo(() => new Map((props.server?.accountNodes ?? []).map((n) => [n.id, n])), [props.server]);

  const selectableKeys = useMemo(() => diffs.filter((d) => d.category !== 'server_only').map((d) => d.key), [diffs]);
  const localOnlyKeys = useMemo(() => diffs.filter((d) => d.category === 'local_only').map((d) => d.key), [diffs]);
  const counts = useMemo(() => {
    const c = { local_only: 0, server_only: 0, both: 0 };
    for (const d of diffs) c[d.category]++;
    return c;
  }, [diffs]);

  const toggle = (key: string, checked: boolean) => {
    const next = new Set(selectedKeys);
    if (checked) next.add(key); else next.delete(key);
    props.onSelectedKeysChange(next);
  };

  /** 一侧的值展示:万元(或数量)为主,精确值(到分/原数量)可核对;空侧显示占位 */
  const sideText = (d: CellDiff, cell: ExactCell | null, deleted: boolean) => {
    if (d.kind === 'summary_note') {
      return cell?.note
        ? <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{cell.note}</span>
        : <Typography.Text type="secondary">{deleted ? '（清空）' : '—'}</Typography.Text>;
    }
    if (!cell) return <Typography.Text type="secondary">{deleted ? '（清空）' : '—'}</Typography.Text>;
    const display = displayOfExact(cell, d.accountType);
    const exact = exactTextOf(cell, d.accountType);
    const parts: string[] = [];
    if (display !== '') parts.push(d.accountType === 'quantity' ? display : `${display} 万元`);
    if (cell.formula) parts.push(`公式 ${cell.formula}`);
    if (cell.note) parts.push(`附注 ${cell.note.length > 24 ? `${cell.note.slice(0, 24)}…` : cell.note}`);
    return (
      <Tooltip title={exact && exact !== display ? `精确值：${exact}` : undefined}>
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {parts.length > 0 ? parts.map((p, i) => <div key={i}>{p}</div>) : <Typography.Text type="secondary">—</Typography.Text>}
          {exact && exact !== display && d.accountType !== 'quantity' && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>精确 {exact}</Typography.Text>
          )}
        </div>
      </Tooltip>
    );
  };

  return (
    <Drawer
      title="并发冲突：核对三方差异"
      width="min(920px, 94vw)"
      open={props.open}
      onClose={props.onClose}
      footer={(
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            默认保留服务器值；勾选后只恢复选定的本地修改。关闭本抽屉不产生任何写入。
          </Typography.Text>
          <Space>
            <Button onClick={props.onClose}>取消</Button>
            <Button type="primary" loading={props.applying} disabled={diffs.length === 0 || props.loading || props.error != null} onClick={props.onApply}>
              应用选定恢复项（{selectedKeys.size}）并保存
            </Button>
          </Space>
        </Space>
      )}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="自动保存已暂停"
        description={(
          <span>
            其他页面已更新该草稿（基线修订 {props.baselineRevision ?? '—'} → 服务器修订 {props.serverRevision ?? '—'}）。
            网格中的本地输入仍保留，核对完成前不会写入服务器。
          </span>
        )}
      />
      {props.error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="服务器最新数据加载失败"
          description={props.error}
          action={<Button size="small" onClick={props.onRetry}>重试</Button>}
        />
      )}
      {props.importError && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="恢复文件未采用" description={props.importError} />
      )}

      <Space wrap style={{ marginBottom: 12 }}>
        <Tag color="orange">双方都修改 {counts.both}</Tag>
        <Tag color="blue">仅本地修改 {counts.local_only}</Tag>
        <Tag color="default">仅服务器修改 {counts.server_only}</Tag>
        {props.convergedCount > 0 && <Tag>双方修改一致 {props.convergedCount}（无需处理）</Tag>}
      </Space>

      <Space wrap style={{ marginBottom: 12 }}>
        <Button size="small" disabled={localOnlyKeys.length === 0} onClick={() => props.onSelectedKeysChange(new Set([...selectedKeys, ...localOnlyKeys]))}>
          全选仅本地修改（{localOnlyKeys.length}）
        </Button>
        <Button size="small" disabled={selectedKeys.size === 0} onClick={() => props.onSelectedKeysChange(new Set())}>
          全部保留服务器值
        </Button>
        <Button size="small" onClick={props.onExportLocal}>导出本地待保存修改（JSON）</Button>
        <Upload
          accept=".json,application/json"
          showUploadList={false}
          beforeUpload={(file) => { props.onImportFile(file); return false; }}
        >
          <Button size="small">导入恢复文件…</Button>
        </Upload>
        <Button size="small" danger onClick={props.onDiscard}>放弃本地内容并刷新</Button>
      </Space>

      <Table
        size="small"
        rowKey={(d: CellDiff) => `${d.kind}:${d.key}`}
        loading={props.loading}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        dataSource={diffs}
        locale={{ emptyText: '三方内容一致，没有需要处理的差异' }}
        columns={[
          {
            title: '恢复本地值',
            width: 88,
            render: (_: unknown, d: CellDiff) => (
              d.category === 'server_only'
                ? <Tooltip title="本地未修改该格，无需恢复"><Checkbox disabled checked={false} /></Tooltip>
                : (
                  <Checkbox
                    checked={selectedKeys.has(d.key)}
                    onChange={(e) => toggle(d.key, e.target.checked)}
                  />
                )
            ),
          },
          {
            title: '分类',
            width: 108,
            render: (_: unknown, d: CellDiff) => (
              <Tag color={d.category === 'both' ? 'orange' : d.category === 'local_only' ? 'blue' : 'default'}>
                {CONFLICT_CATEGORY_LABEL[d.category]}
              </Tag>
            ),
          },
          {
            title: '组织',
            width: 140,
            render: (_: unknown, d: CellDiff) => {
              const org = orgById.get(d.orgId);
              return <span>{org ? `${org.code} ${org.name}` : `#${d.orgId}`}</span>;
            },
          },
          {
            title: '科目',
            width: 170,
            render: (_: unknown, d: CellDiff) => {
              const acc = accountById.get(d.accountId);
              return (
                <span>
                  {acc ? `${acc.code} ${acc.name}` : `#${d.accountId}`}
                  {d.kind === 'summary_note' && <Tag style={{ marginLeft: 4 }}>汇总格备注</Tag>}
                  {d.localInvalid && <Tag color="red" style={{ marginLeft: 4 }}>本地格式非法</Tag>}
                </span>
              );
            },
          },
          {
            title: '方面',
            width: 110,
            render: (_: unknown, d: CellDiff) => d.aspects.join('、'),
          },
          { title: '编辑开始时（基线）', render: (_: unknown, d: CellDiff) => sideText(d, d.baseline, false) },
          {
            title: '本地未保存',
            render: (_: unknown, d: CellDiff) => (
              <span style={d.localInvalid ? { color: 'var(--bd-danger, #cf1322)' } : undefined}>
                {sideText(d, d.local, d.localDelete)}
              </span>
            ),
          },
          { title: '服务器最新', render: (_: unknown, d: CellDiff) => sideText(d, d.server, false) },
        ]}
      />
    </Drawer>
  );
}
