import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert, App as AntdApp, Button, Card, Checkbox, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, List, Modal, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag,
  Timeline, Typography, Upload,
} from 'antd';
import dayjs from 'dayjs';
import { can, download, errorText, getSession } from '../../api/client';
import {
  riskApi, type RiskCommand, type RiskEventDetailDto, type RiskEventDto, type RiskLevel, type RiskListQuery, type RiskRuleDto, type RiskStatus,
  type RiskThresholdKind,
} from '../../api/riskInvestment';
import { Markdown } from '../../components/assistant/Markdown';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { useUrlId } from '../../hooks/useUrlId';
import { shortTime } from '../../utils/relativeTime';
import { compact, Money, OrgSelect, Ratio, statusTag } from '../financeData/shared';
import { RISK_ACTION_LABEL, RISK_LEVEL, RISK_SOURCE_LABEL, RISK_STATUS } from './shared';

/**
 * AC-F17 风险台账:扫描(规则命中 → 新建/再次命中/重开;误报只计次)→ 确认 → 整改 → 提交复核 → 他人复核通过/退回。
 * 未再命中的风险只标记,不自动关闭。复核要求提交人 ≠ 复核人;管理员同人复核须填例外原因。
 * 风险解释(模板 + 可选模型改写)只追加、不改状态;整改清单由服务端按来源与证据确定性生成。
 * 自定义规则复用内置计算器,可设阈值、等级并限定组织(含下级)。
 */

const THRESHOLD_RULES: Record<RiskThresholdKind, { pattern: RegExp; message: string; placeholder: string; suffix: string }> = {
  ratio: { pattern: /^(0(\.\d{1,6})?|1(\.0{1,6})?)?$/, message: '0～1 之间最多 6 位小数', placeholder: '如 0.5', suffix: '(0～1)' },
  amount: { pattern: /^(\d{1,13}(\.\d{1,2})?)?$/, message: '请输入大于 0 的金额,最多 2 位小数', placeholder: '如 1000000', suffix: '(元)' },
};

