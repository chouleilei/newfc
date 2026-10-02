import { Descriptions, Empty, Space, Table, Typography } from 'antd';
import { Link } from 'react-router-dom';
import type { AssistantFact } from '../../api/assistant';

export const DOMAIN_TOOL_LABELS: Record<string, string> = {
  domain_ledger: '当前台账筛选结果',
  mgmt_analysis: '管理会计多维分析',
  authorization_scope: '我的权限范围',
  domain_batch_read: '指定来源批次', statement_trends: '财报趋势', mgmt_workspace: '管理会计页签', domain_workspace: '业务页签记录', feasibility_report_read: '可行性报告',
  eas_period_status: 'EAS 对账状态', statement_overview: '财务报表', mgmt_metric_snapshots: '管理会计指标', mgmt_alerts: '管理会计预警',
  project_budget_summary: '项目预算', plan_execution_overview: '计划执行', contract_summary: '合同汇总', contract_detail: '合同详情', expense_audit_queue: '费用复核队列',
  feasibility_result: '可行性测算', investment_comparison: '投资控制', forecast_runs: '财务预测', risk_summary: '风险概况', report_list: '分析报告',
  cross_search: '跨域检索', project_profile: '项目全景', master_entities: '项目与供应商', expense_detail: '报销审核详情', policy_search: '制度条款',
  governance_issues: '数据治理', standard_report_read: '冻结标准报表', analysis_report_read: '分析报告详情', risk_detail: '风险与整改', forecast_result: '预测版本与运行',
  task_status: '任务状态', configuration_overview: '配置与能力',
};
const LABEL: Record<string, string> = {
  fieldName: '字段', valueType: '数值类型', facts: '原始事实', debit: '借方（元）', credit: '贷方（元）', periodFrom: '起始期间', periodTo: '截至期间', from: '起始期间', to: '截至期间', points: '趋势各期', annualPlan: '年度计划（元）', annualActualYtd: '累计执行（元）', fundSource: '资金来源', expenseCategory: '费用类别', execMonth: '执行月份', scope: '财报口径',
  id: 'ID', code: '编码', name: '名称', title: '标题', orgName: '组织', period: '期间', year: '年度', status: '状态', stage: '阶段',
  amount: '金额（元）', currentAmount: '当前金额（元）', paidAmount: '已付款（元）', originalAmount: '原金额（元）', approvedChange: '已批准变更（元）',
  paymentRate: '付款比率（0–1）', value: '数值', unit: '单位', budget: '预算（元）', executed: '已执行（元）', remaining: '余额（元）',
  currentTotal: '当前金额（元）', paidTotal: '已付金额（元）', paidRate: '付款比率（0–1）', rate: '比率（0–1）', totalDeviation: '偏差（元）', totalDeviationRate: '偏差比率',
  totalLevel: '偏差等级', riskLevel: '风险等级', level: '等级', total: '记录数', hidden: '未展示数', count: '数量', reviewVersion: '审核版本',
  claimNo: '报销单号', contractNo: '合同编号', projectCode: '项目编码', projectName: '项目名称', scenarioName: '方案名称', expenseType: '费用类型',
  nodeName: '付款节点', paidDate: '支付日期', occurredDate: '发生日期', submittedAt: '提交时间', createdAt: '创建时间', generatedAt: '生成时间', publishedAt: '发布时间',
  sourceRef: '来源定位', sourceHash: '来源摘要', contentSha256: '冻结摘要', parameterHash: '参数摘要', revisionNo: '修订号', version: '版本',
  clauseNo: '条款编号', clauseText: '条款摘要', policyCode: '制度编码', policyName: '制度名称', effectiveFrom: '生效日期', effectiveTo: '失效日期', hasSource: '有原始制度文件',
  limit: '上限（元）', ruleName: '规则', message: '说明', severity: '等级', stale: '依据已过期', allChecksPassed: '全部检查通过',
  deadline: '整改截止', overdue: '逾期', conclusion: '人工结论', modelStatus: '模型状态', ocrStatus: '识别状态', openAmount: '未关闭风险金额（元）',
  batch: '来源批次', totals: '合计', byProject: '按项目', byOrg: '按组织', byFundSource: '资金来源', metrics: '金额指标（元）', ratios: '比率',
  currentSet: '当前对账集合', lock: '期间锁', pendingCorrection: '待复核更正', results: '核对结果', payments: '付款节点', changes: '合同变更',
  audit: '当前审核', findings: '审核发现', reviews: '人工复核', lines: '明细', scenarios: '可研方案', latestRun: '最新测算', indicators: '指标', failedChecks: '未通过检查',
  models: '预测模型', model: '模型', versions: '预测版本', runs: '运行记录', outputs: '输出', comparison: '冻结对比', flaggedRows: '超限明细',
  openRisks: '未关闭风险', actions: '整改记录', reports: '报告列表', report: '冻结报表', summary: '摘要', sources: '事实来源', sections: '报告章节',
  settings: '业务设置', channels: '模型渠道', bindings: '功能绑定', notes: '口径说明', items: '记录', candidates: '候选对象',
};
const STATUS: Record<string, string> = { active: '生效', draft: '草稿', frozen: '已冻结', published: '已发布', superseded: '已替代', approved: '已批准',
  submitted: '已提交', audited: '待人工复核', reviewing: '复核中', reviewed: '已复核', pending_approval: '待审批', pending_review: '待复核',
  open: '待处理', acknowledged: '已确认', closed: '已关闭', resolved: '已解决', dismissed: '已排除', high: '高', medium: '中', low: '低',
  succeeded: '成功', failed: '失败', interrupted: '中断', cancelled: '已取消', running: '运行中', queued: '排队', unavailable: '不可用', not_needed: '无需识别', ok: '正常' };
