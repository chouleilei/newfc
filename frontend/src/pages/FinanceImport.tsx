import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, App, Button, Card, Checkbox, Col, DatePicker, Descriptions, Divider, Form, Input, Modal, Popconfirm, Row, Select, Space, Spin, Statistic, Tabs, Tag, Typography, Upload } from 'antd';
import type { TableColumnsType, TabsProps } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import { api, download, ApiError } from '../api/client';
import { errorText } from '../components/TreeNodePage';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { statusColor, useThemeMode } from '../theme';
import { invalidateAnalysisQueries } from '../utils/queryInvalidation';
import { CODE_WIDTH } from '../utils/tableColumns';
import { useUrlScopeSync } from '../hooks/useUrlScopeSync';
import type { ScopeIssue, WorkspaceScope } from '../utils/workspaceScope';
import { MappingCandidatesPanel, type CandidateInput, type Candidate } from './financeImport/MappingCandidates';
import { SourceProfileForm } from './financeImport/SourceProfileForm';
import ImportPreviewModal from '../components/ImportPreviewPanel';

interface Profile { id: number; code: string; name: string; adapter_type: string; config_json: string; status: string }
interface Mapping { id: number; source_profile_id: number; version_no: number; name: string; status: string; created_by: string; reviewed_by: string | null; locked_at: string | null }
interface Issue { gate: string; code: string; message: string; sourceSheet?: string; sourceRow?: number }
interface Report {
  passed: boolean;
  counts: { sourceRows: number; nonZeroRows: number; excludedNonZeroRows?: number; organizations: number; sourceAccounts: number; outputRows: number };
  errors: Issue[];
  warnings: Issue[];
  conservation: { sourceCents: number; allocatedCents: number; differenceCents: number; passed: boolean };
  reconciliations: { item: string; officialCents: number; mappedCents: number; differenceCents: number; toleranceCents: number; passed: boolean }[];
  journalVerification?: {
    provided: boolean; passed: boolean; sourceRows: number; includedRows: number; ignoredOtherPeriodRows: number; ignoredUnpostedRows: number;
    accountCount: number; matchedCount: number; mismatchCount: number; toleranceCents: number;
    differences: { accountCode: string; accountName: string; balanceDebitCents: number; journalDebitCents: number; debitDifferenceCents: number; balanceCreditCents: number; journalCreditCents: number; creditDifferenceCents: number }[];
  };
  hashes: { balanceSha256: string; profitSha256: string; journalSha256?: string; outputSha256?: string };
}
/** validation 为 null:批次仍在解析(或被取消)时后端不落完整报告,前端展示「报告尚未生成」。 */
interface Conversion { id: number; source_profile_id: number; mapping_version_id: number; year: number; snapshot_date: string; status: string; revision_of_id: number | null; balance_name: string; balance_sha256: string; profit_name: string; profit_sha256: string; journal_name: string | null; journal_sha256: string | null; import_batch_id: number | null; created_at: string; validation: Report | null; hasJournal: boolean; hasOutput: boolean }
type JournalDifference = NonNullable<Report['journalVerification']>['differences'][number];
type ReconciliationRow = Report['reconciliations'][number];
interface ParallelTrial {
  id: number; conversion_batch_id: number; status: string; manual_name: string; manual_sha256: string; created_at: string; reviewed_at: string | null;
  comparison: { year: number; snapshotDate: string; totalCombinations: number; matchedCount: number; mismatchCount: number; netDifferenceCents: number; absoluteDifferenceCents: number; ignoredOutsideScopeRows: number; differences: { orgCode: string; accountCode: string; convertedCents: number; manualCents: number; differenceCents: number }[] };
  explanations: { orgCode: string; accountCode: string; reason: string; resolution: string }[];
}

/** 映射审核明细行(与 mapping.service 的 list* 返回一致)。 */
interface OrgMappingRow {
  id: number; source_book_code: string; source_org_code: string; source_org_name: string; source_aux_json: string;
  target_org_id: number; priority: number; note: string; origin: string; reviewed: number;
  target_org_code: string | null; target_org_name: string | null;
  current_target_org_code: string | null; current_target_org_name: string | null;
}
interface AccountMappingRow {
  id: number; source_account_code: string; source_account_name: string; source_aux_json: string;
  target_account_id: number; amount_rule: string; allocation_method: string; allocation_weight: number;
  priority: number; status: string; note: string; origin: string; reviewed: number;
  target_account_code: string | null; target_account_name: string | null; target_account_type: string | null;
  current_target_account_code: string | null; current_target_account_name: string | null; current_target_account_type: string | null;
}
interface ReconciliationRuleRow {
  id: number; source_line_alias: string; target_type: string; target_code: string; org_scope_json: string;
  comparison: string; tolerance_cents: number; tolerance_reason: string; required: number;
}

/** 整表 PUT 的输入行(与 mapping.service replace* 的字段一致)。 */
interface OrgMappingInput {
  sourceBookCode: string; sourceOrgCode: string; sourceOrgName: string; sourceAux: Record<string, unknown>;
  targetOrgId: number; priority: number; note: string; origin?: string; reviewed?: number;
}
interface AccountMappingInput {
  sourceAccountCode: string; sourceAccountName: string; sourceAux: Record<string, unknown>; targetAccountId: number;
  amountRule: string; allocationMethod: string; allocationWeight: number; priority: number; status: string;
  note: string; origin?: string; reviewed?: number;
}

interface ProfileFormValues { code: string; name: string; config: string }
interface MappingFormValues { sourceProfileId: number; name: string }
interface ConversionFormValues { sourceProfileId: number; mappingVersionId: number; period: Dayjs }
interface MappingActionResult { passed?: boolean; errors?: Issue[] }

/** UX-18 修订目标只读查询响应(与后端 findRevisionTarget 一致)。 */
interface RevisionTargetResult {
  sourceProfileId: number; year: number; snapshotDate: string;
  target: {
    id: number; status: string; mappingVersionId: number; revisionOfId: number | null;
    createdAt: string; importedAt: string | null;
    importBatchId: number | null; importBatchStatus: string | null;
    resultSummary: { count: number; added: number; modified: number; cleared: number } | null;
  } | null;
  revisable: boolean;
  reasonCode: 'ok' | 'no_prior_batch' | 'parsing_in_flight';
  reason: string | null;
}

