import { useAssistantDomainPage } from '../assistant/contextHooks';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Card, Checkbox, DatePicker, Descriptions,
  Input, InputNumber, Segmented, Select, Skeleton, Space, Switch, Table, Tabs, Tag, Typography,
} from 'antd';
import { api, ApiError, can, errorText } from '../api/client';
import { businessSettingsApi, type PdfParserProbeResult } from '../api/systemSettings';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { LEGAL_CATEGORIES, LEGAL_LABELS } from './project/contractOptions';
import { shortTime } from '../utils/relativeTime';
import CustomFieldsPanel from './settings/CustomFieldsPanel';
import ImportAliasesPanel from './settings/ImportAliasesPanel';

type Value = string | number | boolean | null;

interface SettingItem {
  key: string; label: string; group: string; type: 'string' | 'int' | 'bool' | 'enum' | 'url' | 'secret' | 'ratio';
  description?: string; min?: number; max?: number; maxLength?: number; options?: { value: string; label: string }[];
  value: Value; defaultValue: Value; isDefault: boolean; configured?: boolean; preview?: string | null; updatedAt: string | null;
}

interface OrgRowLite {
  id: number;
  parent_id?: number | null;
  parentId?: number | null;
  code: string;
  name: string;
  status: string;
  org_kind?: string;
  orgKind?: string;
}

interface NetAssetEntry {
  orgId: number | null;
  year: number;
  amount: string;
}

type GroupFilterKey = '全部' | '合同与法审' | '投资与预警' | '日历与集成' | '展示口径';

function matchSettingGroupFilter(filter: GroupFilterKey, item: SettingItem): boolean {
  if (filter === '全部') return true;
  if (filter === '合同与法审') return item.group === '合同' || item.key.startsWith('contract.');
  if (filter === '投资与预警') return ['投资控制', '财务预测', '财务'].includes(item.group);
  if (filter === '日历与集成') return ['日历', '集成', '任务'].includes(item.group);
  if (filter === '展示口径') return ['报表', '显示'].includes(item.group);
  return true;
}

function parseNetAssetsJson(raw: string): { entries: NetAssetEntry[]; parseError: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { entries: [], parseError: null };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return { entries: [], parseError: '净资产配置格式非 JSON 数组' };
    return {
      entries: parsed.map((item) => {
        const rec = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        return {
          orgId: typeof rec.orgId === 'number' ? rec.orgId : null,
          year: typeof rec.year === 'number' ? rec.year : new Date().getFullYear() - 1,
          amount: typeof rec.amount === 'string' ? rec.amount : String(rec.amount ?? ''),
        };
      }),
      parseError: null,
    };
  } catch {
    return { entries: [], parseError: '原 JSON 内容无法解析，请重新核对录入' };
  }
}

function validateNetAssetEntries(entries: NetAssetEntry[]): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.orgId || e.orgId < 1) return `第 ${i + 1} 行：请选择二级法人组织`;
    if (!Number.isInteger(e.year) || e.year < 2000 || e.year > 2100) return `第 ${i + 1} 行：年度须在 2000～2100 之间`;
    if (!/^\d{1,15}\.\d{2}$/.test(e.amount.trim()) || /^0+\.00$/.test(e.amount.trim())) {
      return `第 ${i + 1} 行：净资产须为保留两位小数的正数金额（如 50000000.00）`;
    }
    const key = `${e.orgId}:${e.year}`;
    if (seen.has(key)) return `第 ${i + 1} 行：同一法人同一年度（${e.year}）不可重复录入`;
    seen.add(key);
  }
  return null;
}

function splitDateCsv(raw: string): string[] {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].sort();
}

/**
 * 业务设置(AC-F23):登记过的键才能保存,整批校验后一次写入;
 * 凭据只写不读,页面只显示“已配置 ****末4位”,留空表示不修改。
 */
