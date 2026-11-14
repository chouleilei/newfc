import JSZip from 'jszip';
import type { ParsedDocument } from '../src/modules/contracts/document-parser';
export const GOOD_TEXT = [
  '设备物资采购合同',
  '合同编号：LS-SG-001/2026-001',
  '甲方：上海公司',
  '乙方：测试供货公司',
  '根据《中华人民共和国民法典》订立合同。',
  '第一条 供货内容',
  '乙方负责水泵设备供货，数量一台，规格详见技术附件。',
  '第二条 合同价格',
  '本合同含税总价为人民币壹拾万元整（¥100000.00元），增值税税率为13%。',
  '第三条 支付与发票',
  '到货款：货物验收合格并提供增值税专用发票后支付合同总价的95%。',
  '质保金：质保期满后支付合同总价的5%。',
  '第四条 交付及验收',
  '交付日期：2026年12月01日；验收日期：2026年12月02日。按技术附件验收。',
  '质保期三年。',
  '第五条 违约责任',
  '违约方赔偿实际损失。不得将主体义务转包或违法分包。',
  '第六条 争议解决',
  '争议由长沙市人民法院管辖并依法起诉。',
  '第七条 解除与生效',
  '严重违约时可以解除合同，解除后应结算、返还并完成善后。',
  '在合同未签署或者未生效之前，不得实质履行。',
  '第八条 签署',
  '双方盖章签字后生效。签署日期：2026年11月20日。',
].join('\n');
export async function docx(text = GOOD_TEXT, extra = '') {
  const z = new JSZip();
  z.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text
      .split('\n')
      .map(
        (s) =>
          `<w:p><w:r><w:t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`,
      )
      .join('')}${extra}</w:body></w:document>`,
  );
  return z.generateAsync({ type: 'nodebuffer' });
}
export const parsed = (text = GOOD_TEXT): ParsedDocument => ({
  text,
  paragraphs: text
    .split('\n')
    .map((text, i) => ({ index: i + 1, heading: '', page: 1, text })),
  channel: 'docx_native',
  status: 'ok',
  findings: [],
  stats: {},
});