function ThresholdCell({ rule }: { rule: RiskRuleDto }) {
  if (!rule.thresholdApplies) return <>—</>;
  return rule.thresholdKind === 'amount' ? <Money value={rule.threshold} /> : <Ratio value={rule.threshold} />;
}

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
  const { message } = AntdApp.useApp();
  const q = useQuery({ queryKey: ['risk-event', id], queryFn: () => riskApi.event(id!), enabled: id != null });
  const e = q.data;
  const checklist = useQuery({ queryKey: ['risk-checklist', id, e?.version], queryFn: () => riskApi.checklist(id!), enabled: id != null && e != null });
  const explain = useMutation({
    mutationFn: () => riskApi.explain(id!),
    onSuccess: (n) => {
      message.success(n.source === 'model' ? '已生成解释(模型改写)' : '已生成解释(模板)');
      void qc.invalidateQueries({ queryKey: ['risk-event', id] });
    },
    onError: (err) => message.error(errorText(err)),
  });
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
            <Descriptions.Item label="项目">{e.projectCode && e.projectId ? <Link to={`/projects/${e.projectId}`}>{e.projectCode} {e.projectName ?? ''}</Link> : '—'}</Descriptions.Item>
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
          {checklist.data && (
            <Card size="small" title="整改清单" extra={checklist.data.suggestedNextStatus && <Typography.Text type="secondary">建议下一步:{RISK_STATUS[checklist.data.suggestedNextStatus].text}</Typography.Text>}>
              {checklist.data.missingMaterials.length > 0 && (
                <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`缺少材料:${checklist.data.missingMaterials.map((m) => m.label).join('、')}`} />
              )}
              <List size="small" dataSource={checklist.data.items} renderItem={(it) => (
                <List.Item>
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space wrap>
                      {it.done === true ? <Tag color="success">已完成</Tag> : it.done === false ? <Tag color="error">未完成</Tag> : <Tag>待核实</Tag>}
                      <Typography.Text strong>{it.question}</Typography.Text>
                      {it.required && <Typography.Text type="danger">*</Typography.Text>}
                    </Space>
                    <Typography.Text type="secondary">{it.hint}</Typography.Text>
                    {it.refs.length > 0 && <Space wrap>{it.refs.map((r) => <Link key={r.path} to={r.path}>{r.label}</Link>)}</Space>}
                  </Space>
                </List.Item>
              )} />
            </Card>
          )}
          <Card size="small" title="风险解释" extra={can('risk:handle') && (
            <Button size="small" loading={explain.isPending} onClick={() => explain.mutate()}>{e.explanations.length ? '重新生成' : '生成解释'}</Button>
          )}>
            {e.explanations.length === 0 ? <Typography.Text type="secondary">尚未生成解释。解释仅作辅助参考,不改变风险状态。</Typography.Text> : (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  {e.explanations[0].source === 'model' ? `模型改写(${e.explanations[0].model})` : '确定性模板'} · {e.explanations[0].createdBy ?? '—'} · {shortTime(e.explanations[0].createdAt)}
                  {e.explanations[0].eventVersion !== e.version && ' · 生成后风险已更新'}
                  {e.explanations.length > 1 && ` · 历史 ${e.explanations.length - 1} 条`}
                </Typography.Text>
                <Markdown text={e.explanations[0].content} />
              </Space>
            )}
          </Card>
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
  const [openId, setOpenId] = useUrlId();
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
  const [form] = Form.useForm<{ name?: string; enabled: boolean; level: RiskLevel; threshold?: string; suggestion?: string }>();
  const save = useMutation({
    mutationFn: (v: { name?: string; enabled: boolean; level: RiskLevel; threshold?: string; suggestion?: string }) => riskApi.updateRule(rule!.code, {
      expectedVersion: rule!.version, enabled: v.enabled, level: v.level, suggestion: v.suggestion ?? '',
      ...(!rule!.builtin && v.name?.trim() ? { name: v.name.trim() } : {}),
      ...(rule!.thresholdApplies ? { threshold: v.threshold?.trim() ? v.threshold.trim() : null } : {}),
    }),
    onSuccess: () => { message.success('规则已更新,下次扫描生效'); void qc.invalidateQueries({ queryKey: ['risk-rules'] }); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  if (!rule) return null;
  const th = THRESHOLD_RULES[rule.thresholdKind ?? 'ratio'];
  return (
    <Modal open title={`调整规则:${rule.name}`} onCancel={onClose} destroyOnClose confirmLoading={save.isPending} onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ name: rule.name, enabled: rule.enabled, level: rule.level, threshold: rule.threshold ?? '', suggestion: rule.suggestion }}>
        {!rule.builtin && <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, min: 2, max: 60 }]}><Input /></Form.Item>}
        <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="level" label="等级"><Select options={(['high', 'medium', 'low'] as const).map((k) => ({ value: k, label: RISK_LEVEL[k].text }))} /></Form.Item>
        {rule.thresholdApplies && (
          <Form.Item name="threshold" label={`${rule.thresholdLabel ?? '阈值'}${th.suffix}`} extra="留空使用计算器默认值" rules={[{ pattern: th.pattern, message: th.message }]}><Input placeholder={th.placeholder} /></Form.Item>
        )}
        <Form.Item name="suggestion" label="处理建议"><Input.TextArea rows={3} maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}

