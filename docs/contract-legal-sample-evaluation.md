# T-9 脱敏历史样本离线评估（2026-11-12）

执行：`backend/scripts/evaluate-contract-legal.ts --samples <受控脱敏文本目录> --output docs/contract-legal-sample-evaluation.md`，Node 24.22.1。输入为本地 8 份脱敏文本及已核对的制度/候选范本种子。脚本不打开业务数据库、不调用模型，仓库只保存汇总；受控文本不入 Git。

本次验证文本规则与已知修改点的可检出性，不代表 DOCX/OCR 解析准确率或生产法审效果。台账金额、主体、合同编号及当前项目审批材料不能从脱敏文本重建，对应检查不计入下列发现数。

| 样本 | 输入 SHA-256 前缀 | 字符数 | 文本规则发现数 | 候选条款差异数 | 规则代码（去重） |
|---|---|---:|---:|---:|---|
| 01 | 2074a86b2bec | 6866 | 9 | 42 | PLACEHOLDER_UNFILLED、OBSOLETE_LAW_BASIS、ESSENTIAL_CLAUSE_MISSING、SUBSTANTIVE_PERF_BEFORE_EFFECTIVE、AMOUNT_UNPARSEABLE、PAYMENT_RATIO_SUM_INVALID、TAX_INVOICE_UNCLEAR |
| 02 | fe03f184e568 | 3647 | 6 | 44 | PLACEHOLDER_UNFILLED、ESSENTIAL_CLAUSE_MISSING、SUBSTANTIVE_PERF_BEFORE_EFFECTIVE、TAX_INVOICE_UNCLEAR |
| 03 | 801dfc7b320f | 4778 | 6 | 40 | PLACEHOLDER_UNFILLED、ESSENTIAL_CLAUSE_MISSING、SUBSTANTIVE_PERF_BEFORE_EFFECTIVE、AMOUNT_UNPARSEABLE、TAX_INVOICE_UNCLEAR |
| 04 | fcfafa40b6dd | 9621 | 6 | 无适用范本 | PLACEHOLDER_UNFILLED、ESSENTIAL_CLAUSE_MISSING、SUBSTANTIVE_PERF_BEFORE_EFFECTIVE、PAYMENT_RATIO_SUM_INVALID |
| 05 | b75a8ba9ed02 | 9433 | 7 | 无适用范本 | PLACEHOLDER_UNFILLED、ESSENTIAL_CLAUSE_MISSING、SUBSTANTIVE_PERF_BEFORE_EFFECTIVE、AMOUNT_UNPARSEABLE、PAYMENT_RATIO_SUM_INVALID |
| 06 | 27c9f9e919fc | 50885 | 12 | 无适用范本 | PLACEHOLDER_UNFILLED、ESSENTIAL_CLAUSE_MISSING、SUBSTANTIVE_PERF_BEFORE_EFFECTIVE、AMOUNT_UNPARSEABLE、TAX_INVOICE_UNCLEAR |
| 07 | efb723ade3ad | 50983 | 12 | 无适用范本 | PLACEHOLDER_UNFILLED、ESSENTIAL_CLAUSE_MISSING、SUBSTANTIVE_PERF_BEFORE_EFFECTIVE、AMOUNT_UNPARSEABLE、TAX_INVOICE_UNCLEAR |
| 08 | 2ed12e36a7cb | 1616 | 11 | 无适用范本 | PLACEHOLDER_UNFILLED、ESSENTIAL_CLAUSE_MISSING、SUBSTANTIVE_PERF_BEFORE_EFFECTIVE、AMOUNT_UNPARSEABLE、TAX_INVOICE_UNCLEAR |

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
