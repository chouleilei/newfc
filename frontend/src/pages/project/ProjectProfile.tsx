import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Descriptions, Empty, Row, Space, Statistic, Table, Tabs, Tag, Typography } from 'antd';
import { projectProfileApi, type ProjectProfileDto } from '../../api/projectProfile';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { compact, Money, Ratio, statusTag } from '../financeData/shared';
import { RISK_LEVEL, RISK_STATUS, RPT_KIND_LABEL, RPT_STATUS } from '../risk/shared';
import { IC_VERSION_TYPE_LABEL } from '../invest/shared';
import { CONTRACT_DOC_TYPE_LABELS, CONTRACT_STAGE_LABELS, CONTRACT_STATUS, FLOW_STATUS } from './shared';

/**
 * 项目档案(360 视图):主数据 + 项目预算、计划执行、合同付款、EAS 凭证、风险、投资控制/可研、相关报告、操作日志。
 * 每个页签只在当前用户有该域读权限时出现(服务端返回 null 即不展示),数据与各域页面同源同口径。
 */

type P = ProjectProfileDto;

function BudgetTab({ b }: { b: NonNullable<P['budget']> }) {
  if (!b.batch) return <Empty description="暂无当前项目预算批次" />;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Row gutter={12}>
        <Col span={8}><Card size="small"><Statistic title={`预算(元)· ${b.batch.period}`} valueRender={() => <Money value={b.budget} />} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="已执行(元)" valueRender={() => <Money value={b.executed} />} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="执行率" valueRender={() => <Ratio value={b.rate} />} /></Card></Col>
      </Row>
      <Table size="small" rowKey={(_, i) => String(i)} pagination={false} dataSource={b.rows} columns={[
        { title: '资金来源', dataIndex: 'fundSource' }, { title: '费用类别', dataIndex: 'expenseCategory' }, { title: '组织', dataIndex: 'orgName' },
        { title: '执行月份', dataIndex: 'execMonth', width: 100 },
        { title: '预算(元)', dataIndex: 'budget', align: 'right', render: (v: string) => <Money value={v} /> },
        { title: '已执行(元)', dataIndex: 'executed', align: 'right', render: (v: string) => <Money value={v} /> },
      ]} />
      <Link to="/project-budget">前往项目预算</Link>
    </Space>
  );
}

function PlanTab({
  p,
  projectId,
  hasContractsTab,
  onFilterContractsByPlanItem,
}: {
  p: NonNullable<P['plan']>;
  projectId: number;
  hasContractsTab: boolean;
  onFilterContractsByPlanItem: (planItemId: number) => void;
}) {
  if (!p.batch) return <Empty description="暂无当前计划执行批次" />;
  if (p.items.length === 0) return <Empty description={`${p.batch.year} 年计划(截至 ${p.batch.actualPeriod})中没有关联本项目的明细`} />;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {p.items.map((it) => (
        <Card
          key={it.itemId}
          size="small"
          title={`${it.itemName}(${it.orgName || '—'})`}
          extra={
            <Space wrap size={8}>
              <Typography.Text type="secondary">截至 {p.batch!.actualPeriod}</Typography.Text>
              {it.linkedContractCount !== undefined && (
                <Tag color={it.linkedContractCount > 0 ? 'blue' : 'default'}>
                  已挂接合同：{it.linkedContractCount} 份 / <Money value={it.linkedContractAmount ?? '0.00'} />
                </Tag>
              )}
              {hasContractsTab && (
                <Button size="small" type="link" onClick={() => onFilterContractsByPlanItem(it.itemId)}>
                  查看挂接合同
                </Button>
              )}
              {hasContractsTab && (
                <Link to={`/contracts?projectId=${projectId}&planItemId=${it.itemId}`}>合同台账</Link>
              )}
            </Space>
          }
        >
          <Descriptions size="small" column={3}>
            {it.facts.map((f) => (
              <Descriptions.Item key={f.key} label={f.label}>
                {f.valueType === 'amount' ? <Money value={f.value} /> : f.valueType === 'ratio' ? <Ratio value={f.value} /> : f.value}
              </Descriptions.Item>
            ))}
          </Descriptions>
        </Card>
      ))}
      <Link to="/plan">前往计划执行</Link>
    </Space>
  );
}

