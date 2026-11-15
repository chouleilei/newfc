/** Explicit offline assessment; no business database, model call or runtime import of private sources. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { legalRules } from '../src/modules/contracts/legal-rules';
import { templateDiff } from '../src/modules/contracts/template-diff';
import type { ContractRow } from '../src/modules/contracts/contract.service';
import type { ParsedDocument } from '../src/modules/contracts/document-parser';
import {
  policyPublishRequest,
  templatePublishRequest,
  type PolicyDto,
  type TemplateDto,
} from '../src/contracts/contract-legal-review';
import { runPairedEvaluationCli } from './evaluate-contract-legal-pairs';
if (process.argv.includes('--paired-manifest')) {
  runPairedEvaluationCli('--paired-manifest');
} else {
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`必须显式传入 ${name}`);
  return path.resolve(process.argv[i + 1]);
};
const samples = arg('--samples'),
  output = arg('--output');
const seed = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../deploy/contract-legal-seed-v1.json'),
    'utf8',
  ),
);
let clauseId = 0;
const policies: PolicyDto[] = seed.policies.map((x: unknown, i: number) => {
  const p = policyPublishRequest.parse(x);
  return {
    ...p,
    id: i + 1,
    status: 'active',
    sourceFileObjectId: null,
    clauses: p.clauses.map((c) => ({ ...c, id: ++clauseId })),
  };
});
const templates: TemplateDto[] = seed.templates.map((x: unknown, i: number) => {
  const t = templatePublishRequest.parse(x);
  return {
    ...t,
    id: i + 1,
    sourceFileObjectId: null,
    clauses: t.clauses.map((c) => ({ ...c, id: ++clauseId })),
  };
});
const parsed = (raw: string): ParsedDocument => {
  const text = raw
    .replace(/[\u0000-\u0008]/g, ' ')
    .split('\n')
    .slice(2)
    .join('\n');
  let heading = '';
  const paragraphs = text
    .split('\n')
    .filter((t) => t.trim())
    .map((text, i) => {
      heading =
        text.match(
          /^(第.+?[条章]|[一二三四五六七八九十]+、|\d+(?:\.\d+)+)/,
        )?.[0] ?? heading;
      return { index: i + 1, heading, page: 1, text: text.trim() };
    });
  return {
    text,
    paragraphs,
    channel: 'docx_native',
    status: 'ok',
    findings: [],
    stats: { offlineText: true },
  };
};
const rows: string[] = [];
const documents: ParsedDocument[] = [];
const contextCodes = new Set([
  'PARTY_SUPPLIER_MISMATCH',
  'CONTRACT_NO_FORMAT',
  'PROCUREMENT_TIER_EVIDENCE_MISSING',
  'IMPORTANT_CONTRACT_GATE',
  'AMOUNT_UPPER_LOWER_MISMATCH',
  'SMALL_DIRECT_REIMBURSE_HINT',
]);
for (const file of fs
  .readdirSync(samples)
  .filter((f) => /^0[1-8]_.*\.txt$/.test(f))
  .sort()) {
  const n = Number(file.slice(0, 2)),
    content = fs.readFileSync(path.join(samples, file), 'utf8'),
    p = parsed(content);
  documents[n] = p;
  const category =
    n === 1
      ? 'goods_procurement'
      : n === 2
        ? 'small_construction'
        : n === 3
          ? 'tech_service'
          : n < 6
            ? 'general_service'
            : 'other';
  const c = {
    contract_no: '已脱敏',
    name: '离线样本',
    original_cents: 0n,
    approved_change_cents: 0n,
    legal_category: category,
    party_role: 'buyer',
    is_procurement: n < 6 ? 1 : 0,
    procurement_target:
      n === 1 ? 'goods' : n === 2 ? 'construction' : 'service',
    procurement_method: 'inquiry',
    is_important: 0,
    sign_date: null,
    effective_date: null,
  } as ContractRow;
  const findings = legalRules({
    c,
    parsed: p,
    evidence: [],
    policies,
    orgName: '',
    supplierName: null,
  }).findings.filter((f) => !contextCodes.has(f.code));
  const codes = [...new Set(findings.map((f) => f.code))];
  const diff =
    n <= 3
      ? templateDiff(p, templates[n - 1]).filter(
          (f) => f.code !== 'TEMPLATE_CANDIDATE_UNCONFIRMED',
        ).length
      : null;
  rows.push(
    `| ${String(n).padStart(2, '0')} | ${crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)} | ${p.text.length} | ${findings.length} | ${diff ?? '无适用范本'} | ${codes.join('、')} |`,
  );
}
if (documents.filter(Boolean).length !== 8)
  throw new Error('必须包含 01～08 八份脱敏文本');
const lawyerClauses = [
  '因移交路段养护、管理工作不到位，给我方公司造成损失的，我方公司有权要求【相对方单位】进行赔偿。',
  '后续移交路段的养护管理工作及修缮费用均由【相对方单位】承担，与我方公司无关。',
  '均具有同等法律效力。',
];
const paired: TemplateDto = {
  id: 999,
  code: 'OFFLINE-LAWYER-REFERENCE',
  version: 1,
  name: '律师修改点对照（仅离线）',
  legalCategory: 'other',
  approvalStatus: 'candidate',
  notes: '对照律师增补文本，不作为正式范本或业务规则发布',
  sourceFileObjectId: null,
  clauses: lawyerClauses.map((text, i) => ({
    id: 10000 + i,
    clauseKey: `lawyer-${i + 1}`,
    clauseNo: `修改点${i + 1}`,
    title: ['养护不当赔偿', '后续养护修缮承担', '各份同等效力'][i],
    tier: 'fixed',
    standardText: text,
    defaultValueNote: '',
    placeholderKeys: [],
  })),
};
const signals = [6, 7, 8].map((n) =>
  templateDiff(documents[n], paired)
    .filter((f) => f.code === 'TEMPLATE_FIXED_DEVIATION')
    .map((f) => f.templateClauseId),
);
if (
  signals[0].length !== 3 ||
  signals[1].length !== 0 ||
  signals[2].length !== 1
)
  throw new Error(`律师链差异结果变化，请复核：${JSON.stringify(signals)}`);
const report = `# T-9 脱敏历史样本离线评估（2026-11-12）

执行：\`backend/scripts/evaluate-contract-legal.ts --samples <受控脱敏文本目录> --output docs/contract-legal-sample-evaluation.md\`，Node 24.22.1。输入为本地 8 份脱敏文本及已核对的制度/候选范本种子。脚本不打开业务数据库、不调用模型，仓库只保存汇总；受控文本不入 Git。

本次验证文本规则与已知修改点的可检出性，不代表 DOCX/OCR 解析准确率或生产法审效果。台账金额、主体、合同编号及当前项目审批材料不能从脱敏文本重建，对应检查不计入下列发现数。

| 样本 | 输入 SHA-256 前缀 | 字符数 | 文本规则发现数 | 候选条款差异数 | 规则代码（去重） |
|---|---|---:|---:|---:|---|
${rows.join('\n')}

01/02/03 分别为采购、施工、技术服务；04/05 为运维原版/内部修改版；06/07/08 为公路移交原始版/律师修改版/终版。

## 公路移交协议配对链

以律师新增的 3 项措辞建立仅离线使用的候选对照（不发布到系统规则库）：养护不当导致损失的赔偿责任、后续养护修缮费用承担、各份协议同等法律效力。

| 版本 | 缺少的已知修改点 | 解释 |
|---|---|---|
| 06 原始版 | 3/3 | 三项增补均可由条款比对检出，这是文本变化检出而非法律风险召回率 |
| 07 律师版 | 0/3 | 三项增补均匹配，无该组三项差异误报 |
| 08 终版 | 1/3 | 保留后续费用与同等效力，删除养护不当赔偿句；需业务说明取舍，不能直接认定终版违法或漏改 |

终版另明确总价和付款、票据条件。它属于非采购行政移交协议，没有唯一适用的正式范本，应走通用检查与人工审查，不能套用采购范本后给出通过。

## 命中、误报与建议可采纳边界

- 2021 文本中的《合同法》引用被检出，适用于当前重新起草时提示更新；不能反推 2021 签署当时违法。
- 脱敏替换使用的【主体/项目/账号】会触发占位符规则，这是夹具引入的人工痕迹，不能计为真实未填写项或用来计算精确率。
- 原合同章节、主体别名与清理稿不同，简单锚点和全文匹配产生较多候选差异。候选差异仅供人工对照；没有正式法审意见的条目不能标为真实命中或漏检。
- 公路协议的接管方/移交方、非增值税票据、已有行政批准背景与一般采购条款不同。通用主体、价款和税票检查可能提示无法识别或不适用，需人工核验，不能直接当成应修改的法律结论。
- 律师链三项措辞检出为 3/3、0/3、1/3，只证明该链的文字变化可追踪。各份同等效力可用于文本核对；责任和资金承担仍须法律顾问结合事实判断，终版删除条款的可采纳性尚未确认。

## 验收结论

AC-CLR-09 **已完成首批离线评估，尚未达到完整业务验收条件**。缺口为采购、施工、服务各类型与正式法审意见的一一配对、多样本逐条标注及业务复核人对建议可采纳性的确认；尚不能给出总体漏检率、误报率或准确率。三份初始范本保持 candidate，离线律师对照不转为正式红线。自动化工程验收见 [验收记录](acceptance-records.md)。
`;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, report);
console.log(`已评估 8 份脱敏文本；律师链差异 3/0/1；报告 ${output}`);

}
