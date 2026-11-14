import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, App as AntdApp, Button, Card, Col, Collapse, Descriptions, Result, Row, Segmented, Select, Space, Statistic, Table, Tag, Typography, Upload } from 'antd';
import { ApiError, can, download, errorText, getSession } from '../../api/client';
import {
  contractApi,
  type ContractImportAction,
  type ContractImportDto,
  type ContractImportKind,
  type ContractImportRowDto,
} from '../../api/projectContract';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { Money } from '../financeData/shared';
import { RowErrors } from './shared';

/**
 * AC-F04 合同导入:上传即生成预览(全量校验、逐行计划与计划哈希,不写合同);
 * 确认时服务端按同一文件重算,计划哈希一致才在一个事务里写入,失败整体回滚;重复确认返回原结果。
 */

const ACTION = { create: { text: '新增', color: 'green' }, update: { text: '更新', color: 'blue' }, unchanged: { text: '无变化', color: 'default' } } as const;
export const FIELD_LABEL: Record<string, string> = {
  name: '名称', supplier: '供应商', paid: '已付', signDate: '签订日期', contractType: '合同类型', paymentCapRatio: '付款上限比例',
  undertakerName: '承办人', undertakerDept: '承办部门', counterpartyNames: '相对方', summaryText: '主要内容',
  status: '执行状态', stage: '阶段', payments: '实付明细', receipts: '实收明细', supplement: '补充协议', dispute: '合同纠纷',
  originalAmount: '原始金额', exchangeRate: '参考汇率', rawSignDateText: '原始签订日期文本', rawAmountText: '原始金额文本',
  foreignAmountText: '原币金额原文', legacyRawNo: '原台账原始编号', noExemptReason: '无号豁免/赋码说明',
  signingOrgName: '实际签约/历史主体', legalEntityOrgName: '法定法人统计口径', isReversal: '红冲标识',
  missingFields: '待补录缺口', coManagedOrgName: '共管/互录方', canonicalEntityCode: '归并母公司代码', legacyPrefixCode: '原台账前缀',
};
export const IMPORT_KIND_LABELS: Record<ContractImportKind, string> = {
  standard_ledger: '标准合同台账',
  monthly_ledger_wan: '公司月报合同台账(万元)',
  supervision_expense_base: '纪巡财审 · 支出合同基本信息',
  supervision_expense_exec: '纪巡财审 · 支出合同执行及实付',
  supervision_expense_change: '纪巡财审 · 支出合同变更与纠纷',
  supervision_income_base: '纪巡财审 · 收入合同基本信息',
  supervision_income_exec: '纪巡财审 · 收入合同执行及实收',
  supervision_income_change: '纪巡财审 · 收入合同变更与纠纷',
};