function ContractsTab({
  c,
  planItems,
  filterPlanItemId,
  onClearPlanFilter,
}: {
  c: NonNullable<P['contracts']>;
  planItems?: NonNullable<P['plan']>['items'];
  filterPlanItemId: number | null;
  onClearPlanFilter: () => void;
}) {
  const filteredRows = filterPlanItemId != null ? c.rows.filter((r) => r.planItemId === filterPlanItemId) : c.rows;
  const activePlanItemName =
    filterPlanItemId != null
      ? planItems?.find((it) => it.itemId === filterPlanItemId)?.itemName ??
        filteredRows.find((r) => r.planItemName)?.planItemName ??
        `#${filterPlanItemId}`
      : null;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {filterPlanItemId != null && (
        <Alert
          type="info"
          showIcon
          message={
            <Space wrap>
              <span>
                当前按综合计划项筛选：{activePlanItemName}（共 {filteredRows.length} 份合同）
              </span>
              <Button size="small" type="link" onClick={onClearPlanFilter}>
                清除筛选
              </Button>
            </Space>
          }
        />
      )}
      <Row gutter={12}>
        <Col span={6}><Card size="small"><Statistic title="合同数" value={c.count} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="支出合同额/已结(元)" valueRender={() => <><Money value={c.currentTotal} /> / <Money value={c.settledTotal ?? '0.00'} /></>} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="支出已付(元)" valueRender={() => <Money value={c.paidTotal} />} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="付款比例" valueRender={() => <Ratio value={c.paidRate} />} /></Card></Col>
      </Row>
      {(c.incomeCount ?? 0) > 0 && (
        <Row gutter={12}>
          <Col span={6}><Card size="small"><Statistic title="收入合同数" value={c.incomeCount ?? 0} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="收入合同额/已结(元)" valueRender={() => <><Money value={c.incomeCurrentTotal ?? '0.00'} /> / <Money value={c.incomeSettledTotal ?? '0.00'} /></>} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="收入已收(元)" valueRender={() => <Money value={c.receivedTotal ?? '0.00'} />} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="收款比例" valueRender={() => <Ratio value={c.receivedRate ?? null} />} /></Card></Col>
        </Row>
      )}
      <Space wrap>
        <Tag color={(c.activeGuaranteeCount ?? 0) > 0 ? 'blue' : 'default'}>活跃保函 {c.activeGuaranteeCount ?? 0} 笔</Tag>
        <Tag color={(c.openChangeCount ?? 0) > 0 ? 'gold' : 'default'}>未闭环变更 {c.openChangeCount ?? 0} 笔</Tag>
        <Tag color={(c.openDisputeCount ?? 0) > 0 ? 'red' : 'default'}>未闭环纠纷 {c.openDisputeCount ?? 0} 宗</Tag>
        {(c.foreignCurrencyCount ?? 0) > 0 && <Tag color="purple">外币合同 {c.foreignCurrencyCount} 份(未折算并入人民币合计)</Tag>}
      </Space>
      <Table<NonNullable<P['contracts']>['rows'][number]> size="small" rowKey="id" pagination={false} dataSource={filteredRows} scroll={{ x: 1280 }} columns={[
        { title: '合同编号', dataIndex: 'contractNo', width: 140, render: (v: string, r) => <Link to={`/contracts?id=${r.id}`}>{v}</Link> },
        { title: '方向', dataIndex: 'direction', width: 64, render: (v?: string) => (v === 'income' ? <Tag color="green">收入</Tag> : <Tag>支出</Tag>) },
        { title: '名称', dataIndex: 'name', ellipsis: true },
        {
          title: '关联综合计划项',
          dataIndex: 'planItemName',
          width: 170,
          ellipsis: true,
          render: (v: string | null | undefined, r) => (v ? v : r.planItemId ? `#${r.planItemId}` : '—'),
        },
        { title: '供应商', dataIndex: 'supplierName', width: 150, ellipsis: true, render: (v: string | null) => v ?? '—' },
        { title: '阶段', dataIndex: 'stage', width: 90, render: (v: string) => CONTRACT_STAGE_LABELS[v] ?? v },
        { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => statusTag(CONTRACT_STATUS, v) },
        { title: '合同金额(元)', dataIndex: 'current', width: 130, align: 'right', render: (v: string) => <Money value={v} /> },
        { title: '累计净结算(元)', dataIndex: 'settled', width: 130, align: 'right', render: (v?: string) => <Money value={v ?? '0.00'} /> },
        { title: '已付/已收(元)', dataIndex: 'paid', width: 130, align: 'right', render: (_: string, r) => <Money value={r.direction === 'income' ? (r.received ?? '0.00') : r.paid} /> },
        {
          title: '文档', dataIndex: 'documents', width: 200,
          render: (d: Record<string, number>) => (Object.keys(d).length ? Object.entries(d).map(([k, n]) => <Tag key={k}>{CONTRACT_DOC_TYPE_LABELS[k] ?? k} {n}</Tag>) : '—'),
        },
      ]} />
      <Card size="small" title="最近付款">
        <Table size="small" rowKey="id" pagination={false} dataSource={c.payments} columns={[
          { title: '合同', dataIndex: 'contractNo', width: 140 }, { title: '节点', dataIndex: 'nodeName' },
          { title: '金额(元)', dataIndex: 'amount', align: 'right', render: (v: string) => <Money value={v} /> },
          { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => statusTag(FLOW_STATUS, v) },
          { title: '支付日期', dataIndex: 'paidDate', width: 110, render: (v: string | null) => v ?? '—' },
          { title: '凭证号', dataIndex: 'voucherNo', width: 110, render: (v: string | null) => v || '—' },
        ]} />
      </Card>
    </Space>
  );
}

