import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Alert, App as AntdApp, Button, Card, Checkbox, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, Modal, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag,
  Timeline, Typography, Upload,
} from 'antd';
import dayjs from 'dayjs';
import { can, download, errorText, getSession } from '../../api/client';
import {
  riskApi, type RiskCommand, type RiskEventDetailDto, type RiskEventDto, type RiskLevel, type RiskListQuery, type RiskRuleDto, type RiskStatus,
} from '../../api/riskInvestment';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { compact, Money, OrgSelect, Ratio, statusTag } from '../financeData/shared';
import { RISK_ACTION_LABEL, RISK_LEVEL, RISK_SOURCE_LABEL, RISK_STATUS } from './shared';

/**
 * AC-F17 风险台账:扫描(规则命中 → 新建/再次命中/重开;误报只计次)→ 确认 → 整改 → 提交复核 → 他人复核通过/退回。
 * 未再命中的风险只标记,不自动关闭。复核要求提交人 ≠ 复核人;管理员同人复核须填例外原因。
 */

const STATUS_KEYS = Object.keys(RISK_STATUS) as RiskStatus[];
const COMMAND_META: Record<RiskCommand, { label: string; danger?: boolean; primary?: boolean; comment?: 'required' | 'optional'; assign?: boolean; review?: boolean }> = {
  confirm: { label: '确认风险', primary: true, comment: 'optional', assign: true },
  start: { label: '开始整改', primary: true, comment: 'optional', assign: true },
  submit: { label: '提交复核', primary: true, comment: 'required' },
  approve: { label: '复核通过', primary: true, comment: 'optional', review: true },
  return: { label: '复核退回', danger: true, comment: 'required', review: true },
  false_positive: { label: '认定误报', danger: true, comment: 'required' },
  comment: { label: '添加备注', comment: 'required', assign: true },
};

