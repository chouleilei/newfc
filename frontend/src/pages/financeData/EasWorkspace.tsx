import { useBatchDeepLink } from '../../hooks/useBatchDeepLink';
import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Card, Descriptions, Drawer, Empty, Form, Input, Popconfirm, Select, Space, Table, Tabs, Tag, Typography, Upload,
} from 'antd';
import { can, download, errorText } from '../../api/client';
import { easApi, type EasBatchDto, type EasCorrectionDto, type EasDataType, type EasReconSetDto } from '../../api/financeData';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { defaultOrgId, EXCEPTION_REASON_FIELD, lastPeriod, Money, OrgSelect, PeriodPicker, RULE_STATUS, statusTag, usePrompt, compact } from './shared';

/** AC-F05 EAS 工作区:导入 → 预检 → 激活 → 锁期 → 锁后更正。所有写操作在页面显式确认。 */

const DATA_TYPE_LABEL: Record<EasDataType, string> = { voucher: '凭证序时簿', balance: '科目余额表', auxiliary: '辅助核算余额' };
const RULE_LABEL: Record<string, string> = {
  required_files: '三类文件齐全', voucher_balance_movement: '凭证发生额 = 余额表本期', period_continuity: '上期期末 = 本期期初', auxiliary_requirements: '辅助核算与余额一致',
};

/** 规则明细:说明文字 + 差异行(accounts/requirements)或缺失文件。 */
function detailItems(d: Record<string, unknown>): unknown[] {
  for (const k of ['accounts', 'requirements', 'missingDataTypes']) if (Array.isArray(d?.[k]) && (d[k] as unknown[]).length) return d[k] as unknown[];
  return [];
}
const SET_STATUS = { passed: { text: '通过', color: 'success' }, failed: { text: '未通过', color: 'error' }, incomplete: { text: '不完整', color: 'default' } };
const BATCH_STATUS = { candidate: { text: '候选', color: 'processing' }, active: { text: '生效', color: 'success' }, superseded: { text: '已替换', color: 'default' } };
const CORRECTION_STATUS = {
  submitted: { text: '已提交', color: 'processing' }, candidate_import: { text: '待导入候选', color: 'processing' }, pending_review: { text: '待复核', color: 'warning' },
  approved: { text: '已批准', color: 'success' }, returned: { text: '已退回', color: 'default' },
};

function ResultsTable({ set }: { set: EasReconSetDto }) {
  return (
    <Table
      size="small" rowKey="ruleCode" pagination={false} dataSource={set.results}
      columns={[
        { title: '规则', dataIndex: 'ruleCode', render: (v: string) => RULE_LABEL[v] ?? v },
        { title: '结果', dataIndex: 'status', width: 90, render: (v: string) => statusTag(RULE_STATUS, v) },
        { title: '差异条数', dataIndex: 'diffCount', width: 90, align: 'right' },
        { title: '差异金额', dataIndex: 'diffAmount', width: 150, align: 'right', render: (v: string) => <Money value={v} /> },
        { title: '说明', dataIndex: 'details', render: (d: Record<string, unknown>) => <Typography.Text type="secondary">{String(d?.message ?? '')}</Typography.Text> },
      ]}
      expandable={{
        rowExpandable: (r) => detailItems(r.details).length > 0,
        expandedRowRender: (r) => <pre style={{ margin: 0, maxHeight: 240, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(detailItems(r.details), null, 2)}</pre>,
      }}
    />
  );
}

function BatchLinesDrawer({ batch, onClose }: { batch: EasBatchDto | null; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['eas-lines', batch?.id, page], queryFn: () => easApi.batchLines(batch!.id, page, 50), enabled: !!batch });
  const lines = (q.data?.lines ?? []) as unknown as Record<string, unknown>[];
  const keys = lines.length ? Object.keys(lines[0]) : [];
  const moneyKeys = new Set(['debit', 'credit', 'beginDebit', 'beginCredit', 'endDebit', 'endCredit', 'begin', 'end']);
  return (
    <Drawer open={!!batch} onClose={onClose} width={1100} title={batch ? `${DATA_TYPE_LABEL[batch.dataType]} · ${batch.fileName}` : ''} destroyOnClose>
      {q.error ? <QueryErrorResult title="明细加载失败" error={q.error} refetch={q.refetch} /> : (
        <Table
          size="small" rowKey="sourceRow" loading={q.isLoading} dataSource={lines} scroll={{ x: 'max-content' }}
          pagination={{ current: page, pageSize: 50, total: q.data?.total ?? 0, onChange: setPage, showSizeChanger: false }}
          columns={keys.map((k) => ({
            title: k, dataIndex: k, align: moneyKeys.has(k) ? 'right' as const : undefined,
            render: (v: unknown) => (moneyKeys.has(k) ? <Money value={v as string} /> : v == null ? <Typography.Text type="secondary">空</Typography.Text> : String(v)),
          }))}
        />
      )}
    </Drawer>
  );
}

