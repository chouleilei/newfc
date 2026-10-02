import { matchPage } from '@contracts/page-catalog';
import { useState, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Tabs, Button, Space, App, Tag, Popconfirm, Typography, Modal, Input,
  Select, Row, Col, Statistic, Alert, List, Form, InputNumber, Switch, Result,
} from 'antd';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import { FinanceEmpty } from '../components/FinanceEmpty';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { TechDetail } from '../components/TechDetail';
import ImportBatchDetailDrawer from '../components/ImportBatchDetailDrawer';
import { api, download } from '../api/client';
import { errorText } from '../components/TreeNodePage';
import { invalidateAnalysisQueries } from '../utils/queryInvalidation';
import { formatRate } from '../utils/money';
import { IMPORT_BATCH_STATUS_LABEL, type ImportBatchStatus } from '../api/importBatch';
import {
  IMPORT_BATCH_KIND_FILTER_LABEL,
  importBatchMatchesFilter,
  parseImportBatchFilters,
  rollbackCorrectionAdvice,
  summarizeImportBatch,
  yearsOfImportBatch,
  type ImportBatchKindFilter,
} from '../utils/importBatchSummary';
import EChart from '../components/EChart';
import { chartTheme, useThemeMode, statusColor } from '../theme';
import { useAssistantPageContext } from '../assistant/contextHooks';

interface BackupItem { name: string; size: number; mtime: string; monthly: boolean }
interface CheckItem { name: string; ok: boolean; problems: string[] }
interface Batch { id: number; year: number; snapshot_date: string; revision: number; status: string; source: string; updates_current: 0 | 1; entry_count?: number }

