import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, App as AntdApp, Button, Card, Descriptions, Result, Segmented, Space, Table, Tag, Typography, Upload } from 'antd';
import { can, errorText } from '../../api/client';
import { contractApi, type ContractImportAction, type ContractImportDto, type ContractImportRowDto } from '../../api/projectContract';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { Money } from '../financeData/shared';
import { RowErrors } from './shared';

/**
 * AC-F04 合同导入:上传即生成预览(全量校验、逐行计划与计划哈希,不写合同);
 * 确认时服务端按同一文件重算,计划哈希一致才在一个事务里写入,失败整体回滚;重复确认返回原结果。
 */

const ACTION = { create: { text: '新增', color: 'green' }, update: { text: '更新', color: 'blue' }, unchanged: { text: '无变化', color: 'default' } } as const;
const FIELD_LABEL: Record<string, string> = {
  name: '名称', supplier: '供应商', paid: '已付', signDate: '签订日期', contractType: '合同类型', paymentCapRatio: '付款上限比例',
};

export default function ContractImport() {
  useAssistantDomainPage({ pageKey: 'contract_import', ready: true, view: {} });
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const importId = params.get('id') ? Number(params.get('id')) : null;
  const [filter, setFilter] = useState<'all' | ContractImportAction>('all');
  const q = useQuery({ queryKey: ['contract-import', importId], queryFn: () => contractApi.getImport(importId!), enabled: importId != null });
  const show = (d: ContractImportDto) => { qc.setQueryData(['contract-import', d.id], d); setParams({ id: String(d.id) }); };
  const previewM = useMutation({ mutationFn: (f: File) => contractApi.previewImport(f), onSuccess: show, onError: (e) => message.error(errorText(e)) });
  const confirmM = useMutation({
    mutationFn: (d: ContractImportDto) => contractApi.confirmImport(d.id, d.planHash),
    onSuccess: (d) => {
      show(d);
      message.success(d.replayed ? '该导入已确认过,返回原结果' : '导入已确认');
      void qc.invalidateQueries({ queryKey: ['contracts'] }); void qc.invalidateQueries({ queryKey: ['contract-summary'] });
    },
    onError: (e) => message.error(errorText(e)),
  });
  const d = q.data;
  if (!can('contract:import')) return <Result status="403" title="没有合同导入权限" />;
  const rows = (d?.rows ?? []).filter((r) => filter === 'all' || r.action === filter);
  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Upload.Dragger accept=".csv,.xlsx" showUploadList={false} disabled={previewM.isPending} beforeUpload={(f) => { previewM.mutate(f); return false; }}>
            <p>{previewM.isPending ? '正在校验…' : '点击或拖入合同台账 .csv / .xlsx 生成预览'}</p>
            <p style={{ color: 'var(--newfc-text-secondary)', fontSize: 12 }}>按合同编号匹配:不存在则新增;已存在则只更新有变化的字段。预览不写合同,确认前可放弃。</p>
          </Upload.Dragger>
        </Space>
      </Card>
      {importId != null && q.error && <QueryErrorResult title="导入记录加载失败" error={q.error} refetch={q.refetch} />}
      {d && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Descriptions size="small" bordered column={3}>
            <Descriptions.Item label="文件">{d.fileName}</Descriptions.Item>
            <Descriptions.Item label="状态">{d.status === 'confirmed' ? <Tag color="success">已确认 {d.confirmedAt ? shortTime(d.confirmedAt) : ''}</Tag> : <Tag color="warning">待确认</Tag>}</Descriptions.Item>
            <Descriptions.Item label="预览时间">{shortTime(d.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="行数">{d.rowCount}</Descriptions.Item>
            <Descriptions.Item label="计划">新增 {d.counts.create} · 更新 {d.counts.update} · 无变化 {d.counts.unchanged}</Descriptions.Item>
            <Descriptions.Item label="计划哈希"><Typography.Text code>{d.planHash.slice(0, 16)}…</Typography.Text></Descriptions.Item>
          </Descriptions>
          {d.errorCount > 0 && <RowErrors errors={d.errors} title="校验未通过,不能确认;修正文件后重新上传" />}
          {d.result && (
            <Alert type="success" showIcon message={`已写入:新增 ${d.result.created}、更新 ${d.result.updated}、无变化 ${d.result.unchanged}`}
              action={<Button size="small" onClick={() => navigate('/contracts')}>查看合同台账</Button>} />
          )}
          {d.status === 'previewed' && d.errorCount === 0 && (
            <Space>
              <Button type="primary" loading={confirmM.isPending} onClick={() => modal.confirm({
                title: '确认导入?', content: `将新增 ${d.counts.create} 份、更新 ${d.counts.update} 份合同。服务端会按原文件重算计划,不一致时拒绝(PREVIEW_STALE)。`,
                onOk: () => confirmM.mutateAsync(d),
              })}>确认导入</Button>
              <Button onClick={() => setParams({})}>放弃</Button>
            </Space>
          )}
          <Segmented value={filter} onChange={(v) => setFilter(v as typeof filter)}
            options={[{ value: 'all', label: '全部' }, ...(['create', 'update', 'unchanged'] as const).map((a) => ({ value: a, label: `${ACTION[a].text} ${d.counts[a]}` }))]} />
          <Table<ContractImportRowDto> rowKey="row" size="small" dataSource={rows} pagination={{ pageSize: 50 }} scroll={{ x: 1100 }}
            columns={[
              { title: '行', dataIndex: 'row', width: 60 },
              { title: '动作', dataIndex: 'action', width: 80, render: (a: ContractImportAction | null) => (a ? <Tag color={ACTION[a].color}>{ACTION[a].text}</Tag> : <Tag color="error">错误</Tag>) },
              { title: '合同编号', dataIndex: 'contractNo', width: 140 },
              { title: '名称', dataIndex: 'name', ellipsis: true },
              { title: '组织', dataIndex: 'orgName', width: 120, render: (v: string | null) => v ?? '—' },
              { title: '金额', dataIndex: 'amount', width: 130, align: 'right', render: (v: string | null) => (v == null ? '—' : <Money value={v} />) },
              { title: '已付', dataIndex: 'paid', width: 120, align: 'right', render: (v: string | null) => (v == null ? '—' : <Money value={v} />) },
              {
                title: '变化', key: 'changes', render: (_, r) => (
                  <Space size={[4, 2]} wrap>
                    {Object.entries(r.changes).map(([k, [from, to]]) => <Tag key={k}>{FIELD_LABEL[k] ?? k}:{from ?? '空'} → {to ?? '空'}</Tag>)}
                  </Space>
                ),
              },
            ]} />
        </Space>
      )}
    </div>
  );
}