function VouchersTab({ v }: { v: NonNullable<P['vouchers']> }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Text type="secondary">按项目编码 {v.projectCodes.join('、')} 匹配当前凭证批次;共 {v.lineCount} 条分录,列表显示最近 {v.lines.length} 条。</Typography.Text>
      <Row gutter={12}>
        <Col span={12}><Card size="small"><Statistic title="借方合计(元)" valueRender={() => <Money value={v.debitTotal} />} /></Card></Col>
        <Col span={12}><Card size="small"><Statistic title="贷方合计(元)" valueRender={() => <Money value={v.creditTotal} />} /></Card></Col>
      </Row>
      <Table size="small" rowKey={(r) => `${r.batchId}-${r.voucherNo}-${r.accountCode}-${r.debit}-${r.credit}`} pagination={false} dataSource={v.lines} scroll={{ x: 900 }} columns={[
        { title: '期间', dataIndex: 'period', width: 80 }, { title: '日期', dataIndex: 'voucherDate', width: 100 },
        { title: '凭证号', dataIndex: 'voucherNo', width: 100 }, { title: '组织', dataIndex: 'orgName', width: 110, ellipsis: true },
        { title: '科目', dataIndex: 'accountName', width: 160, render: (n: string, r) => `${r.accountCode} ${n}` },
        { title: '摘要', dataIndex: 'summary', ellipsis: true },
        { title: '借方(元)', dataIndex: 'debit', width: 120, align: 'right', render: (x: string) => <Money value={x} /> },
        { title: '贷方(元)', dataIndex: 'credit', width: 120, align: 'right', render: (x: string) => <Money value={x} /> },
      ]} />
    </Space>
  );
}