const statusTag = (status: string) => {  const color: Record<string, string> = { draft: 'blue', locked: 'green', retired: 'default', parsing: 'processing', blocked: 'red', validated: 'green', imported: 'purple', cancelled: 'default', compared: 'orange', explained: 'blue', passed: 'green' };
  const label: Record<string, string> = { draft: '草稿', locked: '已锁定', retired: '已停用', parsing: '解析中', blocked: '已阻断', validated: '已校验', imported: '已导入', cancelled: '已取消', compared: '待分析', explained: '差异已解释', passed: '分毫一致' };
  return <Tag color={color[status]}>{label[status] ?? status}</Tag>;
};
const cents = (v: number) => (v / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function SourceAndMapping() {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [profileOpen, setProfileOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [profileForm] = Form.useForm<ProfileFormValues>();
  const [mappingForm] = Form.useForm<MappingFormValues>();
  const [selected, setSelected] = useState<number>();
  const profiles = useQuery({ queryKey: ['finance-profiles'], queryFn: () => api.get<{ items: Profile[] }>('/finance/source-profiles') });
  const mappings = useQuery({ queryKey: ['finance-mappings'], queryFn: () => api.get<{ items: Mapping[] }>('/finance/mapping-versions') });
  const selectedMapping = mappings.data?.items.find((v) => v.id === selected);
  const orgRules = useQuery({ queryKey: ['finance-org-rules', selected], enabled: !!selected, queryFn: () => api.get<{ items: OrgMappingRow[] }>(`/finance/mapping-versions/${selected}/org-mappings`) });
  const accountRules = useQuery({ queryKey: ['finance-account-rules', selected], enabled: !!selected, queryFn: () => api.get<{ items: AccountMappingRow[] }>(`/finance/mapping-versions/${selected}/account-mappings`) });
  const recRules = useQuery({ queryKey: ['finance-rec-rules', selected], enabled: !!selected, queryFn: () => api.get<{ items: ReconciliationRuleRow[] }>(`/finance/mapping-versions/${selected}/reconciliation-rules`) });
  const createProfile = useMutation({
    mutationFn: (v: ProfileFormValues) => api.post('/finance/source-profiles', { ...v, adapterType: 'fixed_finance_system_v1', config: JSON.parse(v.config) }),
    onSuccess: () => { message.success('数据源已创建'); setProfileOpen(false); qc.invalidateQueries({ queryKey: ['finance-profiles'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const createMapping = useMutation({
    mutationFn: (v: MappingFormValues) => api.post('/finance/mapping-versions', v),
    onSuccess: () => { message.success('映射草稿已创建'); setMappingOpen(false); qc.invalidateQueries({ queryKey: ['finance-mappings'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const action = async (id: number, name: 'clone' | 'validate' | 'lock' | 'retire') => {
    try {
      const r = await api.post<MappingActionResult>(`/finance/mapping-versions/${id}/${name}`);
      if (name === 'validate') modal.info({
        title: r.passed ? '映射完整性检查通过' : '映射完整性检查未通过',
        content: r.passed ? '可执行锁定' : <div>{(r.errors ?? []).map((e) => <Alert key={e.code + e.message} type="error" message={e.message} style={{ marginBottom: 8 }} />)}</div>,
        width: 680,
      });
      else message.success('操作完成');
      qc.invalidateQueries({ queryKey: ['finance-mappings'] });
    } catch (e) {
      // 含未复核建议行时锁定需显式确认(计划阶段二.3:不新增阻断规则,只要求确认)
      if (name === 'lock' && e instanceof ApiError && e.body?.code === 'UNREVIEWED_MAPPINGS') {
        modal.confirm({
          title: '映射含未复核建议行',
          content: `${e.message}。逐行复核可回到映射明细点「标记复核」;确认仍要锁定?`,
          okText: '确认锁定',
          onOk: async () => {
            try {
              await api.post(`/finance/mapping-versions/${id}/lock`, { confirmUnreviewed: true });
              message.success('操作完成');
              qc.invalidateQueries({ queryKey: ['finance-mappings'] });
            } catch (err) { message.error(errorText(err)); }
          },
        });
        return;
      }
      message.error(errorText(e));
    }
  };
  // 采纳候选建议:整表读取 → 追加带来源标记与未复核状态的新行 → 整表 PUT(与手工编辑同一写入通道,本期无按行 patch)
  const serializeOrgRow = (r: OrgMappingRow): OrgMappingInput => ({ sourceBookCode: r.source_book_code, sourceOrgCode: r.source_org_code, sourceOrgName: r.source_org_name, sourceAux: JSON.parse(r.source_aux_json || '{}') as Record<string, unknown>, targetOrgId: r.target_org_id, priority: r.priority, note: r.note, origin: r.origin, reviewed: r.reviewed });
  const serializeAccRow = (r: AccountMappingRow): AccountMappingInput => ({ sourceAccountCode: r.source_account_code, sourceAccountName: r.source_account_name, sourceAux: JSON.parse(r.source_aux_json || '{}') as Record<string, unknown>, targetAccountId: r.target_account_id, amountRule: r.amount_rule, allocationMethod: r.allocation_method, allocationWeight: r.allocation_weight, priority: r.priority, status: r.status, note: r.note, origin: r.origin, reviewed: r.reviewed });
  const adoptCandidate = async (kind: 'org' | 'account', input: CandidateInput, candidate: Candidate) => {
    await adoptCandidateBatch(kind, [{ input, candidate }]);
  };
  // 批量采纳:一次整表 PUT 追加全部选择(本期无按行 patch,整表提交是唯一写入通道)
  const adoptCandidateBatch = async (kind: 'org' | 'account', rows: { input: CandidateInput; candidate: Candidate }[]) => {
    if (!selected || rows.length === 0) return;
    const noteOf = (candidate: Candidate) => `候选建议采纳(${candidate.source}${candidate.reason ? `:${candidate.reason}` : ''})`;
    const originOf = (candidate: Candidate) => candidate.source === 'ai' ? 'ai' : 'deterministic';
    if (kind === 'org') {
      const appended: OrgMappingInput[] = rows.map(({ input, candidate }) => ({ sourceBookCode: input.sourceBookCode ?? '', sourceOrgCode: input.sourceCode ?? '', sourceOrgName: input.sourceName ?? '', sourceAux: {}, targetOrgId: candidate.targetId, priority: 0, note: noteOf(candidate), origin: originOf(candidate), reviewed: 0 }));
      const items = [...(orgRules.data?.items ?? []).map(serializeOrgRow), ...appended];
      await api.put(`/finance/mapping-versions/${selected}/org-mappings`, { items });
      qc.invalidateQueries({ queryKey: ['finance-org-rules', selected] });
    } else {
      const appended: AccountMappingInput[] = rows.map(({ input, candidate }) => ({ sourceAccountCode: input.sourceCode ?? '', sourceAccountName: input.sourceName ?? '', sourceAux: {}, targetAccountId: candidate.targetId, amountRule: candidate.type === 'income' ? 'credit_minus_debit' : 'debit_minus_credit', allocationMethod: 'direct', allocationWeight: 1000000, priority: 0, status: 'active', note: noteOf(candidate), origin: originOf(candidate), reviewed: 0 }));
      const items = [...(accountRules.data?.items ?? []).map(serializeAccRow), ...appended];
      await api.put(`/finance/mapping-versions/${selected}/account-mappings`, { items });
      qc.invalidateQueries({ queryKey: ['finance-account-rules', selected] });
    }
    message.success(`已采纳 ${rows.length} 条为未复核建议行,复核后才可锁定`);
  };
  // 逐行标记复核:同样整表 PUT,仅翻转目标行 reviewed
  const markReviewed = async (kind: 'org' | 'account', row: { id: number }) => {
    if (!selected) return;
    if (kind === 'org') {
      const items = (orgRules.data?.items ?? []).map((r) => ({ ...serializeOrgRow(r), reviewed: r.id === row.id ? 1 : r.reviewed }));
      await api.put(`/finance/mapping-versions/${selected}/org-mappings`, { items });
      qc.invalidateQueries({ queryKey: ['finance-org-rules', selected] });
    } else {
      const items = (accountRules.data?.items ?? []).map((r) => ({ ...serializeAccRow(r), reviewed: r.id === row.id ? 1 : r.reviewed }));
      await api.put(`/finance/mapping-versions/${selected}/account-mappings`, { items });
      qc.invalidateQueries({ queryKey: ['finance-account-rules', selected] });
    }
    message.success('已标记复核');
  };
  const originColumn = <T extends { origin: string }>(): TableColumnsType<T>[number] => ({
    title: '来源', dataIndex: 'origin', width: 90,
    render: (v: string) => <Tag color={v === 'ai' ? 'purple' : v === 'deterministic' ? 'blue' : 'default'}>{v === 'ai' ? 'AI 建议' : v === 'deterministic' ? '确定性' : '手工'}</Tag>,
  });
  const reviewedColumn = <T extends { id: number; reviewed: number }>(kind: 'org' | 'account'): TableColumnsType<T>[number] => ({
    title: '复核', dataIndex: 'reviewed', width: 96,
    render: (v: number, r: T) => v === 1
      ? <Tag color="green">已复核</Tag>
      : (selectedMapping?.status === 'draft' ? <Button size="small" onClick={() => void markReviewed(kind, r)}>标记复核</Button> : <Tag color="orange">未复核</Tag>),
  });

  if (profiles.isError || mappings.isError) {
    return (
      <QueryErrorResult
        title="财务数据源或映射版本加载失败"
        error={profiles.error ?? mappings.error}
        refetch={() => { void profiles.refetch(); void mappings.refetch(); }}
      />
    );
  }

  const rulesError = orgRules.error ?? accountRules.error ?? recRules.error;
  const refetchRules = () => { void orgRules.refetch(); void accountRules.refetch(); void recRules.refetch(); };

  const orgColumns: TableColumnsType<OrgMappingRow> = [
    { title: '源账套', dataIndex: 'source_book_code', ellipsis: { showTitle: true } },
    { title: '源组织编码', dataIndex: 'source_org_code', ellipsis: { showTitle: false }, render: (v: string) => <Typography.Text code style={{ whiteSpace: 'nowrap' }}>{v}</Typography.Text> },
    { title: '历史/源名称', dataIndex: 'source_org_name', ellipsis: { showTitle: true } },
    { title: '目标组织', width: CODE_WIDTH.org + 12, render: (_, r) => `${r.target_org_code ?? '?'} ${r.target_org_name ?? ''}` },
    originColumn<OrgMappingRow>(),
    reviewedColumn<OrgMappingRow>('org'),
    { title: '映射依据', dataIndex: 'note', ellipsis: { showTitle: true } },
  ];
  const accountColumns: TableColumnsType<AccountMappingRow> = [
    { title: '源科目', render: (_, r) => `${r.source_account_code} ${r.source_account_name}`, ellipsis: { showTitle: false } },
    { title: '辅助条件', dataIndex: 'source_aux_json', ellipsis: { showTitle: true } },
    { title: '目标科目', width: CODE_WIDTH.account + 90, render: (_, r) => `${r.target_account_code ?? '?'} ${r.target_account_name ?? ''}` },
    { title: '金额规则', dataIndex: 'amount_rule' },
    { title: '拆分', render: (_, r) => r.allocation_method === 'fixed_ratio' ? `${(r.allocation_weight / 10000).toFixed(2)}%` : '直接' },
    originColumn<AccountMappingRow>(),
    reviewedColumn<AccountMappingRow>('account'),
    { title: '依据', dataIndex: 'note', ellipsis: { showTitle: true } },
  ];
  const reconColumns: TableColumnsType<ReconciliationRuleRow> = [
    { title: '官方项目', dataIndex: 'source_line_alias', ellipsis: { showTitle: true } },
    { title: '目标', render: (_, r) => `${r.target_type}:${r.target_code}`, ellipsis: { showTitle: true } },
    { title: '容差(分)', dataIndex: 'tolerance_cents' },
    { title: '容差依据', dataIndex: 'tolerance_reason', ellipsis: { showTitle: true } },
  ];

  const mappingItems: NonNullable<TabsProps['items']> = [
    { key: 'org', label: `组织映射 (${orgRules.data?.items.length ?? 0})`, children: <Table<OrgMappingRow> size="small" rowKey="id" dataSource={orgRules.data?.items ?? []} columns={orgColumns} /> },
    { key: 'account', label: `科目映射 (${accountRules.data?.items.length ?? 0})`, children: <Table<AccountMappingRow> size="small" rowKey="id" dataSource={accountRules.data?.items ?? []} columns={accountColumns} /> },
    { key: 'recon', label: `利润表勾稽 (${recRules.data?.items.length ?? 0})`, children: <Table<ReconciliationRuleRow> size="small" rowKey="id" dataSource={recRules.data?.items ?? []} columns={reconColumns} /> },
  ];

  return <>
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card title="财务数据源" extra={<Button icon={<i className="ri-add-line" aria-hidden />} onClick={() => setProfileOpen(true)}>新增</Button>}>
          <Table<Profile> size="small" rowKey="id" pagination={false} dataSource={profiles.data?.items ?? []} columns={[{ title: '编码', dataIndex: 'code' }, { title: '名称', dataIndex: 'name' }, { title: '状态', dataIndex: 'status', render: statusTag }]} />
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card title="版本化映射" extra={<Button type="primary" icon={<i className="ri-add-line" aria-hidden />} disabled={!profiles.data?.items.length} onClick={() => setMappingOpen(true)}>新建草稿</Button>}>
          <Table<Mapping>
            size="small" rowKey="id" dataSource={mappings.data?.items ?? []}
            rowSelection={{ type: 'radio', selectedRowKeys: selected ? [selected] : [], onChange: (keys) => setSelected(Number(keys[0])) }}
            columns={[
              { title: '版本', render: (_, r) => `V${r.version_no} ${r.name}` },
              { title: '数据源', dataIndex: 'source_profile_id', render: (v: number) => profiles.data?.items.find((p) => p.id === v)?.name ?? v },
              { title: '状态', dataIndex: 'status', render: statusTag },
              {
                title: '操作', render: (_, r) => (
                  <Space wrap>
                    <Button size="small" onClick={() => download(`/finance/mapping-versions/${r.id}/export`, `映射-V${r.version_no}.xlsx`)}>导出</Button>
                    <Button size="small" onClick={() => action(r.id, 'clone')}>复制新版本</Button>
                    {r.status === 'draft' && <>
                      <Button size="small" onClick={() => action(r.id, 'validate')}>完整检查</Button>
                      <Popconfirm title="锁定后永不原地修改，确认?" onConfirm={() => action(r.id, 'lock')}><Button size="small" icon={<i className="ri-lock-2-line" aria-hidden />}>审核锁定</Button></Popconfirm>
                    </>}
                    {r.status === 'locked' && <Button size="small" onClick={() => action(r.id, 'retire')}>停用</Button>}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </Col>
    </Row>
    {selectedMapping && (
      <Card
        title={`映射审核明细 · V${selectedMapping.version_no}`} style={{ marginTop: 16 }}
        extra={<Space>
          {selectedMapping.status === 'draft' && (
            <Upload showUploadList={false} accept=".xlsx" beforeUpload={async (file) => {
              const fd = new FormData();
              fd.append('file', file);
              try {
                await api.post(`/finance/mapping-versions/${selected}/import`, fd);
                message.success('映射文件已导入草稿');
                qc.invalidateQueries({ queryKey: ['finance-org-rules', selected] });
                qc.invalidateQueries({ queryKey: ['finance-account-rules', selected] });
                qc.invalidateQueries({ queryKey: ['finance-rec-rules', selected] });
              } catch (e) { message.error(errorText(e)); }
              return false;
            }}><Button icon={<i className="ri-file-excel-2-line" aria-hidden />}>导入审核文件</Button></Upload>
          )}
          <Button icon={<i className="ri-download-2-line" aria-hidden />} onClick={() => download(`/finance/mapping-versions/${selected}/export`, '待审核映射.xlsx')}>下载审核文件</Button>
        </Space>}
      >
        {/* 源编码长度不受控(外部财务系统):不定宽 + nowrap + 尾部省略 + Tooltip,
            不折行撑高、不撑歪整表;目标编码按 8/12 字符取宽(方案二.C) */}
        {rulesError ? (
          <Alert type="error" showIcon message="映射明细加载失败" description={errorText(rulesError)} action={<Button size="small" onClick={refetchRules}>重试</Button>} />
        ) : (
          <Tabs items={mappingItems} />
        )}
        <MappingCandidatesPanel versionId={selectedMapping.id} sourceProfileId={selectedMapping.source_profile_id} readOnly={selectedMapping.status !== 'draft'} onAdopt={adoptCandidate} onAdoptBatch={adoptCandidateBatch} />
      </Card>
    )}
    <Modal title="新增财务数据源" open={profileOpen} onCancel={() => setProfileOpen(false)} onOk={() => profileForm.validateFields().then((v) => createProfile.mutate(v))} confirmLoading={createProfile.isPending} width={760}><SourceProfileForm form={profileForm} /></Modal>
    <Modal title="新建映射草稿" open={mappingOpen} onCancel={() => setMappingOpen(false)} onOk={() => mappingForm.validateFields().then((v) => createMapping.mutate(v))}>
      <Form form={mappingForm} layout="vertical">
        <Form.Item name="sourceProfileId" label="数据源" rules={[{ required: true }]}><Select options={(profiles.data?.items ?? []).filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: p.name }))} /></Form.Item>
        <Form.Item name="name" label="版本名称" rules={[{ required: true }]}><Input /></Form.Item>
      </Form>
    </Modal>
  </>;
}

function MonthlyConversion({ initialScope, onGoToMapping }: { initialScope?: Pick<WorkspaceScope, 'sourceProfileId' | 'cutoff' | 'revisionOfId'>; onGoToMapping: () => void }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<ConversionFormValues>();
  const [balance, setBalance] = useState<File>();
  const [profit, setProfit] = useState<File>();
  const [journal, setJournal] = useState<File>();
  const [result, setResult] = useState<Conversion>();
  /** UX-15:待确认的财务导入预览批次(统一预览面板;取消/确认由面板完成) */
  const [importPreview, setImportPreview] = useState<{
    batchId: number; count: number; added: number; modified: number; cleared: number;
    changesByOrgAndRoot: { orgCode: string; rootAccountCode: string; changeCents: number }[];
  } | null>(null);
  const profiles = useQuery({ queryKey: ['finance-profiles'], queryFn: () => api.get<{ items: Profile[] }>('/finance/source-profiles') });
  const mappings = useQuery({ queryKey: ['finance-mappings'], queryFn: () => api.get<{ items: Mapping[] }>('/finance/mapping-versions') });
  const profileId = Form.useWatch('sourceProfileId', form);
  const period = Form.useWatch('period', form);
  const activeProfiles = useMemo(() => (profiles.data?.items ?? []).filter((p) => p.status === 'active'), [profiles.data]);
  const locked = useMemo(() => (mappings.data?.items ?? []).filter((m) => m.status === 'locked' && m.source_profile_id === profileId), [mappings.data, profileId]);

  /* URL 恢复入口(UX-02):sourceProfileId/cutoff 一次性预填表单,不持续写回 URL ——
     正在输入的表单条件不属于已应用筛选;revisionOfId 不直接进表单,由修订目标查询
     与「修订这次导入」勾选承接(见下方 initialRevisionHandledRef)。 */
  const appliedInitialScopeRef = useRef(false);
  useEffect(() => {
    if (appliedInitialScopeRef.current) return;
    appliedInitialScopeRef.current = true;
    if (!initialScope) return;
    if (initialScope.sourceProfileId != null) form.setFieldValue('sourceProfileId', initialScope.sourceProfileId);
    if (initialScope.cutoff) {
      const parsed = dayjs(initialScope.cutoff);
      if (parsed.isValid()) form.setFieldValue('period', parsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 归属校验:URL 指定的数据源不存在时清空并说明,不带着失效目标提交 */
  useEffect(() => {
    const pid = initialScope?.sourceProfileId;
    if (pid == null || !profiles.data) return;
    if (!profiles.data.items.some((p) => p.id === pid)) {
      form.setFieldValue('sourceProfileId', undefined);
      message.warning(`链接中的数据源 ${pid} 不存在或已删除,请重新选择`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.data]);

  /* 有效默认值(UX-18):仅一个可用数据源/锁定映射时自动带出,URL 显式指定时不覆盖;
     用户主动清空后不反复回填(仅随选项集变化触发一次)。 */
  useEffect(() => {
    if (initialScope?.sourceProfileId != null) return;
    if (activeProfiles.length === 1 && form.getFieldValue('sourceProfileId') == null) {
      form.setFieldValue('sourceProfileId', activeProfiles[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfiles]);
  useEffect(() => {
    if (profileId == null) return;
    if (locked.length === 1 && form.getFieldValue('mappingVersionId') == null) {
      form.setFieldValue('mappingVersionId', locked[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, profileId]);

  /* UX-18 修订目标:按当前数据源+年度+截止日查询最新成功批次,用户明确勾选才发起修订 */
  const cutoff = period && dayjs(period).isValid() ? dayjs(period).format('YYYY-MM-DD') : undefined;
  const revisionTarget = useQuery({
    queryKey: ['finance-revision-target', profileId, cutoff],
    enabled: typeof profileId === 'number' && !!cutoff,
    queryFn: () => api.get<RevisionTargetResult>(`/finance/conversions/revision-target?sourceProfileId=${profileId}&year=${Number(cutoff!.slice(0, 4))}&cutoff=${cutoff}`),
  });
  const target = revisionTarget.data?.target ?? null;
  const targetId = target?.id ?? null;
  const [reviseChecked, setReviseChecked] = useState(false);
  /* 目标变化(切换范围,或期间出现更新的成功批次)时回到未勾选,由用户重新明确选择,
     不偷偷更换修订对象 */
  useEffect(() => { setReviseChecked(false); }, [targetId]);
  /* URL 带入的 revisionOfId(批次历史「修订这次导入」):仍指向当前最新成功批次时沿用
     用户的明确选择并勾选;已被更新批次取代或不存在时说明原因,保持未勾选。 */
  const initialRevisionHandledRef = useRef(false);
  useEffect(() => {
    const data = revisionTarget.data;
    if (!data || initialRevisionHandledRef.current) return;
    initialRevisionHandledRef.current = true;
    const wanted = initialScope?.revisionOfId;
    if (wanted == null) return;
    if (data.target && data.target.id === wanted) setReviseChecked(true);
    else if (data.target) message.warning(`链接中的修订批次 #${wanted} 已被更新的成功批次取代，修订目标已刷新为 #${data.target.id}，请确认后再勾选「修订这次导入」`);
    else message.warning(`链接中的修订批次 #${wanted} 在当前范围下没有可修订记录，本次按首次导入处理`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionTarget.data]);

  const run = useMutation({
    mutationFn: async (v: ConversionFormValues) => {
      const fd = new FormData();
      fd.append('sourceProfileId', String(v.sourceProfileId));
      fd.append('mappingVersionId', String(v.mappingVersionId));
      fd.append('year', String(v.period.year()));
      fd.append('snapshotDate', v.period.format('YYYY-MM-DD'));
      if (reviseChecked && target) fd.append('revisionOfId', String(target.id));
      fd.append('balance', balance!);
      fd.append('profit', profit!);
      if (journal) fd.append('journal', journal);
      return api.post<Conversion>('/finance/conversions/preview', fd);
    },
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ['finance-conversions'] });
      qc.invalidateQueries({ queryKey: ['finance-revision-target'] });
      r.status === 'blocked' ? message.error('转换被校验闸门阻断') : message.success('转换及二次导入边界校验通过');
    },
    onError: (e) => message.error(errorText(e)),
  });
  const createPreview = async () => {
    if (!result) return;
    try {
      const p = await api.post<{ importBatchId: number; count: number; added: number; modified: number; cleared: number; changesByOrgAndRoot: { orgCode: string; rootAccountCode: string; changeCents: number }[] }>(`/finance/conversions/${result.id}/create-import-preview`);
      // UX-15:统一预览面板承载核对/确认/取消与结果未知恢复;按组织×根科目变化表作为路径补充内容保留
      setImportPreview({ batchId: p.importBatchId, count: p.count, added: p.added, modified: p.modified, cleared: p.cleared, changesByOrgAndRoot: p.changesByOrgAndRoot ?? [] });
    } catch (e) { message.error(errorText(e)); }
  };
  const loadError = profiles.error ?? mappings.error;
  const targetProfileName = profileId != null ? (profiles.data?.items.find((p) => p.id === profileId)?.name ?? `#${profileId}`) : '';
  /* UX-18 修订对象面板:手填内部 ID 改为「自动查询最新成功批次 + 明确勾选」 */
  const revisionPanel = (() => {
    if (profileId == null || !cutoff) {
      return <Typography.Text type="secondary">选择数据源与截止日期后，自动查询该期间可修订的成功批次</Typography.Text>;
    }
    if (revisionTarget.isPending) {
      return <Typography.Text type="secondary"><Spin size="small" /> 正在查询可修订批次…</Typography.Text>;
    }
    if (revisionTarget.isError) {
      return <Alert type="error" showIcon message="修订目标查询失败" description={errorText(revisionTarget.error)} action={<Button size="small" onClick={() => void revisionTarget.refetch()}>重试</Button>} />;
    }
    const data = revisionTarget.data!;
    if (!data.target) {
      return <Alert type={data.reasonCode === 'parsing_in_flight' ? 'warning' : 'info'} showIcon message={data.reason ?? '该期间尚无成功批次，本次为首次导入'} />;
    }
    const summary = data.target.resultSummary;
    return (
      <Alert
        type={data.revisable ? 'warning' : 'error'}
        showIcon
        message={data.revisable
          ? `该期间已有成功批次 #${data.target.id}，重复导入必须作为它的修订`
          : (data.reason ?? '该期间暂时不能发起修订')}
        description={<>
          <Descriptions
            size="small" column={1} style={{ margin: '4px 0 8px' }}
            items={[
              { key: 'profile', label: '数据源', children: targetProfileName },
              { key: 'period', label: '期间', children: `${data.year} / ${data.snapshotDate}` },
              { key: 'status', label: '状态', children: statusTag(data.target.status) },
              { key: 'created', label: '创建时间', children: data.target.createdAt.slice(0, 19).replace('T', ' ') },
              {
                key: 'changes', label: '变化数量',
                children: summary
                  ? `新增 ${summary.added} · 修改 ${summary.modified} · 清零 ${summary.cleared}（共 ${summary.count} 行）`
                  : '已校验未导入，尚无结果摘要',
              },
            ]}
          />
          <Checkbox checked={reviseChecked} disabled={!data.revisable} onChange={(e) => setReviseChecked(e.target.checked)}>
            修订这次导入（批次 #{data.target.id}）
          </Checkbox>
        </>}
      />
    );
  })();
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card title="月度文件与口径" className="bd-ghost-host">
          {/* 幽灵数字表达「先左后右」的两段流程:此卡是第 1 步;叠 sm 变体移至右上角,避开底部满宽提交按钮 */}
          <span className="bd-ghost-num bd-ghost-num-sm" aria-hidden>1</span>
          {loadError ? (
            <QueryErrorResult title="数据源与映射版本加载失败" error={loadError} refetch={() => { void profiles.refetch(); void mappings.refetch(); }} />
          ) : (
            <Form
              form={form} layout="vertical"
              /* 期间有效默认值:月度转换最常见目标是上月月末,可改 */
              initialValues={{ period: dayjs().subtract(1, 'month').endOf('month') }}
              onFinish={(v) => {
                if (!balance || !profit) { message.error('请同时选择两份文件'); return; }
                if (revisionTarget.data?.revisable && !reviseChecked) { message.warning('该期间已有成功批次，请勾选「修订这次导入」，或更换截止日期'); return; }
                run.mutate(v);
              }}
            >
              {profiles.data && activeProfiles.length === 0 && (
                <Alert
                  type="warning" showIcon style={{ marginBottom: 12 }}
                  message="还没有可用的财务数据源"
                  description={<>请先到「数据源与映射审核」页签创建数据源。<Button type="link" size="small" onClick={onGoToMapping}>前往配置</Button></>}
                />
              )}
              {profileId != null && mappings.data && locked.length === 0 && (
                <Alert
                  type="warning" showIcon style={{ marginBottom: 12 }}
                  message="该数据源还没有已审核锁定的映射版本"
                  description={<>转换必须使用锁定映射。请先在「数据源与映射审核」页签完成映射审核与锁定。<Button type="link" size="small" onClick={onGoToMapping}>前往配置</Button></>}
                />
              )}
              <Form.Item name="sourceProfileId" label="数据源" rules={[{ required: true }]}><Select onChange={() => form.setFieldValue('mappingVersionId', undefined)} options={activeProfiles.map((p) => ({ value: p.id, label: p.name }))} /></Form.Item>
              <Form.Item name="mappingVersionId" label="已审核锁定映射版本" rules={[{ required: true }]}><Select options={locked.map((m) => ({ value: m.id, label: `V${m.version_no} ${m.name}` }))} /></Form.Item>
              <Form.Item name="period" label="截止日期" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
              <Form.Item label="修订对象">{revisionPanel}</Form.Item>
              <Form.Item label="财务系统余额表"><Upload maxCount={1} accept=".xlsx" beforeUpload={(f) => { setBalance(f); return false; }} onRemove={() => setBalance(undefined)}><Button icon={<i className="ri-upload-cloud-2-line" aria-hidden />}>选择余额表</Button></Upload></Form.Item>
              <Form.Item label="官方利润表"><Upload maxCount={1} accept=".xlsx" beforeUpload={(f) => { setProfit(f); return false; }} onRemove={() => setProfit(undefined)}><Button icon={<i className="ri-upload-cloud-2-line" aria-hidden />}>选择利润表</Button></Upload></Form.Item>
              <Form.Item label="凭证序时簿（可选；数据源可设为必传）"><Upload maxCount={1} accept=".xlsx" beforeUpload={(f) => { setJournal(f); return false; }} onRemove={() => setJournal(undefined)}><Button icon={<i className="ri-upload-cloud-2-line" aria-hidden />}>选择序时簿</Button></Upload></Form.Item>
              <Button block type="primary" htmlType="submit" loading={run.isPending}>解析、转换并执行全部校验</Button>
            </Form>
          )}
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card
          title="校验报告" className="bd-ghost-host"
          extra={result?.status === 'validated' && (
            <Space>
              <Button onClick={() => download(`/finance/conversions/${result.id}/output`, `标准实际数-${result.snapshot_date}.xlsx`)}>下载标准文件</Button>
              <Button type="primary" icon={<i className="ri-checkbox-circle-line" aria-hidden />} onClick={createPreview}>创建导入预览</Button>
            </Space>
          )}
        >
          {/* 第 2 步:左侧文件与口径就绪后,在此读校验结果;幽灵数字与左卡同落右上角保持成对 */}
          <span className="bd-ghost-num bd-ghost-num-sm" aria-hidden>2</span>
          {!result ? <Alert type="info" showIcon message="正式金额全程由固定程序转换；序时簿仅做独立逐分核验，任一强制校验失败将关闭输出。" /> : <ReportView conversion={result} />}
        </Card>
      </Col>
      {/* UX-15 统一预览:与标准/清洗导入同一组核对信息;确认只发批次 ID,结果未知先查批次状态 */}
      <ImportPreviewModal
        open={importPreview != null}
        batchId={importPreview?.batchId ?? null}
        title="财务转换导入预览"
        confirmLabel="确认导入并生成快照"
        extraContent={importPreview && (
          <>
            <Descriptions
              column={3} size="small" bordered
              items={[
                { key: 'count', label: '完整快照行', children: importPreview.count },
                { key: 'trace', label: '来源', children: `财务转换 #${result?.id ?? '?'}` },
                { key: 'recon', label: '官方利润表勾稽', children: <Tag color="green">通过</Tag> },
              ]}
            />
            <Typography.Title level={5} style={{ marginTop: 8 }}>按组织与预算根科目变化额（元，利润方向）</Typography.Title>
            <Table<{ orgCode: string; rootAccountCode: string; changeCents: number }>
              size="small" pagination={false} rowKey={(r) => `${r.orgCode}:${r.rootAccountCode}`}
              dataSource={importPreview.changesByOrgAndRoot}
              columns={[{ title: '组织', dataIndex: 'orgCode' }, { title: '根科目', dataIndex: 'rootAccountCode' }, { title: '变化额', dataIndex: 'changeCents', align: 'right', render: cents }]}
            />
          </>
        )}
        onConfirmed={async () => {
          message.success('实际数已提交并生成不可变快照');
          setResult(undefined);
          qc.invalidateQueries({ queryKey: ['finance-conversions'] });
          qc.invalidateQueries({ queryKey: ['actual-matrix'] });
          qc.invalidateQueries({ queryKey: ['actual-years'] });
          qc.invalidateQueries({ queryKey: ['batches'] });
          await invalidateAnalysisQueries(qc);
        }}
        onClose={() => setImportPreview(null)}
      />
    </Row>
  );
}

function ReportView({ conversion }: { conversion: Conversion }) {
  const { mode } = useThemeMode();
  const r = conversion.validation;
  if (!r) {
    return (
      <Alert
        showIcon type="info"
        message={conversion.status === 'parsing' ? `批次 #${conversion.id} 解析中，校验报告尚未生成` : `批次 #${conversion.id} 没有完整的校验报告`}
        description={`余额 ${conversion.balance_sha256.slice(0, 16)}… · 利润 ${conversion.profit_sha256.slice(0, 16)}…${conversion.journal_sha256 ? ` · 序时簿 ${conversion.journal_sha256.slice(0, 16)}…` : ''}`}
      />
    );
  }
  const j = r.journalVerification;
  return <>
    <Alert
      showIcon type={r.passed ? 'success' : 'error'}
      message={r.passed ? '全部强制闸门通过，可生成导入预览' : `批次 #${conversion.id} 已失败关闭`}
      description={`余额 ${r.hashes.balanceSha256.slice(0, 16)}… · 利润 ${r.hashes.profitSha256.slice(0, 16)}…${r.hashes.journalSha256 ? ` · 序时簿 ${r.hashes.journalSha256.slice(0, 16)}…` : ''}`}
    />
    <Row gutter={[12, 12]} style={{ margin: '16px 0' }}>
      <Col xs={12} sm={8} lg={4}><Statistic title="源末级行" value={r.counts.sourceRows} /></Col>
      <Col xs={12} sm={8} lg={4}><Statistic title="范围内非零" value={r.counts.nonZeroRows} /></Col>
      <Col xs={12} sm={8} lg={4}><Statistic title="范围外非零" value={r.counts.excludedNonZeroRows ?? 0} /></Col>
      <Col xs={12} sm={8} lg={4}><Statistic title="源科目" value={r.counts.sourceAccounts} /></Col>
      <Col xs={12} sm={8} lg={4}><Statistic title="输出组合" value={r.counts.outputRows} /></Col>
      <Col xs={12} sm={8} lg={4}><Statistic title="守恒差额(分)" value={r.conservation.differenceCents} valueStyle={{ color: r.conservation.passed ? statusColor(mode).good : statusColor(mode).bad }} /></Col>
    </Row>
    {r.errors.length > 0 && <>
      <Typography.Title level={5}>阻断错误</Typography.Title>
      {r.errors.map((e, i) => <Alert key={i} type="error" showIcon message={e.message} description={e.sourceSheet ? `${e.sourceSheet}!${e.sourceRow}` : e.code} style={{ marginBottom: 8 }} />)}
    </>}
    {r.warnings.length > 0 && <>
      <Typography.Title level={5}>审计提示</Typography.Title>
      {r.warnings.map((e, i) => <Alert key={i} type="warning" showIcon message={e.message} description={e.code} style={{ marginBottom: 8 }} />)}
    </>}
    {j && <>
      <Divider />
      <Typography.Title level={5}>序时簿与余额表逐分核验</Typography.Title>
      <Descriptions
        bordered size="small" column={4}
        items={[
          { key: 'result', label: '结果', children: j.passed ? <Tag color="green">分毫一致</Tag> : <Tag color="red">阻断</Tag> },
          { key: 'rows', label: '纳入/源流水', children: `${j.includedRows}/${j.sourceRows}` },
          { key: 'ignored', label: '跨期/未过账', children: `${j.ignoredOtherPeriodRows}/${j.ignoredUnpostedRows}` },
          { key: 'accounts', label: '一致科目', children: `${j.matchedCount}/${j.accountCount}` },
        ]}
      />
      {j.differences.length > 0 && (
        <Table<JournalDifference>
          style={{ marginTop: 12 }} size="small" rowKey="accountCode" dataSource={j.differences}
          columns={[
            { title: '源科目', render: (_, v) => `${v.accountCode} ${v.accountName}` },
            { title: '余额借方', dataIndex: 'balanceDebitCents', align: 'right', render: cents },
            { title: '序时借方', dataIndex: 'journalDebitCents', align: 'right', render: cents },
            { title: '借方差额', dataIndex: 'debitDifferenceCents', align: 'right', render: cents },
            { title: '余额贷方', dataIndex: 'balanceCreditCents', align: 'right', render: cents },
            { title: '序时贷方', dataIndex: 'journalCreditCents', align: 'right', render: cents },
            { title: '贷方差额', dataIndex: 'creditDifferenceCents', align: 'right', render: cents },
          ]}
        />
      )}
    </>}
    <Divider />
    <Typography.Title level={5}>官方利润表勾稽</Typography.Title>
    <Table<ReconciliationRow>
      size="small" rowKey="item" pagination={false} dataSource={r.reconciliations}
      columns={[
        { title: '项目', dataIndex: 'item' },
        { title: '官方数(元)', dataIndex: 'officialCents', align: 'right', render: cents },
        { title: '映射数(元)', dataIndex: 'mappedCents', align: 'right', render: cents },
        { title: '差额(元)', dataIndex: 'differenceCents', align: 'right', render: cents },
        { title: '结果', dataIndex: 'passed', render: (v: boolean) => v ? <Tag color="green">通过</Tag> : <Tag color="red">阻断</Tag> },
      ]}
    />
  </>;
}

function History() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const data = useQuery({ queryKey: ['finance-conversions'], queryFn: () => api.get<{ items: Conversion[] }>('/finance/conversions') });
  return (
    <Card title="转换批次与全链路追溯">
      {data.isError ? (
        <QueryErrorResult title="转换批次加载失败" error={data.error} refetch={() => void data.refetch()} />
      ) : (
        <Table<Conversion>
          rowKey="id" size="small" dataSource={data.data?.items ?? []}
          expandable={{ expandedRowRender: (r) => <ReportView conversion={r} /> }}
          columns={[
            { title: '批次', dataIndex: 'id', render: (v: number) => `#${v}` },
            { title: '期间', render: (_, r) => `${r.year} / ${r.snapshot_date}` },
            { title: '状态', dataIndex: 'status', render: statusTag },
            { title: '余额表', dataIndex: 'balance_name' },
            { title: '利润表', dataIndex: 'profit_name' },
            { title: '序时簿', dataIndex: 'journal_name', render: (v: string | null) => v ?? '-' },
            { title: '映射版本', dataIndex: 'mapping_version_id' },
            /* UX-19 互链:下游导入批次直达「导入批次」详情(只读),反向链接在批次详情抽屉 */
            { title: '下游导入', dataIndex: 'import_batch_id', render: (v: number | null) => v ? <Link to={`/data?tab=imports&batch=${v}`}>导入批次 #{v}</Link> : '-' },
            { title: '创建时间', dataIndex: 'created_at', render: (v: string) => v.slice(0, 19).replace('T', ' ') },
            {
              title: '操作', render: (_, r) => (
                <Space wrap>
                  <Button size="small" onClick={() => download(`/finance/conversions/${r.id}/balance-source`, r.balance_name)}>余额原件</Button>
                  <Button size="small" onClick={() => download(`/finance/conversions/${r.id}/profit-source`, r.profit_name)}>利润原件</Button>
                  {r.hasJournal && <Button size="small" onClick={() => download(`/finance/conversions/${r.id}/journal-source`, r.journal_name!)}>序时原件</Button>}
                  {r.hasOutput && <Button size="small" onClick={() => download(`/finance/conversions/${r.id}/output`, `标准实际数-${r.snapshot_date}.xlsx`)}>输出</Button>}
                  {/* UX-18:从历史发起修订,带入数据源/截止日/修订对象走 URL 预填;
                      该批次若已非最新成功,转换页会说明原因并刷新目标,不偷偷更换 */}
                  {['validated', 'imported'].includes(r.status) && (
                    <Button size="small" onClick={() => navigate(`/finance?tab=convert&sourceProfileId=${r.source_profile_id}&cutoff=${r.snapshot_date}&revisionOfId=${r.id}`)}>修订这次导入</Button>
                  )}
                  {!['imported', 'cancelled'].includes(r.status) && (
                    <Popconfirm title="取消批次?原件与报告仍保留供追溯" onConfirm={async () => { await api.post(`/finance/conversions/${r.id}/cancel`); message.success('已取消'); qc.invalidateQueries({ queryKey: ['finance-conversions'] }); }}>
                      <Button size="small">取消</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}

function ParallelTrials() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [conversionId, setConversionId] = useState<number>();
  const [editing, setEditing] = useState<ParallelTrial>();
  const [explanations, setExplanations] = useState<Record<string, { reason: string; resolution: string }>>({});
  const conversions = useQuery({ queryKey: ['finance-conversions'], queryFn: () => api.get<{ items: Conversion[] }>('/finance/conversions') });
  const trials = useQuery({ queryKey: ['finance-parallel-trials'], queryFn: () => api.get<{ items: ParallelTrial[] }>('/finance/parallel-trials') });
  const beginEdit = (trial: ParallelTrial) => {
    const old = new Map(trial.explanations.map((e) => [`${e.orgCode}|${e.accountCode}`, e]));
    setExplanations(Object.fromEntries(trial.comparison.differences.filter((d) => d.differenceCents !== 0).map((d) => {
      const key = `${d.orgCode}|${d.accountCode}`;
      const e = old.get(key);
      return [key, { reason: e?.reason ?? '', resolution: e?.resolution ?? '' }];
    })));
    setEditing(trial);
  };
  const save = async () => {
    if (!editing) return;
    try {
      const items = Object.entries(explanations).map(([key, value]) => {
        const [orgCode, accountCode] = key.split('|');
        return { orgCode, accountCode, ...value };
      });
      await api.put(`/finance/parallel-trials/${editing.id}/explanations`, { items });
      message.success('差异原因已保存');
      setEditing(undefined);
      qc.invalidateQueries({ queryKey: ['finance-parallel-trials'] });
    } catch (e) { message.error(errorText(e)); }
  };
  const review = async (id: number) => {
    try {
      await api.post(`/finance/parallel-trials/${id}/review`);
      message.success('并行试运行已复核');
      qc.invalidateQueries({ queryKey: ['finance-parallel-trials'] });
    } catch (e) { message.error(errorText(e)); }
  };
  const loadError = conversions.error ?? trials.error;
  return <>
    <Card
      title="真实数据并行试运行"
      extra={<Space>
        <Select
          placeholder="选择已通过转换批次" style={{ width: 280 }} value={conversionId} onChange={setConversionId}
          options={(conversions.data?.items ?? []).filter((c) => ['validated', 'imported'].includes(c.status)).map((c) => ({ value: c.id, label: `#${c.id} · ${c.snapshot_date} · 映射V${c.mapping_version_id}` }))}
        />
        <Upload
          accept=".xlsx" showUploadList={false} disabled={!conversionId}
          beforeUpload={async (file) => {
            const fd = new FormData();
            fd.append('file', file);
            try {
              const result = await api.post<ParallelTrial>(`/finance/conversions/${conversionId}/parallel-trials`, fd);
              message.success(result.comparison.mismatchCount === 0 ? '与原手工结果分毫一致' : `发现 ${result.comparison.mismatchCount} 个差异，请逐项登记原因`);
              qc.invalidateQueries({ queryKey: ['finance-parallel-trials'] });
            } catch (e) { message.error(errorText(e)); }
            return false;
          }}
        >
          <Button type="primary" icon={<i className="ri-file-excel-2-line" aria-hidden />} disabled={!conversionId}>上传原手工结果并比较</Button>
        </Upload>
      </Space>}
    >
      <Alert type="info" showIcon message="比较只覆盖转换批次拥有范围；范围外手工数据不会被误判为差异。差异必须逐项说明并复核，修正映射后应创建新转换批次重跑至分毫一致。" style={{ marginBottom: 12 }} />
      {loadError ? (
        <QueryErrorResult title="并行试运行数据加载失败" error={loadError} refetch={() => { void conversions.refetch(); void trials.refetch(); }} />
      ) : (
        <Table<ParallelTrial>
          rowKey="id" size="small" dataSource={trials.data?.items ?? []}
          expandable={{
            expandedRowRender: (t) => (
              <Table<ParallelTrial['comparison']['differences'][number]>
                rowKey={(r) => `${r.orgCode}:${r.accountCode}`} size="small" pagination={{ pageSize: 20 }}
                dataSource={t.comparison.differences.filter((d) => d.differenceCents !== 0)}
                columns={[
                  { title: '组织', dataIndex: 'orgCode' },
                  { title: '科目', dataIndex: 'accountCode' },
                  { title: '转换数(元)', dataIndex: 'convertedCents', align: 'right', render: cents },
                  { title: '原手工数(元)', dataIndex: 'manualCents', align: 'right', render: cents },
                  { title: '差异(元)', dataIndex: 'differenceCents', align: 'right', render: cents },
                ]}
              />
            ),
          }}
          columns={[
            { title: '试运行', dataIndex: 'id', render: (v: number) => `#${v}` },
            { title: '转换批次', dataIndex: 'conversion_batch_id', render: (v: number) => `#${v}` },
            { title: '期间', render: (_, r) => r.comparison.snapshotDate },
            { title: '原手工文件', dataIndex: 'manual_name' },
            { title: '状态', dataIndex: 'status', render: statusTag },
            { title: '组合', render: (_, r) => `${r.comparison.matchedCount}/${r.comparison.totalCombinations} 一致` },
            { title: '差异数', dataIndex: 'mismatchCount', render: (_, r) => <Typography.Text type={r.comparison.mismatchCount ? 'danger' : undefined}>{r.comparison.mismatchCount}</Typography.Text> },
            { title: '差异绝对值(元)', render: (_, r) => cents(r.comparison.absoluteDifferenceCents) },
            {
              title: '操作', render: (_, r) => (
                <Space>
                  <Button size="small" onClick={() => download(`/finance/parallel-trials/${r.id}/manual-source`, r.manual_name)}>原手工文件</Button>
                  <Button size="small" onClick={() => download(`/finance/parallel-trials/${r.id}/report`, `并行试运行-${r.id}.xlsx`)}>报告</Button>
                  {r.status === 'compared' && r.comparison.mismatchCount > 0 && <Button size="small" onClick={() => beginEdit(r)}>登记差异</Button>}
                  {r.status === 'compared' && (
                    <Popconfirm title={r.comparison.mismatchCount ? '确认全部差异均已解释?' : '确认转换结果与原手工结果分毫一致?'} onConfirm={() => review(r.id)}>
                      <Button size="small">复核</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      )}
    </Card>
    <Modal title={`登记并行差异原因 · #${editing?.id ?? ''}`} open={!!editing} onCancel={() => setEditing(undefined)} onOk={save} width={1000}>
      <Table<ParallelTrial['comparison']['differences'][number]>
        rowKey={(r) => `${r.orgCode}:${r.accountCode}`} size="small" pagination={false} scroll={{ y: 500 }}
        dataSource={editing?.comparison.differences.filter((d) => d.differenceCents !== 0) ?? []}
        columns={[
          { title: '组合', render: (_, r) => `${r.orgCode}/${r.accountCode}`, width: 200, onCell: () => ({ style: { whiteSpace: 'nowrap' } }) },
          { title: '差异(元)', dataIndex: 'differenceCents', render: cents, width: 130 },
          {
            title: '原因', render: (_, r) => {
              const key = `${r.orgCode}|${r.accountCode}`;
              return <Input value={explanations[key]?.reason} onChange={(e) => setExplanations((old) => ({ ...old, [key]: { ...(old[key] ?? { resolution: '' }), reason: e.target.value } }))} />;
            },
          },
          {
            title: '处理结论', render: (_, r) => {
              const key = `${r.orgCode}|${r.accountCode}`;
              return <Input value={explanations[key]?.resolution} onChange={(e) => setExplanations((old) => ({ ...old, [key]: { ...(old[key] ?? { reason: '' }), resolution: e.target.value } }))} />;
            },
          },
        ]}
      />
    </Modal>
  </>;
}

const FINANCE_TABS = ['convert', 'mapping', 'parallel', 'history'] as const;

export default function FinanceImport() {
  /* 小澧助手页面登记(§7.2 finance_import)：当前步骤(页签)即工作区。 */
  const [tab, setTab] = useState('convert');
  const [scopeIssues, setScopeIssues] = useState<ScopeIssue[]>([]);

  /* URL 范围契约(UX-02):tab 双向镜像可恢复;sourceProfileId/cutoff/revisionOfId 是
     恢复入口的一次性预填(表单是「正在输入的条件」,不持续写回 URL)。 */
  const { parsed } = useUrlScopeSync('finance_import', { tab }, (p) => {
    if (p.scope.tab) {
      if ((FINANCE_TABS as readonly string[]).includes(p.scope.tab)) {
        setTab((prev) => (prev === p.scope.tab ? prev : p.scope.tab!));
      } else {
        setScopeIssues((prev) => (prev.some((x) => x.key === 'tab' && x.raw === p.scope.tab) ? prev : [...prev, {
          key: 'tab', field: 'tab', raw: p.scope.tab!, reason: 'unknown_value',
          detail: `链接中的页签「${p.scope.tab}」无效,已打开「月度转换」`,
        }]));
      }
    }
    if (p.issues.length > 0) {
      setScopeIssues((prev) => [...prev, ...p.issues.filter((issue) => !prev.some((x) => x.key === issue.key && x.raw === issue.raw))]);
    }
  }, { keys: ['tab'] });
  /* 批次历史「修订这次导入」会改 URL 的 sourceProfileId/cutoff/revisionOfId,
     用 scopeKey 重挂载月度转换页签以应用新的预填(tab 镜像只写 tab,不触发重挂载);
     页签内部的一次性预填守卫保证未重挂载时 URL 变化不会反复覆盖表单。 */
  const scopeKey = `${parsed.scope.sourceProfileId ?? ''}|${parsed.scope.cutoff ?? ''}|${parsed.scope.revisionOfId ?? ''}`;
  const goToMapping = useCallback(() => setTab('mapping'), []);
  useAssistantPageContext({ pageKey: 'finance_import', ready: true, scope: {}, view: { step: tab } });
  const items: NonNullable<TabsProps['items']> = useMemo(() => [
    { key: 'convert', label: '月度转换', children: <MonthlyConversion key={scopeKey} initialScope={parsed.scope} onGoToMapping={goToMapping} /> },
    { key: 'mapping', label: '数据源与映射审核', children: <SourceAndMapping /> },
    { key: 'parallel', label: '真实数据并行试运行', children: <ParallelTrials /> },
    { key: 'history', label: '批次历史与追溯', children: <History /> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [scopeKey, goToMapping]);
  return (
    <>
      {scopeIssues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ marginBottom: 12 }}
          onClose={() => setScopeIssues([])}
          message="链接中的范围参数已忽略"
          description={scopeIssues.map((issue) => issue.detail).join('；')}
        />
      )}
      <Tabs activeKey={tab} onChange={setTab} items={items} />
    </>
  );
}
