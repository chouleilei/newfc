import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Timeline, Typography } from 'antd';
import { api, can, errorText } from '../../api/client';
import { easApi, govApi, type GovDispositionDto, type GovDispositionKind, type GovIssueDto } from '../../api/financeData';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { compact, defaultOrgId, EXCEPTION_REASON_FIELD, OrgSelect, PeriodPicker, statusTag, usePrompt } from './shared';

/** AC-F06 数据治理:扫描 → 处置(映射覆盖/误报/重新导入)→ 复核 → 生效证明;治理从不改写原始事实。 */

const ISSUE_STATUS = {
  open: { text: '待处理', color: 'error' }, pending_review: { text: '待复核', color: 'warning' },
  resolved: { text: '已解决', color: 'success' }, dismissed: { text: '误报关闭', color: 'default' },
};
const SOURCE_LABEL: Record<string, string> = { eas_recon: 'EAS 预检', eas_master: 'EAS 主数据', statement: '财务报表' };
const KIND_LABEL: Record<GovDispositionKind, string> = { mapping_override: '映射覆盖', false_positive: '误报', reimport: '重新导入' };
const DISPOSITION_STATUS = { pending_review: { text: '待复核', color: 'warning' }, approved: { text: '已批准', color: 'success' }, returned: { text: '已退回', color: 'default' } };

interface MasterOption { id: number; code: string | null; name: string }

