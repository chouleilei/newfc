import { useAssistantRegistry } from '../../assistant/AssistantContextRegistry';
/**
 * 导入辅助抽屉(方案《AI助手完整方案》4.1「解释错误、建议组织/科目匹配、列出未匹配和重复项」)。
 *
 * 两种入口:①已持久化的导入批次 ID;②直接粘贴上传失败时接口返回的 errors 数组。
 * 解释、候选建议与清单全部由后端 /api/assistant/import-help 确定性给出,前端不做匹配打分。
 */
import { useState } from 'react';
import { Alert, Button, Card, Descriptions, Drawer, Empty, Input, InputNumber, Space, Spin, Table, Tag, Typography, message } from 'antd';
import type { ImportHelpReport } from '@contracts/assistant';
import { assistantApi } from '../../api/assistant';
import { ApiError } from '../../api/client';

const SAMPLE = `[
  { "row": 3, "field": "orgCode", "message": "组织编码不存在: SH1" },
  { "row": 6, "field": "accountCode", "message": "与第 5 行重复(同组织科目组合)" }
]`;

function MatchCard({
  title, items, onPick,
}: {
  title: string;
  items: ImportHelpReport['unmatched']['org'] | ImportHelpReport['unmatched']['account'];
  onPick?: (code: string) => void;
}) {
  if (!items.length) return null;
  return (
    <Card size="small" title={title}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {items.map((item) => (
          <div key={item.code}>
            <Space size={6} wrap style={{ marginBottom: 4 }}>
              <Typography.Text strong>文件中的编码：{item.code}</Typography.Text>
              <Tag>出现在第 {item.rows.join('、')} 行</Tag>
            </Space>
            {item.candidates.length ? (
              <Table
                size="small"
                rowKey="id"
                dataSource={item.candidates}
                pagination={false}
                columns={[
                  { title: '候选编码', dataIndex: 'code', width: 120, ellipsis: { showTitle: true } },
                  { title: '名称', dataIndex: 'name' },
                  { title: '类型', dataIndex: 'type', width: 80, render: (value?: string) => value ?? '—' },
                  { title: '可填报', width: 80, render: (_: unknown, row: any) => (row.isLeaf ? <Tag color="blue">末级</Tag> : <Tag>汇总</Tag>) },
                  { title: '相似度', align: 'right', width: 80, render: (_: unknown, row: any) => `${(row.score * 100).toFixed(0)}%` },
                  { title: '判定依据', dataIndex: 'reason' },
                  ...(onPick ? [{
                    title: '', width: 70,
                    render: (_: unknown, row: any) => <Button size="small" type="link" onClick={() => onPick(row.code)}>采用</Button>,
                  }] : []),
                ]}
                scroll={{ x: 720 }}
              />
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>没有相似度足够的候选，需要先在主数据中新建该节点。</Typography.Text>
            )}
          </div>
        ))}
      </Space>
    </Card>
  );
}