function BackupsTab() {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const { data, error, refetch } = useQuery({ queryKey: ['backups'], queryFn: () => api.get<{ items: BackupItem[] }>('/backup/list') });
  const [tagOpen, setTagOpen] = useState(false); const [tag, setTag] = useState('');
  const [verifying, setVerifying] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (tag: string) => api.post<{ file: string }>('/backup/create', { tag }),
    onSuccess: (r: { file: string }) => { message.success(`备份完成: ${r.file}`); qc.invalidateQueries({ queryKey: ['backups'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const restore = useMutation({
    mutationFn: (b: { file: string; scope: string }) => api.post<{ objectsRestored?: number }>('/backup/restore', { file: b.file, scope: b.scope, confirmed: true }),
    // 恢复会影响所有服务端数据，保留全量失效
    onSuccess: (r) => { message.success(`恢复完成${r?.objectsRestored ? `(已从备份补齐 ${r.objectsRestored} 个文件对象)` : ''},页面数据将刷新`); qc.invalidateQueries(); },
    onError: (e) => message.error(errorText(e)),
  });

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" loading={create.isPending} disabled={create.isPending} onClick={() => { setTag(''); setTagOpen(true); }}>立即备份</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          策略:每日自动备份;迁移/批量导入/年度重开/恢复前自动备份;保留最近 30 份日备 + 每月 1 份长期归档(保留 24 份)。
        </Typography.Text>
      </Space>
      {error ? <Result status="error" title="备份列表加载失败" subTitle={error instanceof Error ? error.message : String(error)} extra={<Button onClick={() => void refetch()}>重试</Button>} /> : <Table
        size="small"
        rowKey={(r: BackupItem) => `${r.monthly ? 'monthly' : 'daily'}:${r.name}`}
        loading={!data}
        dataSource={data?.items ?? []}
        columns={[
          { title: '文件名', dataIndex: 'name', render: (v: string, r: BackupItem) => <Space>{v}{r.monthly && <Tag color="purple">月度归档</Tag>}</Space> },
          { title: '大小', dataIndex: 'size', width: 110, render: (v: number) => `${(v / 1024).toFixed(1)} KB` },
          { title: '时间', dataIndex: 'mtime', width: 180, render: (v: string) => v.slice(0, 19).replace('T', ' ') },
          {
            title: '操作', width: 200,
            render: (_, r: BackupItem) => (
              <Space>
                <Button size="small" loading={verifying === r.name} onClick={async () => {
                  setVerifying(r.name);
                  try {
                    const v = await api.get<VerifyResult>(`/backup/verify?file=${encodeURIComponent(r.name)}&scope=${r.monthly ? 'monthly' : 'daily'}`);
                    const content = <VerifyDetail v={v} />;
                    if (v.ok) modal.success({ title: '备份包校验通过', content, width: 520 });
                    else modal.error({ title: '备份校验失败', content, width: 520 });
                  } catch (e) {
                    message.error(`备份校验请求失败:${errorText(e)}`);
                  } finally {
                    setVerifying(null);
                  }
                }}>校验</Button>
                <Popconfirm
                  title="恢复此备份?"
                  description="恢复前会自动备份当前库;需二次确认"
                  onConfirm={() => modal.confirm({
                    title: `二次确认:恢复备份 ${r.name}?`,
                    content: '当前数据库将被备份后替换,确认继续?',
                    okType: 'danger',
                    onOk: () => restore.mutate({ file: r.name, scope: r.monthly ? 'monthly' : 'daily' }),
                  })}
                >
                  <Button size="small" danger loading={restore.isPending} disabled={restore.isPending}>恢复</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />}
      <Modal title="立即备份" open={tagOpen} onCancel={() => setTagOpen(false)} confirmLoading={create.isPending} onOk={() => create.mutate(tag, { onSuccess: () => setTagOpen(false) })}><Input placeholder="备份标签(可留空)" value={tag} onChange={e => setTag(e.target.value)} /></Modal>
    </div>
  );
}

interface VerifyResult {
  ok: boolean; message: string;
  checks?: { name: string; ok: boolean; detail: string }[];
  runtime?: { total: number; missing: number; corrupt: number; recoverableFromBackup: number };
}

const CHECK_LABEL: Record<string, string> = { database: '数据库', manifest: '备份清单', db_sha256: '库文件摘要', object_list: '对象清单', objects: '文件对象' };

/** AC-X07:备份包逐项校验结果 + 运行对象目录核对(缺失对象可由恢复补齐)。 */
function VerifyDetail({ v }: { v: VerifyResult }) {
  const rt = v.runtime;
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {(v.checks ?? [{ name: 'database', ok: v.ok, detail: v.message }]).map((c) => (
        <div key={c.name}><Tag color={c.ok ? 'success' : 'error'}>{c.ok ? '通过' : '失败'}</Tag>{CHECK_LABEL[c.name] ?? c.name}:{c.detail}</div>
      ))}
      {rt && (
        <Typography.Text type={rt.missing || rt.corrupt ? 'warning' : 'secondary'}>
          运行对象目录:登记 {rt.total} 个{rt.missing || rt.corrupt ? `,缺失 ${rt.missing} 个、摘要不符 ${rt.corrupt} 个,其中 ${rt.recoverableFromBackup} 个可由此备份恢复时补齐` : ',全部存在'}
        </Typography.Text>
      )}
    </Space>
  );
}

function ConsistencyTab() {
  const { message } = App.useApp();
  const [result, setResult] = useState<{ ok: boolean; checks: CheckItem[] } | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      setResult(await api.get<{ ok: boolean; checks: CheckItem[] }>('/check/consistency'));
    } catch (e) {
      message.error(`一致性检查失败:${errorText(e)}`);
    } finally {
      setRunning(false);
    }
  };
  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" icon={<i className="ri-shield-check-line" aria-hidden />} loading={running} onClick={() => void run()}>运行一致性检查</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          检查项:当前实际与最新快照一致性;锁定版本明细与绑定树引用有效性;每年度当前生效版本唯一性;树快照节点引用完整性;同日快照唯一性。
        </Typography.Text>
      </Space>
      {result && (
        <Alert
          type={result.ok ? 'success' : 'error'}
          showIcon
          message={result.ok ? '全部检查通过' : '发现问题'}
          style={{ marginBottom: 12 }}
        />
      )}
      <List
        dataSource={result?.checks ?? []}
        renderItem={(c) => (
          <List.Item>
            <Space>
              {c.ok ? <Tag color="green">通过</Tag> : <Tag color="red">未通过</Tag>}
              <span>{c.name}</span>
              {!c.ok && <Typography.Text type="danger">{c.problems.join(';')}</Typography.Text>}
            </Space>
          </List.Item>
        )}
      />
    </div>
  );
}

function LogsTab() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<string | undefined>();
  const { data, error, refetch } = useQuery({
    queryKey: ['logs', page, action],
    queryFn: () => api.get<{ total: number; items: { id: number; action: string; entity_type: string; entity_id: string; detail_json: string; created_at: string }[] }>(`/logs?page=${page}&pageSize=50${action ? `&action=${action}` : ''}`),
  });
  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<i className="ri-download-2-line" aria-hidden />} onClick={() => download('/io/export/logs', '操作日志.xlsx')}>导出日志</Button>
        <Select
          allowClear placeholder="按操作类型筛选" style={{ width: 200 }} value={action} onChange={(v) => { setAction(v); setPage(1); }}
          options={[
            'org.create', 'org.move', 'account.create', 'account.deactivate',
            'budget.create', 'budget.save', 'budget.checkpoint', 'budget.lock', 'budget.set_current', 'budget.copy', 'budget.archive',
            'actual.save', 'actual.import', 'actual.history_import',
            'year.freeze', 'year.reopen', 'backup.create', 'backup.restore', 'import.failed', 'finance.conversion.recover',
          ].map((a) => ({ value: a, label: a }))}
        />
      </Space>
      {error ? (
        <QueryErrorResult title="操作日志加载失败" error={error} refetch={() => void refetch()} />
      ) : (
      <Table
        size="small"
        rowKey="id"
        dataSource={data?.items ?? []}
        pagination={{ current: page, pageSize: 50, total: data?.total ?? 0, onChange: setPage, showTotal: (t) => `共 ${t} 条` }}
        columns={[
          { title: '时间', dataIndex: 'created_at', width: 170, render: (v: string) => v.slice(0, 19).replace('T', ' ') },
          { title: '操作', dataIndex: 'action', width: 150 },
          { title: '实体类型', dataIndex: 'entity_type', width: 120 },
          { title: '实体标识', dataIndex: 'entity_id', width: 100 },
          { title: '变更摘要', dataIndex: 'detail_json', render: (v: string) => <Typography.Text style={{ fontSize: 12 }} type="secondary">{v}</Typography.Text> },
        ]}
      />
      )}
    </div>
  );
}

interface ImportHistoryRow {
  id: number;
  kind: 'budget' | 'actual';
  status: 'pending' | 'committed' | 'rolled_back' | 'cancelled';
  history: 0 | 1;
  original_name: string;
  sha256: string;
  summary_json: string;
  result_json: string;
  created_at: string;
  committed_at: string | null;
}

/** 列表行:原始记录 + 解析出的业务摘要与年度集合(供筛选;解析失败回退技术详情)。 */
interface ImportHistoryListRow extends ImportHistoryRow {
  business: ReturnType<typeof summarizeImportBatch>;
  years: number[];
}

function parseSummaryJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* 摘要损坏时按不可识别处理,业务摘要回退为技术详情 */ }
  return {};
}

function ImportHistoryTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  /* UX-19:范围筛选(年度/类型/状态)与详情批次由 URL 承接(UX-02 约定);
     非法参数不生效并就地说明,不静默替换范围;打开详情用 push,返回可回到列表原位。 */
  const [params, setParams] = useSearchParams();
  const { filter, issues: filterIssues } = useMemo(() => parseImportBatchFilters(params), [params]);
  const { data, error, refetch } = useQuery({ queryKey: ['import-batches'], queryFn: () => api.get<{ items: ImportHistoryRow[] }>('/io/import-batches') });
  // 预算目标版本名/年度映射:列表行只有 versionId,版本目录一次性取回
  const versionsQuery = useQuery({ queryKey: ['versions'], queryFn: () => api.get<{ id: number; year: number; name: string }[]>('/versions') });
  const rows = useMemo<ImportHistoryListRow[]>(() => {
    const items = data?.items ?? [];
    const nameById = new Map((versionsQuery.data ?? []).map((v) => [v.id, v.name] as const));
    const yearById = new Map((versionsQuery.data ?? []).map((v) => [v.id, v.year] as const));
    return items.map((row) => {
      const summary = parseSummaryJson(row.summary_json);
      const versionId = typeof summary.versionId === 'number' ? summary.versionId : undefined;
      return {
        ...row,
        business: summarizeImportBatch({
          kind: row.kind,
          history: row.history === 1,
          summary,
          versionName: versionId != null ? nameById.get(versionId) ?? null : null,
        }),
        years: yearsOfImportBatch({ kind: row.kind, summary }, yearById),
      };
    });
  }, [data, versionsQuery.data]);
  const yearOptions = useMemo(() => [...new Set(rows.flatMap((row) => row.years))].sort((a, b) => b - a), [rows]);
  const filteredRows = useMemo(
    () => rows.filter((row) => importBatchMatchesFilter({ kind: row.kind, history: row.history === 1, status: row.status, years: row.years }, filter)),
    [rows, filter],
  );
  const filterActive = filter.year != null || filter.kind != null || filter.status != null;
  const updateFilter = (patch: Partial<Record<'year' | 'kind' | 'status', string | undefined>>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  /* 批次详情入口:URL batch=<id> 承接财务批次历史等跨页互链 */
  const batchParam = params.get('batch');
  const detailBatchId = batchParam != null && /^\d+$/.test(batchParam) ? Number(batchParam) : null;
  const openDetail = (id: number) => {
    const next = new URLSearchParams(params);
    next.set('batch', String(id));
    setParams(next);
  };
  const closeDetail = () => {
    const next = new URLSearchParams(params);
    next.delete('batch');
    setParams(next, { replace: true });
  };

  const mutate = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'rollback' | 'cancel' }) => api.post(`/io/import-batches/${id}/${action}`),
    onSuccess: (_r, v) => {
      message.success(v.action === 'rollback' ? '该批次导入已撤销，相关数据恢复到导入前' : '预览已取消，未写入任何数据');
      qc.invalidateQueries({ queryKey: ['import-batches'] });
      qc.invalidateQueries({ queryKey: ['import-batch-detail'] });
      qc.invalidateQueries({ queryKey: ['actual-matrix'] });
      if (v.action === 'rollback') void invalidateAnalysisQueries(qc);
    },
    // 撤销被服务端拒绝(已有后续修改等):原因与更正路径持续展示,不伪装可安全撤销
    onError: (e, v) => {
      if (v.action === 'rollback') {
        const row = rows.find((item) => item.id === v.id);
        modal.error({
          title: `批次 #${v.id} 不能安全撤销`,
          content: `${errorText(e)}。${rollbackCorrectionAdvice({ kind: row?.kind ?? 'actual', history: row?.history === 1 })}`,
        });
        return;
      }
      message.error(errorText(e));
    },
  });
  return (
    <div>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="每次预览都会保存原始 Excel、SHA-256 和影响摘要；只有相关数据未被后续修改时才允许撤销已导入。" />
      {filterIssues.length > 0 && (
        <Alert
          key={filterIssues.join('|')}
          type="warning" showIcon closable style={{ marginBottom: 12 }}
          message="链接中的部分筛选参数已忽略"
          description={filterIssues.join('；')}
        />
      )}
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear placeholder="年度" style={{ width: 110 }}
          value={filter.year} options={yearOptions.map((y) => ({ value: y, label: `${y} 年` }))}
          onChange={(v) => updateFilter({ year: v != null ? String(v) : undefined })}
        />
        <Select
          allowClear placeholder="类型" style={{ width: 200 }}
          value={filter.kind}
          options={(Object.entries(IMPORT_BATCH_KIND_FILTER_LABEL) as [ImportBatchKindFilter, string][]).map(([value, label]) => ({ value, label }))}
          onChange={(v) => updateFilter({ kind: v })}
        />
        <Select
          allowClear placeholder="状态" style={{ width: 120 }}
          value={filter.status}
          options={(Object.entries(IMPORT_BATCH_STATUS_LABEL) as [ImportBatchStatus, string][]).map(([value, label]) => ({ value, label }))}
          onChange={(v) => updateFilter({ status: v })}
        />
        {filterActive && <Button size="small" onClick={() => updateFilter({ year: undefined, kind: undefined, status: undefined })}>清除筛选</Button>}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>筛选条件记录在网址中，可收藏或分享后恢复同一范围</Typography.Text>
      </Space>
      {error ? (
        <QueryErrorResult title="导入批次加载失败" error={error} refetch={() => void refetch()} />
      ) : (
      <Table
        size="small"
        rowKey="id"
        dataSource={filteredRows}
        pagination={{ pageSize: 20 }}
        locale={{
          emptyText: filterActive ? (
            <FinanceEmpty
              kind="search"
              description="当前筛选条件下没有导入批次"
              onClearFilters={() => updateFilter({ year: undefined, kind: undefined, status: undefined })}
            />
          ) : (
            <FinanceEmpty kind="data" description="暂无导入批次记录">
              <Space style={{ marginTop: 8 }}>
                <Button type="primary" size="small" onClick={() => navigate('/actual')}>
                  前往实际录入与快照导入
                </Button>
                <Button size="small" onClick={() => navigate('/finance')}>
                  财务系统转换
                </Button>
              </Space>
            </FinanceEmpty>
          ),
        }}
        columns={[
        { title: '批次', dataIndex: 'id', width: 70, render: (v: number) => <Typography.Link onClick={() => openDetail(v)}>#{v}</Typography.Link> },
        { title: '类型', dataIndex: 'kind', width: 90, render: (v: string, r: ImportHistoryListRow) => <Tag color={v === 'budget' ? 'blue' : 'purple'}>{v === 'budget' ? '预算' : r.history ? '历史补录' : '实际数'}</Tag> },
        { title: '状态', dataIndex: 'status', width: 90, render: (v: ImportBatchStatus) => <Tag color={{ pending: 'gold', committed: 'green', rolled_back: 'default', cancelled: 'default' }[v]}>{IMPORT_BATCH_STATUS_LABEL[v] ?? v}</Tag> },
        { title: '原文件', dataIndex: 'original_name', width: 180, ellipsis: true },
        /* UX-19 摘要列业务化:来源/年度/目标/期间/动作计数;原始 JSON 仅留「技术详情」折叠 */
        { title: '摘要', width: 320, render: (_: unknown, r: ImportHistoryListRow) => {
          const b = r.business;
          if (!b.recognized) {
            return <TechDetail summary={<Typography.Text type="secondary" style={{ fontSize: 12 }}>摘要格式未识别，查看原始字段</Typography.Text>} raw={r.summary_json} />;
          }
          return (
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Space size={4} wrap>
                <Tag style={{ marginInlineEnd: 0 }}>{b.sourceLabel}</Tag>
                {b.yearsLabel && <Typography.Text style={{ fontSize: 12 }}>{b.yearsLabel}</Typography.Text>}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{b.targetLabel}</Typography.Text>
              </Space>
              {b.periodsLabel && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{b.periodsLabel}</Typography.Text>}
              <TechDetail
                summary={<Typography.Text style={{ fontSize: 12 }}>{[b.actionsLabel, b.countLabel].filter(Boolean).join('；') || '无动作计数'}</Typography.Text>}
                raw={r.summary_json}
              />
            </Space>
          );
        } },
        { title: '时间', dataIndex: 'created_at', width: 165, render: (v: string) => v.slice(0, 19).replace('T', ' ') },
        /* 文案纪律(4.9):待确认=「取消预览」,已提交=「撤销已导入」,绝不共用含糊按钮名 */
        { title: '操作', width: 250, render: (_: unknown, r: ImportHistoryListRow) => <Space wrap>
          <Button size="small" onClick={() => openDetail(r.id)}>详情</Button>
          {r.status !== 'cancelled' && <Button size="small" onClick={() => download(`/io/import-batches/${r.id}/source`, r.original_name)}>原文件</Button>}
          {r.status === 'pending' && (
            <Popconfirm
              title={`取消待确认批次 #${r.id} 的预览?`}
              description="取消后这份预览即失效，不会写入任何数据；如需导入，需要重新上传并生成新预览。"
              okText="取消预览"
              onConfirm={() => mutate.mutate({ id: r.id, action: 'cancel' })}
            ><Button size="small">取消预览</Button></Popconfirm>
          )}
          {r.status === 'committed' && !r.history && (
            <Popconfirm
              title={`撤销批次 #${r.id} 的已导入数据?`}
              description="仅当导入后相关数据未再改动时才会撤销成功；已有后续修改时将被拒绝并给出原因与更正路径。"
              okText="撤销已导入"
              okButtonProps={{ danger: true }}
              onConfirm={() => mutate.mutate({ id: r.id, action: 'rollback' })}
            ><Button size="small" danger>撤销已导入</Button></Popconfirm>
          )}
        </Space> },
      ]} />
      )}
      <ImportBatchDetailDrawer batchId={detailBatchId} onClose={closeDetail} />
    </div>
  );
}

