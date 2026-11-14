import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Col, Modal, Row, Segmented, Space, Statistic, Table, Tabs, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { can, download, errorText } from '../../api/client';
import { contractApi, type SupervisionExportLogDto, type SupervisionPreflightItemDto } from '../../api/projectContract';
import { shortTime } from '../../utils/relativeTime';
import { OrgSelect, PeriodPicker } from '../financeData/shared';

export function ContractExportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [period, setPeriod] = useState<string>(dayjs().format('YYYY-MM'));
  const [orgId, setOrgId] = useState<number | undefined>(undefined);
  const [scopeMode, setScopeMode] = useState<'all_active' | 'changed'>('all_active');

  const canExport = can('analysis:export');
  const preflight = useQuery({
    queryKey: ['contract-supervision-preflight', period, orgId, scopeMode],
    queryFn: () => contractApi.preflightSupervision({ period, orgId, scopeMode }),
    enabled: open,
  });
  const logs = useQuery({
    queryKey: ['contract-supervision-logs'],
    queryFn: () => contractApi.supervisionExportLogs(),
    enabled: open,
  });

  const exportZip = useMutation({
    mutationFn: async () => {
      const blob = await contractApi.exportSupervisionPackage({ period, orgId, scopeMode });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `纪巡财审报送包_${period}_${scopeMode}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      message.success('纪巡财审 6 表 + 附件报送包已生成并下载');
      void qc.invalidateQueries({ queryKey: ['contract-supervision-logs'] });
    },
    onError: (e) => message.error(errorText(e)),
  });

  const exportMonthly = async () => {
    const ok = await download(contractApi.monthlyLedgerExportPath({ period, orgId }), `合同月报5表_${period}.xlsx`);
    if (ok) void qc.invalidateQueries({ queryKey: ['contract-supervision-logs'] });
  };

  const pf = preflight.data;

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={960} title="合同标准报送导出（5 表月报 / 纪巡财审 6 表 + ZIP）" destroyOnClose>
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
            label: '上级《纪巡财审》6 表 + 附件 ZIP',
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Segmented
                    value={scopeMode}
                    onChange={(v) => setScopeMode(v as 'all_active' | 'changed')}
                    options={[
                      { value: 'all_active', label: '全量在途 + 本年完结' },
                      { value: 'changed', label: '仅本期新增 / 变动' },
                    ]}
                  />
                  <Space>
                    <Button onClick={() => void preflight.refetch()} loading={preflight.isFetching}>重新预检</Button>
                    <Button type="primary" disabled={!canExport || !pf || preflight.isFetching || pf.incompleteCount > 0} loading={exportZip.isPending} onClick={() => exportZip.mutate()}>
                      生成并下载 ZIP 报送包
                    </Button>
                  </Space>
                </Space>
                {!canExport && <Alert type="warning" showIcon message="当前账号缺少 analysis:export 权限，仅可查看完整性预检，不能下载导出文件。" />}
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
                    { title: '合同编号', dataIndex: 'contractNo', width: 150 },
                    { title: '合同名称', dataIndex: 'name', ellipsis: true },
                    { title: '方向', dataIndex: 'direction', width: 70, render: (v) => (v === 'income' ? <Tag color="green">收入</Tag> : <Tag>支出</Tag>) },
                    { title: '预检', dataIndex: 'ready', width: 80, render: (ok: boolean) => (ok ? <Tag color="success">就绪</Tag> : <Tag color="error">缺项</Tag>) },
                    {
                      title: '缺失字段 / 附件槽位', key: 'missing', render: (_, r) => (
                        <Space size={[4, 2]} wrap>
                          {r.missingFields.map((f) => <Tag color="red" key={'f-' + f}>字段:{f}</Tag>)}
                          {r.missingAttachments.map((a) => <Tag color="orange" key={'a-' + a}>附件:{a}</Tag>)}
                          {r.warnings.map((w) => <Tag key={'w-' + w}>{w}</Tag>)}
                          {r.ready && r.warnings.length === 0 && <Typography.Text type="secondary">齐全</Typography.Text>}
                        </Space>
                      ),
                    },
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
                />
                <Button type="primary" disabled={!canExport} onClick={() => void exportMonthly()}>
                  下载 {period} 公司 5 表月报 (.xlsx)
                </Button>
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