function RisksTab({ r }: { r: NonNullable<P['risks']> }) {
  return (
    <Table size="small" rowKey="id" pagination={false} dataSource={r.rows} locale={{ emptyText: <Empty description="本项目没有风险事件" /> }} columns={[
      { title: '等级', dataIndex: 'level', width: 64, render: (v: string) => statusTag(RISK_LEVEL, v) },
      { title: '风险', dataIndex: 'title', render: (v: string, x) => <Link to={`/risk?id=${x.id}`}>{v}</Link> },
      { title: '规则', dataIndex: 'ruleName', width: 180, ellipsis: true },
      { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => statusTag(RISK_STATUS, v) },
      {
        title: '关联合同',
        dataIndex: 'contractId',
        width: 120,
        render: (cid?: number | null) => (cid ? <Link to={`/contracts?id=${cid}`}>查看合同 #{cid}</Link> : '—'),
      },
      { title: '金额(元)', dataIndex: 'amount', width: 130, align: 'right', render: (v: string | null) => <Money value={v} /> },
      { title: '最近命中', dataIndex: 'lastDetectedAt', width: 120, render: (v: string) => shortTime(v) },
    ]} />
  );
}

function InvestmentTab({ i }: { i: NonNullable<P['investment']> }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="投资控制(四算)" extra={i.control && <Link to={`/investment-control?id=${i.control.id}`}>打开</Link>}>
        {!i.control ? <Typography.Text type="secondary">未建立投资控制项目</Typography.Text> : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Descriptions size="small" column={3}>
              <Descriptions.Item label="批复概算(元)"><Money value={i.control.approved} /></Descriptions.Item>
              <Descriptions.Item label="最近对比">{i.control.latestComparison ? `#${i.control.latestComparison.id} · ${shortTime(i.control.latestComparison.createdAt)}` : '—'}</Descriptions.Item>
              <Descriptions.Item label="总偏差(元)">
                {i.control.latestComparison ? <Space size={4}><Money value={i.control.latestComparison.totalDeviation} tone /><Ratio value={i.control.latestComparison.totalDeviationRate} /></Space> : '—'}
              </Descriptions.Item>
            </Descriptions>
            <Table size="small" rowKey="id" pagination={false} dataSource={i.control.versions} columns={[
              { title: '当前版本', dataIndex: 'versionType', render: (v: string, r) => `${IC_VERSION_TYPE_LABEL[v] ?? v} · ${r.name}` },
              { title: '静态(元)', dataIndex: 'staticAmount', align: 'right', render: (v: string) => <Money value={v} /> },
              { title: '动态(元)', dataIndex: 'dynamicAmount', align: 'right', render: (v: string) => <Money value={v} /> },
              { title: '批复日期', dataIndex: 'approvalDate', render: (v: string | null) => v ?? '—' },
            ]} />
          </Space>
        )}
      </Card>
      <Card size="small" title="可行性测算">
        {i.feasibility.length === 0 ? <Typography.Text type="secondary">没有关联的测算项目</Typography.Text> : (
          <Space wrap>{i.feasibility.map((f) => <Link key={f.id} to={`/feasibility?id=${f.id}`}>{f.code} {f.name}({f.scenarioCount} 个方案)</Link>)}</Space>
        )}
      </Card>
    </Space>
  );
}