function BusinessParams() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const writable = can('settings:manage');
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [groupFilter, setGroupFilter] = useState<GroupFilterKey>('全部');
  const [netAssetDraftRows, setNetAssetDraftRows] = useState<NetAssetEntry[] | null>(null);
  const [pdfProbeResult, setPdfProbeResult] = useState<PdfParserProbeResult | null>(null);
  const q = useQuery({ queryKey: ['settings-business'], queryFn: () => api.get<{ items: SettingItem[] }>('/settings/business') });
  const orgTreeQ = useQuery({
    queryKey: ['org-tree'],
    queryFn: () => api.get<{ rows: OrgRowLite[] }>('/org/tree'),
  });

  const probePdf = useMutation({
    mutationFn: (url: string) => businessSettingsApi.testPdfParser(url),
    onSuccess: (res) => setPdfProbeResult(res),
    onError: (e) => setPdfProbeResult({ ok: false, status: 0, latencyMs: 0, message: errorText(e) }),
  });

  const save = useMutation({
    mutationFn: (body: Record<string, Value>) => api.put<{ items: SettingItem[] }>('/settings/business', body),
    onSuccess: (data) => {
      qc.setQueryData(['settings-business'], data);
      setDraft({});
      setNetAssetDraftRows(null);
      setFieldErrors({});
      message.success('设置已保存');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.body.errors) setFieldErrors(Object.fromEntries(e.body.errors.map((x) => [x.field, x.message])));
      message.error(errorText(e, { includeFieldErrors: false }));
    },
  });

  const settingMap = useMemo(
    () => new Map((q.data?.items ?? []).map((item) => [item.key, item])),
    [q.data],
  );

  const effectiveValue = (key: string): Value => {
    if (key in draft) return draft[key];
    return settingMap.get(key)?.value ?? null;
  };

  const orgRows = orgTreeQ.data?.rows ?? [];
  const secondaryLegalOrgs = useMemo(
    () =>
      orgRows.filter((r) => {
        const kind = r.org_kind ?? r.orgKind ?? 'legal_entity';
        const pid = r.parent_id ?? r.parentId;
        return kind === 'legal_entity' && r.status === 'active' && pid != null;
      }),
    [orgRows],
  );

  const legalOrgOptions = useMemo(
    () =>
      orgRows
        .filter((r) => (r.org_kind ?? r.orgKind ?? 'legal_entity') === 'legal_entity' && r.status === 'active')
        .map((r) => ({ value: r.id, label: `${r.name} (${r.code})` })),
    [orgRows],
  );

  const netAssetsMissingWarning = useMemo(() => {
    const rawNetAssets = String(effectiveValue('contract.prior_year_net_assets') ?? '').trim();
    if (!rawNetAssets) return true;
    const { entries, parseError } = parseNetAssetsJson(rawNetAssets);
    if (parseError || entries.length === 0) return true;
    const configuredIds = String(effectiveValue('contract.legal_entity_org_ids') ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    const requiredOrgIds = configuredIds.length > 0 ? configuredIds : secondaryLegalOrgs.map((o) => o.id);
    if (requiredOrgIds.length === 0) return false;
    const coveredOrgs = new Set(entries.filter((e) => e.orgId && /^\d{1,15}\.\d{2}$/.test(e.amount)).map((e) => e.orgId!));
    return requiredOrgIds.some((id) => !coveredOrgs.has(id));
  }, [q.data, draft, secondaryLegalOrgs]);

  const groups = useMemo(() => {
    const map = new Map<string, SettingItem[]>();
    for (const item of q.data?.items ?? []) {
      if (!matchSettingGroupFilter(groupFilter, item)) continue;
      map.set(item.group, [...(map.get(item.group) ?? []), item]);
    }
    return [...map.entries()];
  }, [q.data, groupFilter]);

  if (q.error) return <QueryErrorResult title="业务设置加载失败" error={q.error} refetch={q.refetch} />;
  const dirty = Object.keys(draft).length > 0;
  const current = (s: SettingItem): Value => (s.key in draft ? draft[s.key] : s.value);
  const set = (key: string, v: Value) => setDraft((d) => ({ ...d, [key]: v }));

  const updateNetAssetRows = (nextRows: NetAssetEntry[]) => {
    setNetAssetDraftRows(nextRows);
    const err = validateNetAssetEntries(nextRows);
    setFieldErrors((prev) => {
      const copy = { ...prev };
      if (err) copy['contract.prior_year_net_assets'] = err;
      else delete copy['contract.prior_year_net_assets'];
      return copy;
    });
    if (nextRows.length === 0) {
      set('contract.prior_year_net_assets', '');
    } else if (!err) {
      set(
        'contract.prior_year_net_assets',
        JSON.stringify(nextRows.map((r) => ({ orgId: r.orgId!, year: r.year, amount: r.amount.trim() }))),
      );
    } else {
      // 标记脏状态以便保存按钮提示错误，但不覆盖合法序列化结构
      set('contract.prior_year_net_assets', String(effectiveValue('contract.prior_year_net_assets') ?? ''));
    }
  };

  const renderCalendarDatesEditor = (s: SettingItem) => {
    const disabled = !writable;
    const dates = splitDateCsv(String(current(s) ?? ''));
    const oppositeKey = s.key === 'calendar.holidays' ? 'calendar.workdays' : 'calendar.holidays';
    const oppositeLabel = s.key === 'calendar.holidays' ? '调休工作日' : '法定休息日';
    const oppositeDates = new Set(splitDateCsv(String(effectiveValue(oppositeKey) ?? '')));

    return (
      <Space direction="vertical" size={6}>
        {writable && (
          <DatePicker
            placeholder="选择日期添加"
            onChange={(_d, dateStr) => {
              const ds = typeof dateStr === 'string' ? dateStr.trim() : '';
              if (!ds) return;
              if (oppositeDates.has(ds)) {
                setFieldErrors((prev) => ({
                  ...prev,
                  [s.key]: `日期 ${ds} 已存在于「${oppositeLabel}」，同一日期不可同时为休息日与调休工作日`,
                }));
                return;
              }
              setFieldErrors((prev) => {
                const copy = { ...prev };
                delete copy[s.key];
                return copy;
              });
              const merged = [...new Set([...dates, ds])].sort();
              set(s.key, merged.join(','));
            }}
          />
        )}
        <Space wrap size={[4, 4]}>
          {dates.length === 0 ? (
            <Typography.Text type="secondary">尚未配置日期</Typography.Text>
          ) : (
            dates.map((d) => (
              <Tag
                key={d}
                closable={!disabled}
                onClose={(e) => {
                  e.preventDefault();
                  set(s.key, dates.filter((x) => x !== d).join(','));
                }}
              >
                {d}
              </Tag>
            ))
          )}
        </Space>
      </Space>
    );
  };

  const editor = (s: SettingItem) => {
    const disabled = !writable;
    if (s.key === 'contract.legal_entity_org_ids') {
      const selectedIds = String(current(s) ?? '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isSafeInteger(n) && n > 0);
      return (
        <Space wrap>
          <Select
            mode="multiple"
            disabled={disabled}
            style={{ minWidth: 360 }}
            placeholder="选择二级法人组织节点"
            value={selectedIds}
            options={legalOrgOptions}
            onChange={(ids: number[]) => {
              const sorted = [...new Set(ids)].sort((a, b) => a - b);
              set(s.key, sorted.join(','));
            }}
          />
          {writable && (
            <Button
              size="small"
              onClick={() => {
                const ids = secondaryLegalOrgs.map((o) => o.id).sort((a, b) => a - b);
                set(s.key, ids.join(','));
              }}
            >
              一键填入全部在运二级法人
            </Button>
          )}
        </Space>
      );
    }

    if (s.key === 'contract.prior_year_net_assets') {
      const parsed = parseNetAssetsJson(String(current(s) ?? ''));
      const rows = netAssetDraftRows ?? parsed.entries;
      return (
        <Space direction="vertical" style={{ width: '100%', maxWidth: 680 }} size={8}>
          {parsed.parseError && !netAssetDraftRows && <Alert type="error" showIcon message={parsed.parseError} />}
          <Table<NetAssetEntry>
            rowKey={(_r, idx) => String(idx)}
            size="small"
            pagination={false}
            locale={{ emptyText: '尚未录入法人年度净资产明细' }}
            dataSource={rows}
            columns={[
              {
                title: '二级法人组织',
                width: 240,
                render: (_: unknown, row, idx) => (
                  <Select
                    disabled={disabled}
                    style={{ width: '100%' }}
                    placeholder="选择法人组织"
                    value={row.orgId ?? undefined}
                    options={legalOrgOptions}
                    onChange={(orgId: number) => {
                      const next = rows.map((item, i) => (i === idx ? { ...item, orgId } : item));
                      updateNetAssetRows(next);
                    }}
                  />
                ),
              },
              {
                title: '年度',
                width: 120,
                render: (_: unknown, row, idx) => (
                  <InputNumber
                    disabled={disabled}
                    min={2000}
                    max={2100}
                    precision={0}
                    style={{ width: '100%' }}
                    value={row.year}
                    onChange={(year) => {
                      const next = rows.map((item, i) => (i === idx ? { ...item, year: year ?? new Date().getFullYear() - 1 } : item));
                      updateNetAssetRows(next);
                    }}
                  />
                ),
              },
              {
                title: '净资产（元，两位小数）',
                width: 210,
                render: (_: unknown, row, idx) => (
                  <Input
                    disabled={disabled}
                    placeholder="如 50000000.00"
                    value={row.amount}
                    onChange={(e) => {
                      const next = rows.map((item, i) => (i === idx ? { ...item, amount: e.target.value } : item));
                      updateNetAssetRows(next);
                    }}
                  />
                ),
              },
              ...(writable
                ? [
                    {
                      title: '操作',
                      width: 72,
                      render: (_: unknown, _row: NetAssetEntry, idx: number) => (
                        <Button
                          size="small"
                          danger
                          onClick={() => updateNetAssetRows(rows.filter((_, i) => i !== idx))}
                        >
                          删除
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          {writable && (
            <Button
              size="small"
              onClick={() =>
                updateNetAssetRows([
                  ...rows,
                  { orgId: secondaryLegalOrgs[0]?.id ?? legalOrgOptions[0]?.value ?? null, year: new Date().getFullYear() - 1, amount: '' },
                ])
              }
            >
              + 新增法人净资产行
            </Button>
          )}
        </Space>
      );
    }

    if (s.key === 'calendar.holidays' || s.key === 'calendar.workdays') {
      return renderCalendarDatesEditor(s);
    }

    if (s.key === 'integration.pdf_parser_base_url') {
      const urlVal = (current(s) as string | null) ?? '';
      return (
        <Space wrap>
          <Input
            disabled={disabled}
            style={{ width: 340 }}
            maxLength={s.maxLength}
            placeholder="如 http://127.0.0.1:8090"
            value={urlVal}
            onChange={(e) => {
              setPdfProbeResult(null);
              set(s.key, e.target.value);
            }}
          />
          {writable && (
            <Button
              size="small"
              loading={probePdf.isPending}
              onClick={() => probePdf.mutate(urlVal)}
            >
              测试连通性
            </Button>
          )}
          {pdfProbeResult && (
            pdfProbeResult.ok ? (
              <Tag color="success">在线 {pdfProbeResult.latencyMs}ms</Tag>
            ) : (
              <Tag color="error">{pdfProbeResult.message}</Tag>
            )
          )}
        </Space>
      );
    }

    if (s.key === 'contract.change_or_mode') {
      return (
        <Select
          disabled={disabled}
          style={{ width: 240 }}
          value={(current(s) as string) ?? 'min'}
          options={[
            { value: 'min', label: '比例与定额双达标（从严）' },
            { value: 'max', label: '比例或定额任一达标（从宽）' },
          ]}
          onChange={(v) => set(s.key, v)}
        />
      );
    }

    if (s.key === 'contract.legal_review_categories') {
      const checked = String(current(s) ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      return (
        <Checkbox.Group
          disabled={disabled}
          value={checked}
          options={LEGAL_CATEGORIES.map((c) => ({ value: c, label: LEGAL_LABELS[c] }))}
          onChange={(vals) => set(s.key, (vals as string[]).join(','))}
        />
      );
    }

    switch (s.type) {
      case 'int':
        return <InputNumber disabled={disabled} min={s.min} max={s.max} precision={0} value={current(s) as number | null} onChange={(v) => set(s.key, v)} />;
      case 'bool':
        return <Switch disabled={disabled} checked={current(s) as boolean} onChange={(v) => set(s.key, v)} />;
      case 'enum':
        return <Select disabled={disabled} style={{ width: 160 }} value={current(s) as string} options={s.options} onChange={(v) => set(s.key, v)} />;
      case 'secret':
        return (
          <Space>
            {s.configured ? <Tag color="success">已配置 {s.preview}</Tag> : <Tag>未配置</Tag>}
            {writable && (
              <Input.Password
                autoComplete="new-password" style={{ width: 260 }} placeholder={s.configured ? '留空表示不修改' : '输入后保存'}
                value={typeof draft[s.key] === 'string' ? draft[s.key] as string : ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft((d) => {
                    const next = { ...d };
                    if (v) next[s.key] = v; else delete next[s.key];
                    return next;
                  });
                }}
              />
            )}
            {writable && s.configured && <Button size="small" danger onClick={() => set(s.key, null)}>清除</Button>}
            {draft[s.key] === null && <Tag color="warning">保存后清除</Tag>}
          </Space>
        );
      default:
        return <Input disabled={disabled} style={{ width: 360 }} maxLength={s.maxLength} value={(current(s) as string | null) ?? ''} onChange={(e) => set(s.key, e.target.value)} />;
    }
  };

  if (q.isLoading) return <Skeleton active />;
  const hasBlockingDraftError = Boolean(
    (netAssetDraftRows && validateNetAssetEntries(netAssetDraftRows)) ||
    fieldErrors['calendar.holidays'] ||
    fieldErrors['calendar.workdays'],
  );

  return (
    <div>
      {!writable && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="当前账号只能查看设置" />}
      {netAssetsMissingWarning && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="法人上年净资产尚未完整配置，大额付款审批分级将统一按集团最高级集体决策校验并阻断缺失资金可行性附件的付款"
        />
      )}
      <div style={{ marginBottom: 16 }}>
        <Segmented<GroupFilterKey>
          value={groupFilter}
          onChange={(v) => setGroupFilter(v)}
          options={['全部', '合同与法审', '投资与预警', '日历与集成', '展示口径']}
        />
      </div>
      {groups.map(([group, items]) => (
        <Descriptions key={group} title={group} bordered column={1} size="small" style={{ marginBottom: 20 }} labelStyle={{ width: 200 }}>
          {items.map((s) => (
            <Descriptions.Item key={s.key} label={s.label}>
              <Space direction="vertical" size={2}>
                {editor(s)}
                {fieldErrors[s.key] && <Typography.Text type="danger">{fieldErrors[s.key]}</Typography.Text>}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.description ? `${s.description}。` : ''}
                  {s.type !== 'secret' && `默认:${s.defaultValue === '' || s.defaultValue === null ? '空' : String(s.options?.find((o) => o.value === s.defaultValue)?.label ?? s.defaultValue)}`}
                  {s.updatedAt && ` · 更新于 ${shortTime(s.updatedAt)}`}
                </Typography.Text>
              </Space>
            </Descriptions.Item>
          ))}
        </Descriptions>
      ))}
      {writable && (
        <Space>
          <Button
            type="primary"
            disabled={!dirty || hasBlockingDraftError}
            loading={save.isPending}
            onClick={() => save.mutate(draft)}
          >
            保存
          </Button>
          <Button disabled={!dirty && !netAssetDraftRows} onClick={() => { setDraft({}); setNetAssetDraftRows(null); setFieldErrors({}); }}>放弃修改</Button>
        </Space>
      )}
    </div>
  );
}

/** 业务设置页:业务参数 + T-7 自定义字段、导入字段模板。 */
export default function SettingsBusiness() {
  useAssistantDomainPage({ pageKey: 'business_settings', ready: true, view: {} });
  return (
    <Card>
      <Tabs items={[
        { key: 'params', label: '业务参数', children: <BusinessParams /> },
        { key: 'custom-fields', label: '自定义字段', children: <CustomFieldsPanel /> },
        { key: 'import-aliases', label: '导入字段模板', children: <ImportAliasesPanel /> },
      ]} />
    </Card>
  );
}
