/**
 * 报告生成抽屉(方案《AI助手完整方案》4.3「执行月报 / 年度复盘 / 预算讨论材料」)。
 *
 * 报告由后端确定性组稿:章节要点、金额(万元)与引用都来自 /api/assistant/report。
 * 模型可用时只改写叙述文字,数字不变;不可用时展示模板叙述并明确标注降级。
 */
import { useState } from 'react';
import { Alert, Button, Collapse, Descriptions, Drawer, Segmented, Space, Spin, Tag, Typography, message } from 'antd';
import { Markdown } from './Markdown';
import type { AssistantContext, ReportDraft, ReportKind } from '../../api/assistant';
import { assistantApi } from '../../api/assistant';
import { ApiError } from '../../api/client';
import { CitationList } from './FactsPanel';

const KINDS: { value: ReportKind; label: string; needs: 'version' | 'year'; hint: string }[] = [
  { value: 'monthly_execution', label: '执行月报', needs: 'version', hint: '总体执行 → 指标 → 差异归因 → 数量 → 异常 → 年内趋势' },
  { value: 'annual_review', label: '年度复盘', needs: 'year', hint: '年度结果 → 预算准确率 → 历年对比 → 主要差异归因(年度关闭后数据最完整)' },
  { value: 'budget_discussion', label: '预算讨论材料', needs: 'version', hint: '版本概况 → 预算结构 → 质量与合规 → 与对比版本差异 → 待讨论议题' },
];

export function ReportDrawer({
  open, onClose, context, onSaveInsight,
}: {
  open: boolean;
  onClose: () => void;
  context: AssistantContext;
  onSaveInsight?: (params: Record<string, unknown>, title: string) => void;
}) {
  const [kind, setKind] = useState<ReportKind>('monthly_execution');
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const config = KINDS.find((item) => item.value === kind)!;

  const generate = async () => {
    if (config.needs === 'version' && context.budgetVersionId == null) {
      message.error('请先在助手上下文中选择预算版本');
      return;
    }
    if (config.needs === 'year' && context.year == null) {
      message.error('请先在助手上下文中选择年度');
      return;
    }
    setLoading(true);
    try {
      const result = await assistantApi.report({
        kind,
        ...(context.budgetVersionId == null ? {} : { versionId: context.budgetVersionId }),
        ...(context.year == null ? {} : { year: context.year }),
        ...(context.actualSnapshotId == null ? {} : { batchId: context.actualSnapshotId }),
        ...(context.targetVersionId == null ? {} : { targetVersionId: context.targetVersionId }),
        ...(context.orgId == null ? {} : { orgScopeId: context.orgId }),
        ...(context.accountId == null ? {} : { accountScopeId: context.accountId }),
      });
      setDraft(result);
    } catch (err) {
      setDraft(null);
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '报告生成失败');
    } finally {
      setLoading(false);
    }
  };

  const copyNarrative = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.narrative);
      message.success('报告 Markdown 已复制');
    } catch {
      message.error('浏览器拒绝了剪贴板访问，请手动选择文本复制');
    }
  };

  return (
    <Drawer
      open={open} onClose={onClose} width="min(900px, 94vw)" title="报告生成"
      extra={
        <Space>
          <Button size="small" icon={<i className="ri-file-text-line" aria-hidden />} loading={loading} type="primary" onClick={() => void generate()}>生成</Button>
          {draft ? <Button size="small" icon={<i className="ri-file-copy-line" aria-hidden />} onClick={() => void copyNarrative()}>复制 Markdown</Button> : null}
          {draft && onSaveInsight ? (
            <Button
              size="small" icon={<i className="ri-save-3-line" aria-hidden />}
              onClick={() => onSaveInsight({
                reportKind: kind,
                ...(context.budgetVersionId == null ? {} : { versionId: context.budgetVersionId }),
                ...(context.year == null ? {} : { year: context.year }),
                ...(context.actualSnapshotId == null ? {} : { batchId: context.actualSnapshotId }),
                ...(context.targetVersionId == null ? {} : { targetVersionId: context.targetVersionId }),
              }, draft.title)}
            >
              保存为洞察
            </Button>
          ) : null}
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Segmented
          options={KINDS.map((item) => ({ value: item.value, label: item.label }))}
          value={kind}
          onChange={(value) => { setKind(value as ReportKind); setDraft(null); }}
          block
        />
        <Alert
          type="info" showIcon
          message={`章节结构:${config.hint}`}
          description="所有金额、完成率、准确率与归因数字由后端确定性计算并附引用;模型只改写叙述文字。建议部分为 AI 生成,仅供参考。"
        />
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="年度">{context.year ?? '未选择'}</Descriptions.Item>
          <Descriptions.Item label="预算版本">{context.budgetVersionId ?? '未选择'}</Descriptions.Item>
          <Descriptions.Item label="对比版本">{context.targetVersionId ?? '未选择'}</Descriptions.Item>
          <Descriptions.Item label="实际快照">{context.actualSnapshotId ?? '默认当前累计'}</Descriptions.Item>
        </Descriptions>

        {loading && !draft ? <Spin /> : null}

        {draft ? (
          <>
            <Space size={6} wrap>
              <Typography.Text strong>{draft.title}</Typography.Text>
              <Tag color="blue">{draft.kindLabel}</Tag>
              <Tag color={draft.narrativeSource === 'model' ? 'green' : 'default'}>
                {draft.narrativeSource === 'model' ? `叙述由模型改写（${draft.model}）` : '模板叙述（模型未启用或降级）'}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>生成于 {draft.generatedAt}</Typography.Text>
            </Space>

            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>引用来源</Typography.Text>
              <CitationList citations={draft.citations} />
            </div>

            <Collapse
              size="small"
              defaultActiveKey={draft.sections.map((section) => section.key)}
              items={[
                ...draft.sections.map((section) => ({
                  key: section.key,
                  label: <Space size={6}><Tag color="blue">事实</Tag><span>{section.title}</span></Space>,
                  children: (
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      {section.bullets.map((bullet, index) => (
                        <Typography.Text key={index} style={{ whiteSpace: 'pre-wrap' }}>· {bullet}</Typography.Text>
                      ))}
                      {section.citations.length ? (
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>本节引用</Typography.Text>
                          <CitationList citations={section.citations} />
                        </div>
                      ) : null}
                    </Space>
                  ),
                })),
                {
                  key: '__suggestions',
                  label: <Space size={6}><Tag color="orange">建议</Tag><span>后续动作(AI 生成,仅供参考)</span></Space>,
                  children: (
                    <Space direction="vertical" size={4}>
                      {draft.suggestions.map((item, index) => <Typography.Text key={index}>· {item}</Typography.Text>)}
                    </Space>
                  ),
                },
                {
                  key: '__narrative',
                  label: <Space size={6}><Tag>成稿</Tag><span>Markdown 全文</span></Space>,
                  children: (
                    <div style={{ maxHeight: 420, overflow: 'auto', fontSize: 12 }}>
                      <Markdown text={draft.narrative} />
                    </div>
                  ),
                },
              ]}
            />

            <Space direction="vertical" size={2}>
              {draft.notes.map((note) => (
                <Typography.Text key={note} type="secondary" style={{ fontSize: 12 }}>· {note}</Typography.Text>
              ))}
            </Space>
          </>
        ) : null}
      </Space>
    </Drawer>
  );
}
