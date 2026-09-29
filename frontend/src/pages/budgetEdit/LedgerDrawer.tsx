import { useMemo, useState } from 'react';
import { Space, Button, Input, Drawer, Typography, theme, Modal, Empty, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { EnhancedTable as Table } from '../../components/EnhancedTable';
import { typeTagConfig } from '../../utils/grid';
import { statusColor, useThemeMode } from '../../theme';
import type { MatrixResponse, Row } from './types';

/** 测算底稿附注台账抽屉:集中汇总当前版本所有附注/公式的明细(含汇总格备注),支持检索与定位回网格 */
export function LedgerDrawer(props: {
  open: boolean;
  onClose: () => void;
  data?: MatrixResponse;
  values: Map<string, string>;
  notes: Map<string, string>;
  formulas: Map<string, string>;
  /** 汇总格备注(非叶子组织列/非叶子科目行) */
  summaryNotes: Map<string, string>;
  rowById: Map<number, Row>;
  onLocate: (orgId: number, accountId: number) => void;
  versionId: number;
}) {
  const { token } = theme.useToken();
  const { mode } = useThemeMode();
  const typeChips = typeTagConfig(mode);
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [historyTarget, setHistoryTarget] = useState<{ orgId: number; accountId: number; label: string } | null>(null);
  const historyQuery = useQuery({
    queryKey: ['budget-cell-history', props.versionId, historyTarget?.orgId, historyTarget?.accountId],
    queryFn: () => api.get<{ changes: { checkpointId: number; sequenceNo: number; title: string; createdAt: string; before: { note: string; formula: string }; after: { note: string; formula: string } }[] }>(`/versions/${props.versionId}/cell-history?orgId=${historyTarget!.orgId}&accountId=${historyTarget!.accountId}`),
    enabled: historyTarget != null,
  });

  const noteEntries = useMemo(() => {
    if (!props.data) return [];
    const accById = new Map(props.data.accountNodes.map((n) => [n.id, n]));
    const orgById = new Map(props.data.orgNodes.map((n) => [n.id, n]));
    const list: {
      key: string;
      orgId: number;
      accountId: number;
      orgCode: string;
      orgName: string;
      accCode: string;
      accName: string;
      accType: string;
      unit?: string;
      value: string;
      formula: string;
      note: string;
      /** 汇总格(组织或科目至少一侧非叶子):无单格数值,备注不参与汇总 */
      summary: boolean;
      row: Row | undefined;
    }[] = [];

    const keys = new Set([...props.notes.keys(), ...props.formulas.keys()]);
    for (const key of keys) {
      const [orgId, accountId] = key.split(':').map(Number);
      const note = props.notes.get(key)?.trim() ?? '';
      const formula = props.formulas.get(key)?.trim() ?? '';
      if (!note && !formula) continue;
      const org = orgById.get(orgId);
      const acc = accById.get(accountId);
      if (!org || !acc) continue;
      const r = props.rowById.get(accountId);
      list.push({
        key,
        orgId,
        accountId,
        orgCode: org.code,
        orgName: org.name,
        accCode: acc.code,
        accName: acc.name,
        accType: acc.type ?? 'expense',
        unit: acc.unit,
        value: props.values.get(key) ?? '',
        formula,
        note,
        summary: false,
        row: r,
      });
    }
    for (const [key, raw] of props.summaryNotes) {
      const note = raw.trim();
      if (!note) continue;
      const [orgId, accountId] = key.split(':').map(Number);
      const org = orgById.get(orgId);
      const acc = accById.get(accountId);
      if (!org || !acc) continue;
      list.push({
        key,
        orgId,
        accountId,
        orgCode: org.code,
        orgName: org.name,
        accCode: acc.code,
        accName: acc.name,
        accType: acc.type ?? 'expense',
        unit: acc.unit,
        value: '',
        formula: '',
        note,
        summary: true,
        row: props.rowById.get(accountId),
      });
    }
    return list;
  }, [props.data, props.notes, props.formulas, props.summaryNotes, props.values, props.rowById]);

  const totalNotesCount = noteEntries.length;

  const filteredLedgerEntries = useMemo(() => {
    const kw = ledgerSearch.trim().toLowerCase();
    if (!kw) return noteEntries;
    return noteEntries.filter((item) =>
      item.orgName.toLowerCase().includes(kw) ||
      item.orgCode.toLowerCase().includes(kw) ||
      item.accName.toLowerCase().includes(kw) ||
      item.accCode.toLowerCase().includes(kw) ||
      item.note.toLowerCase().includes(kw) ||
      item.formula.toLowerCase().includes(kw)
    );
  }, [noteEntries, ledgerSearch]);

  return (
    <Drawer
      title={
        <Space>
          <i className="ri-file-text-line" style={{ color: token.colorPrimary }} aria-hidden />
          <span>📑 测算依据与底稿附注台账 ({totalNotesCount} 条记录)</span>
        </Space>
      }
      placement="right"
      width="min(720px, 94vw)"
      open={props.open}
      onClose={props.onClose}
      extra={
        <Input.Search
          placeholder="搜索组织、科目、附注或公式"
          style={{ width: 240 }}
          value={ledgerSearch}
          onChange={(e) => setLedgerSearch(e.target.value)}
          allowClear
        />
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
        集中汇总当前版本所有填报了测算说明（附注）或行内公式的明细科目，方便评审复核、审计追踪与导出核查。
      </Typography.Paragraph>

      <Table
        size="small"
        rowKey="key"
        dataSource={filteredLedgerEntries}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        columns={[
          {
            title: '预算组织',
            dataIndex: 'orgName',
            width: 140,
            render: (name: string, r) => (
              <div>
                <div style={{ fontWeight: 600 }}>{name}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.orgCode}</Typography.Text>
              </div>
            ),
          },
          {
            title: '科目',
            dataIndex: 'accName',
            width: 160,
            render: (name: string, r) => (
              <div>
                <div><span style={{ fontFamily: 'monospace', fontWeight: 600, color: typeChips[r.accType]?.color ?? 'var(--bd-text-tertiary)' }}>{r.accCode}</span> {name}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {r.summary ? <Tag style={{ marginRight: 4 }}>汇总格</Tag> : null}
                  {r.summary ? '备注不参与数值汇总' : `${r.value || '0.00'} ${r.accType === 'quantity' ? (r.unit ?? '') : '万元'}`}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: '公式 / 测算依据附注',
            key: 'memo',
            render: (_, r) => (
              <div>
                {r.formula && (
                  <div style={{ color: token.colorPrimary, fontFamily: 'monospace', marginBottom: r.note ? 4 : 0 }}>
                    <strong>📐 公式:</strong> {r.formula}
                  </div>
                )}
                {r.note && (
                  <div style={{ whiteSpace: 'pre-wrap' }}>
                    <strong>📝 依据:</strong> {r.note}
                  </div>
                )}
                <div style={{ marginTop: 6 }}><Button type="link" size="small" style={{ padding: 0 }} onClick={() => setHistoryTarget({ orgId: r.orgId, accountId: r.accountId, label: `${r.orgCode} ${r.orgName} · ${r.accCode} ${r.accName}` })}>查看历史</Button></div>
              </div>
            ),
          },
          {
            title: '操作',
            key: 'action',
            width: 80,
            render: (_, r) => (
              <Button
                size="small"
                type="link"
                icon={<i className="ri-focus-3-line" aria-hidden />}
                onClick={() => { props.onClose(); props.onLocate(r.orgId, r.accountId); }}
              >
                定位
              </Button>
            ),
          },
        ]}
      />
      <Modal title={historyTarget ? `附注变更历史 · ${historyTarget.label}` : '附注变更历史'} open={historyTarget != null} onCancel={() => setHistoryTarget(null)} footer={null} width={680} destroyOnClose>
        {historyQuery.isLoading ? <Typography.Text type="secondary">正在加载历史…</Typography.Text> : (historyQuery.data?.changes?.length ?? 0) === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无附注变更记录" /> : <Space direction="vertical" style={{ width: '100%' }}>{historyQuery.data!.changes.map((c) => <div key={`${c.checkpointId}-${c.sequenceNo}`} style={{ borderBottom: '1px solid var(--bd-border-subtle)', paddingBottom: 10 }}><Space><Tag color="blue">#{c.sequenceNo}</Tag><strong>{c.title}</strong><Typography.Text type="secondary">{c.createdAt.slice(0, 19).replace('T', ' ')}</Typography.Text></Space><div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}><div style={{ background: `color-mix(in srgb, ${statusColor(useThemeMode().mode).warn} 12%, transparent)`, padding: 5 }}>修改前：{c.before.note || '无附注'}</div><div style={{ background: 'var(--bd-primary-bg)', padding: 5, marginTop: 3 }}>修改后：{c.after.note || '无附注'}</div></div></div>)}</Space>}
      </Modal>
    </Drawer>
  );
}