function text(value: unknown) { return value == null ? '未提供' : typeof value === 'boolean' ? value ? '是' : '否' : STATUS[String(value)] ?? String(value); }
const scalar = (v: unknown) => v == null || ['string', 'number', 'boolean'].includes(typeof v);
function DataView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (scalar(value)) return <Typography.Text>{text(value)}</Typography.Text>;
  if (Array.isArray(value)) {
    if (!value.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围没有记录" />;
    if (value.every(scalar)) return <ul>{value.map((v, i) => <li key={i}>{text(v)}</li>)}</ul>;
    const rows = value.filter((r) => r && typeof r === 'object') as Record<string, unknown>[];
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => rows.some((r) => Object.prototype.hasOwnProperty.call(r, k) && scalar(r[k])) && k !== 'path').slice(0, 8);
    const nestedKeys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => rows.some((r) => r[k] != null && !scalar(r[k])));
    if (keys.length) return <Table expandable={depth < 3 && nestedKeys.length ? { expandedRowRender: (row) => <Space direction="vertical" style={{ width: '100%' }}>{nestedKeys.filter((k) => row[k] != null).map((k) => <div key={k}><Typography.Text strong>{LABEL[k] ?? k}</Typography.Text><DataView value={row[k]} depth={depth + 1} /></div>)}</Space>, rowExpandable: (row) => nestedKeys.some((k) => row[k] != null), defaultExpandedRowKeys: nestedKeys.includes('facts') ? ['0'] : [] } : undefined} size="small" rowKey={(_, i) => String(i)} dataSource={rows} pagination={{ pageSize: 8, size: 'small', showSizeChanger: false }} scroll={{ x: Math.max(480, keys.length * 130) }}
      columns={[...keys.map((key) => ({ title: LABEL[key] ?? key, key, dataIndex: key, render: (v: unknown) => scalar(v) ? text(v) : '查看业务详情', ellipsis: true })),
        ...(rows.some((r) => typeof r.path === 'string') ? [{ title: '来源', key: 'source', render: (_: unknown, row: Record<string, unknown>) => typeof row.path === 'string' && /^\/(?!\/)/.test(row.path) ? <Link to={row.path}>打开详情</Link> : null }] : [])]} />;
    return <Space direction="vertical">{rows.slice(0, 8).map((r, i) => <DataView key={i} value={r} depth={depth + 1} />)}</Space>;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const flat = entries.filter(([, v]) => scalar(v));
  const nested = entries.filter(([, v]) => !scalar(v));
  return <Space direction="vertical" style={{ width: '100%' }} size="middle">
    {flat.length > 0 && <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={flat.map(([key, v]) => ({ key, label: LABEL[key] ?? key, children: text(v) }))} />}
    {depth < 4 && nested.filter(([k]) => !['columns', 'publication'].includes(k)).map(([key, v]) => <div key={key} style={{ width: '100%' }}><Typography.Text strong>{LABEL[key] ?? key}</Typography.Text><DataView value={v} depth={depth + 1} /></div>)}
  </Space>;
}
export function DomainFactView({ fact }: { fact: AssistantFact }) {
  return <div><DataView value={fact.data} /><Space wrap style={{ marginTop: 12 }}>{fact.source.references?.map((r) => <Link key={`${r.kind}:${r.id}`} to={r.path}>{r.label} · #{r.id}</Link>)}</Space></div>;
}
