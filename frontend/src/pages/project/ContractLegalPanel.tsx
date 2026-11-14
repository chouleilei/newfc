import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Collapse,
  Descriptions,
  Empty,
  Input,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import type { ContractDetailDto } from '@contracts/project-contract';
import type {
  LegalFinding,
  LegalRunDto,
} from '@contracts/contract-legal-review';
import { contractApi } from '../../api/projectContract';
import { can, errorText, download } from '../../api/client';
import { formatMoney } from '../../utils/decimal';
export const VERDICT_LABEL = {
  pass: '建议通过',
  revise: '建议修改后重审',
  manual_review: '需补充人工审查',
};
const severityLabel = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
  info: '提示',
};
function Finding({ f }: { f: LegalFinding }) {
  return (
    <section style={{ overflowWrap: 'anywhere', lineHeight: 1.7 }}>
      <Typography.Text type="secondary">
        {f.locationRef} · {f.code}
      </Typography.Text>
      <blockquote
        style={{
          margin: '8px 0',
          padding: '8px 12px',
          borderLeft: '3px solid var(--newfc-border, #e5ded0)',
        }}
      >
        {f.excerpt || '正文未找到相应要素，请核对完整原件。'}
      </blockquote>
      <p>{f.message}</p>
      <p>
        <Typography.Text strong>
          依据{' '}
          {f.policyClauseId
            ? `制度条款 #${f.policyClauseId}`
            : f.templateClauseId
              ? `范本条款 #${f.templateClauseId}`
              : '完整性检查'}
        </Typography.Text>
        ：{f.expectedText}
      </p>
      <p>建议：{f.suggestedText}</p>
    </section>
  );
}
export function LegalRunView({ run }: { run: LegalRunDto }) {
  const major = run.findings.filter(
    (f) => f.blocking || f.severity === 'high' || f.severity === 'medium',
  );
  const minor = run.findings.filter((f) => !major.includes(f));
  return (
    <Space
      direction="vertical"
      size={12}
      style={{ width: '100%', fontSize: 14, lineHeight: 1.7 }}
    >
      <Space wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {VERDICT_LABEL[run.verdict]}
        </Typography.Title>
        <Tag
          color={
            run.riskLevel === 'high'
              ? 'error'
              : run.riskLevel === 'medium'
                ? 'warning'
                : 'default'
          }
        >
          {severityLabel[run.riskLevel]}
        </Tag>
        <Tag>{run.isCurrent ? '当前有效' : '已失效，需重新法审'}</Tag>
      </Space>
      {run.templateApprovalStatus === 'candidate' && (
        <Alert
          type="warning"
          showIcon
          message="当前比对基准为候选清理稿（待主管部门核定转正）"
        />
      )}
      <ul style={{ margin: 0, paddingLeft: 22 }}>
        {run.summary.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <Descriptions
        title="关键商务要素"
        size="small"
        column={{ xs: 1, sm: 2 }}
        bordered
        items={Object.entries(run.elements).map(([key, v]) => ({
          key,
          label:
            (
              {
                partyA: '甲方',
                partyB: '乙方',
                totalAmount: '台账金额（元）',
                amountUppercase: '大写金额',
                paymentRatios: '分期比例（%）',
                subject: '标的',
                term: '工期 / 交付',
                warranty: '质保',
                liability: '违约责任',
                dispute: '争议解决',
                tax: '税率',
                procurementTier: '采购层级',
              } as Record<string, string>
            )[key] ?? key,
          children: Array.isArray(v)
            ? v.join(' / ')
            : key === 'totalAmount'
              ? formatMoney(v)
              : key === 'procurementTier'
                ? ((
                    {
                      tier_1: '一级采购',
                      tier_2: '二级采购',
                      tier_3: '三级采购',
                      exempt_small: '小额直接报账',
                      non_procurement: '非采购',
                    } as Record<string, string>
                  )[v] ?? v)
                : v || '未识别，需核验',
        }))}
      />
      {major.length > 0 && (
        <Collapse
          defaultActiveKey={major.map((_, i) => String(i))}
          items={major.map((f, i) => ({
            key: String(i),
            label: (
              <Space wrap>
                <Tag color={f.blocking ? 'error' : 'warning'}>
                  {f.blocking ? '必须处理' : '需核验'}
                </Tag>
                {f.title}
              </Space>
            ),
            children: <Finding f={f} />,
          }))}
        />
      )}
      {minor.length > 0 && (
        <Collapse
          items={[
            {
              key: 'minor',
              label: `普通建议与提示（${minor.length}）`,
              children: minor.map((f, i) => <Finding key={i} f={f} />),
            },
          ]}
        />
      )}
      <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere' }}>
        制度：{run.policyRefs.map((p) => `${p.code} v${p.version}`).join('、')}
        ；范本 #{run.templateId ?? '无'}；运行 #{run.id}
      </Typography.Text>
      <Collapse
        size="small"
        items={[
          {
            key: 'trace',
            label: '版本与核验记录',
            children: (
              <Typography.Text style={{ overflowWrap: 'anywhere' }}>
                正文 SHA-256 {run.documentSha256}；解析：{run.parseChannel}
                ；模型：{String(run.stats?.modelName ?? run.modelStatus)}
                ；规则：{String(run.stats?.ruleVersion ?? '')}
              </Typography.Text>
            ),
          },
        ]}
      />
    </Space>
  );
}
export function ContractLegalPanel({
  contract: c,
  onChanged,
}: {
  contract: ContractDetailDto;
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [selected, setSelected] = useState<number>();
  const [comment, setComment] = useState('');
  const [exception, setException] = useState('');
  const [pendingOp, setPendingOp] = useState<'run' | 'submit' | 'approve' | 'reject' | null>(null);
  const q = useQuery({
    queryKey: ['contract-legal', c.id, c.version],
    queryFn: () => contractApi.legalReviews(c.id),
    refetchInterval: (query) => (query.state.data?.activeJob ? 1000 : false),
  });
  const run = q.data?.runs.find((r) => r.id === selected) ?? q.data?.runs[0];
  const pending = c.reviews.find((r) => r.status === 'submitted');
  const approved = c.reviews.some(
    (r) => r.status === 'approved' && r.legalRunId === run?.id,
  );
  const action = useMutation({
    mutationFn: async ({ op, fn }: { op: 'run' | 'submit' | 'approve' | 'reject'; fn: () => Promise<unknown> }) => {
      setPendingOp(op);
      return fn();
    },
    onSettled: () => setPendingOp(null),
    onSuccess: () => {
      void q.refetch();
      onChanged();
    },
    onError: (e) => message.error(errorText(e)),
  });
  const decide = (decision: 'approve' | 'reject') => {
    if (!pending) return;
    action.mutate({
      op: decision,
      fn: () => contractApi.decideReview(c.id, pending.id, {
        decision,
        comment: comment || undefined,
        exceptionReason: exception || undefined,
      }),
    });
  };
  const latestText = c.documents
    .filter((d) => d.docType === 'contract_text')
    .slice(-1)[0];
  return (
    <section aria-label="合同智能法审" style={{ width: '100%' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            签约前智能法审
          </Typography.Title>
          {(can('contract:write') || can('contract:review')) &&
            c.status === 'active' &&
            ['drafting', 'approval'].includes(c.stage) && (
              <Button
                loading={pendingOp === 'run' || !!q.data?.activeJob}
                onClick={() =>
                  action.mutate({ op: 'run', fn: () => contractApi.runLegalReview(c.id) })
                }
              >
                {run ? '重新运行法审' : '启动智能法审'}
              </Button>
            )}
          {q.data && q.data.runs.length > 1 && (
            <Select
              aria-label="法审历史"
              style={{ minWidth: 200, maxWidth: '100%' }}
              value={run?.id}
              onChange={setSelected}
              options={q.data.runs.map((r) => ({
                value: r.id,
                label: `运行 #${r.id} · ${r.isCurrent ? '有效' : '失效'} · ${VERDICT_LABEL[r.verdict]}`,
              }))}
            />
          )}
        </Space>
        {q.isError && (
          <Alert
            type="error"
            message={errorText(q.error)}
            action={<Button onClick={() => void q.refetch()}>重试</Button>}
          />
        )}
        {q.data?.lastJob &&
          ['failed', 'interrupted', 'cancelled'].includes(
            q.data.lastJob.status,
          ) && (
            <Alert
              type="error"
              showIcon
              message={
                q.data.lastJob.error || '最近法审任务未完成，请重新运行法审'
              }
            />
          )}
        {q.data?.activeJob && (
          <div role="status">
            <Progress percent={Math.floor(q.data.activeJob.progress / 10)} />
            <Typography.Text>
              {q.data.activeJob.message || '法审任务排队中，可稍后返回查看'}
            </Typography.Text>
          </div>
        )}
        {run ? (
          <LegalRunView key={run.id} run={run} />
        ) : (
          <Empty
            description={
              q.isLoading
                ? '正在读取法审记录'
                : '上传最新 DOCX 正文及签订依据后启动法审。PDF 接口或 OCR 未配置时需补充人工审查。'
            }
          />
        )}
        {latestText && (
          <Button
            onClick={() =>
              void download(
                `/contracts/${c.id}/documents/${latestText.id}/content`,
                latestText.name,
              )
            }
          >
            查看合同正文
          </Button>
        )}
        {c.stage === 'approval' &&
          c.status === 'active' &&
          run &&
          run.id === q.data?.runs[0]?.id && (
            <Space direction="vertical" style={{ width: '100%' }}>
              {approved && run.isCurrent && (
                <Tag color="success">正式复核已通过</Tag>
              )}
              {!pending &&
                !approved &&
                run.isCurrent &&
                can('contract:write') && (
                  <Button
                    loading={pendingOp === 'submit'}
                    onClick={() =>
                      action.mutate({
                        op: 'submit',
                        fn: () => contractApi.submitReview(c.id, run.documentId),
                      })
                    }
                  >
                    提交正式复核
                  </Button>
                )}
              {pending && can('contract:review') && (
                <>
                  <label htmlFor="legal-review-comment">
                    人工核验说明
                    {run.verdict !== 'pass' ? '（确认通过时必填）' : '（可选）'}
                  </label>
                  <Input.TextArea
                    id="legal-review-comment"
                    value={comment}
                    maxLength={500}
                    rows={3}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="核对原文、候选默认值或补充审查情况"
                  />
                  {can('security:manage') && (
                    <Input
                      aria-label="同人复核例外原因"
                      value={exception}
                      maxLength={500}
                      onChange={(e) => setException(e.target.value)}
                      placeholder="同人复核需填写例外原因"
                    />
                  )}
                  <Space wrap>
                    {run.isCurrent && pending.documentId === run.documentId && (
                      <Button
                        type="primary"
                        disabled={
                          run.findings.some((f) => f.blocking) ||
                          run.verdict === 'revise'
                        }
                        loading={pendingOp === 'approve'}
                        onClick={() => decide('approve')}
                      >
                        确认通过
                      </Button>
                    )}
                    <Button
                      danger
                      loading={pendingOp === 'reject'}
                      onClick={() => {
                        if (!comment)
                          setComment(run.summary.join('；').slice(0, 500));
                        action.mutate({
                          op: 'reject',
                          fn: () => contractApi.decideReview(c.id, pending.id, {
                            decision: 'reject',
                            comment:
                              comment || run.summary.join('；').slice(0, 500),
                            exceptionReason: exception || undefined,
                          }),
                        });
                      }}
                    >
                      退回修改
                    </Button>
                  </Space>
                  {(!run.isCurrent ||
                    pending.documentId !== run.documentId) && (
                    <Typography.Text type="warning">
                      待复核记录或法审结论已失效，请先退回后重新提交。
                    </Typography.Text>
                  )}
                  {(run.findings.some((f) => f.blocking) ||
                    run.verdict === 'revise') && (
                    <Typography.Text type="danger">
                      存在必须修改或补充的事项，请退回修改后重新法审。
                    </Typography.Text>
                  )}
                </>
              )}
            </Space>
          )}
      </Space>
    </section>
  );
}