function PeriodTab() {
  const [params] = useSearchParams();
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [orgId, setOrgId] = useState<number | undefined>(Number(params.get('orgId')) || defaultOrgId());
  const [period, setPeriod] = useState<string | undefined>(params.get('period') ?? lastPeriod());
  const [dataType, setDataType] = useState<EasDataType>('voucher');
  const [viewBatch, setViewBatch] = useState<EasBatchDto | null>(null);
  const linkedBatch = useBatchDeepLink('eas', easApi.batch, (batch) => { setViewBatch(batch); setOrgId(batch.orgId); setPeriod(batch.period); });
  const [prompt, promptHolder] = usePrompt();
  const ready = !!orgId && !!period;
  const status = useQuery({ queryKey: ['eas-status', orgId, period], queryFn: () => easApi.periodStatus(orgId!, period!), enabled: ready });
  useAssistantDomainPage({ pageKey: 'eas', ready: ready && !status.isLoading && !status.error, scope: { orgScopeId: viewBatch?.orgId ?? orgId, period: viewBatch?.period ?? period, easBatchId: viewBatch?.id } });
  const sets = useQuery({ queryKey: ['eas-sets', orgId, period], queryFn: () => easApi.sets({ orgId, period }), enabled: ready });
  const batches = useQuery({ queryKey: ['eas-batches', orgId, period], queryFn: () => easApi.batches({ orgId, period }), enabled: ready });
  const refresh = () => { for (const k of ['eas-status', 'eas-sets', 'eas-batches', 'eas-locks', 'eas-corrections']) void qc.invalidateQueries({ queryKey: [k] }); };
  const onError = (e: unknown) => message.error(errorText(e));

  const upload = useMutation({
    mutationFn: (file: File) => easApi.importFile(file, { dataType, orgId, correctionId: status.data?.pendingCorrection?.status === 'candidate_import' ? status.data.pendingCorrection.id : undefined }),
    onSuccess: (b) => { message.success(b.replayed ? '同一文件已导入过,返回原批次' : `已导入 ${b.rowCount} 行`); refresh(); },
    onError,
  });
  const precheck = useMutation({ mutationFn: () => easApi.precheck(orgId!, period!), onSuccess: (s) => { message.success(`预检完成:${SET_STATUS[s.status].text}`); refresh(); }, onError });
  const activate = useMutation({
    mutationFn: (s: EasReconSetDto) => easApi.activate(s.id, s.version, status.data?.currentSet?.id ?? null),
    onSuccess: () => { message.success('已激活为当前集合'); refresh(); }, onError,
  });
  const lock = useMutation({ mutationFn: (body: { setId: number; reason: string }) => easApi.lock({ orgId: orgId!, period: period!, ...body }), onSuccess: () => { message.success('期间已锁定'); refresh(); }, onError });
  const unlock = useMutation({ mutationFn: (v: { id: number; version: number; reason: string }) => easApi.unlock(v.id, v.version, v.reason), onSuccess: () => { message.success('已解锁'); refresh(); }, onError });
  const correction = useMutation({
    mutationFn: (v: { setId: number; reason: string }) => easApi.createCorrection({ orgId: orgId!, period: period!, expectedCurrentSetId: v.setId, reason: v.reason }),
    onSuccess: () => { message.success('已提交更正申请,请在本期间导入候选文件并预检'); refresh(); }, onError,
  });
  const precheckCorrection = useMutation({ mutationFn: (id: number) => easApi.precheckCorrection(id), onSuccess: () => { message.success('更正候选预检完成'); refresh(); }, onError });

  const st = status.data;
  const current = st?.currentSet ?? null;
  const locked = st?.lock?.status === 'locked';
  const pending = st?.pendingCorrection ?? null;
  const importBlocked = locked && pending?.status !== 'candidate_import';

  return (
    <>
      {linkedBatch.error && <QueryErrorResult title="来源批次加载失败" error={linkedBatch.error} refetch={linkedBatch.refetch} />}
      {promptHolder}
      <Space wrap style={{ marginBottom: 12 }}>
        <OrgSelect value={orgId} onChange={setOrgId} allowClear={false} />
        <PeriodPicker value={period} onChange={setPeriod} allowClear={false} />
        {can('eas:import') && (
          <>
            <Select<EasDataType> value={dataType} onChange={setDataType} style={{ width: 150 }} options={Object.entries(DATA_TYPE_LABEL).map(([value, label]) => ({ value: value as EasDataType, label }))} />
            <Upload showUploadList={false} accept=".csv,.xlsx" disabled={!ready || importBlocked} beforeUpload={(f) => { upload.mutate(f); return false; }}>
              <Button loading={upload.isPending} disabled={!ready || importBlocked} icon={<i className="ri-upload-cloud-2-line" aria-hidden />}>导入 EAS 文件</Button>
            </Upload>
            <Button onClick={() => precheck.mutate()} loading={precheck.isPending} disabled={!ready || locked}>运行预检</Button>
          </>
        )}
      </Space>
      {!ready ? <Empty description="请选择组织与期间" /> : status.error ? <QueryErrorResult title="期间状态加载失败" error={status.error} refetch={status.refetch} /> : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {importBlocked && <Alert type="info" showIcon message="本期间已锁定:直接导入会被拒绝。如需更正,请发起更正申请,在申请下导入候选文件并预检,复核通过后原子切换。" />}
          <Card size="small" title="当前集合" extra={current && (
            <Space>
              {!locked && can('eas:period_lock') && current.status === 'passed' && (
                <Button size="small" onClick={async () => { const v = await prompt({ title: '锁定期间', fields: [{ name: 'reason', label: '锁定原因', required: true, multiline: true }] }); if (v) lock.mutate({ setId: current.id, reason: v.reason }); }}>锁定期间</Button>
              )}
              {locked && can('eas:period_lock') && st?.lock && (
                <Button size="small" danger onClick={async () => { const v = await prompt({ title: '解锁期间', description: '仅管理员可解锁;有待处理更正时不能解锁。', danger: true, fields: [{ name: 'reason', label: '解锁原因', required: true, multiline: true }] }); if (v) unlock.mutate({ id: st.lock!.id, version: st.lock!.version, reason: v.reason }); }}>解锁</Button>
              )}
              {locked && !pending && can('eas:correction_submit') && (
                <Button size="small" onClick={async () => { const v = await prompt({ title: '发起锁后更正', fields: [{ name: 'reason', label: '更正原因', required: true, multiline: true }] }); if (v) correction.mutate({ setId: current.id, reason: v.reason }); }}>发起更正</Button>
              )}
            </Space>
          )}>
            {current ? (
              <>
                <Descriptions size="small" column={4} style={{ marginBottom: 8 }}>
                  <Descriptions.Item label="集合">#{current.id} v{current.version}</Descriptions.Item>
                  <Descriptions.Item label="状态">{statusTag(SET_STATUS, current.status)}</Descriptions.Item>
                  <Descriptions.Item label="激活时间">{current.activatedAt ? shortTime(current.activatedAt) : '—'}</Descriptions.Item>
                  <Descriptions.Item label="期间锁">{locked ? <Tag color="warning">已锁定</Tag> : <Tag>未锁定</Tag>}</Descriptions.Item>
                </Descriptions>
                <ResultsTable set={current} />
              </>
            ) : <Empty description="本期间还没有生效集合:导入三类文件并预检通过后激活" />}
          </Card>
          {pending && (
            <Card size="small" title={<>待处理更正 #{pending.id} {statusTag(CORRECTION_STATUS, pending.status)}</>} extra={pending.status === 'candidate_import' && can('eas:correction_submit') && (
              <Button size="small" onClick={() => precheckCorrection.mutate(pending.id)} loading={precheckCorrection.isPending}>预检候选</Button>
            )}>
              <Typography.Text>{pending.reason}</Typography.Text>
              <div style={{ marginTop: 8 }}>候选批次:{pending.candidateBatches.map((b) => <Tag key={b.id}>{DATA_TYPE_LABEL[b.dataType]} #{b.id}</Tag>)}</div>
            </Card>
          )}
          <Card size="small" title="预检集合">
            <Table<EasReconSetDto>
              size="small" rowKey="id" loading={sets.isLoading} dataSource={sets.data ?? []} pagination={false}
              expandable={{ expandedRowRender: (s) => <ResultsTable set={s} /> }}
              columns={[
                { title: '集合', dataIndex: 'id', width: 80, render: (v: number, s) => <>#{v}{s.isCurrent && <Tag color="success" style={{ marginLeft: 6 }}>当前</Tag>}</> },
                { title: '结果', dataIndex: 'status', width: 90, render: (v: string) => statusTag(SET_STATUS, v) },
                { title: '错误/警告', width: 100, render: (_: unknown, s) => `${s.errorCount} / ${s.warningCount}` },
                { title: '批次', render: (_: unknown, s) => s.batches.map((b) => <Tag key={b.batchId}>{DATA_TYPE_LABEL[b.dataType]} #{b.batchId}</Tag>) },
                { title: '更正', dataIndex: 'correctionId', width: 80, render: (v: number | null) => (v ? `#${v}` : '') },
                { title: '创建', dataIndex: 'createdAt', width: 130, render: (v: string) => shortTime(v) },
                {
                  title: '操作', width: 90, render: (_: unknown, s) => (!s.isCurrent && s.status === 'passed' && !s.correctionId && !locked && can('eas:period_lock') ? (
                    <Popconfirm title="激活后本期间当前集合切换为该集合,旧批次标记为已替换。确认激活?" onConfirm={() => activate.mutate(s)}><a>激活</a></Popconfirm>
                  ) : null),
                },
              ]}
            />
          </Card>
          <Card size="small" title="导入批次">
            <Table<EasBatchDto>
              size="small" rowKey="id" loading={batches.isLoading} dataSource={batches.data ?? []} pagination={false}
              columns={[
                { title: '批次', dataIndex: 'id', width: 70, render: (v: number) => `#${v}` },
                { title: '类型', dataIndex: 'dataType', width: 120, render: (v: EasDataType) => DATA_TYPE_LABEL[v] },
                { title: '文件', dataIndex: 'fileName', ellipsis: true },
                { title: '行数', dataIndex: 'rowCount', width: 70, align: 'right' },
                { title: '借方合计', dataIndex: 'debitTotal', width: 150, align: 'right', render: (v: string) => <Money value={v} /> },
                { title: '贷方合计', dataIndex: 'creditTotal', width: 150, align: 'right', render: (v: string) => <Money value={v} /> },
                { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => statusTag(BATCH_STATUS, v) },
                { title: '导入', dataIndex: 'createdAt', width: 130, render: (v: string) => shortTime(v) },
                {
                  title: '操作', width: 120, render: (_: unknown, b) => (
                    <Space><a onClick={() => setViewBatch(b)}>明细</a><a onClick={() => void download(`/eas/batches/${b.id}/original`, b.fileName)}>原件</a></Space>
                  ),
                },
              ]}
            />
          </Card>
        </Space>
      )}
      <BatchLinesDrawer batch={viewBatch} onClose={() => setViewBatch(null)} />
    </>
  );
}

function CorrectionsTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [pendingOnly, setPendingOnly] = useState(true);
  useAssistantDomainPage({ pageKey: 'eas', ready: true, view: { tab: 'corrections', pendingOnly } });
  const [prompt, holder] = usePrompt();
  const list = useQuery({ queryKey: ['eas-corrections', pendingOnly], queryFn: () => easApi.corrections(pendingOnly) });
  const review = useMutation({
    mutationFn: (v: { c: EasCorrectionDto; action: 'approve' | 'return'; comment?: string; exceptionReason?: string }) =>
      easApi.reviewCorrection(v.c.id, compact({ action: v.action, expectedVersion: v.c.version, comment: v.comment, exceptionReason: v.exceptionReason }) as never),
    onSuccess: (c) => { message.success(c.status === 'approved' ? '已批准:候选集合已激活,锁基线已切换' : '已退回'); void qc.invalidateQueries({ queryKey: ['eas-corrections'] }); void qc.invalidateQueries({ queryKey: ['eas-status'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  if (list.error) return <QueryErrorResult title="更正申请加载失败" error={list.error} refetch={list.refetch} />;
  const act = async (c: EasCorrectionDto, action: 'approve' | 'return') => {
    const v = await prompt({
      title: action === 'approve' ? '批准更正' : '退回更正', okText: action === 'approve' ? '批准并切换' : '退回', danger: action === 'return',
      description: action === 'approve' ? '批准时重验当前集合与锁基线未变,并在同一事务里激活候选集合。' : undefined,
      fields: [{ name: 'comment', label: '复核意见', multiline: true }, EXCEPTION_REASON_FIELD],
    });
    if (v) review.mutate({ c, action, comment: v.comment, exceptionReason: v.exceptionReason });
  };
  return (
    <>
      {holder}
      <Space style={{ marginBottom: 12 }}>
        <Select value={pendingOnly ? 'pending' : 'all'} onChange={(v) => setPendingOnly(v === 'pending')} style={{ width: 140 }} options={[{ value: 'pending', label: '处理中' }, { value: 'all', label: '全部' }]} />
      </Space>
      <Table<EasCorrectionDto>
        rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []}
        columns={[
          { title: '申请', dataIndex: 'id', width: 70, render: (v: number) => `#${v}` },
          { title: '组织', dataIndex: 'orgName', width: 160 },
          { title: '期间', dataIndex: 'period', width: 90 },
          { title: '状态', dataIndex: 'status', width: 110, render: (v: string) => statusTag(CORRECTION_STATUS, v) },
          { title: '原因', dataIndex: 'reason', ellipsis: true },
          { title: '候选集合', dataIndex: 'candidateSetId', width: 90, render: (v: number | null) => (v ? `#${v}` : '—') },
          { title: '提交', dataIndex: 'submittedAt', width: 130, render: (v: string) => shortTime(v) },
          {
            title: '操作', width: 120, render: (_: unknown, c) => (c.status === 'pending_review' && can('eas:correction_review') ? (
              <Space><a onClick={() => void act(c, 'approve')}>批准</a><a onClick={() => void act(c, 'return')}>退回</a></Space>
            ) : null),
          },
        ]}
      />
    </>
  );
}

function LocksTab() {
  const list = useQuery({ queryKey: ['eas-locks'], queryFn: () => easApi.locks() });
  if (list.error) return <QueryErrorResult title="期间锁加载失败" error={list.error} refetch={list.refetch} />;
  return (
    <Table
      rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []}
      columns={[
        { title: '组织', dataIndex: 'orgName', width: 180 },
        { title: '期间', dataIndex: 'period', width: 90 },
        { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => (v === 'locked' ? <Tag color="warning">已锁定</Tag> : <Tag>已解锁</Tag>) },
        { title: '绑定集合', dataIndex: 'setId', width: 90, render: (v: number) => `#${v}` },
        { title: '原因', dataIndex: 'reason', ellipsis: true },
        { title: '锁定', dataIndex: 'lockedAt', width: 130, render: (v: string | null) => (v ? shortTime(v) : '—') },
        { title: '解锁', dataIndex: 'unlockedAt', width: 130, render: (v: string | null) => (v ? shortTime(v) : '—') },
      ]}
    />
  );
}

function AuxTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [orgId, setOrgId] = useState<number | undefined>(defaultOrgId());
  const [form] = Form.useForm<{ accountCode: string; auxType: string }>();
  const list = useQuery({ queryKey: ['eas-aux', orgId], queryFn: () => easApi.auxRequirements(orgId) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['eas-aux'] });
  const add = useMutation({
    mutationFn: (v: { accountCode: string; auxType: string }) => easApi.addAuxRequirement({ orgId: orgId!, ...v }),
    onSuccess: () => { message.success('已保存'); form.resetFields(); refresh(); }, onError: (e) => message.error(errorText(e)),
  });
  const off = useMutation({ mutationFn: (id: number) => easApi.deactivateAuxRequirement(id), onSuccess: () => { message.success('已停用'); refresh(); }, onError: (e) => message.error(errorText(e)) });
  if (list.error) return <QueryErrorResult title="辅助核算要求加载失败" error={list.error} refetch={list.refetch} />;
  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <OrgSelect value={orgId} onChange={setOrgId} />
        {can('eas:import') && (
          <Form form={form} layout="inline" onFinish={(v) => add.mutate(v)}>
            <Form.Item name="accountCode" rules={[{ required: true, message: '科目编码' }]}><Input placeholder="科目编码,如 220201" style={{ width: 170 }} /></Form.Item>
            <Form.Item name="auxType" rules={[{ required: true, message: '辅助类型' }]}><Input placeholder="辅助类型,如 项目" style={{ width: 140 }} /></Form.Item>
            <Button htmlType="submit" disabled={!orgId} loading={add.isPending}>添加要求</Button>
          </Form>
        )}
      </Space>
      <Typography.Paragraph type="secondary">预检按这里的配置核对“辅助核算期末 = 科目余额期末”;未配置时给警告,不阻断。</Typography.Paragraph>
      <Table
        rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []}
        columns={[
          { title: '组织', dataIndex: 'orgName', width: 180 },
          { title: '科目', dataIndex: 'accountCode', width: 140 },
          { title: '辅助类型', dataIndex: 'auxType', width: 120 },
          { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => (v === 'active' ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>) },
          { title: '创建', dataIndex: 'createdAt', width: 130, render: (v: string) => shortTime(v) },
          {
            title: '操作', width: 80, render: (_: unknown, r: { id: number; status: string }) => (r.status === 'active' && can('eas:import') ? (
              <Popconfirm title="停用后预检不再核对该要求。确认停用?" onConfirm={() => off.mutate(r.id)}><a>停用</a></Popconfirm>
            ) : null),
          },
        ]}
      />
    </>
  );
}

export default function EasWorkspace() {
  const [tab, setTab] = useState('period');
  useAssistantDomainPage({ pageKey: 'eas', ready: true, view: { tab } }, tab !== 'period' && tab !== 'corrections');
  return (
    <div>
      <Tabs destroyInactiveTabPane activeKey={tab} onChange={setTab}
        items={[
          { key: 'period', label: '期间工作台', children: <PeriodTab /> },
          { key: 'corrections', label: '锁后更正', children: <CorrectionsTab /> },
          { key: 'locks', label: '期间锁', children: <LocksTab /> },
          { key: 'aux', label: '辅助核算要求', children: <AuxTab /> },
        ]}
      />
    </div>
  );
}
