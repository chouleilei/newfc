import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Col, DatePicker, Drawer, Form, Input, Modal, Row, Select, Space, Switch, Table, Tag, Typography, Upload } from 'antd';
import dayjs from 'dayjs';
import { can, download, errorText, getSession } from '../../api/client';
import { expenseApi, type PolicyClauseDto, type PolicyDto } from '../../api/projectContract';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { compact, Money, usePrompt } from '../financeData/shared';

/**
 * AC-F22 制度依据:条款(适用费用类型、金额上限、必备材料关键词)由页面维护、按版本生效,
 * 审核运行按发生日期取有效版本并在发现里引用条款;不在代码里写死阈值。维护需要全组织范围的复核人。
 */

const dateItem = { getValueProps: (v?: string) => ({ value: v ? dayjs(v) : null }), normalize: (d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null) };

function PolicyFormModal({ open, base, onClose }: { open: boolean; base?: PolicyDto; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => expenseApi.createPolicy({
      ...compact(v),
      clauses: ((v.clauses as Record<string, unknown>[]) ?? []).map((c) => ({ ...compact(c), expenseTypes: c.expenseTypes ?? [], requiredKeywords: c.requiredKeywords ?? [] })),
    } as never),
    onSuccess: (p) => { message.success(`已发布 ${p.code} v${p.version}`); void qc.invalidateQueries({ queryKey: ['expense-policies'] }); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} width={980} title={base ? `发布新版本:${base.code}` : '新建制度依据'} onCancel={onClose} destroyOnClose confirmLoading={save.isPending}
      onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false}
        initialValues={base ? {
          code: base.code, title: base.title, effectiveFrom: dayjs().format('YYYY-MM-DD'),
          clauses: base.clauses.map((c) => ({ clauseNo: c.clauseNo, clauseText: c.clauseText, expenseTypes: c.expenseTypes, limit: c.limit ?? undefined, requiredKeywords: c.requiredKeywords })),
        } : { effectiveFrom: dayjs().format('YYYY-MM-DD'), clauses: [{}] }}>
        <Row gutter={12}>
          <Col span={6}><Form.Item name="code" label="制度编码" rules={[{ required: true, whitespace: true }]} extra="同编码再次发布即新版本"><Input maxLength={50} disabled={!!base} /></Form.Item></Col>
          <Col span={10}><Form.Item name="title" label="名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item></Col>
          <Col span={4}><Form.Item name="effectiveFrom" label="生效日期" rules={[{ required: true }]} {...dateItem}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={4}><Form.Item name="effectiveTo" label="失效日期" {...dateItem}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
        </Row>
        <Typography.Text strong>条款</Typography.Text>
        <Form.List name="clauses">
          {(fields, { add, remove }) => (
            <>
              {fields.map((f) => (
                <Row key={f.key} gutter={8} style={{ marginTop: 8 }} align="top">
                  <Col span={3}><Form.Item name={[f.name, 'clauseNo']} rules={[{ required: true, whitespace: true, message: '条款号' }]}><Input placeholder="条款号" /></Form.Item></Col>
                  <Col span={8}><Form.Item name={[f.name, 'clauseText']} rules={[{ required: true, whitespace: true, message: '条款内容' }]}><Input.TextArea rows={1} autoSize placeholder="条款原文" maxLength={2000} /></Form.Item></Col>
                  <Col span={4}><Form.Item name={[f.name, 'expenseTypes']}><Select mode="tags" placeholder="适用费用类型(空=全部)" tokenSeparators={[',', ',']} /></Form.Item></Col>
                  <Col span={3}><Form.Item name={[f.name, 'limit']} rules={[{ pattern: /^\d{1,13}(\.\d{1,2})?$/, message: '金额' }]}><Input placeholder="金额上限" /></Form.Item></Col>
                  <Col span={5}><Form.Item name={[f.name, 'requiredKeywords']}><Select mode="tags" placeholder="必备材料关键词" tokenSeparators={[',', ',']} /></Form.Item></Col>
                  <Col span={1}><Button type="text" danger onClick={() => remove(f.name)} aria-label="删除条款"><i className="ri-delete-bin-line" aria-hidden /></Button></Col>
                </Row>
              ))}
              <Button type="dashed" onClick={() => add({})}>添加条款</Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

const clauseColumns = [
  { title: '条款号', dataIndex: 'clauseNo', width: 80 },
  { title: '内容', dataIndex: 'clauseText' },
  { title: '适用费用类型', dataIndex: 'expenseTypes', width: 160, render: (v: string[]) => (v.length ? v.map((t) => <Tag key={t}>{t}</Tag>) : <Typography.Text type="secondary">全部</Typography.Text>) },
  { title: '金额上限', dataIndex: 'limit', width: 120, align: 'right' as const, render: (v: string | null) => (v == null ? '—' : <Money value={v} />) },
  { title: '必备材料', dataIndex: 'requiredKeywords', width: 180, render: (v: string[]) => v.map((t) => <Tag key={t} color="purple">{t}</Tag>) },
];

export default function ExpensePolicies() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [includeRetired, setIncludeRetired] = useState(false);
  const [editing, setEditing] = useState<{ base?: PolicyDto } | null>(null);
  const [viewing, setViewing] = useState<PolicyDto | null>(null);
  const maintain = can('expense:review') && (getSession()?.user.allOrgs ?? false);
  const list = useQuery({ queryKey: ['expense-policies', includeRetired], queryFn: () => expenseApi.policies(includeRetired) });
  const run = useMutation({
    mutationFn: (fn: () => Promise<PolicyDto>) => fn(),
    onSuccess: (p) => { message.success('已完成'); setViewing((v) => (v?.id === p.id ? p : v)); void qc.invalidateQueries({ queryKey: ['expense-policies'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <div>
      {holder}
      <Space wrap style={{ marginBottom: 12 }}>
        <Space><Switch checked={includeRetired} onChange={setIncludeRetired} aria-label="含已停用" /><span>含已停用</span></Space>
        {maintain && <Button type="primary" onClick={() => setEditing({})}>新建制度依据</Button>}
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="审核运行按报销单发生日期选取每个制度编码的有效最高版本;金额上限与必备材料在此维护,不写在代码里。条款变更请发布新版本,历史审核仍引用当时的版本。" />
      {list.error ? <QueryErrorResult title="制度依据加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<PolicyDto> rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 20 }}
          onRow={(r) => ({ onClick: () => setViewing(r), style: { cursor: 'pointer' } })}
          columns={[
            { title: '编码', dataIndex: 'code', width: 120 },
            { title: '名称', dataIndex: 'title' },
            { title: '版本', dataIndex: 'version', width: 70, render: (v: number) => `v${v}` },
            { title: '有效期', key: 'eff', width: 210, render: (_, p) => `${p.effectiveFrom} ~ ${p.effectiveTo ?? '长期'}` },
            { title: '条款', key: 'n', width: 70, render: (_, p) => p.clauses.length },
            { title: '原件', dataIndex: 'hasSource', width: 70, render: (v: boolean) => (v ? <Tag color="blue">有</Tag> : '—') },
            { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => (v === 'active' ? <Tag color="success">生效</Tag> : <Tag>已停用</Tag>) },
            { title: '更新', dataIndex: 'updatedAt', width: 120, render: (v: string) => shortTime(v) },
          ]} />
      )}
      <Drawer open={!!viewing} onClose={() => setViewing(null)} width={1000} destroyOnClose title={viewing ? `${viewing.code} v${viewing.version} · ${viewing.title}` : ''}
        extra={viewing && (
          <Space>
            {viewing.hasSource && <Button onClick={() => void download(`/expense/policies/${viewing.id}/source`, `${viewing.code}-v${viewing.version}`)}>下载原件</Button>}
            {maintain && viewing.status === 'active' && (
              <>
                <Upload showUploadList={false} accept=".pdf,.docx,.txt,.ofd" beforeUpload={(f) => { run.mutate(() => expenseApi.uploadPolicySource(viewing.id, f)); return false; }}>
                  <Button>上传原件</Button>
                </Upload>
                <Button onClick={() => { setEditing({ base: viewing }); setViewing(null); }}>发布新版本</Button>
                <Button danger onClick={async () => {
                  const v = await prompt({ title: '停用制度依据', danger: true, description: '停用后新的审核运行不再引用该版本;已有审核的引用保留。', fields: [{ name: 'reason', label: '停用原因', required: true, multiline: true }] });
                  if (v) run.mutate(() => expenseApi.retirePolicy(viewing.id, v.reason));
                }}>停用</Button>
              </>
            )}
          </Space>
        )}>
        {viewing && <Table<PolicyClauseDto> rowKey="id" size="small" pagination={false} dataSource={viewing.clauses} columns={clauseColumns} />}
      </Drawer>
      {editing && <PolicyFormModal open base={editing.base} onClose={() => setEditing(null)} />}
    </div>
  );
}
