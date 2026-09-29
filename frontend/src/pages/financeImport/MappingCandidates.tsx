/**
 * 财务映射「候选建议」面板(AI 功能增强计划阶段二)。
 *
 * 两条入口:
 * 1. 未映射清单:选一个财务转换批次,后端用运行时匹配器算出该批次里仍未映射的源组织/源科目,
 *    一次性为全部未映射源取候选(单次请求 ≤100 条),每行给出确定性 top-1 作为默认选择,
 *    用户逐行调整后「批量采纳」一次性写回——避免几十个未映射源要点几十次。
 * 2. 单条试算:手工输入源编码/名称,用于清单之外的临时核对。
 *
 * 后端先在映射版本绑定树快照字典上确定性打分产出 top-N;勾选「低置信时请求 AI 残差建议」后,
 * 确定性候选为空或低置信的行才调用模型。采纳只把「目标 + 来源标记 + 未复核状态」写回整表 PUT
 * (与手工编辑同一通道),不存在模型直写路径;采纳行需复核(逐行标记或锁定时显式确认)后才可定稿。
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, App, Button, Card, Checkbox, Empty, Input, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { api } from '../../api/client';
import { errorText } from '../../components/TreeNodePage';

export interface CandidateInput {
  kind: 'org' | 'account';
  sourceCode?: string;
  sourceName?: string;
  sourceBookCode?: string;
}

export interface Candidate {
  targetId: number;
  code: string;
  name: string;
  path: string;
  type?: string;
  score: number;
  source: 'alias' | 'deterministic' | 'ai';
  reason?: string;
}

interface CandidateResult {
  input: CandidateInput;
  exactCodeMatched: boolean;
  deterministicTopScore: number;
  candidates: Candidate[];
  aiUsed: boolean;
}

interface UnmappedSourceRow {
  sourceBookCode?: string;
  sourceCode: string;
  sourceName: string;
  rowCount: number;
  firstSheet: string;
  firstRow: number;
}

interface UnmappedSources {
  conversionId: number;
  year: number;
  snapshotDate: string;
  sourceRowCount: number;
  org: UnmappedSourceRow[];
  account: UnmappedSourceRow[];
}

interface ConversionOption {
  id: number;
  year: number;
  snapshot_date: string;
  status: string;
  source_profile_id: number;
  mapping_version_id: number;
}

/** 批量工作流里每个未映射源的当前选择 */
interface BatchRow {
  source: UnmappedSourceRow;
  result: CandidateResult;
  /** 用户选中的目标(默认取确定性 top-1);null = 本行跳过 */
  selected: Candidate | null;
}

const SOURCE_TAG: Record<Candidate['source'], { color: string; label: string }> = {
  alias: { color: 'green', label: '别名' },
  deterministic: { color: 'blue', label: '确定性' },
  ai: { color: 'purple', label: 'AI 建议' },
};

/** 单次候选请求的源条数上限,与后端 items 上限一致 */
const MAX_BATCH_ITEMS = 100;

function candidateLabel(candidate: Candidate): string {
  return `${candidate.code} ${candidate.name}（${(candidate.score * 100).toFixed(0)}%·${SOURCE_TAG[candidate.source].label}）`;
}

