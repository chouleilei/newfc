# 金额与定点数契约（OPEN-02）

适用范围：newfc 新增领域（EAS 原始事实、治理、财报、管理会计、项目/合同/费用、投资、预测）及其 API。经营预算/实际/分析模块保持 `core/money.ts`（number 安全整数）不变，两者交界显式转换。

| 类型 | 存储 | 计算 | API | 舍入 |
|---|---|---|---|---|
| 金额 money | `INTEGER` 整数分，列名以 `_cents` 结尾 | `bigint`（`core/decimal.ts`），64 位溢出检查 | 两位小数十进制字符串，如 `"-1234.50"`；同时给出币种/单位字段（默认 `CNY`/元） | 输入默认拒绝超两位小数；乘除/分摊在明确步骤 `half-up` |
| 数量 quantity | `INTEGER` 缩放值，scale 在字段定义中声明（继承科目数量 scale=4） | 缩放 `bigint` | 去尾零十进制字符串 | 同上 |
| 单价 price | `INTEGER`，分的 4 位小数（scale=4 over cents） | `mulCents` 回到分 | 十进制字符串 | 回到分时 `half-up` |
| 比率 ratio | 不持久化或以 scale=6 缩放整数 | `ratioScaled` | 0～1 口径字符串，固定 6 位小数（`"0.123456"`、`"0.420000"`），不是百分数；分母为零为 `null` | `half-up`，6 位 |

规则：

1. **范围**：金额为 SQLite 有符号 64 位整数分，即 ±92,233,720,368,547,758.07 元；兼容导入的 `Numeric(18,2)` 最大值 9,999,999,999,999,999.99 元可精确表示。超出返回业务码 `VALUE_OUT_OF_RANGE`（400）。
2. **读取**：可能超过 2^53 分（约 90 万亿元）的列，查询语句必须 `.safeIntegers(true)`。实测 better-sqlite3 默认模式会**静默**转为不精确 number（`tests/decimal-contract.test.ts` 固定了这一行为）。
3. **序列化**：`bigint` 不能 `JSON.stringify`，也不得用 `Number()` 绕过；API 统一经 `centsToDecimalString`。
4. **缺失与零**：缺失为 `null`（`centsToDecimalOrNull`），零为 `"0.00"`；汇总时缺失不当零报告“完整”。
5. **分摊守恒**：`allocateCents` 用最大余数法，各份之和严格等于总额；基数合计为零报 `ALLOCATION_BASIS_EMPTY`（422），由领域规则决定缺省口径。
6. **交界**：新领域金额进入继承 number 路径前用 `centsToSafeNumber`，超安全整数时报错；继承的 number 金额进入新领域用 `toCentsBig`。
7. **模型上下文**：AI 工具返回的金额同样是十进制字符串，模型不得自行做金额计算后作为事实返回（见 specs/ai.md）。
8. 前端显示换算（万元、千分位、百分数）只改展示，不回写原值。

各领域落地时在对应迁移注释和领域文档中声明字段 scale，并在测试中覆盖边界。