function ActionModal({ event, action, onClose, onDone }: { event: RiskEventDetailDto; action: RiskCommand | null; onClose: () => void; onDone: (e: RiskEventDetailDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ comment?: string; deadline?: string; assignMe?: boolean; exceptionReason?: string }>();
  const [file, setFile] = useState<File | null>(null);
  const meta = action ? COMMAND_META[action] : null;
  const act = useMutation({
    mutationFn: (v: { comment?: string; deadline?: string; assignMe?: boolean; exceptionReason?: string }) => riskApi.act(event.id, {
      action: action!, expectedVersion: event.version,
      ...compact({ comment: v.comment?.trim(), deadline: v.deadline, exceptionReason: v.exceptionReason?.trim() }),
      ...(v.assignMe ? { handlerUserId: getSession()?.user.id } : {}),
    }, file),
    onSuccess: (e) => { message.success(`${meta?.label}已完成`); setFile(null); onDone(e); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  if (!action || !meta) return null;
  return (
    <Modal open title={`${meta.label}:${event.title}`} onCancel={onClose} destroyOnClose confirmLoading={act.isPending} okButtonProps={{ danger: meta.danger }}
      onOk={() => form.validateFields().then((v) => act.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ deadline: event.deadline ?? undefined, assignMe: action === 'start' && !event.handlerUserId }}>
        <Form.Item name="comment" label={action === 'submit' ? '整改说明' : '意见'} rules={meta.comment === 'required' ? [{ required: true, whitespace: true, message: '请填写' }] : []}>
          <Input.TextArea rows={3} maxLength={2000} showCount />
        </Form.Item>
        {meta.assign && (
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="deadline" label="整改期限" getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : undefined)}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}><Form.Item name="assignMe" label="责任人" valuePropName="checked"><Checkbox>由我负责</Checkbox></Form.Item></Col>
          </Row>
        )}
        {meta.review && (
          <Form.Item name="exceptionReason" label="例外原因(仅管理员复核本人提交时填写)"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
        )}
        <Form.Item label="附件(可选)">
          <Upload beforeUpload={(f) => { setFile(f); return false; }} onRemove={() => setFile(null)} maxCount={1} fileList={file ? [{ uid: '1', name: file.name }] : []}>
            <Button icon={<i className="ri-attachment-2" aria-hidden />}>选择文件</Button>
          </Upload>
        </Form.Item>
      </Form>
    </Modal>
  );
}

function RiskDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [action, setAction] = useState<RiskCommand | null>(null);
  const q = useQuery({ queryKey: ['risk-event', id], queryFn: () => riskApi.event(id!), enabled: id != null });
  const e = q.data;
  const done = (d: RiskEventDetailDto) => {
    qc.setQueryData(['risk-event', id], d);
    void qc.invalidateQueries({ queryKey: ['risk-events'] }); void qc.invalidateQueries({ queryKey: ['risk-summary'] });
  };
  return (
    <Drawer open={id != null} onClose={onClose} width={760} title={e ? e.title : '风险详情'} destroyOnClose
      extra={e && (
        <Space wrap>
          {e.allowed.map((a) => (
            <Button key={a} type={COMMAND_META[a].primary ? 'primary' : 'default'} danger={COMMAND_META[a].danger} onClick={() => setAction(a)}>{COMMAND_META[a].label}</Button>
          ))}
        </Space>
      )}>
      {q.error ? <QueryErrorResult title="风险加载失败" error={q.error} refetch={q.refetch} /> : !e ? null : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {!e.lastScanHit && ['open', 'confirmed', 'rectifying', 'rectified'].includes(e.status) && (
            <Alert type="info" showIcon message="最近一次扫描未再命中该风险" description="风险不会自动关闭,请按整改与复核流程处理。" />
          )}
          {e.overdue && <Alert type="error" showIcon message={`已超过整改期限 ${e.deadline}`} />}
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="规则">{e.ruleName}({e.ruleCode})</Descriptions.Item>
            <Descriptions.Item label="来源">{RISK_SOURCE_LABEL[e.source] ?? e.source}</Descriptions.Item>
            <Descriptions.Item label="等级">{statusTag(RISK_LEVEL, e.level)}</Descriptions.Item>
            <Descriptions.Item label="状态">{statusTag(RISK_STATUS, e.status)}</Descriptions.Item>
            <Descriptions.Item label="组织">{e.orgName}</Descriptions.Item>
            <Descriptions.Item label="项目">{e.projectCode ? `${e.projectCode} ${e.projectName ?? ''}` : '—'}</Descriptions.Item>
            <Descriptions.Item label="涉及金额(元)"><Money value={e.amount} /></Descriptions.Item>
            <Descriptions.Item label="指标">{e.metric ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="责任人">{e.handlerName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="整改期限">{e.deadline ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="命中次数">{e.occurrenceCount}{e.reopenedCount ? `(重开 ${e.reopenedCount} 次)` : ''}</Descriptions.Item>
            <Descriptions.Item label="首次/最近命中">{shortTime(e.firstDetectedAt)} / {shortTime(e.lastDetectedAt)}</Descriptions.Item>
            <Descriptions.Item label="说明" span={2}>{e.description}</Descriptions.Item>
            {e.suggestion && <Descriptions.Item label="处理建议" span={2}>{e.suggestion}</Descriptions.Item>}
            {e.rectifyNote && <Descriptions.Item label="整改说明" span={2}>{e.rectifyNote}</Descriptions.Item>}
          </Descriptions>
          <Card size="small" title="命中证据">
            <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(e.evidence, null, 2)}</pre>
          </Card>
          <Card size="small" title="处理时间线">
            <Timeline items={e.actions.map((a) => ({
              color: a.action === 'approve' ? 'green' : a.action === 'return' || a.action === 'reopen' ? 'red' : 'blue',
              children: (
                <div>
                  <Typography.Text strong>{RISK_ACTION_LABEL[a.action] ?? a.actionLabel}</Typography.Text>
                  {a.fromStatus && a.toStatus && a.fromStatus !== a.toStatus && <Typography.Text type="secondary"> {RISK_STATUS[a.fromStatus].text} → {RISK_STATUS[a.toStatus].text}</Typography.Text>}
                  <Typography.Text type="secondary"> · {a.actorName ?? (a.scanId ? `扫描 #${a.scanId}` : '系统')} · {shortTime(a.createdAt)}</Typography.Text>
                  {a.comment && <div>{a.comment}</div>}
                  {a.exceptionReason && <div><Tag color="warning">例外</Tag>{a.exceptionReason}</div>}
                  {a.hasAttachment && (
                    <Button type="link" size="small" style={{ padding: 0 }} onClick={() => void download(riskApi.attachmentPath(e.id, a.id), a.attachmentName ?? '附件')}>
                      <i className="ri-attachment-2" aria-hidden /> {a.attachmentName}
                    </Button>
                  )}
                </div>
              ),
            }))} />
          </Card>
          <ActionModal event={e} action={action} onClose={() => setAction(null)} onDone={done} />
        </Space>
      )}
    </Drawer>
  );
}

function EventsTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as RiskStatus | null) ?? undefined;
  const [level, setLevel] = useState<RiskLevel>();
  const [source, setSource] = useState<string>();
  const [orgId, setOrgId] = useState<number>();
  const [keyword, setKeyword] = useState('');
  const [openOnly, setOpenOnly] = useState(!status);
  const [openId, setOpenId] = useState<number | null>(null);
  const query: Partial<RiskListQuery> = compact({ status, level, source: source as RiskListQuery['source'], orgId, keyword: keyword.trim(), open: openOnly && !status ? '1' as const : undefined });
  const events = useQuery({ queryKey: ['risk-events', query], queryFn: () => riskApi.events(query) });
  const summary = useQuery({ queryKey: ['risk-summary', orgId], queryFn: () => riskApi.summary(compact({ orgId })) });
  const scan = useMutation({
    mutationFn: () => riskApi.scan(orgId),
    onSuccess: (s) => {
      message.success(`扫描完成:新增 ${s.createdCount}、再次命中 ${s.updatedCount}、重开 ${s.reopenedCount}、误报计次 ${s.suppressedCount}、未再命中 ${s.clearedCount}`);
      void qc.invalidateQueries({ queryKey: ['risk-events'] }); void qc.invalidateQueries({ queryKey: ['risk-summary'] }); void qc.invalidateQueries({ queryKey: ['risk-scans'] });
    },
    onError: (e) => message.error(errorText(e)),
  });
  const setStatus = (v?: RiskStatus) => { const p = new URLSearchParams(params); if (v) p.set('status', v); else p.delete('status'); setParams(p, { replace: true }); };
  const s = summary.data;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Row gutter={12}>
        <Col xs={12} md={4}><Card size="small"><Statistic title="未关闭" value={s?.openCount ?? '—'} /></Card></Col>
        <Col xs={12} md={5}><Card size="small"><Statistic title="未关闭金额(元)" value={s ? undefined : '—'} formatter={() => <Money value={s?.openAmount} />} /></Card></Col>
        <Col xs={12} md={5}><Card size="small" hoverable onClick={() => setStatus('open')}><Statistic title="待确认" value={s?.pendingConfirm ?? '—'} /></Card></Col>
        <Col xs={12} md={5}><Card size="small" hoverable onClick={() => setStatus('rectified')}><Statistic title="待复核" value={s?.pendingReview ?? '—'} /></Card></Col>
        <Col xs={12} md={5}><Card size="small"><Statistic title="已逾期" value={s?.overdue ?? '—'} valueStyle={s?.overdue ? { color: 'var(--ant-color-error)' } : undefined} /></Card></Col>
      </Row>
      <Space wrap>
        <Select allowClear placeholder="状态" style={{ width: 120 }} value={status} onChange={setStatus} options={STATUS_KEYS.map((k) => ({ value: k, label: RISK_STATUS[k].text }))} />
        <Select allowClear placeholder="等级" style={{ width: 100 }} value={level} onChange={setLevel} options={(['high', 'medium', 'low'] as const).map((k) => ({ value: k, label: RISK_LEVEL[k].text }))} />
        <Select allowClear placeholder="来源" style={{ width: 130 }} value={source} onChange={setSource} options={Object.entries(RISK_SOURCE_LABEL).map(([value, label]) => ({ value, label }))} />
        <OrgSelect value={orgId} onChange={setOrgId} />
        <Input.Search allowClear placeholder="标题/项目" style={{ width: 200 }} onSearch={setKeyword} />
        {!status && <Space><Switch checked={openOnly} onChange={setOpenOnly} size="small" />只看未关闭</Space>}
        {can('risk:handle') && <Button type="primary" loading={scan.isPending} onClick={() => scan.mutate()}>{orgId ? '扫描所选组织' : '执行扫描'}</Button>}
      </Space>
      {events.error ? <QueryErrorResult title="风险列表加载失败" error={events.error} refetch={events.refetch} /> : (
        <Table<RiskEventDto>
          rowKey="id" size="small" loading={events.isLoading} dataSource={events.data ?? []} scroll={{ x: 1300 }}
          locale={{ emptyText: <Empty description={openOnly ? '没有未关闭风险;可执行扫描或取消“只看未关闭”' : '没有符合条件的风险'} /> }}
          onRow={(r) => ({ onClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: '等级', dataIndex: 'level', width: 64, render: (v: RiskLevel) => statusTag(RISK_LEVEL, v) },
            { title: '风险', dataIndex: 'title', ellipsis: true },
            { title: '规则', dataIndex: 'ruleName', width: 150, ellipsis: true },
            { title: '状态', dataIndex: 'status', width: 86, render: (v: RiskStatus) => statusTag(RISK_STATUS, v) },
            { title: '组织', dataIndex: 'orgName', width: 110, ellipsis: true },
            { title: '项目', dataIndex: 'projectCode', width: 120, ellipsis: true, render: (v: string | null, r) => (v ? `${v} ${r.projectName ?? ''}` : '—') },
            { title: '金额(元)', dataIndex: 'amount', width: 130, align: 'right', render: (v: string | null) => <Money value={v} /> },
            { title: '责任人', dataIndex: 'handlerName', width: 90, render: (v: string | null) => v ?? '—' },
            { title: '期限', dataIndex: 'deadline', width: 110, render: (v: string | null, r) => (v ? <Typography.Text type={r.overdue ? 'danger' : undefined}>{v}{r.overdue ? ' 逾期' : ''}</Typography.Text> : '—') },
            { title: '命中', dataIndex: 'occurrenceCount', width: 60, align: 'right' },
            { title: '最近扫描', dataIndex: 'lastScanHit', width: 90, render: (v: boolean) => (v ? <Tag color="red">命中</Tag> : <Tag>未再命中</Tag>) },
            { title: '最近命中', dataIndex: 'lastDetectedAt', width: 120, render: (v: string) => shortTime(v) },
          ]}
        />
      )}
      <RiskDrawer id={openId} onClose={() => setOpenId(null)} />
    </Space>
  );
}