export function MappingCandidatesPanel(props: {
  versionId: number;
  /** 映射版本所属数据源;用于筛出同源的转换批次 */
  sourceProfileId: number;
  /** 非草稿版本禁止采纳(映射行只读) */
  readOnly: boolean;
  onAdopt: (kind: 'org' | 'account', input: CandidateInput, candidate: Candidate) => Promise<void>;
  /** 批量采纳:一次整表 PUT 写回全部选择 */
  onAdoptBatch: (kind: 'org' | 'account', rows: { input: CandidateInput; candidate: Candidate }[]) => Promise<void>;
}) {
  const { message } = App.useApp();
  const [mode, setMode] = useState<'batch' | 'single'>('batch');
  const [kind, setKind] = useState<'org' | 'account'>('org');
  const [allowAi, setAllowAi] = useState(true);

  // ---- 单条试算 ----
  const [sourceCode, setSourceCode] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [pending, setPending] = useState(false);
  const [adopting, setAdopting] = useState<string>('');
  const [results, setResults] = useState<CandidateResult[] | null>(null);

  // ---- 批量工作流 ----
  const [conversionId, setConversionId] = useState<number>();
  const [batchRows, setBatchRows] = useState<BatchRow[] | null>(null);
  const [batchPending, setBatchPending] = useState(false);
  const [batchSaving, setBatchSaving] = useState(false);

  const conversions = useQuery({
    queryKey: ['finance-conversions'],
    queryFn: () => api.get<{ items: ConversionOption[] }>('/finance/conversions'),
  });
  const sameProfileConversions = useMemo(
    () => (conversions.data?.items ?? []).filter((item) => item.source_profile_id === props.sourceProfileId),
    [conversions.data, props.sourceProfileId],
  );

  const unmapped = useQuery({
    queryKey: ['finance-unmapped-sources', props.versionId, conversionId],
    enabled: mode === 'batch' && Boolean(conversionId),
    queryFn: () => api.get<UnmappedSources>(`/finance/mapping-versions/${props.versionId}/unmapped-sources?conversionId=${conversionId}`),
  });
  const unmappedRows = kind === 'org' ? unmapped.data?.org ?? [] : unmapped.data?.account ?? [];

  const fetchCandidates = async () => {
    if (!sourceCode.trim() && !sourceName.trim()) {
      message.warning('请输入源编码或源名称');
      return;
    }
    setPending(true);
    try {
      const response = await api.post<{ items: CandidateResult[] }>(
        `/finance/mapping-versions/${props.versionId}/mapping-candidates`,
        { kind, allowAi, items: [{ sourceCode: sourceCode.trim(), sourceName: sourceName.trim() }] },
      );
      setResults(response.items);
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setPending(false);
    }
  };

  /** 为未映射清单一次性取候选:每行默认选中确定性 top-1(得分最高那条)。 */
  const fetchBatchCandidates = async () => {
    if (unmappedRows.length === 0) {
      message.info('该批次在当前映射下没有未映射的源');
      return;
    }
    const slice = unmappedRows.slice(0, MAX_BATCH_ITEMS);
    setBatchPending(true);
    try {
      const response = await api.post<{ items: CandidateResult[] }>(
        `/finance/mapping-versions/${props.versionId}/mapping-candidates`,
        {
          kind,
          allowAi,
          items: slice.map((row) => ({
            sourceCode: row.sourceCode,
            sourceName: row.sourceName,
            ...(row.sourceBookCode ? { sourceBookCode: row.sourceBookCode } : {}),
          })),
        },
      );
      setBatchRows(slice.map((source, index) => {
        const result = response.items[index];
        return { source, result, selected: result?.candidates[0] ?? null };
      }));
      if (unmappedRows.length > MAX_BATCH_ITEMS) {
        message.warning(`未映射源 ${unmappedRows.length} 条,本轮只取前 ${MAX_BATCH_ITEMS} 条;采纳后可再次获取`);
      }
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setBatchPending(false);
    }
  };

  const selectedCount = (batchRows ?? []).filter((row) => row.selected).length;
  const aiSelectedCount = (batchRows ?? []).filter((row) => row.selected?.source === 'ai').length;

  const adoptBatch = async () => {
    const chosen = (batchRows ?? []).filter((row): row is BatchRow & { selected: Candidate } => Boolean(row.selected));
    if (chosen.length === 0) {
      message.warning('没有选中任何目标');
      return;
    }
    setBatchSaving(true);
    try {
      await props.onAdoptBatch(kind, chosen.map((row) => ({
        input: {
          kind,
          sourceCode: row.source.sourceCode,
          sourceName: row.source.sourceName,
          ...(row.source.sourceBookCode ? { sourceBookCode: row.source.sourceBookCode } : {}),
        },
        candidate: row.selected,
      })));
      setBatchRows(null);
      await unmapped.refetch();
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setBatchSaving(false);
    }
  };

  const saveAlias = async (input: CandidateInput, candidate: Candidate) => {
    const sourceText = (input.sourceName || input.sourceCode || '').trim();
    if (!sourceText) return;
    try {
      await api.post('/io/cleaning/aliases', {
        targetKind: 'finance',
        mappingKind: kind,
        sourceText,
        targetCode: candidate.code,
      });
      message.success('已沉淀为财务映射别名,后续同类源串将优先命中');
    } catch (error) {
      message.error(errorText(error));
    }
  };

  const result = results?.[0];
  return (
    <Card
      size="small"
      title="候选建议"
      style={{ marginTop: 12 }}
      extra={(
        <Space wrap>
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as 'batch' | 'single')}
            options={[{ value: 'batch', label: '未映射清单批量采纳' }, { value: 'single', label: '单条试算' }]}
          />
          <Select
            value={kind}
            onChange={(value) => { setKind(value); setResults(null); setBatchRows(null); }}
            options={[{ value: 'org', label: '组织映射' }, { value: 'account', label: '科目映射' }]}
            style={{ width: 110 }}
          />
          <Checkbox checked={allowAi} onChange={(event) => setAllowAi(event.target.checked)}>低置信时请求 AI 残差建议</Checkbox>
        </Space>
      )}
    >
      {mode === 'batch' ? (
        <div>
          <Space wrap style={{ marginBottom: 8 }}>
            <Select
              placeholder="选择同数据源的转换批次(按其源明细计算未映射)"
              style={{ width: 380 }}
              value={conversionId}
              onChange={(value) => { setConversionId(value); setBatchRows(null); }}
              options={sameProfileConversions.map((item) => ({
                value: item.id,
                label: `#${item.id} · ${item.snapshot_date} · ${item.status}`,
              }))}
            />
            <Button
              type="primary"
              loading={batchPending}
              disabled={!conversionId || unmapped.isFetching}
              onClick={() => void fetchBatchCandidates()}
            >为全部未映射源取候选</Button>
            {batchRows && (
              <Button
                type="primary"
                loading={batchSaving}
                disabled={props.readOnly || selectedCount === 0}
                onClick={() => void adoptBatch()}
              >批量采纳选中 {selectedCount} 条为未复核行</Button>
            )}
          </Space>
          {sameProfileConversions.length === 0 && (
            <Alert
              type="info"
              showIcon
              message="该数据源还没有转换批次:未映射清单来自转换批次的源明细,先跑一次转换(即使被未映射阻断)即可在此逐条补映射。"
            />
          )}
          {unmapped.data && (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              批次 #{unmapped.data.conversionId}（{unmapped.data.snapshotDate}，源末级 {unmapped.data.sourceRowCount} 行）:
              未映射组织 {unmapped.data.org.length} 个、未映射科目 {unmapped.data.account.length} 个。
              当前查看{kind === 'org' ? '组织' : '科目'}。
            </Typography.Paragraph>
          )}
          {batchRows ? (
            <>
              {aiSelectedCount > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 8 }}
                  message={`选中项里有 ${aiSelectedCount} 条来自 AI 残差建议,采纳后一律标记为未复核,需逐行复核或在锁定时显式确认。`}
                />
              )}
              <Table
                size="small"
                rowKey={(row) => `${row.source.sourceBookCode ?? ''}:${row.source.sourceCode}:${row.source.sourceName}`}
                pagination={{ pageSize: 20, showSizeChanger: false }}
                dataSource={batchRows}
                columns={[
                  {
                    title: '未映射源',
                    render: (_, row) => (
                      <span>
                        {row.source.sourceCode} {row.source.sourceName}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          （{row.source.rowCount} 行 · 首见 {row.source.firstSheet}!{row.source.firstRow}）
                        </Typography.Text>
                      </span>
                    ),
                  },
                  {
                    title: '目标(默认取最高分候选)',
                    width: 380,
                    render: (_, row) => (
                      <Select
                        style={{ width: '100%' }}
                        allowClear
                        placeholder={row.result?.candidates.length ? '选择目标' : '没有候选,请手工维护'}
                        value={row.selected ? String(row.selected.targetId) : undefined}
                        onChange={(value) => setBatchRows((old) => (old ?? []).map((item) => (
                          item === row
                            ? { ...item, selected: value ? row.result.candidates.find((c) => String(c.targetId) === value) ?? null : null }
                            : item
                        )))}
                        options={(row.result?.candidates ?? []).map((candidate) => ({
                          value: String(candidate.targetId),
                          label: candidateLabel(candidate),
                        }))}
                      />
                    ),
                  },
                  {
                    title: '来源',
                    width: 100,
                    render: (_, row) => (row.selected
                      ? <Tag color={SOURCE_TAG[row.selected.source].color}>{SOURCE_TAG[row.selected.source].label}</Tag>
                      : <Tag>跳过</Tag>),
                  },
                  {
                    title: '理由 / 置信',
                    render: (_, row) => (row.selected
                      ? `${row.selected.reason ?? '字面相似度匹配'}（确定性最高分 ${(row.result.deterministicTopScore * 100).toFixed(0)}%）`
                      : '—'),
                  },
                ]}
              />
            </>
          ) : (
            unmapped.data && unmappedRows.length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`该批次的${kind === 'org' ? '源组织' : '源科目'}已全部映射`} />
            )
          )}
        </div>
      ) : (
        <div>
          <Space wrap style={{ marginBottom: 8 }}>
            <Input placeholder="源编码(可选)" value={sourceCode} onChange={(event) => setSourceCode(event.target.value)} style={{ width: 160 }} />
            <Input placeholder="源名称" value={sourceName} onChange={(event) => setSourceName(event.target.value)} style={{ width: 220 }} />
            <Button type="primary" loading={pending} onClick={() => void fetchCandidates()}>获取候选</Button>
          </Space>
          {result && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                确定性最高分 {(result.deterministicTopScore * 100).toFixed(0)}%
                {result.exactCodeMatched ? ' · 编码归一化后完全一致' : ''}
                {result.aiUsed ? ' · 已追加 AI 残差建议(需人工复核)' : ''}
                {allowAi && !result.aiUsed && result.deterministicTopScore < 0.6 ? ' · 模型未配置或无残差候选,仅确定性结果' : ''}
              </Typography.Text>
              {result.candidates.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有候选;请手工维护映射行" />
              ) : (
                <Table
                  size="small"
                  rowKey={(candidate) => `${candidate.source}:${candidate.targetId}`}
                  pagination={false}
                  dataSource={result.candidates}
                  columns={[
                    { title: '目标', render: (_, candidate) => <span>{candidate.code} {candidate.name}<Typography.Text type="secondary" style={{ fontSize: 12 }}>（{candidate.path}）</Typography.Text></span> },
                    { title: '得分', dataIndex: 'score', width: 80, render: (score) => `${(score * 100).toFixed(0)}%` },
                    { title: '来源', dataIndex: 'source', width: 90, render: (source) => <Tag color={SOURCE_TAG[source as Candidate['source']].color}>{SOURCE_TAG[source as Candidate['source']].label}</Tag> },
                    { title: '理由', dataIndex: 'reason', render: (reason) => reason ?? '—' },
                    {
                      title: '操作',
                      width: 210,
                      render: (_, candidate) => (
                        <Space>
                          <Button
                            size="small"
                            type="primary"
                            disabled={props.readOnly}
                            loading={adopting === `${candidate.source}:${candidate.targetId}`}
                            onClick={async () => {
                              const key = `${candidate.source}:${candidate.targetId}`;
                              setAdopting(key);
                              try {
                                await props.onAdopt(kind, result.input, candidate);
                              } catch (error) {
                                message.error(errorText(error));
                              } finally {
                                setAdopting('');
                              }
                            }}
                          >采纳为未复核行</Button>
                          <Button size="small" onClick={() => void saveAlias(result.input, candidate)}>存为别名</Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
