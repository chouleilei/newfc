import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Col, Form, Input, Modal, Row, Segmented, Space, Statistic, Table, Tabs, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { can, download, errorText } from '../../api/client';
import {
  contractApi,
  type MonthlyReportLogDto,
  type SupervisionExportLogDto,
  type SupervisionExportPurpose,
  type SupervisionPreflightItemDto,
} from '../../api/projectContract';
import { shortTime } from '../../utils/relativeTime';
import { OrgSelect, PeriodPicker } from '../financeData/shared';

export const EXPORT_FIELD_LABELS: Record<string, string> = {
  contractNo: '合同编号',
  name: '合同名称',
  signDate: '签订日期',
  counterpartyNames: '相对方名称',
  originalAmount: '合同原始金额',
  unitPriceDesc: '单价标准说明',
  exchangeRate: '参考汇率',
  ourSignatoryName: '我方签署人姓名',
  ourSignatoryIsLegalRep: '我方是否法定代表人签署',
  counterpartySignatoryIsLegalRep: '对方是否法定代表人签署',
  procurementMethod: '采购方式',
  reportCategory: '监督报送分类',
  undertakerName: '承办人',
  negativeReversal: '负向红冲金额',
  unstructuredForeignCurrency: '未拆分多币种金额',
  duplicateConflict: '同号冲突待核实',
  directoryCollision: '导出目录名碰撞',
};

export const ATTACHMENT_SLOT_LABELS: Record<string, string> = {
  signed: '已盖章合同扫描件(signed)',
  contract_text: '合同正文文本(contract_text)',
  our_signatory_auth: '我方签署授权委托书',
  counterparty_signatory_auth: '对方签署授权委托书',
  procurement: '招采定标审批依据',
  change_agreement: '补充/变更协议扫描件',
  settlement: '结算审定单',
  invoice: '发票或收付款凭据',
};