export default function ProjectProfile() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const rawPlanItemId = params.get('planItemId');
  const filterPlanItemId = rawPlanItemId && /^\d+$/.test(rawPlanItemId) ? Number(rawPlanItemId) : null;

  const setTabAndPlanFilter = (nextTab: string, nextPlanItemId?: number | null) => {
    const next = new URLSearchParams(params);
    next.set('tab', nextTab);
    if (nextPlanItemId != null && nextPlanItemId > 0) next.set('planItemId', String(nextPlanItemId));
    else next.delete('planItemId');
    setParams(next, { replace: true });
  };

  useAssistantDomainPage({
    pageKey: 'project_profile',
    ready: Number.isSafeInteger(id) && id > 0,
    scope: { projectId: id },
    view: compact({ tab: tabParam ?? undefined, planItemId: filterPlanItemId ?? undefined }),
  });
  const q = useQuery({ queryKey: ['project-profile', id], queryFn: () => projectProfileApi.get(id), enabled: Number.isSafeInteger(id) && id > 0 });
  if (q.error) return <QueryErrorResult title="项目档案加载失败" error={q.error} refetch={q.refetch} />;
  const d = q.data;
  if (!d) return <Card loading />;
  const p = d.project;
  const tabs = [
    d.budget && { key: 'budget', label: '项目预算', children: <BudgetTab b={d.budget} /> },
    d.plan && {
      key: 'plan',
      label: '计划执行',
      children: (
        <PlanTab
          p={d.plan}
          projectId={id}
          hasContractsTab={Boolean(d.contracts)}
          onFilterContractsByPlanItem={(planItemId) => setTabAndPlanFilter('contracts', planItemId)}
        />
      ),
    },
    d.contracts && {
      key: 'contracts',
      label: `合同付款(${d.contracts.count})`,
      children: (
        <ContractsTab
          c={d.contracts}
          planItems={d.plan?.items}
          filterPlanItemId={filterPlanItemId}
          onClearPlanFilter={() => setTabAndPlanFilter('contracts', null)}
        />
      ),
    },
    d.vouchers && { key: 'vouchers', label: `EAS 凭证(${d.vouchers.lineCount})`, children: <VouchersTab v={d.vouchers} /> },
    d.risks && { key: 'risks', label: `风险(${d.risks.openCount}/${d.risks.total})`, children: <RisksTab r={d.risks} /> },
    d.investment && { key: 'investment', label: '投资控制·可研', children: <InvestmentTab i={d.investment} /> },
    d.reports && {
      key: 'reports', label: `相关报告(${d.reports.length})`, children: (
        <Table size="small" rowKey="id" pagination={false} dataSource={d.reports} locale={{ emptyText: <Empty description="所属组织及上级暂无已审批/已发布报告" /> }} columns={[
          { title: '标题', dataIndex: 'title', render: (v: string, r) => <Link to={`/analysis-reports?id=${r.id}`}>{v}</Link> },
          { title: '类型', dataIndex: 'kind', width: 120, render: (v: string) => RPT_KIND_LABEL[v] ?? v },
          { title: '组织', dataIndex: 'orgName', width: 120, render: (v: string | null) => v ?? '全部' },
          { title: '年度', dataIndex: 'year', width: 70 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => statusTag(RPT_STATUS, v) },
          { title: '更新', dataIndex: 'updatedAt', width: 120, render: (v: string) => shortTime(v) },
        ]} />
      ),
    },
    d.logs && {
      key: 'logs', label: '操作日志', children: (
        <Table size="small" rowKey="id" pagination={false} dataSource={d.logs} columns={[
          { title: '时间', dataIndex: 'createdAt', width: 150, render: (v: string) => shortTime(v) },
          { title: '操作', dataIndex: 'action', width: 220 },
          { title: '对象', dataIndex: 'entityType', render: (v: string, r) => `${v === 'md_project' ? '项目' : v === 'ct_contract' ? '合同' : v} #${r.entityId}` },
          { title: '操作人', dataIndex: 'actor', width: 120, render: (v: string | null) => v ?? '—' },
          { title: '结果', dataIndex: 'result', width: 80, render: (v: string) => (v === 'success' ? <Tag color="success">成功</Tag> : <Tag color="error">{v}</Tag>) },
        ]} />
      ),
    },
  ].filter((t): t is { key: string; label: string; children: JSX.Element } => !!t);
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Descriptions size="small" column={3} title={<Space>{p.code} {p.name}{p.status === 'inactive' && <Tag>已停用</Tag>}</Space>}
          extra={<Link to={`/master-entities?tab=projects&keyword=${encodeURIComponent(p.code)}`}>主数据</Link>}>
          <Descriptions.Item label="归属组织">{p.orgName}</Descriptions.Item>
          <Descriptions.Item label="项目类型">{p.projectType || '—'}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{shortTime(p.updatedAt)}</Descriptions.Item>
          {Object.entries(p.extra).map(([k, v]) => <Descriptions.Item key={k} label={k}>{String(v)}</Descriptions.Item>)}
        </Descriptions>
      </Card>
      {tabs.length === 0 ? (
        <Alert type="info" showIcon message="当前账号没有项目相关业务数据的查看权限" />
      ) : (
        <Card size="small">
          <Tabs
            activeKey={tabParam && tabs.some((t) => t.key === tabParam) ? tabParam : tabs[0]?.key}
            onChange={(key) => setTabAndPlanFilter(key, key === 'contracts' ? filterPlanItemId : null)}
            items={tabs}
          />
        </Card>
      )}
    </Space>
  );
}