function RuleCreateModal({ open, rules, onClose }: { open: boolean; rules: RiskRuleDto[]; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  type V = { code: string; name: string; detector: string; level: RiskLevel; threshold?: string; suggestion?: string; orgId?: number };
  const [form] = Form.useForm<V>();
  const detectors = rules.filter((r) => r.builtin);
  const detector = detectors.find((r) => r.code === Form.useWatch('detector', form));
  const th = detector?.thresholdKind ? THRESHOLD_RULES[detector.thresholdKind] : null;
  const create = useMutation({
    mutationFn: (v: V) => riskApi.createRule({
      code: v.code.trim(), name: v.name.trim(), detector: v.detector, level: v.level,
      ...compact({ suggestion: v.suggestion?.trim(), orgId: v.orgId }),
      ...(th && v.threshold?.trim() ? { threshold: v.threshold.trim() } : {}),
    }),
    onSuccess: (r) => { message.success(`已新增规则 ${r.code},下次扫描生效`); void qc.invalidateQueries({ queryKey: ['risk-rules'] }); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="新增自定义规则" onCancel={onClose} destroyOnClose confirmLoading={create.isPending} onOk={() => form.validateFields().then((v) => create.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ level: 'medium' }}
        onValuesChange={(c: Partial<V>) => {
          const d = c.detector ? detectors.find((r) => r.code === c.detector) : undefined;
          if (d) form.setFieldsValue({ threshold: d.threshold ?? '', level: d.level, suggestion: d.suggestion });
        }}>
        <Form.Item name="detector" label="计算器(复用内置规则的命中逻辑)" rules={[{ required: true, message: '请选择' }]}>
          <Select showSearch optionFilterProp="label" options={detectors.map((r) => ({ value: r.code, label: `${r.detectorName}(${r.code})` }))} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="code" label="编码" rules={[{ required: true, pattern: /^[A-Z][A-Z0-9_]{2,47}$/, message: '大写字母开头,仅大写字母/数字/下划线,3～48 位' }]}>
              <Input placeholder="如 CUSTOM_PB_LOW_EXEC_HZ" />
            </Form.Item>
          </Col>
          <Col span={12}><Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, min: 2, max: 60 }]}><Input /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}><Form.Item name="level" label="等级"><Select options={(['high', 'medium', 'low'] as const).map((k) => ({ value: k, label: RISK_LEVEL[k].text }))} /></Form.Item></Col>
          <Col span={12}>
            {th ? (
              <Form.Item name="threshold" label={`${detector?.thresholdLabel ?? '阈值'}${th.suffix}`} rules={[{ pattern: th.pattern, message: th.message }]}><Input placeholder={th.placeholder} /></Form.Item>
            ) : <Form.Item label="阈值"><Typography.Text type="secondary">该计算器无阈值</Typography.Text></Form.Item>}
          </Col>
        </Row>
        <Form.Item name="orgId" label="适用组织(含下级,留空为全部)"><OrgSelect onChange={(v) => form.setFieldValue('orgId', v)} width={470} /></Form.Item>
        <Form.Item name="suggestion" label="处理建议"><Input.TextArea rows={3} maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}

function RulesTab() {
  const [editing, setEditing] = useState<RiskRuleDto | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['risk-rules'], queryFn: riskApi.rules });
  const editable = can('risk:review') && !!getSession()?.user.allOrgs;
  if (q.error) return <QueryErrorResult title="规则加载失败" error={q.error} refetch={q.refetch} />;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {editable && <Button type="primary" onClick={() => setCreating(true)}>新增自定义规则</Button>}
      <Table<RiskRuleDto> rowKey="code" size="small" loading={q.isLoading} dataSource={q.data ?? []} pagination={false} scroll={{ x: 1200 }} columns={[
        { title: '编码', dataIndex: 'code', width: 220, render: (v: string, r) => <Space size={4}>{v}{!r.builtin && <Tag color="purple">自定义</Tag>}</Space> },
        { title: '名称', dataIndex: 'name', width: 200 },
        { title: '来源', dataIndex: 'source', width: 100, render: (v: string) => RISK_SOURCE_LABEL[v] ?? v },
        { title: '等级', dataIndex: 'level', width: 70, render: (v: RiskLevel) => statusTag(RISK_LEVEL, v) },
        { title: '阈值', dataIndex: 'threshold', width: 150, render: (_: string | null, r) => (r.thresholdApplies ? <Space size={4}><Typography.Text type="secondary">{r.thresholdLabel}</Typography.Text><ThresholdCell rule={r} /></Space> : '—') },
        { title: '适用组织', dataIndex: 'orgName', width: 110, render: (v: string | null) => v ?? '全部' },
        { title: '启用', dataIndex: 'enabled', width: 70, render: (v: boolean) => (v ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>) },
        { title: '处理建议', dataIndex: 'suggestion', ellipsis: true },
        ...(editable ? [{ title: '', key: 'op', width: 70, render: (_: unknown, r: RiskRuleDto) => <Button size="small" onClick={() => setEditing(r)}>调整</Button> }] : []),
      ]} />
      <RuleEditModal rule={editing} onClose={() => setEditing(null)} />
      {creating && <RuleCreateModal open rules={q.data ?? []} onClose={() => setCreating(false)} />}
    </Space>
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

