import { useEffect, useState } from 'react';
import { Button, Select, Space, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { CONFIG_FIELD_HELP, type ConfigFormKind } from '@contracts/config-fields';
import { useAssistant } from '../../assistant/AssistantProvider';
import { useOptionalAssistantRegistry, useOptionalAssistantRegistryView } from '../../assistant/AssistantContextRegistry';
import { useAssistantFocus } from '../../assistant/contextHooks';

const FIELD_LABELS: Record<string, string> = { code: '编码', name: '名称', sortOrder: '排序', parentId: '上级节点', status: '状态', type: '科目类型', unit: '计量单位', quantityAgg: '数量汇总方式', budgetRequired: '预算必填', basisRequired: '测算依据', rootCodes: '表格根科目', collapsedCodes: '折叠科目', displayOrder: '显示顺序', kind: '指标类型', direction: '有利方向', displayFormat: '显示格式', displaySign: '展示符号', terms: '公式项', numerator: '分子', denominator: '分母', ruleType: '测算类型', sheetCode: '使用表格', config: '规则配置', quantityAccountCode: '数量科目', priceAccountCode: '单价科目', taxAccountCode: '税率科目', defaultTaxRate: '缺省税率', leftAccountCode: '乘数一', rightAccountCode: '乘数二', outputAccountCode: '输出科目', enabled: '启用', targetKind: '目标数据集', sheets: '工作表区域', columns: '列映射', valueKind: '金额或数量', amountUnit: '金额单位', signConvention: '符号口径', mappings: '名称映射', excludedRows: '排除行', headerRow: '表头行', dataStartRow: '数据开始行', dataEndRow: '数据结束行', clearBlankNotes: '空白备注覆盖', preferredSheetName: '优先工作表', mappingKind: '映射对象', sourceText: '来源名称', targetCode: '目标编码' };

/** 表单中显式字段帮助；hover 不更新焦点，不发送任何请求。 */
export function ConfigFormAssistant({ kind, form, onLocateField }: { kind: ConfigFormKind; form?: FormInstance; onLocateField?: (field: string) => void }) {
  const assistant = useAssistant();
  const registry = useOptionalAssistantRegistry();
  const view = useOptionalAssistantRegistryView();
  const [field, setField] = useState<string>();
  useEffect(() => setField(undefined), [kind, view?.draftInstanceId]);
  useAssistantFocus(field ? { kind: 'form_field', formKind: kind, field } : null);
  useEffect(() => {
    const locate = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: string; targetId: number | null; clientKey: string | null; field: string }>).detail;
      const snapshot = registry?.buildSnapshot();
      if (!detail || detail.kind !== kind || snapshot?.status !== 'ok') return;
      const draft = snapshot.pageContext.draft;
      if (!draft || draft.kind !== kind || (draft.base.id ?? null) !== detail.targetId || (draft.base.clientKey ?? null) !== detail.clientKey) return;
      if (!CONFIG_FIELD_HELP[kind][detail.field]) return;
      setField(detail.field);
      form?.scrollToField(detail.field, { focus: true });
      onLocateField?.(detail.field);
    };
    window.addEventListener('newfc:assistant-locate-field', locate);
    return () => window.removeEventListener('newfc:assistant-locate-field', locate);
  }, [registry, kind, form, onLocateField]);
  return <Space wrap style={{ marginBottom: 12 }}>
    <Typography.Text type="secondary">当前修改未保存</Typography.Text>
    <Button onClick={assistant.openDock}>检查当前修改</Button>
    <Select aria-label="字段帮助" placeholder="选择字段帮助" showSearch optionFilterProp="label" style={{ minWidth: 150 }} value={field} options={Object.keys(CONFIG_FIELD_HELP[kind]).map((key) => ({ value: key, label: FIELD_LABELS[key] ?? key }))} onChange={(key) => { setField(key); form?.scrollToField(key, { focus: true }); onLocateField?.(key); }} />
    <Button disabled={!field} onClick={assistant.openDock}>询问当前字段</Button>
  </Space>;
}

/** 已有表单只发送实际变更，新建只发送有值字段。 */
export function changedFields(current: Record<string, unknown>, baseline?: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => value !== undefined && (!baseline || JSON.stringify(value) !== JSON.stringify(baseline[key]))));
}
