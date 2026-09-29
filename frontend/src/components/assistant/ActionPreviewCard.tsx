/**
 * 助手写操作卡片:预览 → 确认 / 取消。
 *
 * 前端不判断版本状态、不重算金额:确认由后端再次校验令牌、有效期、预览基线、
 * 版本状态、绑定树快照与金额/数量规则。这里只展示后端返回的预览差异。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Descriptions, Modal, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import { ApiError } from '../../api/client';
import { assistantApi, downloadActionArtifact, type AssistantAction } from '../../api/assistant';
import { centsToWan, formatRateOrReason } from '../../utils/money';
import MoneyText from '../MoneyText';
import { TechDetail } from '../TechDetail';
import { actionResultLinks, summarizeActionResult } from './actionResultLinks';

const TYPE_LABEL: Record<string, string> = {
  budget_draft: '生成预算草案',
  copy_budget: '复制预算版本',
  bulk_adjustment: '批量调整预算明细',
  scenario: '情景测算',
  basis_text: '保存测算依据(AI 草稿)',
  export: '生成导出文件',
};

const STATUS_COLOR: Record<string, string> = { pending: 'gold', confirmed: 'green', cancelled: 'default', expired: 'red' };
const STATUS_LABEL: Record<string, string> = { pending: '待确认', confirmed: '已确认', cancelled: '已取消', expired: '已过期' };

function changeRows(preview: Record<string, any>): any[] {
  const list = preview?.largestChanges ?? preview?.changes ?? preview?.items ?? [];
  return Array.isArray(list) ? list.slice(0, 20) : [];
}

function cellNumber(row: any, key: 'before' | 'after'): number | null {
  const node = row?.[key];
  if (node == null) return null;
  if (typeof node === 'number') return node;
  if (typeof node.amount_cents === 'number') return node.amount_cents;
  if (typeof node.amountCents === 'number') return node.amountCents;
  return null;
}

function ScenarioSummary({ preview }: { preview: Record<string, any> }) {
  if (!preview?.baseline) return null;
  return (
    <Descriptions size="small" column={2} bordered style={{ marginBottom: 8 }}>
      <Descriptions.Item label="收入增长">{formatRateOrReason(preview.rates?.income)}</Descriptions.Item>
      <Descriptions.Item label="成本增长">{formatRateOrReason(preview.rates?.cost)}</Descriptions.Item>
      <Descriptions.Item label="费用增长">{formatRateOrReason(preview.rates?.expense)}</Descriptions.Item>
      <Descriptions.Item label="利润影响(万元)"><MoneyText cents={preview.profitImpact ?? 0} hideUnit /></Descriptions.Item>
      <Descriptions.Item label="基准利润(万元)"><MoneyText cents={preview.profitBaseline ?? 0} hideUnit /></Descriptions.Item>
      <Descriptions.Item label="测算后利润(万元)"><MoneyText cents={preview.profitAdjusted ?? 0} hideUnit /></Descriptions.Item>
      {preview.expenseCapDisplay != null && (
        <Descriptions.Item label="费用上限(万元)" span={2}>
          {preview.targetProfitInfeasible ? '目标利润在当前收入成本下不可实现' : <MoneyText cents={preview.expenseCapDisplay} hideUnit />}
        </Descriptions.Item>
      )}
    </Descriptions>
  );
}

export function ActionPreviewCard({
  action,
  onChanged,
}: {
  action: AssistantAction;
  onChanged: (next: AssistantAction) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const preview = action.preview ?? {};
  const rows = changeRows(preview);
  /**
   * 令牌过期判定。
   *
   * 原来只看 `status === 'pending'`：TTL 过了但状态还没被 expire() 刷成 expired 时，
   * 「确认执行」按钮照亮，用户点下去只能等后端回 409。这里用已经展示的 expiresAt
   * 自行判定，并每 5 秒复核一次(不依赖后端刷新状态)。
   */
  const expiresAtMs = action.expiresAt ? Date.parse(action.expiresAt) : NaN;
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (action.status !== 'pending' || !Number.isFinite(expiresAtMs)) return undefined;
    const timer = window.setInterval(() => setNowTs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [action.status, expiresAtMs]);
  const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowTs;
  const pending = action.status === 'pending' && !expired;

  const download = async () => {
    setBusy(true);
    try {
      await downloadActionArtifact(action.id, action.result?.filename ?? `assistant-export-${action.id}`);
    } catch (err) {
      // 原来是 `void downloadActionArtifact(...)`：失败连个提示都没有。
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '下载失败');
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn: () => Promise<AssistantAction>, okText: string) => {
    setBusy(true);
    try {
      const next = await fn();
      onChanged(next);
      message.success(okText);
    } catch (err) {
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      size="small"
      style={{ marginTop: 8 }}
      title={
        <Space size={6}>
          <Tag color="purple">操作</Tag>
          <span>{TYPE_LABEL[action.type] ?? action.type}</span>
          <Tag color={STATUS_COLOR[action.status]}>{STATUS_LABEL[action.status] ?? action.status}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>#{action.id}</Typography.Text>
        </Space>
      }
      extra={
        <Space>
          <Typography.Link style={{ fontSize: 12 }} onClick={() => setRawOpen(true)}>查看完整预览</Typography.Link>
          {pending && (
            <>
              <Popconfirm
                title="确认执行该操作？"
                description="确认后由后端在事务内写入，锁定版本与快照口径仍受保护。"
                onConfirm={() => run(() => assistantApi.confirm(action.id, action.confirmationToken ?? ''), '已确认并执行')}
              >
                <Button type="primary" size="small" loading={busy} disabled={!action.confirmationToken}>确认执行</Button>
              </Popconfirm>
              <Button size="small" loading={busy} onClick={() => run(() => assistantApi.cancel(action.id), '已取消')}>取消</Button>
            </>
          )}
          {action.status === 'confirmed' && action.result?.downloadUrl && (
            <Button
              size="small" icon={<i className="ri-download-2-line" aria-hidden />} loading={busy}
              onClick={() => void download()}
            >
              下载导出
            </Button>
          )}
        </Space>
      }
    >
      <Alert
        type={pending ? 'warning' : action.status === 'confirmed' ? 'success' : 'info'}
        showIcon
        style={{ marginBottom: 8 }}
        message={
          pending
            ? `未确认前不会修改任何数据。令牌有效期至 ${action.expiresAt}；预览依据变化后需重新预览。`
            : action.status === 'confirmed'
              ? '已确认执行，写入结果见下方。'
              : expired && action.status === 'pending'
                ? `确认令牌已于 ${action.expiresAt} 过期，请重新创建预览。`
                : `操作状态：${STATUS_LABEL[action.status] ?? action.status}`
        }
      />
      {action.type === 'scenario' && <ScenarioSummary preview={preview} />}
      {action.type === 'export' && (
        <Descriptions size="small" column={3} style={{ marginBottom: 8 }}>
          <Descriptions.Item label="导出类型">{preview.kind}</Descriptions.Item>
          <Descriptions.Item label="格式">{preview.format}</Descriptions.Item>
          <Descriptions.Item label="预估行数">{preview.estimatedRows ?? '—'}</Descriptions.Item>
        </Descriptions>
      )}
      {action.type === 'basis_text' && (
        <>
          <Tag color="orange">AI 草稿</Tag>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{preview.text}</Typography.Paragraph>
        </>
      )}
      {(action.type === 'copy_budget' || action.type === 'budget_draft' || action.type === 'bulk_adjustment') && (
        <>
          <Descriptions size="small" column={3} style={{ marginBottom: 8 }}>
            {preview.source && <Descriptions.Item label="源版本">{preview.source.name}（{preview.source.year}，{preview.source.status}）</Descriptions.Item>}
            {preview.target && <Descriptions.Item label="目标">{preview.target.name}（{preview.target.year}）</Descriptions.Item>}
            <Descriptions.Item label="变更条数">{preview.changeCount ?? rows.length}</Descriptions.Item>
            {preview.sourceType && <Descriptions.Item label="基准">{preview.sourceType}</Descriptions.Item>}
          </Descriptions>
          <Table
            size="small"
            rowKey={(row: any, index) => `${row.orgId ?? '-'}-${row.accountId ?? '-'}-${index}`}
            dataSource={rows}
            pagination={false}
            columns={[
              { title: '组织', dataIndex: 'orgName', width: 120, render: (value: string, row: any) => value ?? row.orgCode ?? row.orgId },
              { title: '科目', dataIndex: 'accountName', width: 140, render: (value: string, row: any) => value ?? row.accountCode ?? row.accountId },
              { title: '原值(万元)', align: 'right' as const, width: 110, render: (_: unknown, row: any) => {
                const before = cellNumber(row, 'before') ?? row.sourceCents;
                return before == null ? '—' : <MoneyText cents={before} hideUnit />;
              } },
              { title: '建议值(万元)', align: 'right' as const, width: 110, render: (_: unknown, row: any) => {
                const after = cellNumber(row, 'after') ?? row.suggestedCents;
                return after == null ? '—' : <MoneyText cents={after} hideUnit />;
              } },
              { title: '变化(万元)', align: 'right' as const, width: 110, render: (_: unknown, row: any) => (row.changeCents == null ? '—' : <MoneyText cents={row.changeCents} hideUnit />) },
              { title: '原因/来源', render: (_: unknown, row: any) => row.reason ?? row.sourceLabel ?? (row.hasSource === false ? '无来源值' : '—') },
            ]}
            scroll={{ x: 700, y: 260 }}
          />
          {(preview.changeCount ?? rows.length) > rows.length && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>仅展示变化最大的 {rows.length} 项，确认时按完整预览执行。</Typography.Text>
          )}
        </>
      )}
      {preview.validationDeferred && <Alert type="info" showIcon style={{ marginTop: 8 }} message={`校验将在确认时执行：${preview.validationMessage ?? ''}`} />}
      {/* UX-26：确认成功用业务语言说明写入了什么，并给「查看结果」跳转；
          原始 result JSON 收进「技术详情」，不再直接铺开。 */}
      {action.status === 'confirmed' && action.result ? (
        <div style={{ marginTop: 8 }} data-testid="assistant-action-result">
          <Space size={8} wrap>
            <TechDetail
              summary={<Typography.Text style={{ fontSize: 13 }}>{summarizeActionResult(action) ?? '已确认执行。'}</Typography.Text>}
              raw={action.result}
            />
            {actionResultLinks(action).map((link) => (
              <Link key={link.path} to={link.path} data-testid="assistant-action-result-link">{link.label}</Link>
            ))}
          </Space>
        </div>
      ) : null}
      <Modal open={rawOpen} onCancel={() => setRawOpen(false)} footer={null} width={820} title={`预览 #${action.id} 完整结构`}>
        <pre style={{ maxHeight: 480, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview, null, 2)}</pre>
      </Modal>
    </Card>
  );
}