function ScansTab() {
  const q = useQuery({ queryKey: ['risk-scans'], queryFn: riskApi.scans });
  if (q.error) return <QueryErrorResult title="扫描记录加载失败" error={q.error} refetch={q.refetch} />;
  return (
    <Table rowKey="id" size="small" loading={q.isLoading} dataSource={q.data ?? []} columns={[
      { title: '#', dataIndex: 'id', width: 70 },
      { title: '时间', dataIndex: 'createdAt', width: 160, render: (v: string) => shortTime(v) },
      { title: '范围', dataIndex: 'scope', render: (v: Record<string, unknown>) => (v.orgId ? `组织 #${String(v.orgId)}(含下级)` : '全部授权组织') },
      { title: '命中', dataIndex: 'hitCount', width: 70, align: 'right' },
      { title: '新增', dataIndex: 'createdCount', width: 70, align: 'right' },
      { title: '再次命中', dataIndex: 'updatedCount', width: 90, align: 'right' },
      { title: '重开', dataIndex: 'reopenedCount', width: 70, align: 'right' },
      { title: '误报计次', dataIndex: 'suppressedCount', width: 90, align: 'right' },
      { title: '未再命中', dataIndex: 'clearedCount', width: 90, align: 'right' },
    ]} />
  );
}

function RuleEditModal({ rule, onClose }: { rule: RiskRuleDto | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ enabled: boolean; level: RiskLevel; threshold?: string; suggestion?: string }>();
  const save = useMutation({
    mutationFn: (v: { enabled: boolean; level: RiskLevel; threshold?: string; suggestion?: string }) => riskApi.updateRule(rule!.code, {
      expectedVersion: rule!.version, enabled: v.enabled, level: v.level, suggestion: v.suggestion ?? '',
      ...(rule!.thresholdApplies ? { threshold: v.threshold?.trim() ? v.threshold.trim() : null } : {}),
    }),
    onSuccess: () => { message.success('规则已更新,下次扫描生效'); void qc.invalidateQueries({ queryKey: ['risk-rules'] }); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  if (!rule) return null;
  return (
    <Modal open title={`调整规则:${rule.name}`} onCancel={onClose} destroyOnClose confirmLoading={save.isPending} onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ enabled: rule.enabled, level: rule.level, threshold: rule.threshold ?? '', suggestion: rule.suggestion }}>
        <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="level" label="等级"><Select options={(['high', 'medium', 'low'] as const).map((k) => ({ value: k, label: RISK_LEVEL[k].text }))} /></Form.Item>
        {rule.thresholdApplies && (
          <Form.Item name="threshold" label="执行率阈值(0～1)" rules={[{ pattern: /^(0(\.\d{1,6})?|1(\.0{1,6})?)?$/, message: '0～1 之间最多 6 位小数' }]}><Input placeholder="如 0.5" /></Form.Item>
        )}
        <Form.Item name="suggestion" label="处理建议"><Input.TextArea rows={3} maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}

function RulesTab() {
  const [editing, setEditing] = useState<RiskRuleDto | null>(null);
  const q = useQuery({ queryKey: ['risk-rules'], queryFn: riskApi.rules });
  const editable = can('risk:review') && !!getSession()?.user.allOrgs;
  if (q.error) return <QueryErrorResult title="规则加载失败" error={q.error} refetch={q.refetch} />;
  return (
    <>
      <Table<RiskRuleDto> rowKey="code" size="small" loading={q.isLoading} dataSource={q.data ?? []} pagination={false} columns={[
        { title: '编码', dataIndex: 'code', width: 180 },
        { title: '名称', dataIndex: 'name', width: 200 },
        { title: '来源', dataIndex: 'source', width: 100, render: (v: string) => RISK_SOURCE_LABEL[v] ?? v },
        { title: '等级', dataIndex: 'level', width: 70, render: (v: RiskLevel) => statusTag(RISK_LEVEL, v) },
        { title: '阈值', dataIndex: 'threshold', width: 90, render: (v: string | null, r) => (r.thresholdApplies ? <Ratio value={v} /> : '—') },
        { title: '启用', dataIndex: 'enabled', width: 70, render: (v: boolean) => (v ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>) },
        { title: '处理建议', dataIndex: 'suggestion', ellipsis: true },
        ...(editable ? [{ title: '', key: 'op', width: 70, render: (_: unknown, r: RiskRuleDto) => <Button size="small" onClick={() => setEditing(r)}>调整</Button> }] : []),
      ]} />
      <RuleEditModal rule={editing} onClose={() => setEditing(null)} />
    </>
  );
}

export default function RiskLedger() {
  return (
    <div>
      <Tabs items={[
        { key: 'events', label: '风险事件', children: <EventsTab /> },
        { key: 'scans', label: '扫描记录', children: <ScansTab /> },
        { key: 'rules', label: '规则', children: <RulesTab /> },
      ]} />
    </div>
  );
}