interface CalculationRuleDto {
  id: number; code: string; name: string; rule_type: 'quantity_price_net_tax' | 'multiply';
  sheet_code: string; config_json: string; status: 'active' | 'inactive'; sort_order: number;
}

function CalculationRulesTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CalculationRuleDto | null>(null);
  const [form] = Form.useForm();
  const { data, error, refetch } = useQuery({ queryKey: ['calculation-rules-all'], queryFn: () => api.get<{ items: CalculationRuleDto[] }>('/calculation-rules?all=1') });
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const ruleType = v.ruleType as CalculationRuleDto['rule_type'];
      const config = ruleType === 'quantity_price_net_tax'
        ? { quantityAccountCode: v.quantityAccountCode, priceAccountCode: v.priceAccountCode, taxAccountCode: v.taxAccountCode, defaultTaxRate: String(v.defaultTaxRate ?? 0), outputAccountCode: v.outputAccountCode }
        : { leftAccountCode: v.leftAccountCode, rightAccountCode: v.rightAccountCode, outputAccountCode: v.outputAccountCode };
      const body = { ...v, config, status: v.enabled ? 'active' : 'inactive' };
      return editing ? api.put(`/calculation-rules/${editing.id}`, body) : api.post('/calculation-rules', body);
    },
    onSuccess: () => { message.success('测算模板已保存'); setOpen(false); qc.invalidateQueries({ queryKey: ['calculation-rules'] }); qc.invalidateQueries({ queryKey: ['calculation-rules-all'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const edit = (row?: CalculationRuleDto) => {
    let cfg: Record<string, unknown> = {};
    if (row) {
      try {
        const parsed: unknown = JSON.parse(row.config_json);
        if (parsed == null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('配置不是对象');
        cfg = parsed as Record<string, unknown>;
      } catch {
        message.error(`测算模板 ${row.code} 的配置已损坏，无法编辑；请先修复或停用该记录`);
        return;
      }
    }
    setEditing(row ?? null); form.resetFields();
    form.setFieldsValue({ code: row?.code, name: row?.name, ruleType: row?.rule_type ?? 'quantity_price_net_tax', sheetCode: row?.sheet_code ?? '', sortOrder: row?.sort_order ?? 0, enabled: row?.status !== 'inactive', ...cfg });
    setOpen(true);
  };
  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap><Button type="primary" onClick={() => edit()}>新增测算模板</Button><Typography.Text type="secondary">只支持“量×价÷税”和“两参数相乘”，不会执行任意代码。</Typography.Text></Space>
      {error ? (
        <QueryErrorResult title="测算模板加载失败" error={error} refetch={() => void refetch()} />
      ) : (
      <Table
        size="small"
        rowKey="id"
        dataSource={data?.items ?? []}
        pagination={false}
        locale={{
          emptyText: (
            <FinanceEmpty kind="data" description="暂无测算模板">
              <Button type="primary" size="small" onClick={() => edit()} style={{ marginTop: 8 }}>
                + 新增测算模板
              </Button>
            </FinanceEmpty>
          ),
        }}
        columns={[
        /* 测算规则码最长 18 字符大写 ≈155px:170 内宽不足,按规范取 ~185 + 尾部省略 */
        { title: '编码', dataIndex: 'code', width: 185, ellipsis: { showTitle: true } }, { title: '名称', dataIndex: 'name', ellipsis: { showTitle: true } },
        { title: '模板类型', dataIndex: 'rule_type', width: 160, render: (v: string) => v === 'multiply' ? '两参数相乘' : '量×价÷(1+税率)' },
        { title: '表格', dataIndex: 'sheet_code', width: 110 },
        { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === 'active' ? 'green' : 'default'}>{v === 'active' ? '启用' : '停用'}</Tag> },
        { title: '操作', width: 90, render: (_: unknown, r: CalculationRuleDto) => <Button size="small" onClick={() => edit(r)}>编辑</Button> },
      ]} />
      )}
      <Modal title={editing ? '编辑测算模板' : '新增测算模板'} open={open} onCancel={() => setOpen(false)} onOk={() => form.validateFields().then((v) => save.mutate(v))} confirmLoading={save.isPending} width={620}>
        <Form form={form} layout="vertical">
          <Space style={{ display: 'flex' }}><Form.Item name="code" label="模板编码" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="name" label="模板名称" rules={[{ required: true }]}><Input /></Form.Item></Space>
          <Form.Item name="ruleType" label="模板类型" rules={[{ required: true }]}><Select options={[{ value: 'quantity_price_net_tax', label: '量×价÷(1+税率)' }, { value: 'multiply', label: '两个数量参数相乘' }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.ruleType !== b.ruleType}>{({ getFieldValue }) => getFieldValue('ruleType') === 'quantity_price_net_tax' ? <>
            <Space style={{ display: 'flex' }}><Form.Item name="quantityAccountCode" label="数量科目" rules={[{ required: true }]}><Input placeholder="Q101" /></Form.Item><Form.Item name="priceAccountCode" label="价格科目" rules={[{ required: true }]}><Input placeholder="Q2" /></Form.Item><Form.Item name="taxAccountCode" label="税率科目"><Input placeholder="Q3" /></Form.Item></Space>
            <Form.Item
              name="defaultTaxRate"
              label="缺省税率(%)"
              rules={[{ type: 'number', min: -99.9999, message: '税率必须大于 -100%' }]}
            ><InputNumber min={-99.9999} precision={4} /></Form.Item>
          </> : <Space style={{ display: 'flex' }}><Form.Item name="leftAccountCode" label="乘数科目一" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="rightAccountCode" label="乘数科目二" rules={[{ required: true }]}><Input /></Form.Item></Space>}</Form.Item>
          <Form.Item name="outputAccountCode" label="输出金额科目" rules={[{ required: true }]}><Input placeholder="I1101" /></Form.Item>
          <Space><Form.Item name="sheetCode" label="优先使用表格"><Input placeholder="power" /></Form.Item><Form.Item name="sortOrder" label="排序"><InputNumber /></Form.Item><Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Space>
        </Form>
      </Modal>
    </div>
  );
}

function YearCloseTab() {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const { data: years, error: yearsError, refetch: refetchYears } = useQuery({ queryKey: ['actual-years'], queryFn: () => api.get<{ year: number; status: string; current_batch_id: number | null; final_batch_id: number | null; frozen_at: string | null }[]>('/actual/years') });
  const [selectedYear, setSelectedYear] = useState<number | undefined>();
  const [reopenOpen, setReopenOpen] = useState(false); const [reopenReason, setReopenReason] = useState('');

  const year = years?.find((y) => y.year === selectedYear);
  const { data: batches } = useQuery({
    queryKey: ['batches-close', selectedYear],
    enabled: !!selectedYear,
    queryFn: () => api.get<Batch[]>(`/actual/batches?year=${selectedYear}`),
  });

  const { data: accuracy } = useQuery({
    queryKey: ['accuracy', year?.year],
    enabled: year?.status === 'frozen',
    queryFn: () => api.get<{ typeAccuracy: Record<string, { e: number | null; q: number | null; rate: number | null }> }>(`/report/accuracy?year=${year!.year}`),
  });

  const freeze = useMutation({
    mutationFn: (batch: Batch) => api.post(`/years/${selectedYear}/freeze`, {
      finalBatchId: batch.id,
      confirmEmpty: batch.entry_count === 0,
      confirmNonCurrent: batch.updates_current !== 1 || batch.id !== year?.current_batch_id,
    }),
    onSuccess: () => { message.success('年度已关闭,历史报表将读取最终快照'); qc.invalidateQueries({ queryKey: ['actual-years'] }); qc.invalidateQueries({ queryKey: ['batches'] }); qc.invalidateQueries({ queryKey: ['actual-matrix'] }); void invalidateAnalysisQueries(qc); },
    onError: (e) => message.error(errorText(e)),
  });

  const reopen = useMutation({
    mutationFn: (reason: string) => api.post(`/years/${selectedYear}/reopen`, { reason }),
    onSuccess: () => { message.success('年度已重新打开'); qc.invalidateQueries({ queryKey: ['actual-years'] }); qc.invalidateQueries({ queryKey: ['actual-matrix'] }); void invalidateAnalysisQueries(qc); },
    onError: (e) => message.error(errorText(e)),
  });

  const activeBatches = (batches ?? []).filter((b) => b.status === 'active');

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          placeholder="选择年度" style={{ width: 120 }} value={selectedYear} onChange={setSelectedYear}
          options={(years ?? []).map((y) => ({ value: y.year, label: `${y.year} 年` }))}
        />
        {year && (year.status === 'open' ? <Tag color="green">开放</Tag> : <Tag color="blue">已冻结</Tag>)}
      </Space>
      {yearsError && (
        <Alert
          type="error" showIcon style={{ marginBottom: 12 }}
          message="年度列表加载失败"
          description={errorText(yearsError)}
          action={<Button size="small" onClick={() => void refetchYears()}>重试</Button>}
        />
      )}
      {!year && <Typography.Text type="secondary">选择年度后管理年度关闭。</Typography.Text>}
      {year && (
        <>
          {year.status === 'open' ? (
            <>
              <Typography.Paragraph>选择年度最终实际快照并关闭。关闭后:禁止更新实际数;历史报表改读最终快照(重开需填原因,最终快照保留,重新关闭时覆盖)。</Typography.Paragraph>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={activeBatches}
                columns={[
                  { title: '截止日期', dataIndex: 'snapshot_date', width: 120 },
                  { title: '修订', dataIndex: 'revision', width: 70 },
                  { title: '来源', dataIndex: 'source', width: 110 },
                  { title: '是否当前实际', dataIndex: 'updates_current', width: 120, render: (v: number) => (v ? <Tag color="blue">当前</Tag> : '补录') },
                  { title: '明细数', dataIndex: 'entry_count', width: 80 },
                  {
                    title: '操作', width: 140,
                    render: (_, b: Batch) => (
                      <Popconfirm
                        title={`以 ${b.snapshot_date}(修订${b.revision})作为最终快照关闭 ${year.year} 年度?`}
                        onConfirm={() => modal.confirm({
                          title: `二次确认:关闭 ${year.year} 年度`,
                          content: `${b.entry_count === 0 ? '警告：该批次为空，确认即代表本年度明确零申报。' : ''}${b.updates_current !== 1 || b.id !== year.current_batch_id ? '警告：该批次不是当前实际快照。' : ''}最终快照:${b.snapshot_date}(修订 ${b.revision})。关闭后该年度实际数不可修改。`,
                          onOk: () => freeze.mutate(b),
                        })}
                      >
                        {/* 音量守恒(3.6③):年度关闭是行内若干动作之一,不承担本页主流程,
                            行级实心主按钮一屏多枚会让主次失效 —— 降级为 default。 */}
                        <Button size="small" disabled={freeze.isPending}>设为最终快照并关闭</Button>
                      </Popconfirm>
                    ),
                  },
                ]}
              />
            </>
          ) : (
            <>
              <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`该年度已冻结(冻结时间 ${year.frozen_at?.slice(0, 19).replace('T', ' ') ?? '-'})`} />
              <Button
                danger
                onClick={() => { setReopenReason(''); setReopenOpen(true); }} disabled={reopen.isPending}
              >重新打开年度</Button>
              {accuracy && (
                <>
                  <Row gutter={16} style={{ marginTop: 16 }}>
                    {Object.entries(accuracy.typeAccuracy).map(([k, v]) => (
                      <Col key={k} span={6}>
                        <Card size="small">
                          <Statistic
                            title={{ income: '收入准确率', cost: '成本准确率', expense: '费用准确率', profit: '利润准确率' }[k] ?? k}
                            value={v.q == null ? '不适用' : formatRate(v.q)}
                            suffix={v.rate != null ? `(完成率 ${formatRate(v.rate)})` : '(预算为 0，完成率不适用)'}
                          />
                        </Card>
                      </Col>
                    ))}
                  </Row>
                  {/* 准确率仪表盘 + 偏差率条形。数据只在年度冻结后才有(接口对未冻结年度 400),
                      所以整块挂在 accuracy 存在的分支里。 */}
                  <AccuracyCharts accuracy={accuracy} />
                </>
              )}
            </>
          )}
        </>
      )}
      <Modal title="重新打开年度" open={reopenOpen} onCancel={() => setReopenOpen(false)} confirmLoading={reopen.isPending} okButtonProps={{ disabled: !reopenReason.trim(), title: reopenReason.trim() ? undefined : '请先填写重开原因' }} onOk={() => { if (!reopenReason.trim()) { message.warning('请填写重开原因(将记录到操作日志)'); return; } modal.confirm({ title:'二次确认:重新打开年度?', content:`原因:${reopenReason}`, onOk:()=>reopen.mutate(reopenReason, { onSuccess:()=>setReopenOpen(false) }) }); }}><Input.TextArea rows={4} placeholder="请输入原因(将记录日志)" value={reopenReason} onChange={e=>setReopenReason(e.target.value)} /></Modal>
    </div>
  );
}

/**
 * 年度准确率的两个图表:利润准确率仪表盘 + 四类偏差率条形。
 * e 是偏差率(越小越好),q 是准确率;预算为 0 时两者都是 null,图上不画。
 */
function AccuracyCharts({ accuracy }: {
  accuracy: { typeAccuracy: Record<string, { e: number | null; q: number | null; rate: number | null }> };
}) {
  const { mode } = useThemeMode();
  const t = chartTheme(mode);
  const status = statusColor(mode);
  const profit = accuracy.typeAccuracy.profit;
  const q = profit?.q ?? null;

  const gaugeOption = useMemo(() => ({
    tooltip: { formatter: (p: { value: number }) => `利润准确率 ${(p.value * 100).toFixed(2)}%` },
    series: [{
      type: 'gauge',
      startAngle: 200, endAngle: -20, min: 0, max: 1,
      radius: '92%', center: ['50%', '62%'],
      /* 分档是状态语义(差/中/好),取 STATUS_COLOR 而不是 chartTheme 系列色 ——
         系列色为区分类型避开了红绿,仪表盘恰恰需要红黄绿直读好坏。 */
      axisLine: {
        lineStyle: { width: 14, color: [[0.6, status.bad], [0.8, status.warn], [1, status.good]] },
      },
      pointer: { itemStyle: { color: t.colors[0] } },
      axisTick: { distance: -14, length: 5, lineStyle: { color: t.axisLine, width: 1 } },
      splitLine: { distance: -16, length: 12, lineStyle: { color: t.axisLine, width: 2 } },
      axisLabel: { distance: 18, fontSize: 12, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      detail: { valueAnimation: true, fontSize: 24, offsetCenter: [0, '38%'], formatter: (v: number) => `${(v * 100).toFixed(2)}%`, color: t.text },
      title: { offsetCenter: [0, '70%'], fontSize: 12, color: t.subText },
      data: [{ value: q ?? 0, name: '利润准确率' }],
    }],
  }), [q, mode, t, status]);

  const order = ['income', 'cost', 'expense', 'profit'];
  const rows = order.filter((key) => accuracy.typeAccuracy[key]);
  const deviationOption = useMemo(() => ({
    tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v == null ? '不适用（预算为 0）' : `${(v * 100).toFixed(2)}%`) },
    grid: { top: 20, left: 60, right: 70, bottom: 20 },
    xAxis: { type: 'value', max: (v: { max: number }) => Math.max(v.max * 1.15, 0.05), axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%`, color: t.subText } },
    yAxis: { type: 'category', data: rows.map((k) => ({ income: '收入', cost: '成本', expense: '费用', profit: '利润' }[k] ?? k)), axisLabel: { color: t.text } },
    series: [{
      type: 'bar',
      barWidth: '48%',
      data: rows.map((key) => {
        const e = accuracy.typeAccuracy[key]?.e ?? null;
        /* 偏差越大越红;e 为 null(预算为 0)时不画 */
        return { value: e, itemStyle: { color: e == null ? 'transparent' : e > 0.2 ? status.bad : e > 0.1 ? status.warn : status.good, borderRadius: [0, 3, 3, 0] } };
      }),
      label: { show: true, position: 'right', fontSize: 12, formatter: (p: { value: number | null }) => (p.value == null ? '' : `${(p.value * 100).toFixed(2)}%`), color: t.text },
    }],
  }), [accuracy, rows.join(','), t, status]);

  if (q == null && rows.length === 0) return null;
  return (
    <Row gutter={16} style={{ marginTop: 16 }}>
      {q != null && <Col xs={24} lg={10}><Card size="small" title="利润准确率"><EChart option={gaugeOption} height={280} /></Card></Col>}
      {rows.length > 0 && <Col xs={24} lg={14}><Card size="small" title="预实偏差率" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>≤10% 绿 / 10–20% 橙 / &gt;20% 红</Typography.Text>}><EChart option={deviationOption} height={280} /></Card></Col>}
    </Row>
  );
}

function MigrationTab() {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const { data, error, refetch } = useQuery({
    queryKey: ['migrations'],
    queryFn: () => api.get<{ applied: { version: number; name: string; applied_at: string }[]; pending: { version: number; name: string }[] }>('/migrations'),
  });
  const apply = useMutation({
    mutationFn: () => api.post('/migrations/apply', { confirmed: true }),
    // 迁移可能改变全部数据域，保留全量失效
    onSuccess: () => { message.success('迁移完成(迁移前已自动备份)'); refetch(); qc.invalidateQueries(); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button
          type="primary" icon={<i className="ri-database-2-line" aria-hidden />}
          disabled={!data || data.pending.length === 0}
          onClick={() => modal.confirm({
            title: '应用待执行迁移?',
            content: '迁移前将自动备份当前数据库;迁移不破坏历史数据。',
            onOk: () => apply.mutate(),
          })}
        >
          应用待执行迁移
        </Button>
        {data && data.pending.length === 0 && <Tag color="green">已是最新版本</Tag>}
      </Space>
      {error ? (
        <QueryErrorResult title="迁移信息加载失败" error={error} refetch={() => void refetch()} />
      ) : (
      <Table
        size="small"
        rowKey="version"
        pagination={false}
        dataSource={data?.applied ?? []}
        columns={[
          { title: '版本', dataIndex: 'version', width: 80 },
          { title: '迁移名称', dataIndex: 'name' },
          { title: '执行时间', dataIndex: 'applied_at', width: 180, render: (v: string) => v.slice(0, 19).replace('T', ' ') },
        ]}
      />
      )}
    </div>
  );
}

function ExportTab() {
  const { data: versions } = useQuery({ queryKey: ['versions'], queryFn: () => api.get<{ id: number; year: number; name: string }[]>('/versions') });
  const [versionId, setVersionId] = useState<number | undefined>();
  const selectedVersion = versions?.find((version) => version.id === versionId);
  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        导出文件头部包含报表名称、年度、预算版本、实际截止日期、组织/科目口径、生成时间、金额单位与数据说明。
      </Typography.Paragraph>
      <Space wrap>
        <Select
          showSearch optionFilterProp="label" placeholder="选择预算版本" style={{ width: 240 }}
          value={versionId} onChange={setVersionId}
          options={(versions ?? []).map((v) => ({ value: v.id, label: `${v.year} · ${v.name}` }))}
        />
        <Button icon={<i className="ri-download-2-line" aria-hidden />} disabled={!versionId} onClick={() => download(`/io/export/budget-detail/${versionId}`, '预算编制明细.xlsx')}>预算编制明细</Button>
        <Button icon={<i className="ri-download-2-line" aria-hidden />} disabled={!versionId} onClick={() => download(`/io/export/completion/${versionId}`, '预算完成情况.xlsx')}>预算完成情况</Button>
        <Button icon={<i className="ri-download-2-line" aria-hidden />} disabled={!selectedVersion} onClick={() => selectedVersion && download(`/io/export/actual-current/${selectedVersion.year}`, `${selectedVersion.year}年当前累计实际.xlsx`)}>当前累计实际</Button>
        <Button icon={<i className="ri-download-2-line" aria-hidden />} onClick={() => download('/io/export/historical', '历年预实对比.xlsx')}>历年预实对比</Button>
        <Button icon={<i className="ri-download-2-line" aria-hidden />} onClick={() => download('/io/export/metrics', '报表指标.xlsx')}>报表指标</Button>
        <Button icon={<i className="ri-download-2-line" aria-hidden />} onClick={() => download('/io/template/actual', '实际数导入模板.xlsx')}>实际数导入模板</Button>
        <Button icon={<i className="ri-download-2-line" aria-hidden />} onClick={() => download('/io/template/budget', '预算导入模板.xlsx')}>预算导入模板</Button>
      </Space>
    </div>
  );
}

/* 每个入口只声明自己要展示哪些页签。title 已移除:
   它原本与侧栏菜单项同名,页面标题由顶栏统一承担。 */
const PRESETS: Record<string, { keys: string[] }> = {
  calculations: { keys: ['calculations'] },
  yearclose: { keys: ['yearclose'] },
  backup: { keys: ['backup', 'migration', 'export'] },
  logs: { keys: ['logs'] },
  imports: { keys: ['imports'] },
  check: { keys: ['check'] },
  export: { keys: ['backup', 'migration', 'export'] },
  migration: { keys: ['backup', 'migration', 'export'] },
};

export default function DataManage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'backup';
  const preset = PRESETS[tab] ?? PRESETS.backup;
  const all = [
    { key: 'export', label: '导入导出', children: <ExportTab /> },
    { key: 'imports', label: '导入批次', children: <ImportHistoryTab /> },
    { key: 'calculations', label: '测算模板', children: <CalculationRulesTab /> },
    { key: 'yearclose', label: '年度关闭', children: <YearCloseTab /> },
    { key: 'backup', label: '备份恢复', children: <BackupsTab /> },
    { key: 'check', label: '一致性检查', children: <ConsistencyTab /> },
    { key: 'logs', label: '操作日志', children: <LogsTab /> },
    { key: 'migration', label: '迁移管理', children: <MigrationTab /> },
  ];
  const items = all.filter((t) => preset.keys.includes(t.key));
  const active = preset.keys.includes(tab) ? tab : preset.keys[0];

  /* 财务助手页面登记(§7.2)：登记组件最终算出的 active 页签，
     无效 tab 最终显示 backup 时 pageKey 也必须是 backup;tab=check 必须是 data_check。 */
  const activePageKey = matchPage('/data', `?tab=${active}`)!;
  useAssistantPageContext({ pageKey: activePageKey, ready: true, scope: {}, view: {} });

  return (
    /* 无壳 + 无标题:原 preset.title 与侧栏菜单项同名,顶栏已显示一遍。
       多页签分支由 Tabs 自己承担分区,不需要再叠一层标题。 */
    <Card className="newfc-root-card">
      {items.length === 1 ? items[0].children : (
        <Tabs
          activeKey={active}
          onChange={(key) => {
            const next = new URLSearchParams(params);
            next.set('tab', key);
            setParams(next, { replace: true });
          }}
          items={items}
        />
      )}
    </Card>
  );
}

void Modal; void Input;
