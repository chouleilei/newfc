import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Descriptions, Drawer, Form, InputNumber, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { can, download, errorText, getSession } from '../api/client';
import { stdReportApi, type StdColumnDto, type StdReportDto, type StdReportGenerate, type StdReportListItemDto, type StdReportType } from '../api/financeData';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { formatMoney, formatRatioPercent } from '../utils/decimal';
import { shortTime } from '../utils/relativeTime';
import { compact, defaultOrgId, EXCEPTION_REASON_FIELD, lastPeriod, OrgSelect, PeriodPicker, usePrompt } from './financeData/shared';

/** AC-F19 标准报表:生成时冻结内容与来源引用,页面与 Excel 导出只读冻结内容;复核一次。 */

export const REPORT_TYPE_LABEL: Record<StdReportType, string> = {
  budget_execution: '经营预算执行表', statement_summary: '财务报表摘要', eas_recon: 'EAS 对账结果表', contract_payment_ledger: '合同付款台账',
};
const SCOPE_OPTIONS = [{ value: 'consolidated', label: '合并' }, { value: 'parent', label: '母公司' }, { value: 'subsidiary', label: '子公司' }];

/** 冻结单元格展示:金额/比率只做字符串排版。 */
export function renderCell(col: StdColumnDto, v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  if (col.kind === 'money') return formatMoney(String(v));
  if (col.kind === 'ratio') return formatRatioPercent(String(v));
  return String(v);
}

function GenerateModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (r: StdReportDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ reportType: StdReportType; year?: number; orgId?: number; period?: string; scope?: string }>();
  const type = Form.useWatch('reportType', form);
  const gen = useMutation({
    mutationFn: (v: { reportType: StdReportType; year?: number; orgId?: number; period?: string; scope?: string }) => {
      const body = v.reportType === 'budget_execution' ? compact({ reportType: v.reportType, year: v.year, orgId: v.orgId })
        : v.reportType === 'statement_summary' ? compact({ reportType: v.reportType, orgId: v.orgId, period: v.period, scope: v.scope })
          : compact({ reportType: v.reportType, orgId: v.orgId, period: v.period });
      // contract_payment_ledger 与 eas_recon 同为 orgId + period;不选组织时为全组织口径
      return stdReportApi.generate(body as StdReportGenerate);
    },
    onSuccess: (r) => { message.success('报表已生成并冻结'); onDone(r); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  const allOrgs = getSession()?.user.allOrgs ?? false;
  return (
    <Modal open={open} title="生成标准报表" onCancel={onClose} confirmLoading={gen.isPending} destroyOnClose onOk={() => form.validateFields().then((v) => gen.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ reportType: 'budget_execution', year: new Date().getFullYear(), orgId: defaultOrgId(), period: lastPeriod(), scope: undefined }}>
        <Form.Item name="reportType" label="报表类型"><Select options={Object.entries(REPORT_TYPE_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
        {type === 'budget_execution' && <Form.Item name="year" label="年度" rules={[{ required: true }]}><InputNumber min={1900} max={9999} style={{ width: 140 }} /></Form.Item>}
        <Form.Item name="orgId" label={type === 'budget_execution' || type === 'contract_payment_ledger' ? `组织${allOrgs ? '(不选为全组织口径)' : ''}` : '组织'}
          rules={(type === 'budget_execution' || type === 'contract_payment_ledger') && allOrgs ? [] : [{ required: true, message: '请选择组织' }]}>
          <OrgSelect onChange={(v) => form.setFieldValue('orgId', v)} width={320} />
        </Form.Item>
        {type !== 'budget_execution' && <Form.Item name="period" label="期间" rules={[{ required: true }]}><PeriodPicker onChange={(v) => form.setFieldValue('period', v)} allowClear={false} /></Form.Item>}
        {type === 'statement_summary' && <Form.Item name="scope" label="口径(缺省合并优先)"><Select allowClear options={SCOPE_OPTIONS} /></Form.Item>}
      </Form>
      <Typography.Text type="secondary">
        {type === 'budget_execution' ? '取该年当前采用预算与最新实际,复用执行分析口径。' : type === 'statement_summary' ? '取当前财报批次的语义指标与比率。'
          : type === 'contract_payment_ledger' ? '冻结合同阶段、当前金额、本期与累计已付、付款比例及合同版本(不含作废合同)。' : '取当前 EAS 对账集合的规则结果。'}
        缺少来源时不生成(REPORT_SOURCE_MISSING)。
      </Typography.Text>
    </Modal>
  );
}

function ReportDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const q = useQuery({ queryKey: ['std-report', id], queryFn: () => stdReportApi.get(id!), enabled: id != null });
  const review = useMutation({
    mutationFn: (v: { comment?: string; exceptionReason?: string }) => stdReportApi.review(id!, compact(v)),
    onSuccess: () => { message.success('已复核'); void qc.invalidateQueries({ queryKey: ['std-report'] }); void qc.invalidateQueries({ queryKey: ['std-reports'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const r = q.data;
  return (
    <Drawer open={id != null} onClose={onClose} width={1100} title={r?.title ?? '标准报表'} destroyOnClose
      extra={r && (
        <Space>
          <Button onClick={() => void download(`/standard-reports/${r.id}/export`, `${r.title}.xlsx`)} icon={<i className="ri-file-excel-2-line" aria-hidden />}>导出 Excel</Button>
          {r.status === 'generated' && can('report:approve') && (
            <Button type="primary" onClick={async () => { const v = await prompt({ title: '复核报表', description: '复核后状态变为已复核,不能再次复核。', fields: [{ name: 'comment', label: '复核意见', multiline: true }, EXCEPTION_REASON_FIELD] }); if (v) review.mutate(v); }}>复核</Button>
          )}
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="报表加载失败" error={q.error} refetch={q.refetch} /> : r && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Descriptions size="small" bordered column={3}>
            <Descriptions.Item label="类型">{REPORT_TYPE_LABEL[r.reportType]}</Descriptions.Item>
            <Descriptions.Item label="组织">{r.orgName ?? '全组织'}</Descriptions.Item>
            <Descriptions.Item label="期间">{r.period}</Descriptions.Item>
            <Descriptions.Item label="生成">{shortTime(r.generatedAt)}</Descriptions.Item>
            <Descriptions.Item label="状态">{r.status === 'reviewed' ? <Tag color="success">已复核</Tag> : <Tag color="warning">待复核</Tag>}</Descriptions.Item>
            <Descriptions.Item label="内容指纹"><Typography.Text code copyable={{ text: r.contentSha256 }}>{r.contentSha256.slice(0, 12)}…</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="来源" span={3}>
              {Object.entries(r.sources).map(([k, v]) => <Tag key={k}>{k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}</Tag>)}
            </Descriptions.Item>
            {r.reviewedAt && (
              <Descriptions.Item label="复核" span={3}>
                {shortTime(r.reviewedAt)} {r.reviewComment ?? ''}{r.selfReview && <Tag color="warning" style={{ marginLeft: 6 }}>同人复核:{r.exceptionReason}</Tag>}
              </Descriptions.Item>
            )}
          </Descriptions>
          {r.summary.length > 0 && (
            <Space wrap>{r.summary.map((s) => <Tag key={s.label} style={{ padding: '4px 8px' }}>{s.label}:{s.value}</Tag>)}</Space>
          )}
          <Table
            size="small" rowKey={(_, i) => String(i)} dataSource={r.rows} pagination={false} scroll={{ x: 'max-content', y: 560 }}
            columns={r.columns.map((c) => ({
              title: c.label, dataIndex: c.key, key: c.key, align: c.kind === 'text' ? undefined : 'right' as const,
              render: (v: string | number | null) => <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{renderCell(c, v)}</span>,
            }))}
          />
        </Space>
      )}
    </Drawer>
  );
}

export default function StandardReports() {
  const qc = useQueryClient();
  const [reportType, setReportType] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [generating, setGenerating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const list = useQuery({ queryKey: ['std-reports', reportType, status], queryFn: () => stdReportApi.list({ reportType, status }) });
  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="报表类型" value={reportType} onChange={setReportType} style={{ width: 170 }} options={Object.entries(REPORT_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        <Select allowClear placeholder="状态" value={status} onChange={setStatus} style={{ width: 110 }} options={[{ value: 'generated', label: '待复核' }, { value: 'reviewed', label: '已复核' }]} />
        {can('report:write') && <Button type="primary" onClick={() => setGenerating(true)}>生成报表</Button>}
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="报表生成后内容冻结:来源数据之后的变化不影响已生成报表;页面与 Excel 导出逐行一致。合同付款台账与风险整改台账在后续阶段加入。" />
      {list.error ? <QueryErrorResult title="报表加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<StdReportListItemDto>
          size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 20, showSizeChanger: false }}
          onRow={(r) => ({ onClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: '标题', dataIndex: 'title' },
            { title: '类型', dataIndex: 'reportType', width: 150, render: (v: StdReportType) => REPORT_TYPE_LABEL[v] },
            { title: '组织', dataIndex: 'orgName', width: 150, render: (v: string | null) => v ?? '全组织' },
            { title: '期间', dataIndex: 'period', width: 90 },
            { title: '行数', dataIndex: 'rowCount', width: 70, align: 'right' },
            { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => (v === 'reviewed' ? <Tag color="success">已复核</Tag> : <Tag color="warning">待复核</Tag>) },
            { title: '生成', dataIndex: 'generatedAt', width: 130, render: (v: string) => shortTime(v) },
          ]}
        />
      )}
      <GenerateModal open={generating} onClose={() => setGenerating(false)} onDone={(r) => { void qc.invalidateQueries({ queryKey: ['std-reports'] }); setOpenId(r.id); }} />
      <ReportDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
