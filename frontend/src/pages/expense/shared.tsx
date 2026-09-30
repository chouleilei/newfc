import { Tag } from 'antd';
import type { EvidenceRef } from '../../api/projectContract';

/** T-4 费用审核页面公用标签(契约的中文标签是值,前端只能以类型导入契约,故在此维护一份)。 */

export const CLAIM_STATUS = {
  draft: { text: '草稿', color: 'default' }, submitted: { text: '审核中', color: 'processing' }, audited: { text: '待复核', color: 'warning' },
  reviewed: { text: '已复核', color: 'success' }, supplement: { text: '退回补件', color: 'error' },
};
export const SEVERITY = {
  info: { text: '提示', color: 'default' }, low: { text: '低', color: 'blue' }, medium: { text: '中', color: 'orange' }, high: { text: '高', color: 'red' },
};
export const RISK = { low: { text: '低风险', color: 'green' }, medium: { text: '中风险', color: 'orange' }, high: { text: '高风险', color: 'red' } };
export const SOURCE_LABEL: Record<string, string> = { rule: '规则', ocr: 'OCR', model: '模型' };
export const CONCLUSION_LABEL: Record<string, string> = { pass: '通过', reject: '驳回', supplement_required: '退回补件' };
export const DISPOSITION_LABEL: Record<string, string> = { confirmed: '确认问题', dismissed: '排除', missing_material: '缺失材料' };
export const OCR_STATUS: Record<string, string> = { ok: 'OCR 完成', unavailable: 'OCR 未配置', failed: 'OCR 失败', not_needed: '无需 OCR' };
export const MODEL_STATUS: Record<string, string> = { ok: '模型完成', unavailable: '模型未配置', invalid: '模型输出无效', failed: '模型调用失败' };

const EVIDENCE_KIND: Record<EvidenceRef['kind'], string> = { field: '字段', line: '明细', attachment: '附件', ocr: 'OCR', clause: '条款' };
export function EvidenceTags({ evidence }: { evidence: EvidenceRef[] }) {
  return (
    <>
      {evidence.map((e, i) => (
        <Tag key={i} title={e.text}>{EVIDENCE_KIND[e.kind]}:{e.ref}{e.text ? ` · ${e.text.length > 30 ? `${e.text.slice(0, 30)}…` : e.text}` : ''}</Tag>
      ))}
    </>
  );
}
