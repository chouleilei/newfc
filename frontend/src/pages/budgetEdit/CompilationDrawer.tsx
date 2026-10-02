import { Button, Collapse, Drawer, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EnhancedTable as Table } from '../../components/EnhancedTable';
import { centsToWan, signOfType, formatQuantity } from '../../utils/money';
import { api } from '../../api/client';
import { Markdown } from '../../components/assistant/Markdown';
import type { CompilationStatus, MatrixResponse } from './types';
import type { CompilationCheckpoint, CheckpointValue, CheckpointChangeKind } from './types';
import { statusColor, useThemeMode } from '../../theme';

export function quantityText(value: number | null): string {
  if (value == null) return '—';
  return value === 0 ? '0' : formatQuantity(value);
}

export type NoteChangeKind = 'none' | 'added' | 'changed' | 'cleared';
export function noteChangeKind(before: string, after: string): NoteChangeKind {
  if (before === after) return 'none';
  if (!before && after) return 'added';
  if (before && !after) return 'cleared';
  return 'changed';
}

export function NoteDiff({ before, after }: { before: string; after: string }) {
  const kind = noteChangeKind(before, after);
  if (kind === 'none') return null;
  const label = kind === 'added' ? '新增附注' : kind === 'cleared' ? '清空附注' : '修改附注';
  const [expanded, setExpanded] = useState(false);
  const block = (title: string, value: string, tone: string) => (
    <div style={{ marginTop: 4, padding: '4px 6px', borderRadius: 4, background: tone, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: expanded ? 360 : 58, overflow: 'hidden' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{title}</Typography.Text>
      <div>{value || '无附注'}</div>
    </div>
  );
  return <div style={{ minWidth: 180, maxWidth: 300 }}><Tag color={kind === 'cleared' ? 'red' : kind === 'added' ? 'green' : 'gold'}>{label}</Tag>{block('修改前', before, `color-mix(in srgb, ${statusColor(useThemeMode().mode).warn} 12%, transparent)`)}{block('修改后', after, 'var(--newfc-primary-bg)')}<Button type="link" size="small" style={{ padding: 0 }} onClick={() => setExpanded((v) => !v)}>{expanded ? '收起' : '展开全文'}</Button></div>;
}

export function FormulaDiff({ before, after }: { before: string; after: string }) {
  if (before === after) return null;
  return <div style={{ marginTop: 4, maxWidth: 320, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><Tag color="blue">公式已修改</Tag><div style={{ padding: '3px 6px', background: `color-mix(in srgb, ${statusColor(useThemeMode().mode).warn} 12%, transparent)`, borderRadius: 4, fontSize: 12 }}>修改前：{before || '无公式'}</div><div style={{ padding: '3px 6px', background: 'var(--newfc-primary-bg)', borderRadius: 4, fontSize: 12 }}>修改后：{after || '无公式'}</div></div>;
}

/** 变化分类标志:消费后端 kind 判别(AI 功能增强计划 §四.阶段六.1);旧数据无 kind 时按 before/after 兜底推导。 */
export function checkpointChangeFlags(change: { kind?: CheckpointChangeKind; before: CheckpointValue; after: CheckpointValue }) {
  if (change.kind) {
    const amountChanged = change.kind === 'amount' || change.kind === 'quantity' || change.kind === 'mixed';
    const noteChanged = change.kind === 'note' || change.kind === 'mixed';
    const formulaChanged = change.kind === 'formula' || change.kind === 'mixed';
    return { amountChanged, noteChanged, formulaChanged, valueOnly: change.kind === 'amount' || change.kind === 'quantity', mixed: change.kind === 'mixed' };
  }
  const amountChanged = change.before.amountCents !== change.after.amountCents || change.before.quantity !== change.after.quantity;
  const noteChanged = change.before.note !== change.after.note;
  const formulaChanged = change.before.formula !== change.after.formula;
  return { amountChanged, noteChanged, formulaChanged, valueOnly: amountChanged && !noteChanged && !formulaChanged, mixed: amountChanged && (noteChanged || formulaChanged) };
}

export function filterCheckpointChanges<T extends { before: CheckpointValue; after: CheckpointValue }>(changes: T[], filter: 'all' | 'value' | 'note' | 'formula' | 'mixed'): T[] {
  return changes.filter((change) => {
    const flags = checkpointChangeFlags(change);
    return filter === 'all' || (filter === 'value' && flags.valueOnly) || (filter === 'note' && flags.noteChanged) || (filter === 'formula' && flags.formulaChanged) || (filter === 'mixed' && flags.mixed);
  });
}

function CheckpointChangesTable({ item, orgById, accountById, leafOrgIds, leafAccountIds, valueText }: { item: CompilationCheckpoint; orgById: Map<number, any>; accountById: Map<number, any>; leafOrgIds: Set<number>; leafAccountIds: Set<number>; valueText: (accountId: number, value: CheckpointValue) => string }) {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  /* 汇总格备注变化(组织或科目至少一侧非叶子)没有数值维度,前后值列显示占位 */
  const isSummaryCell = (r: { orgId: number; accountId: number }) => !leafOrgIds.has(r.orgId) || !leafAccountIds.has(r.accountId);
  const stats = useMemo(() => item.changes.reduce((a, r) => {
    const { amountChanged: amount, noteChanged: note, formulaChanged: formula } = checkpointChangeFlags(r);
    a.all++; if (amount && !note && !formula) a.value++; if (note) a.note++; if (formula) a.formula++; if (amount && (note || formula)) a.mixed++;
    return a;
  }, { all: 0, value: 0, note: 0, formula: 0, mixed: 0 }), [item.changes]);
  const rows = useMemo(() => filterCheckpointChanges(item.changes, filter as 'all' | 'value' | 'note' | 'formula' | 'mixed'), [filter, item.changes]);
  const chips = [['all','全部',stats.all],['value','仅数值变动',stats.value],['note','含附注变动',stats.note],['formula','含公式变动',stats.formula],['mixed','数值与依据同时变动',stats.mixed]] as const;
  return <>
    <Tooltip title="分类可以重叠，数量不要求相加等于总数"><Space wrap style={{ marginBottom: 8 }}>{chips.map(([key, label, count]) => <Button key={key} size="small" type={filter === key ? 'primary' : 'default'} onClick={() => { setFilter(key); setPage(1); }}>{label}（{count}）</Button>)}</Space></Tooltip>
    {rows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下没有变化" /> : <Table size="small" rowKey={(r) => `${r.orgId}:${r.accountId}`} pagination={{ current: page, pageSize: 20, hideOnSinglePage: true, onChange: setPage }} dataSource={rows} columns={[{ title: '组织', width: 170, render: (_: unknown, r: any) => { const org = orgById.get(r.orgId); return <span>{org?.code ?? r.orgId} {org?.name ?? ''}</span>; } }, { title: '科目', width: 210, render: (_: unknown, r: any) => { const acc = accountById.get(r.accountId); return <span>{acc?.code ?? r.accountId} {acc?.name ?? ''}{isSummaryCell(r) && <Tag style={{ marginLeft: 4 }}>汇总格</Tag>}</span>; } }, { title: '修改前', width: 130, render: (_: unknown, r: any) => isSummaryCell(r) ? '—' : valueText(r.accountId, r.before) }, { title: '修改后', width: 130, render: (_: unknown, r: any) => isSummaryCell(r) ? '—' : valueText(r.accountId, r.after) }, { title: '底稿与附注变化', render: (_: unknown, r: any) => <Space direction="vertical" size={4}><FormulaDiff before={r.before.formula} after={r.after.formula} /><NoteDiff before={r.before.note} after={r.after.note} />{r.before.formula === r.after.formula && r.before.note === r.after.note && '—'}</Space> }]} />}
  </>;
}

interface CheckpointSummaryResponse {
  checkpointId: number;
  status: 'none' | 'pending' | 'running' | 'done' | 'failed';
  summary: string;
  source: '' | 'template' | 'model';
  generatedAt: string;
  guardOk: boolean | null;
}

/** 本轮修改小结(AI 功能增强计划 §四.阶段六):异步生成,前端轮询任务状态;小结缺失时仅展示变化清单。 */
function CheckpointSummaryBlock({ item }: { item: CompilationCheckpoint }) {
  const query = useQuery({
    queryKey: ['checkpoint-summary', item.id],
    queryFn: () => api.get<CheckpointSummaryResponse>(`/versions/${item.versionId}/checkpoints/${item.id}/summary`),
    // 生成中每 2s 轮询,终态停止
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 2000 : false;
    },
    retry: false,
  });
  const data = query.data;
  if (!data) return null;
  if (data.status === 'pending' || data.status === 'running') {
    return <div style={{ marginBottom: 10 }}><Tag color="processing">小结生成中…</Tag></div>;
  }
  if (!data.summary) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <Tag color={data.source === 'model' ? 'purple' : 'default'}>
        {data.source === 'model' ? 'AI 改写小结' : '确定性小结'}
      </Tag>
      {data.guardOk === false && <Tag color="orange">数字守卫未通过,已回退模板稿</Tag>}
      <div style={{ border: '1px solid var(--newfc-border)', borderRadius: 6, padding: '4px 10px', background: 'var(--newfc-bg-fill)', maxHeight: 240, overflow: 'auto' }}>
        <Markdown text={data.summary} />
      </div>
    </div>
  );
}

/** 编制记录抽屉:按记录点展示相对上次记录的单元格变化。 */
export function CompilationDrawer(props: {
  open: boolean;
  onClose: () => void;
  data: MatrixResponse;
  compilation?: CompilationStatus;
  loading: boolean;
  focusCell?: { orgId: number; accountId: number } | null;
}) {
  const orgById = new Map(props.data.orgNodes.map((n) => [n.id, n]));
  const accountById = new Map(props.data.accountNodes.map((n) => [n.id, n]));
  /* 叶子集合按版本绑定快照的 parent 结构推导,与后端 computeLeafIds 同口径 */
  const leafOf = (nodes: { id: number; parent_id: number | null }[]) => {
    const parents = new Set(nodes.map((n) => n.parent_id).filter((p): p is number => p != null));
    return new Set(nodes.filter((n) => !parents.has(n.id)).map((n) => n.id));
  };
  const leafOrgIds = leafOf(props.data.orgNodes);
  const leafAccountIds = leafOf(props.data.accountNodes);
  const valueText = (accountId: number, value: { amountCents: number; quantity: number | null }) => {
    const acc = accountById.get(accountId);
    if (acc?.type === 'quantity') return `${quantityText(value.quantity)} ${acc.unit ?? ''}`.trim();
    return `${centsToWan(value.amountCents * signOfType(acc?.type ?? 'expense'))} 万元`;
  };

  return (
    <Drawer
      title={<Space><i className="ri-history-line" aria-hidden /><span>编制记录</span></Space>}
      width="min(820px, 94vw)"
      open={props.open}
      onClose={props.onClose}
      loading={props.loading}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        草稿会自动保存；这里只记录主动点击“记录本轮修改”以及定稿前自动形成的不可变记录点。
      </Typography.Paragraph>
      {(props.compilation?.items.length ?? 0) === 0 ? (
        <Typography.Text type="secondary">尚无编制记录。</Typography.Text>
      ) : (
        <Collapse
          items={(props.compilation?.items ?? []).map((item) => ({
            key: item.id,
            label: (
              <Space wrap>
                <strong>#{item.sequenceNo} {item.title}</strong>
                <Tag color="blue">{item.changeCount} 处修改</Tag>
                {item.autoCreated && <Tag>定稿自动记录</Tag>}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {item.createdAt.slice(0, 19).replace('T', ' ')}
                </Typography.Text>
              </Space>
            ),
            children: (
              <>
                <CheckpointSummaryBlock item={item} />
                <CheckpointChangesTable item={{ ...item, changes: props.focusCell ? item.changes.filter(r => r.orgId === props.focusCell?.orgId && r.accountId === props.focusCell?.accountId) : item.changes }} orgById={orgById} accountById={accountById} leafOrgIds={leafOrgIds} leafAccountIds={leafAccountIds} valueText={valueText} />
              </>
            ),
          }))}
        />
      )}
    </Drawer>
  );
}