function DispositionModal({ issue, onClose }: { issue: GovIssueDto | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ kind: GovDispositionKind; reason: string; targetId?: number; setId?: number }>();
  const kind = Form.useWatch('kind', form);
  const entity = (issue?.detail as { entity?: 'project' | 'supplier' } | undefined)?.entity;
  const targets = useQuery({
    queryKey: ['gov-targets', entity], enabled: !!issue && kind === 'mapping_override' && !!entity,
    queryFn: () => api.get<MasterOption[]>(entity === 'project' ? '/master/projects' : '/master/suppliers'),
  });
  const sets = useQuery({
    queryKey: ['gov-sets', issue?.orgId, issue?.period], enabled: !!issue?.orgId && kind === 'reimport',
    queryFn: () => easApi.sets({ orgId: issue!.orgId!, period: issue!.period }),
  });
  const submit = useMutation({
    mutationFn: (v: { kind: GovDispositionKind; reason: string; targetId?: number; setId?: number }) => govApi.dispose(issue!.id, { ...v, expectedVersion: issue!.version } as never),
    onSuccess: () => { message.success('已提交处置,等待复核'); void qc.invalidateQueries({ queryKey: ['gov-issues'] }); void qc.invalidateQueries({ queryKey: ['gov-issue'] }); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  const kinds: GovDispositionKind[] = issue?.sourceType === 'eas_master' ? ['mapping_override', 'false_positive'] : issue?.sourceType === 'eas_recon' ? ['reimport', 'false_positive'] : ['false_positive'];
  return (
    <Modal open={!!issue} title="提交处置" onCancel={onClose} destroyOnClose confirmLoading={submit.isPending}
      onOk={() => form.validateFields().then((v) => submit.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ kind: kinds[0] }}>
        <Form.Item name="kind" label="处置方式" rules={[{ required: true }]}>
          <Select options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
        </Form.Item>
        {kind === 'mapping_override' && (
          <Form.Item name="targetId" label={`映射到${entity === 'project' ? '项目' : '供应商'}`} rules={[{ required: true, message: '请选择映射目标' }]}
            extra="复核通过后写入主数据映射(退役旧映射再新增),原始凭证不改。">
            <Select showSearch optionFilterProp="label" loading={targets.isLoading}
              options={(targets.data ?? []).map((t) => ({ value: t.id, label: `${t.name}${t.code ? `(${t.code})` : ''}` }))} />
          </Form.Item>
        )}
        {kind === 'reimport' && (
          <Form.Item name="setId" label="关联新激活的 EAS 集合" rules={[{ required: true, message: '请选择集合' }]}
            extra="必须是问题出现之后新激活、且对账通过的当前集合。">
            <Select loading={sets.isLoading}
              options={(sets.data ?? []).filter((s) => s.isCurrent && s.status === 'passed').map((s) => ({ value: s.id, label: `集合 #${s.id}(${shortTime(s.activatedAt ?? s.createdAt)})` }))} />
          </Form.Item>
        )}
        <Form.Item name="reason" label="处置说明" rules={[{ required: true, whitespace: true, message: '请填写说明' }]}>
          <Input.TextArea rows={3} maxLength={500} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function IssueDrawer({ issueId, onClose }: { issueId: number | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [disposing, setDisposing] = useState<GovIssueDto | null>(null);
  const q = useQuery({ queryKey: ['gov-issue', issueId], queryFn: () => govApi.issue(issueId!), enabled: issueId != null });
  const verify = useMutation({
    mutationFn: () => govApi.verify(issueId!),
    onSuccess: (r) => message.success(`来源事实未变化(${r.sourceHash.slice(0, 12)}…)`),
    onError: (e) => message.error(errorText(e)),
  });
  const review = useMutation({
    mutationFn: (v: { d: GovDispositionDto; action: 'approve' | 'return'; comment?: string; exceptionReason?: string }) =>
      govApi.review(v.d.id, compact({ action: v.action, comment: v.comment, exceptionReason: v.exceptionReason }) as never),
    onSuccess: () => { message.success('复核已记录'); void qc.invalidateQueries({ queryKey: ['gov-issue'] }); void qc.invalidateQueries({ queryKey: ['gov-issues'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const issue = q.data;
  const act = async (d: GovDispositionDto, action: 'approve' | 'return') => {
    const v = await prompt({ title: action === 'approve' ? '批准处置' : '退回处置', danger: action === 'return', fields: [{ name: 'comment', label: '复核意见', multiline: true }, EXCEPTION_REASON_FIELD] });
    if (v) review.mutate({ d, action, comment: v.comment, exceptionReason: v.exceptionReason });
  };
  return (
    <Drawer open={issueId != null} onClose={onClose} width={760} title={issue?.title ?? '问题详情'} destroyOnClose
      extra={issue && (
        <Space>
          <Button onClick={() => verify.mutate()} loading={verify.isPending}>验证来源</Button>
          {issue.status === 'open' && can('governance:resolve') && <Button type="primary" onClick={() => setDisposing(issue)}>提交处置</Button>}
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="问题加载失败" error={q.error} refetch={q.refetch} /> : issue && (
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="来源">{SOURCE_LABEL[issue.sourceType]} · {issue.problemType}</Descriptions.Item>
            <Descriptions.Item label="状态">{statusTag(ISSUE_STATUS, issue.status)}</Descriptions.Item>
            <Descriptions.Item label="组织">{issue.orgName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="期间">{issue.period}</Descriptions.Item>
            <Descriptions.Item label="严重程度">{issue.severity === 'error' ? <Tag color="error">错误</Tag> : <Tag color="warning">警告</Tag>}</Descriptions.Item>
            <Descriptions.Item label="重新打开">{issue.reopenCount} 次</Descriptions.Item>
            <Descriptions.Item label="来源引用" span={2}><Typography.Text code>{issue.sourceRef}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="来源哈希" span={2}><Typography.Text code copyable>{issue.sourceHash}</Typography.Text></Descriptions.Item>
          </Descriptions>
          <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', fontSize: 12, background: 'var(--bd-fill)', padding: 8, borderRadius: 6 }}>{JSON.stringify(issue.detail, null, 2)}</pre>
          <Typography.Title level={5} style={{ margin: 0 }}>处置记录</Typography.Title>
          {(issue.dispositions ?? []).length === 0 ? <Typography.Text type="secondary">暂无处置</Typography.Text> : (
            <Timeline items={(issue.dispositions ?? []).map((d) => ({
              key: d.id,
              children: (
                <div>
                  <Space>{KIND_LABEL[d.kind]}{statusTag(DISPOSITION_STATUS, d.status)}<Typography.Text type="secondary">{shortTime(d.submittedAt)}</Typography.Text></Space>
                  <div>{d.reason}</div>
                  {d.review && <div><Typography.Text type="secondary">复核:{d.review.action === 'approve' ? '批准' : '退回'} {d.review.comment ?? ''}{d.review.exceptionReason ? `(例外:${d.review.exceptionReason})` : ''}</Typography.Text></div>}
                  {d.proof && <div><Tag color={d.proof.verified ? 'success' : 'error'}>生效证明</Tag><Typography.Text code>{d.proof.beforeHash.slice(0, 10)}…→{d.proof.afterHash.slice(0, 10)}…</Typography.Text></div>}
                  {d.status === 'pending_review' && can('governance:review') && (
                    <Space style={{ marginTop: 4 }}><Button size="small" type="primary" onClick={() => void act(d, 'approve')}>批准</Button><Button size="small" onClick={() => void act(d, 'return')}>退回</Button></Space>
                  )}
                </div>
              ),
            }))} />
          )}
        </Space>
      )}
      <DispositionModal issue={disposing} onClose={() => setDisposing(null)} />
    </Drawer>
  );
}

export default function Governance() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string | undefined>('open');
  const [sourceType, setSourceType] = useState<string | undefined>();
  const [orgId, setOrgId] = useState<number | undefined>(defaultOrgId());
  const [period, setPeriod] = useState<string | undefined>();
  const [openId, setOpenId] = useState<number | null>(null);
  const list = useQuery({ queryKey: ['gov-issues', status, sourceType, orgId, period], queryFn: () => govApi.issues({ status, sourceType, orgId, period }) });
  const scan = useMutation({
    mutationFn: () => govApi.scan(compact({ orgId, period })),
    onSuccess: (r) => { message.success(`扫描完成:新增 ${r.created},更新 ${r.updated},重新打开 ${r.reopened},未变 ${r.unchanged}`); void qc.invalidateQueries({ queryKey: ['gov-issues'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="状态" value={status} onChange={setStatus} style={{ width: 120 }} options={Object.entries(ISSUE_STATUS).map(([value, m]) => ({ value, label: m.text }))} />
        <Select allowClear placeholder="来源" value={sourceType} onChange={setSourceType} style={{ width: 130 }} options={Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label }))} />
        <OrgSelect value={orgId} onChange={setOrgId} />
        <PeriodPicker value={period} onChange={setPeriod} />
        {can('governance:resolve') && <Button type="primary" onClick={() => scan.mutate()} loading={scan.isPending}>扫描问题</Button>}
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="治理只记录问题与处置,不改写 EAS/财报原始事实;来源事实变化后验证与生效证明会返回 GOVERNANCE_FACT_MUTATED。" />
      {list.error ? <QueryErrorResult title="治理问题加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<GovIssueDto>
          rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 20, showSizeChanger: false }}
          onRow={(r) => ({ onClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: '问题', dataIndex: 'title', ellipsis: true },
            { title: '来源', dataIndex: 'sourceType', width: 110, render: (v: string) => SOURCE_LABEL[v] ?? v },
            { title: '组织', dataIndex: 'orgName', width: 150 },
            { title: '期间', dataIndex: 'period', width: 90 },
            { title: '级别', dataIndex: 'severity', width: 70, render: (v: string) => (v === 'error' ? <Tag color="error">错误</Tag> : <Tag color="warning">警告</Tag>) },
            { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => statusTag(ISSUE_STATUS, v) },
            { title: '最近发现', dataIndex: 'lastSeenAt', width: 130, render: (v: string) => shortTime(v) },
          ]}
        />
      )}
      <IssueDrawer issueId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
