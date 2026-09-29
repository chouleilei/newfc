/**
 * 新建助手操作(预览)。六种 action 与后端 /api/assistant/preview 一一对应。
 *
 * 增长率界面按百分数录入,提交前换算成小数;金额相关字段由后端计算,前端不做换算。
 */
import { useState } from 'react';
import { Alert, Form, Input, InputNumber, Modal, Select, message } from 'antd';
import { ApiError } from '../../api/client';
import { assistantApi, previewIdempotencyKey, type AssistantAction, type AssistantContext } from '../../api/assistant';

const TYPE_OPTIONS = [
  { value: 'budget_draft', label: '预算草案(按基准与增长率生成新版本)' },
  { value: 'copy_budget', label: '复制预算版本(可跨年度与增长率)' },
  { value: 'bulk_adjustment', label: '批量调整预算明细' },
  { value: 'scenario', label: '情景测算(保守/基准/进取或自定义)' },
  { value: 'basis_text', label: '保存测算依据(AI 草稿)' },
  { value: 'export', label: '生成导出文件' },
];

export function NewActionModal({
  open,
  onClose,
  context,
  conversationId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  context: AssistantContext;
  conversationId?: number;
  onCreated: (action: AssistantAction) => void;
}) {
  const [form] = Form.useForm();
  const [type, setType] = useState<string>('budget_draft');
  const [busy, setBusy] = useState(false);
  const currentYear = context.year ?? new Date().getFullYear();

  const submit = async () => {
    const values = await form.validateFields();
    const rate = (value: unknown) => (value == null || value === '' ? 0 : Number(value) / 100);
    let params: Record<string, unknown> = {};
    if (type === 'budget_draft') {
      params = {
        year: values.year, name: values.name, baseFrom: values.baseFrom, baseYear: values.baseYear,
        growthRate: rate(values.growthRate), kind: values.kind,
        ...(values.baseFrom === 'actual_snapshot' ? { baseSnapshotId: values.baseSnapshotId } : {}),
        ...(values.note ? { note: values.note } : {}),
      };
    } else if (type === 'copy_budget') {
      params = { sourceVersionId: values.sourceVersionId, targetYear: values.targetYear, name: values.name, growthRate: rate(values.growthRate), ...(values.note ? { note: values.note } : {}) };
    } else if (type === 'scenario') {
      params = {
        preset: values.preset,
        ...(values.versionId ? { versionId: values.versionId } : {}),
        ...(values.incomeGrowth == null ? {} : { incomeGrowth: rate(values.incomeGrowth) }),
        ...(values.costGrowth == null ? {} : { costGrowth: rate(values.costGrowth) }),
        ...(values.expenseGrowth == null ? {} : { expenseGrowth: rate(values.expenseGrowth) }),
        ...(values.targetProfit ? { targetProfit: values.targetProfit } : {}),
      };
    } else if (type === 'basis_text') {
      params = { title: values.title, text: values.text };
    } else if (type === 'export') {
      params = { kind: values.exportKind, format: values.format, ...(values.exportKind === 'actual_current' ? { year: values.year } : { versionId: values.versionId }) };
    } else {
      let entries: unknown;
      try { entries = JSON.parse(values.entries); } catch { message.error('明细必须是合法 JSON 数组'); return; }
      if (!Array.isArray(entries)) { message.error('明细必须是 JSON 数组'); return; }
      params = { versionId: values.versionId, entries };
    }
    setBusy(true);
    try {
      const action = await assistantApi.preview({ type, params, conversationId, idempotencyKey: previewIdempotencyKey('ui', type, params, conversationId) });
      onCreated(action);
      message.success('预览已创建，确认后才会写入数据');
      onClose();
    } catch (err) {
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '创建预览失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} onOk={submit} okText="创建预览" confirmLoading={busy} width={640} title="新建助手操作">
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="所有写操作都会先返回预览，确认后才由后端业务事务执行；锁定/归档版本不会被修改。" />
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          year: currentYear, baseYear: currentYear - 1, targetYear: currentYear + 1, baseFrom: 'budget', kind: 'budget',
          name: `AI ${currentYear} 草案`, growthRate: 5, preset: 'baseline', format: 'xlsx', exportKind: 'completion',
          versionId: context.budgetVersionId, sourceVersionId: context.budgetVersionId, baseSnapshotId: context.actualSnapshotId,
          title: 'AI 草稿', entries: '[\n  { "orgId": 1, "accountId": 1, "amountWan": "1.00" }\n]',
        }}
      >
        <Form.Item label="操作类型">
          <Select value={type} onChange={setType} options={TYPE_OPTIONS} />
        </Form.Item>

        {type === 'budget_draft' && (
          <>
            <Form.Item name="year" label="目标年度" rules={[{ required: true }]}><InputNumber min={1900} max={9999} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="name" label="版本名称" rules={[{ required: true }]}><Input maxLength={200} /></Form.Item>
            <Form.Item name="kind" label="版本类型"><Select options={[{ value: 'budget', label: '预算' }, { value: 'forecast', label: '预测' }]} /></Form.Item>
            <Form.Item name="baseFrom" label="基准" rules={[{ required: true }]}>
              <Select options={[
                { value: 'budget', label: '历史预算(锁定版本优先)' },
                { value: 'actual', label: '当前实际' },
                { value: 'actual_snapshot', label: '指定历史快照' },
              ]} />
            </Form.Item>
            <Form.Item name="baseYear" label="基准年度" rules={[{ required: true }]}><InputNumber min={1900} max={9999} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="baseSnapshotId" label="基准快照 ID(基准为指定历史快照时必填)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="growthRate" label="整体增长率(%)"><InputNumber min={-100} max={1000} step={0.5} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="note" label="备注"><Input.TextArea rows={2} maxLength={2000} /></Form.Item>
          </>
        )}

        {type === 'copy_budget' && (
          <>
            <Form.Item name="sourceVersionId" label="源版本 ID(需为定稿/归档版本)" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="targetYear" label="目标年度" rules={[{ required: true }]}><InputNumber min={1900} max={9999} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="name" label="新版本名称" rules={[{ required: true }]}><Input maxLength={200} /></Form.Item>
            <Form.Item name="growthRate" label="整体增长率(%)"><InputNumber min={-100} max={1000} step={0.5} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="note" label="备注"><Input.TextArea rows={2} maxLength={2000} /></Form.Item>
          </>
        )}

        {type === 'scenario' && (
          <>
            <Form.Item name="preset" label="情景"><Select options={[{ value: 'conservative', label: '保守' }, { value: 'baseline', label: '基准' }, { value: 'aggressive', label: '进取' }]} /></Form.Item>
            <Form.Item name="versionId" label="预算版本 ID(用于取基准值)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="incomeGrowth" label="收入变化(%)"><InputNumber min={-100} max={1000} step={0.5} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="costGrowth" label="成本变化(%)"><InputNumber min={-100} max={1000} step={0.5} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="expenseGrowth" label="费用变化(%)"><InputNumber min={-100} max={1000} step={0.5} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="targetProfit" label="目标利润(元字符串,反推费用上限)"><Input placeholder="例如 1200000.00" /></Form.Item>
          </>
        )}

        {type === 'basis_text' && (
          <>
            <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input maxLength={200} /></Form.Item>
            <Form.Item name="text" label="依据文本(标记为 AI 草稿,不得编造合同/人数/价格)" rules={[{ required: true }]}>
              <Input.TextArea rows={6} maxLength={20000} />
            </Form.Item>
          </>
        )}

        {type === 'export' && (
          <>
            <Form.Item name="exportKind" label="导出内容"><Select options={[
              { value: 'completion', label: '完成情况(按版本)' },
              { value: 'budget_detail', label: '预算明细(按版本)' },
              { value: 'actual_current', label: '当前实际(按年度)' },
            ]} /></Form.Item>
            <Form.Item name="format" label="格式"><Select options={[{ value: 'xlsx', label: 'Excel(xlsx)' }, { value: 'csv', label: 'CSV' }]} /></Form.Item>
            <Form.Item name="versionId" label="预算版本 ID"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="year" label="年度(导出当前实际时使用)"><InputNumber min={1900} max={9999} style={{ width: '100%' }} /></Form.Item>
          </>
        )}

        {type === 'bulk_adjustment' && (
          <>
            <Form.Item name="versionId" label="预算版本 ID(草稿版本)" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="entries" label="明细 JSON(金额可用 amount 元 / amountCents 分 / amountWan 万元;数量科目只填 quantity)" rules={[{ required: true }]}>
              <Input.TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}