export function ImportHelpDrawer({
  open, onClose, defaultBatchId,
}: {
  open: boolean;
  onClose: () => void;
  defaultBatchId?: number;
}) {
  const registry = useAssistantRegistry();
  const [batchId, setBatchId] = useState<number | null>(defaultBatchId ?? null);
  const [errorsText, setErrorsText] = useState('');
  const [report, setReport] = useState<ImportHelpReport | null>(null);
  const [loading, setLoading] = useState(false);

  const diagnose = async () => {
    let errors: { row: number; field: string; message: string }[] | undefined;
    const trimmed = errorsText.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) throw new Error('errors 必须是数组');
        errors = parsed;
      } catch (err) {
        message.error(`错误清单解析失败：${err instanceof Error ? err.message : '不是合法 JSON'}`);
        return;
      }
    }
    if (batchId == null && !errors) {
      message.error('请填写导入批次 ID，或粘贴接口返回的 errors 数组');
      return;
    }
    setLoading(true);
    try {
      const snapshot = registry.buildSnapshot();
      if (snapshot.status !== 'ok') throw new Error('当前页面范围未就绪');
      setReport(await assistantApi.importHelp({
        pageContext: snapshot.pageContext,
        ...(batchId == null ? {} : { batchId }),
        ...(errors ? { errors } : {}),
        suggestionLimit: 3,
      }));
    } catch (err) {
      setReport(null);
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '导入诊断失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Drawer
      open={open} onClose={onClose} width="min(900px, 94vw)" title="导入辅助(错误解释与匹配建议)"
      extra={<Button size="small" type="primary" icon={<i className="ri-search-line" aria-hidden />} loading={loading} onClick={() => void diagnose()}>诊断</Button>}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info" showIcon
          message="错误解释与处理建议为后端固化口径，匹配建议基于当前组织树/科目树的编码与名称相似度，仅供参考，需人工确认后再改文件。"
        />
        <Space size={12} wrap>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>导入批次 ID</Typography.Text>
            <InputNumber min={1} value={batchId ?? undefined} onChange={(value) => setBatchId(value ?? null)} placeholder="可选" style={{ width: 120 }} />
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>或粘贴上传失败时返回的 errors 数组</Typography.Text>
        </Space>
        <Input.TextArea
          value={errorsText}
          onChange={(event) => setErrorsText(event.target.value)}
          placeholder={SAMPLE}
          autoSize={{ minRows: 4, maxRows: 10 }}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />

        {loading && !report ? <Spin /> : null}

        {report ? (
          <>
            {report.batch ? (
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="批次">#{report.batch.id}（{report.batch.kind}）</Descriptions.Item>
                <Descriptions.Item label="状态">{report.batch.status}</Descriptions.Item>
                <Descriptions.Item label="原文件">{report.batch.originalName}</Descriptions.Item>
                <Descriptions.Item label="历史补录">{report.batch.history ? '是' : '否'}</Descriptions.Item>
                <Descriptions.Item label="创建时间" span={2}>{report.batch.createdAt}</Descriptions.Item>
              </Descriptions>
            ) : null}

            <Alert
              type={report.errorCount ? 'warning' : 'success'} showIcon
              message={report.errorCount
                ? `共 ${report.errorCount} 条校验错误，归为 ${report.groups.length} 类；未匹配组织 ${report.unmatched.org.length} 个、科目 ${report.unmatched.account.length} 个，重复行 ${report.duplicates.length} 处。`
                : '该批次没有记录校验错误。'}
              description={
                <Space direction="vertical" size={2}>
                  {report.nextSteps.map((step, index) => <Typography.Text key={index} style={{ fontSize: 12 }}>{index + 1}. {step}</Typography.Text>)}
                </Space>
              }
            />

            {report.groups.length ? (
              <Table
                size="small"
                rowKey="category"
                dataSource={report.groups}
                pagination={false}
                expandable={{
                  expandedRowRender: (row) => (
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Typography.Text style={{ fontSize: 12 }}><Typography.Text strong>含义：</Typography.Text>{row.explanation}</Typography.Text>
                      <Typography.Text style={{ fontSize: 12 }}><Typography.Text strong>处理：</Typography.Text>{row.fix}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>命中行：{row.rows.join('、')}</Typography.Text>
                      {row.samples.map((sample, index) => (
                        <Typography.Text key={index} type="secondary" style={{ fontSize: 12 }}>
                          第 {sample.row} 行 [{sample.field}] {sample.message}
                        </Typography.Text>
                      ))}
                    </Space>
                  ),
                }}
                columns={[
                  { title: '错误类型', render: (_: unknown, row) => <Space size={6}><Tag color="red">{row.count}</Tag>{row.label}</Space> },
                  /* 分类码最长 29 字符 ≈232px:220 会溢出,按规范取 ~250 */
                  { title: '分类码', dataIndex: 'category', width: 250 },
                  { title: '处理建议', dataIndex: 'fix', ellipsis: true },
                ]}
              />
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可解释的错误" />}

            <MatchCard title="未匹配组织编码与候选建议" items={report.unmatched.org} />
            <MatchCard title="未匹配科目编码与候选建议" items={report.unmatched.account} />

            {report.duplicates.length ? (
              <Card size="small" title="重复项清单">
                <Table
                  size="small"
                  rowKey={(row) => `${row.row}-${row.field}`}
                  dataSource={report.duplicates}
                  pagination={{ pageSize: 8, size: 'small' }}
                  columns={[
                    { title: '行号', dataIndex: 'row', width: 80 },
                    { title: '字段', dataIndex: 'field', width: 120 },
                    { title: '首次出现行', dataIndex: 'firstRow', width: 110, render: (value: number | null) => value ?? '—' },
                    { title: '错误消息', dataIndex: 'message' },
                  ]}
                />
              </Card>
            ) : null}

            <Space direction="vertical" size={2}>
              {report.notes.map((note) => (
                <Typography.Text key={note} type="secondary" style={{ fontSize: 12 }}>· {note}</Typography.Text>
              ))}
            </Space>
          </>
        ) : null}
      </Space>
    </Drawer>
  );
}