export default function ContractImport() {
  useAssistantDomainPage({ pageKey: 'contract_import', ready: true, view: {} });
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const importId = params.get('id') ? Number(params.get('id')) : null;
  const [filter, setFilter] = useState<'all' | ContractImportAction>('all');
  const canMigrate = can('contract:migrate') || (can('master:write') && !!getSession()?.user.allOrgs);
  const [importMode, setImportMode] = useState<'standard' | 'legacy_tolerant'>('standard');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [staleConflictMsg, setStaleConflictMsg] = useState<string | null>(null);
  const [histModeFilter, setHistModeFilter] = useState<'standard' | 'legacy_tolerant' | undefined>();
  const [histStatusFilter, setHistStatusFilter] = useState<'previewed' | 'confirmed' | undefined>();

  const q = useQuery({ queryKey: ['contract-import', importId], queryFn: () => contractApi.getImport(importId!), enabled: importId != null });
  const historyQ = useQuery({
    queryKey: ['contract-imports-history', histModeFilter, histStatusFilter],
    queryFn: () => contractApi.listImports({ importMode: histModeFilter, status: histStatusFilter, limit: 30 }),
    enabled: can('contract:import') || canMigrate,
  });

  const show = (d: ContractImportDto) => {
    setStaleConflictMsg(null);
    qc.setQueryData(['contract-import', d.id], d);
    setParams({ id: String(d.id) });
    void qc.invalidateQueries({ queryKey: ['contract-imports-history'] });
  };
  const previewM = useMutation({
    mutationFn: (files: File | File[]) => contractApi.previewImport(files, { importMode }),
    onSuccess: (res) => {
      setPendingFiles([]);
      show(res);
    },
    onError: (e) => message.error(errorText(e)),
  });
  const confirmM = useMutation({
    mutationFn: (d: ContractImportDto) => contractApi.confirmImport(d.id, d.planHash),
    onSuccess: (d) => {
      show(d);
      message.success(d.replayed ? '该导入已确认过,返回原结果' : '导入已确认');
      void qc.invalidateQueries({ queryKey: ['contracts'] }); void qc.invalidateQueries({ queryKey: ['contract-summary'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 409 || e.body.code === 'PREVIEW_STALE')) {
        setStaleConflictMsg('预览期间目标合同已被并发修改（409 PREVIEW_STALE），为防止静默覆盖已拒绝写入，请重新上传预检后再确认。');
      }
      message.error(errorText(e));
    },
  });
  const d = q.data;
  if (!can('contract:import') && !canMigrate) return <Result status="403" title="没有合同导入权限" />;
  const rows = (d?.rows ?? []).filter((r) => filter === 'all' || r.action === filter);
  const paidColLabel =
    d?.paidOrReceivedLabel ??
    (rows.length > 0 && rows.every((r) => r.direction === 'income') ? '已收金额' : '已付金额');

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
            <Segmented<'standard' | 'legacy_tolerant'>
              value={importMode}
              onChange={(m) => { setImportMode(m); setPendingFiles([]); }}
              options={[
                { value: 'standard', label: '标准台账导入 · 严格校验' },
                ...(canMigrate ? [{ value: 'legacy_tolerant' as const, label: '历史容缺多簿归并入库' }] : []),
              ]}
            />
            {importMode === 'legacy_tolerant' && pendingFiles.length > 0 && (
              <Space>
                <Tag color="blue">已选 {pendingFiles.length} 份工作簿</Tag>
                <Button size="small" onClick={() => setPendingFiles([])}>清空待传</Button>
                <Button size="small" type="primary" loading={previewM.isPending} onClick={() => previewM.mutate(pendingFiles)}>
                  运行多簿统一预检
                </Button>
              </Space>
            )}
          </Space>
          <Collapse
            ghost
            size="small"
            items={[
              {
                key: 'tpls',
                label: '下载 8 种官方标准合同导入模板 (.xlsx)',
                children: (
                  <Space wrap size={[8, 8]}>
                    {(Object.entries(IMPORT_KIND_LABELS) as [ContractImportKind, string][]).map(([kind, label]) => (
                      <Button
                        key={kind}
                        size="small"
                        onClick={() => void download(contractApi.importTemplatePath(kind), `${label}.xlsx`)}
                      >
                        {label}
                      </Button>
                    ))}
                  </Space>
                ),
              },
            ]}
          />
          <Upload.Dragger
            accept=".csv,.xlsx,.xls"
            multiple={importMode === 'legacy_tolerant'}
            showUploadList={false}
            disabled={previewM.isPending}
            beforeUpload={(f, fileList) => {
              if (importMode === 'legacy_tolerant' && fileList.length > 1) {
                if (f === fileList[fileList.length - 1]) {
                  previewM.mutate(fileList);
                } else {
                  setPendingFiles(fileList);
                }
                return false;
              }
              previewM.mutate(f);
              return false;
            }}
          >
            <p>
              {previewM.isPending
                ? '正在校验…'
                : importMode === 'legacy_tolerant'
                  ? '点击或拖入多份历史合同台账 .xls / .xlsx / .csv 生成五维归并预览'
                  : '点击或拖入合同台账 .csv / .xlsx / .xls 生成预览'}
            </p>
            <p style={{ color: 'var(--newfc-text-secondary)', fontSize: 12 }}>
              按合同编号匹配:不存在则新增;已存在则只更新有变化的字段。预览不写合同,确认前可放弃。
            </p>
          </Upload.Dragger>
        </Space>
      </Card>
      {importId != null && q.error && <QueryErrorResult title="导入记录加载失败" error={q.error} refetch={q.refetch} />}
      {staleConflictMsg && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={staleConflictMsg} />}
      {d && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Descriptions size="small" bordered column={3}>
            <Descriptions.Item label="文件">{d.fileName}</Descriptions.Item>
            <Descriptions.Item label="识别模板">
              {d.importKind === 'legacy_batch_upsert'
                ? '历史多工作簿容缺归并 (legacy_batch_upsert)'
                : (IMPORT_KIND_LABELS[(d.importKind ?? 'standard_ledger') as ContractImportKind] ?? d.importKind)}
            </Descriptions.Item>
            <Descriptions.Item label="状态">{d.status === 'confirmed' ? <Tag color="success">已确认 {d.confirmedAt ? shortTime(d.confirmedAt) : ''}</Tag> : <Tag color="warning">待确认</Tag>}</Descriptions.Item>
            <Descriptions.Item label="预览时间">{shortTime(d.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="行数">{d.rowCount}</Descriptions.Item>
            <Descriptions.Item label="计划">新增 {d.counts.create} · 更新 {d.counts.update} · 无变化 {d.counts.unchanged}</Descriptions.Item>
            <Descriptions.Item label="计划哈希"><Typography.Text code>{d.planHash.slice(0, 16)}…</Typography.Text></Descriptions.Item>
          </Descriptions>
          {d.reconciliation && (
            <Card
              size="small"
              title={
                <Space>
                  <span>五维行去向对账摘要</span>
                  {d.reconciliation.closed ? <Tag color="success">100% 闭合</Tag> : <Tag color="error">未闭合</Tag>}
                </Space>
              }
            >
              <Row gutter={12}>
                <Col xs={12} md={4}><Statistic title="源表总行" value={d.reconciliation.totalSourceRows} /></Col>
                <Col xs={12} md={4}><Statistic title="噪声过滤" value={d.reconciliation.filteredNoiseRows} /></Col>
                <Col xs={12} md={4}><Statistic title="同合同折叠" value={d.reconciliation.foldedDuplicateRows} /></Col>
                <Col xs={12} md={4}><Statistic title="入库主合同" value={d.reconciliation.mainContractRows} /></Col>
                <Col xs={12} md={4}><Statistic title="补协子项" value={d.reconciliation.subEventRows} /></Col>
                <Col xs={12} md={4}><Statistic title="重号冲突与凭证线索待核" value={d.reconciliation.conflictAndClueRows} /></Col>
              </Row>
            </Card>
          )}
          {d.errorCount > 0 && <RowErrors errors={d.errors} title="校验未通过,不能确认;修正文件后重新上传" />}
          {d.result && (
            <Alert type="success" showIcon message={`已写入:新增 ${d.result.created}、更新 ${d.result.updated}、无变化 ${d.result.unchanged}`}
              action={<Button size="small" onClick={() => navigate('/contracts')}>查看合同台账</Button>} />
          )}
          {d.status === 'previewed' && d.errorCount === 0 && (
            <Space>
              <Button type="primary" loading={confirmM.isPending} onClick={() => modal.confirm({
                title: '确认导入?', content: `将新增 ${d.counts.create} 份、更新 ${d.counts.update} 份合同。服务端会按原文件重算计划,不一致时拒绝(PREVIEW_STALE)。`,
                onOk: () => confirmM.mutateAsync(d).catch(() => {}),
              })}>确认导入</Button>
              <Button onClick={() => setParams({})}>放弃</Button>
            </Space>
          )}
          <Segmented value={filter} onChange={(v) => setFilter(v as typeof filter)}
            options={[{ value: 'all', label: '全部' }, ...(['create', 'update', 'unchanged'] as const).map((a) => ({ value: a, label: `${ACTION[a].text} ${d.counts[a]}` }))]} />
          <Table<ContractImportRowDto> rowKey="row" size="small" dataSource={rows} pagination={{ pageSize: 50 }} scroll={{ x: 1580 }}
            columns={[
              { title: '行', dataIndex: 'row', width: 60 },
              { title: '动作', dataIndex: 'action', width: 80, render: (a: ContractImportAction | null) => (a ? <Tag color={ACTION[a].color}>{ACTION[a].text}</Tag> : <Tag color="error">错误</Tag>) },
              {
                title: '合同编号',
                dataIndex: 'contractNo',
                width: 165,
                render: (v: string, r) => (
                  <div>
                    <div>{v}</div>
                    {r.legacyRawNo && r.legacyRawNo !== v && (
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>原号:{r.legacyRawNo}</Typography.Text>
                    )}
                  </div>
                ),
              },
              { title: '名称', dataIndex: 'name', ellipsis: true },
              {
                title: '签约主体 / 法定法人',
                key: 'orgDual',
                width: 170,
                render: (_, r) => {
                  const signOrg = r.signingOrgName ?? r.orgName;
                  const legalOrg = r.legalEntityOrgName ?? r.orgName;
                  if (!signOrg && !legalOrg) return '—';
                  return signOrg && legalOrg && signOrg !== legalOrg ? `${signOrg} → ${legalOrg}` : (signOrg ?? legalOrg);
                },
              },
              {
                title: '金额',
                dataIndex: 'amount',
                width: 145,
                align: 'right',
                render: (v: string | null, r) => (
                  <div>
                    {v == null ? '—' : <Money value={v} />}
                    {r.currency && r.currency !== '人民币' && (
                      <div style={{ fontSize: 11, color: '#666' }}>
                        {r.currency}{r.exchangeRate ? ` (汇率 ${r.exchangeRate})` : ''}
                      </div>
                    )}
                    {r.foreignAmountText && <div style={{ fontSize: 11, color: '#666' }}>{r.foreignAmountText}</div>}
                  </div>
                ),
              },
              {
                title: paidColLabel,
                dataIndex: 'paid',
                width: 135,
                align: 'right',
                render: (v: string | null, r) => (
                  <span>
                    {v == null ? '—' : <Money value={v} />}
                    {r.direction === 'income' && paidColLabel !== '已收金额' ? <Tag color="green" style={{ marginLeft: 4 }}>已收</Tag> : null}
                  </span>
                ),
              },
              {
                title: '历史已结算/开票基线',
                dataIndex: 'legacySettledBaselineAmount',
                width: 145,
                align: 'right',
                render: (v?: string | null) => (v == null ? '—' : <Money value={v} />),
              },
              {
                title: '业务待办与特征',
                key: 'bizTags',
                width: 240,
                render: (_, r) => (
                  <Space size={[4, 4]} wrap>
                    {r.duplicateConflictGroup && <Tag color="error">同号冲突待核实</Tag>}
                    {r.amountFactSource === 'voucher_debit_clue' && <Tag color="orange">凭证线索待补原合同</Tag>}
                    {r.isInternalGroupTx && <Tag color="geekblue">集团内部关联合同</Tag>}
                    {((r.currencyLines?.length ?? 0) > 0 || (r.currency && r.currency !== '人民币')) && (
                      <Tag color="cyan">
                        双币/外币明细
                        {r.currencyLines?.length ? ` (${r.currencyLines.map((cl) => `${cl.currency} ${cl.amount}`).join(' + ')})` : ''}
                      </Tag>
                    )}
                    {r.currencyStructStatus === 'partial_unstructured' && (
                      <Tag color="warning">外币未拆分，不计入单币种总价</Tag>
                    )}
                    {(r.syntheticNoFlag || r.contractNo?.startsWith('MIG-')) && <Tag color="purple">待赋正式号 (MIG-)</Tag>}
                    {r.isReversal && <Tag color="magenta">历史红冲</Tag>}
                    {(r.missingFields?.length ?? 0) > 0 && <Tag color="gold">待补录要素 ({r.missingFields!.length})</Tag>}
                  </Space>
                ),
              },
              { title: '摘要', dataIndex: 'detailSummary', width: 180, ellipsis: true, render: (v?: string) => v ?? '—' },
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
      <Card
        size="small"
        title="近期导入批次记录"
        style={{ marginTop: 16 }}
        extra={
          <Space>
            <Select<'standard' | 'legacy_tolerant'>
              allowClear
              placeholder="导入模式"
              style={{ width: 150 }}
              value={histModeFilter}
              onChange={setHistModeFilter}
              options={[
                { value: 'standard', label: '标准台账导入' },
                { value: 'legacy_tolerant', label: '历史容缺归并' },
              ]}
            />
            <Select<'previewed' | 'confirmed'>
              allowClear
              placeholder="状态"
              style={{ width: 120 }}
              value={histStatusFilter}
              onChange={setHistStatusFilter}
              options={[
                { value: 'previewed', label: '待确认' },
                { value: 'confirmed', label: '已确认' },
              ]}
            />
          </Space>
        }
      >
        <Table<ContractImportDto>
          rowKey="id"
          size="small"
          loading={historyQ.isLoading}
          dataSource={historyQ.data ?? []}
          pagination={{ pageSize: 8 }}
          columns={[
            { title: '#', dataIndex: 'id', width: 64 },
            { title: '文件名', dataIndex: 'fileName', ellipsis: true },
            {
              title: '导入模式',
              dataIndex: 'importMode',
              width: 130,
              render: (m?: string) => (m === 'legacy_tolerant' ? <Tag color="purple">历史容缺归并</Tag> : <Tag>标准导入</Tag>),
            },
            { title: '行数', dataIndex: 'rowCount', width: 80 },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (s: string) => (s === 'confirmed' ? <Tag color="success">已确认</Tag> : <Tag color="warning">待确认</Tag>),
            },
            { title: '创建时间', dataIndex: 'createdAt', width: 140, render: (v: string) => shortTime(v) },
            {
              title: '操作',
              key: 'op',
              width: 90,
              render: (_, b) => (
                <Button size="small" type="link" onClick={() => setParams({ id: String(b.id) })}>
                  查看详情
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