export function ContractExportModal({
  open,
  onClose,
  onOpenContract,
}: {
  open: boolean;
  onClose: () => void;
  onOpenContract?: (contractId: number) => void;
}) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [period, setPeriod] = useState<string>(dayjs().format('YYYY-MM'));
  const [orgId, setOrgId] = useState<number | undefined>(undefined);
  const [scopeMode, setScopeMode] = useState<'all_active' | 'changed'>('all_active');
  const [exportPurpose, setExportPurpose] = useState<SupervisionExportPurpose>('supervision_submit');
  const [oaForm] = Form.useForm<{ oaRefNo: string }>();

  const canExport = can('analysis:export');
  const canWriteContract = can('contract:write');
  const preflight = useQuery({
    queryKey: ['contract-supervision-preflight', period, orgId, scopeMode, exportPurpose],
    queryFn: () => contractApi.preflightSupervision({ period, orgId, scopeMode, exportPurpose }),
    enabled: open,
  });
  const logs = useQuery({
    queryKey: ['contract-supervision-logs'],
    queryFn: () => contractApi.supervisionExportLogs(),
    enabled: open,
  });
  const monthlyLogsQ = useQuery({
    queryKey: ['contract-monthly-report-logs', period, orgId],
    queryFn: () => contractApi.monthlyReportLogs({ reportMonth: period, orgId }),
    enabled: open && can('contract:read'),
  });
  const submitOaMut = useMutation({
    mutationFn: (v: { oaRefNo: string }) =>
      contractApi.submitMonthlyReportLog({
        orgId,
        reportMonth: period,
        oaRefNo: v.oaRefNo.trim(),
      }),
    onSuccess: (res) => {
      message.success(`已登记 ${res.reportMonth} 月报 OA 正式报送记录（${res.oaRefNo}）`);
      oaForm.resetFields();
      void monthlyLogsQ.refetch();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const exportZip = useMutation({
    mutationFn: async () => {
      const blob = await contractApi.exportSupervisionPackage({ period, orgId, scopeMode, exportPurpose });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        exportPurpose === 'internal_archive'
          ? `合同历史归档备份包_${period}_${scopeMode}.zip`
          : `纪巡财审报送包_${period}_${scopeMode}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      message.success('5表月报 / 纪巡财审 6套官方台账（8张工作表）+ 附件 ZIP 已生成并下载');
      void qc.invalidateQueries({ queryKey: ['contract-supervision-logs'] });
    },
    onError: (e) => message.error(errorText(e)),
  });

  const exportMonthly = async () => {
    const ok = await download(contractApi.monthlyLedgerExportPath({ period, orgId }), `合同月报5表_${period}.xlsx`);
    if (ok) {
      void qc.invalidateQueries({ queryKey: ['contract-supervision-logs'] });
      void monthlyLogsQ.refetch();
    }
  };

  const pf = preflight.data;
  const zipDisabled =
    !canExport ||
    !pf ||
    preflight.isFetching ||
    (exportPurpose === 'supervision_submit' && pf.incompleteCount > 0);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1040}
      title="合同标准报送导出（5表月报 / 纪巡财审 6套官方台账（8张工作表）+ 附件 ZIP）"
      destroyOnClose
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <span>报送期间：</span>
        <PeriodPicker value={period} onChange={(v) => setPeriod(v || dayjs().format('YYYY-MM'))} allowClear={false} />
        <span>组织范围：</span>
        <OrgSelect value={orgId} onChange={(v) => setOrgId(v)} placeholder="全部授权组织" />
      </Space>

      <Tabs
        items={[
          {
            key: 'supervision',
            label: '纪巡财审 6套官方台账（8张工作表）+ 附件 ZIP',
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Space wrap>
                    <Segmented<SupervisionExportPurpose>
                      value={exportPurpose}
                      onChange={(v) => setExportPurpose(v)}
                      options={[
                        { value: 'supervision_submit', label: '报送上级《纪巡财审》 · 强校验门禁' },
                        { value: 'internal_archive', label: '内部历史全量归档备份' },
                      ]}
                    />
                    <Segmented
                      value={scopeMode}
                      onChange={(v) => setScopeMode(v as 'all_active' | 'changed')}
                      options={[
                        { value: 'all_active', label: '全量在途 + 本年完结' },
                        { value: 'changed', label: '仅本期新增 / 变动' },
                      ]}
                    />
                  </Space>
                  <Space>
                    <Button onClick={() => void preflight.refetch()} loading={preflight.isFetching}>重新预检</Button>
                    <Button type="primary" disabled={zipDisabled} loading={exportZip.isPending} onClick={() => exportZip.mutate()}>
                      {exportPurpose === 'internal_archive' ? '打包下载内部归档 ZIP' : '生成并下载 ZIP 报送包'}
                    </Button>
                  </Space>
                </Space>
                {!canExport && <Alert type="warning" showIcon message="当前账号缺少 analysis:export 权限，仅可查看完整性预检，不能下载导出文件。" />}
                {exportPurpose === 'internal_archive' && pf && pf.incompleteCount > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    message={`包含 ${pf.incompleteCount} 份待补录缺口合同，ZIP 根目录将附带《缺口待补录清单.xlsx》`}
                  />
                )}
                {pf && (
                  <Row gutter={12}>
                    <Col span={8}><Card size="small"><Statistic title="纳入报送合同" value={pf.totalCount} /></Card></Col>
                    <Col span={8}><Card size="small"><Statistic title="完整就绪" value={pf.readyCount} valueStyle={{ color: '#3f8600' }} /></Card></Col>
                    <Col span={8}><Card size="small"><Statistic title="待补录缺项" value={pf.incompleteCount} valueStyle={pf.incompleteCount > 0 ? { color: '#cf1322' } : undefined} /></Card></Col>
                  </Row>
                )}
                <Table<SupervisionPreflightItemDto>
                  rowKey="contractId"
                  size="small"
                  loading={preflight.isFetching}
                  dataSource={pf?.items ?? []}
                  pagination={{ pageSize: 8 }}
                  columns={[
                    {
                      title: '合同编号',
                      dataIndex: 'contractNo',
                      width: 155,
                      render: (v: string, r) =>
                        onOpenContract ? (
                          <Button
                            type="link"
                            size="small"
                            style={{ padding: 0, height: 'auto' }}
                            onClick={() => {
                              onClose();
                              onOpenContract(r.contractId);
                            }}
                          >
                            {v}
                          </Button>
                        ) : (
                          v
                        ),
                    },
                    { title: '合同名称', dataIndex: 'name', ellipsis: true },
                    { title: '方向', dataIndex: 'direction', width: 70, render: (v) => (v === 'income' ? <Tag color="green">收入</Tag> : <Tag>支出</Tag>) },
                    { title: '预检', dataIndex: 'ready', width: 80, render: (ok: boolean) => (ok ? <Tag color="success">就绪</Tag> : <Tag color="error">缺项</Tag>) },
                    {
                      title: '正文/招标就绪摘要',
                      key: 'docSummary',
                      width: 210,
                      render: (_, r) => {
                        const bodyStatus =
                          r.bodyDocStatus ??
                          (r.missingAttachments.includes('signed') && !r.missingAttachments.includes('contract_text')
                            ? 'contract_text'
                            : r.missingAttachments.includes('signed')
                              ? 'missing'
                              : 'signed');
                        return (
                          <Space size={[4, 2]} wrap>
                            {bodyStatus === 'signed' && <Tag color="success">签署扫描件 signed</Tag>}
                            {bodyStatus === 'contract_text' && <Tag color="processing">合同文本 contract_text</Tag>}
                            {bodyStatus === 'missing' && <Tag color="error">缺失正文</Tag>}
                            {r.procurementReady === true && <Tag color="cyan">招标齐全</Tag>}
                            {r.procurementReady === false && <Tag color="warning">招标待补录</Tag>}
                          </Space>
                        );
                      },
                    },
                    {
                      title: '缺失字段 / 附件槽位', key: 'missing', render: (_, r) => (
                        <Space size={[4, 2]} wrap>
                          {r.missingFields.map((f) => <Tag color="red" key={'f-' + f}>字段:{EXPORT_FIELD_LABELS[f] ?? f}</Tag>)}
                          {r.missingAttachments.map((a) => <Tag color="orange" key={'a-' + a}>附件:{ATTACHMENT_SLOT_LABELS[a] ?? a}</Tag>)}
                          {r.warnings.map((w) => <Tag key={'w-' + w}>{w}</Tag>)}
                          {r.ready && r.warnings.length === 0 && <Typography.Text type="secondary">齐全</Typography.Text>}
                        </Space>
                      ),
                    },
                    ...(onOpenContract
                      ? [
                          {
                            title: '操作',
                            key: 'locate',
                            width: 90,
                            render: (_: unknown, r: SupervisionPreflightItemDto) => (
                              <Button
                                size="small"
                                type={r.ready ? 'link' : 'primary'}
                                ghost={!r.ready}
                                onClick={() => {
                                  onClose();
                                  onOpenContract(r.contractId);
                                }}
                              >
                                {r.ready ? '查看' : '去补录'}
                              </Button>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              </Space>
            ),
          },
          {
            key: 'monthly',
            label: '公司每月 28 日 5 表月报',
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <Alert
                  type="info"
                  showIcon
                  message="按制度第 15 章及附件 9～11 自动生成《01_月度统计表》《02_合同台账总表》《03_结算动态分表》《04_变更动态分表》《05_招标项目清查表》，金额由整数分精确折算为万元。"
                  description="注意：仅下载月报 Excel 只记录「已下载导出 (exportedAt)」，须通过 OA 完成正式呈批后在下方登记「OA 报送单号」方标记为「已通过 OA 正式报送 (submittedAt)」，用于消除每月 28 日月报逾期预警 (CW-28)。"
                />
                <Space wrap>
                  <Button type="primary" disabled={!canExport} onClick={() => void exportMonthly()}>
                    下载 {period} 公司 5 表月报 (.xlsx)
                  </Button>
                </Space>
                {canWriteContract && (
                  <Card size="small" title={`登记 ${period} 月报 OA 正式报送回执`}>
                    <Form
                      form={oaForm}
                      layout="inline"
                      onFinish={(v) => submitOaMut.mutate(v)}
                    >
                      <Form.Item
                        name="oaRefNo"
                        label="OA 流程单号/回执号"
                        rules={[{ required: true, whitespace: true, message: '请填写 OA 报送单号' }]}
                      >
                        <Input placeholder="如 OA-HTYB-202610-008" style={{ width: 260 }} maxLength={120} />
                      </Form.Item>
                      <Form.Item>
                        <Button type="primary" htmlType="submit" loading={submitOaMut.isPending}>
                          登记本月 OA 已报送
                        </Button>
                      </Form.Item>
                    </Form>
                  </Card>
                )}
                <Table<MonthlyReportLogDto>
                  rowKey="id"
                  size="small"
                  loading={monthlyLogsQ.isLoading}
                  dataSource={monthlyLogsQ.data ?? []}
                  pagination={false}
                  locale={{ emptyText: `${period} 尚无月报导出或 OA 报送记录` }}
                  columns={[
                    { title: '单位', dataIndex: 'orgName', width: 160 },
                    { title: '报送月份', dataIndex: 'reportMonth', width: 100 },
                    {
                      title: '下载导出状态 (exportedAt)',
                      dataIndex: 'exportedAt',
                      width: 190,
                      render: (v: string | null) =>
                        v ? <Tag color="blue">已下载导出 · {shortTime(v)}</Tag> : <Tag>未下载</Tag>,
                    },
                    {
                      title: 'OA 正式报送状态 (submittedAt)',
                      key: 'submitted',
                      render: (_, r) =>
                        r.submittedAt ? (
                          <Space size={4} wrap>
                            <Tag color="success">已通过 OA 正式报送</Tag>
                            <Typography.Text code>{r.oaRefNo}</Typography.Text>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {r.submittedByName ? `${r.submittedByName} · ` : ''}{shortTime(r.submittedAt)}
                            </Typography.Text>
                          </Space>
                        ) : (
                          <Tag color="warning">仅下载未登记 OA 报送</Tag>
                        ),
                    },
                  ]}
                />
              </Space>
            ),
          },
          {
            key: 'logs',
            label: '最近导出记录',
            children: (
              <Table<SupervisionExportLogDto>
                rowKey="id"
                size="small"
                dataSource={logs.data ?? []}
                pagination={{ pageSize: 8 }}
                columns={[
                  { title: '类型', dataIndex: 'exportKind', width: 130, render: (v) => (v === 'monthly_ledger' ? <Tag color="blue">5表月报</Tag> : <Tag color="purple">纪巡财审ZIP</Tag>) },
                  { title: '期间', dataIndex: 'period', width: 90 },
                  { title: '合同数', dataIndex: 'contractCount', width: 80 },
                  { title: '文件名', dataIndex: 'fileName', ellipsis: true },
                  { title: '大小', dataIndex: 'byteSize', width: 100, render: (n: number) => `${Math.max(1, Math.round(n / 1024))} KB` },
                  { title: '导出时间', dataIndex: 'createdAt', width: 140, render: (v: string) => shortTime(v) },
                ]}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}
