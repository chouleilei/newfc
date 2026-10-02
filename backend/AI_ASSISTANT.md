> newfc 现行助手接口与实现参考。继承章节中的版本号是来源历史，需求与权限契约以 specs/ai.md 为准。

# AI 助手后端交接

助手路由挂载在 `/api/assistant`，与其余 API 共用服务端会话 Cookie 与 POST 的 CSRF 校验。未配置模型时仍可使用事实查询、确定性分析和全部预览/确认流程；模型适配器负责意图路由与组织文字。

## 配置

可选环境变量：

- `AI_PROVIDER`：供应商标识（当前使用 OpenAI-compatible 协议）。
- `AI_MODEL`：模型名，默认 `gpt-4o-mini`。启用模型路由需要支持 function calling。
- `AI_BASE_URL`：兼容接口根地址，也可直接填写 `/chat/completions` 地址。**只有配置了它才启用模型**。
- `AI_API_KEY`：Bearer 密钥；本地兼容服务可省略。
- `AI_TIMEOUT_MS`：模型请求超时，10–120000 毫秒，默认 15000。
- `AI_STREAM`：是否使用流式响应，默认 `1`；设为 `0` 退回一次性响应。
- `AI_ACTION_TTL_MS`：预览 action 有效期，10 毫秒–24 小时，默认 15 分钟。
- `AI_RATE_LIMIT_PER_MIN`：助手接口每分钟请求上限（1–1000，默认 30），按「登录用户 + 来源 IP」计数。
  超限返回 `429 AI_RATE_LIMITED` 并带 `retryAfterSeconds`。只作用于消耗模型或做重计算的入口
  （`/chat`、`/chat/stream`、`/preview`、`/attribution`、`/report`、`/import-help`），纯列表查询不限流。

也兼容 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`。接口异常、超时或非法 JSON 会自动降级为模板回答，后端事实不会丢失。

## 意图路由与上下文解析

`/chat` 的处理顺序是「先解析上下文 → 再路由取数 → 最后组织文字」：

1. **上下文解析**（`assistant/message-context.ts`）：从自然语言里解析年度（含「去年/今年/明年」）、组织与科目（名称最长优先匹配，编码要求两侧无字母数字）、版本名或版本编号、实际快照（快照编号、`YYYY-MM-DD`、「截至 6 月」、「最新快照」）以及导入批次。页面快照请求的总体优先级为 **本轮问题明确范围 > 已核验页面范围 > 上一轮会话仅补空 > 数据库默认值**。需要版本才能计算的意图在缺少版本时回退到该年度**当前生效版本**（无当前生效版本时取最新定稿，再取最新版本）；纯列表类问题不会被悄悄缩小范围。
   - 只读提问额外开启 `yearOverride`：句子里**明确写出**的年度（带「年」后缀或「去年/今年」等相对词）会覆盖页面/请求年度，并在 `contextTrace.used` 与 `contextTrace.overrides` 里说明。裸四位数信号太弱不参与年度覆盖；**写操作请求一律关闭覆盖**，因为那里的年份通常是操作目标年度。
   - 跨年版本：明确点名另一年度版本时同步切换年度，并清除不兼容的对比版本和实际快照。
   - 跨年快照：「截至 6 月」等裸月份只在当前活动年度内匹配；完整日期、快照编号和「最新快照/最近快照/最新实际」等强信号允许跨年。跨年命中快照后，年度、快照和同年度预算基线原子切换；没有同年基线时清除冲突版本。
   - 请求自身的年度与预算版本、目标版本或实际快照矛盾时返回 `CONTEXT_CONFLICT`（409），不把混年上下文交给业务工具。
   - 前端助手页刻意**不预填年度**：缺省年度由后端解析并在「口径」里如实标注。
2. **意图识别**（`assistant/intent.ts`）：关键词路由，覆盖「超支 / 亏得最多 / 拖后腿 / 进度太慢 / 排名」等口语说法，并按语义蕴含去重——命中报告生成时不再单独跑执行分析、差异归因、异常、质量和趋势；命中差异归因时不再单独跑执行分析，同一份 `completionReport` 不会被算两遍。v0.2.4 新增 8 个目录类读意图（编制进度、结构分析、指标目录、洞察记录、主数据体检、一致性检查、测算模板、清洗配置）；其中「洞察报告」做双向消歧——默认把「报告」当作已保存记录的同义词、抑制现场组稿，带「写一份/生成一份」这类组稿语气时反过来抑制洞察列表，创建诉求优先。
   - **纯追问沿用上一轮意图**（`withInheritedIntents`）：本轮既没有只读意图也没有写意图，且消息带追问标记（「那…」「…呢」「第二名」「再往下拆」「继续」「刚才那个」等）或从消息里解析出了新的组织/科目范围时，沿用上一轮的只读意图。`report` 继承时改写成 `attribution`（追问通常想看某一块细节，不必重组整份报告）。沿用结果写在响应的 `intents.inheritedRead`，界面显示「追问·沿用差异归因」。没有追问标记的新话题（如「你好」）不继承。
3. **模型路由优先**：模型可用时取得范围元数据（ID/名称/状态）及服务端生成的有界草稿、字段和选区事实；其中金额来自同源只读计算，原始表单、文件令牌和备注不进入上游。模型调用只读工具取数，最多 4 轮；活动选择仅开放能执行该范围的工具。模型一次工具都没调用时，用关键词兜底查出事实，再让模型基于这些事实作答。模型不可用、超时或异常时直接走关键词兜底 + 确定性摘要。
   - 模型两轮都没产出正文（空响应）时，`routing` 标为 `rules` 且 `modelError` 写明「模型未返回可用内容」，**不会**标成 `model` 却给出模板文案。上游返回的响应既不是 SSE 流也不是合法 completion JSON 时同样显式报错降级。

响应里的 `routing` 字段标明本轮是 `model`（模型自主调用工具）还是 `rules`（关键词兜底）；`model` 是本轮实际生效的模型名（`template` 表示模型不可用、答案来自确定性模板）；`contextTrace.used` 逐项给出上下文的来源（`request` / `message` / `conversation` / `default`）与命中依据，`effectiveContext` 是后端最终使用的上下文，前端可据此回填筛选器，下一轮也会继承它。

## 查询与引用

聊天与 SSE 只接受 `{ conversationId?, message, pageContext }`；独立助手也提供 schemaVersion 为 2 的快照，其 scope 可以为空。共享发送/响应类型位于 `src/contracts/assistant.ts`；页面目录在 `contracts/page-catalog.ts`，工具的 schema、运行校验、能力、权限、选择模式与执行来自唯一 `TOOL_REGISTRY`。

```json
{
  "message": "解释当前范围",
  "pageContext": {
    "schemaVersion": 2,
    "snapshotId": "example-snapshot",
    "routeInstanceId": "example-route",
    "contextVersion": 1,
    "pageKey": "analysis",
    "scope": { "year": 2026, "budgetVersionId": 3 },
    "view": { "sheetKey": "all" },
    "surfaces": [],
    "focus": null,
    "selection": null,
    "draft": null
  }
}
```

`assistant/page-context.ts` 在模型、会话写入和 SSE 响应头之前校验页面/字段白名单、实际 UTF-8 大小、权限、对象/树关系及草稿基线。旧顶层 context、双传、缺快照、未知页面返回 CONTEXT_INVALID；未知版本返回 CONTEXT_PROTOCOL_UNSUPPORTED，前端保留问题并提示刷新。普通上下文最多 64 KiB、草稿最多 5 MiB/10,000 项变更。

范围优先级为问题明确范围 > 已核验页面范围 > 上轮仅补空 > 合法默认值；页面内为最上层浮层 > 明确焦点 > 页面 scope。活动选择或草稿与问题明确范围冲突时拒绝，不能用旧对象回答新范围。响应只返回一份 effectiveContext 与 contextTrace。

六类配置草稿通过实际弹窗/清洗向导的“检查当前修改”进入：组织、科目、指标、测算模板、清洗模板与别名；字段帮助按服务端白名单提供说明及定位。base.operation 必填，新建用 clientKey，已有对象用 id + updatedAt，changes 为真实 patch。草稿与正式保存共用领域 validator；正式保存在短事务中再次检查。文件分析校验当前用户上传或待确认批次、真实指纹/目标/有效期，不写业务记录、树快照或导入批次，也不续期助手读取的暂存文件。

选区工具的服务端约束不能被模型参数覆盖：预算/实际 bounds 限定组织叶子×科目叶子及工作表，父子去重；指标/别名 refs 校验全部 ID；query 复用页面同源 search/kind/status 或 search/targetKind/mappingKind，包含分页外全部匹配。单次处理最多500个对象/单元格，详情最多30并标明省略；超限要求缩小范围。不支持的工具、历史补录/多年实际视图以及归因/报告/导入辅助上的活动选择或草稿明确返回 CAPABILITY_UNAVAILABLE。

后端先生成 draft_validation、draft_impact、field_help、selection_analysis 可信事实，模型与无模型/失败/流式路径均展示未保存、校验、实际范围和不可计算原因。原始 changes、文件令牌/内容、备注不进入模型、会话或日志；模型仅收到领域生成的有界摘要。

响应含 text、facts、citations、suggestions、action、navigation、routing、model、intents、modelError、contextStatus、effectiveContext、contextTrace，并按实际分析返回 capability/draftApplied/metrics。新增金额事实使用十进制字符串，数量独立且显示单位。旧历史由 V66 一次迁移保留正文/事实/引用并规范化范围；未知范围不续用，历史追问重新检查现时权限。

OpenAPI 中 x-page-capabilities 与 x-readonly-tools 是从源目录生成的文档快照；更新目录后运行 `node -r ts-node/register/transpile-only scripts/update-assistant-catalog.ts`。规范行为仍以 specs/ai.md 为准，验收与发布状态见 docs/acceptance-records.md。

## 多轮追问

会话历史回灌给模型时，助手消息不仅带正文，还附上一轮的**结构化事实有界摘要**（归因保留 totals 与前 5 名排行榜，执行分析保留版本、截至日期与指标，异常保留计数与前 5 条，报告保留章节要点），因此「那第二名呢」「再往下拆一层」这类追问能接上。同时上一轮的 `effectiveContext` 会作为本轮的继承上下文，用户不必每轮重复指定年度和版本。

模板降级模式下没有模型来读历史，因此追问还要靠**意图继承**：本轮一个意图都没命中且判定为追问时，沿用上一轮的 `intents.read`（见上文第 2 步），否则「那第二名呢」只会退化成一份版本列表。模型可用时同样会在路由提示词里注明「本轮是追问」，要求模型延续上一轮的口径与范围。


## 只读分析接口(差异归因 / 报告生成 / 导入辅助)

三个接口都不写业务数据，用 POST 只是为了传结构化参数；模型不可用时结果不变。

```text
POST /api/assistant/attribution
POST /api/assistant/report
POST /api/assistant/import-help
```

### 差异归因

```json
{
  "versionId": 3,
  "batchId": 18,
  "orgScopeId": 7,
  "accountScopeId": 21,
  "sheetKey": "profit",
  "maxDepth": 3,
  "topN": 10,
  "direction": "unfavorable",
  "pageContext": {
    "schemaVersion": 2,
    "snapshotId": "example-snapshot",
    "routeInstanceId": "example-route",
    "contextVersion": 1,
    "pageKey": "assistant",
    "scope": {
      "budgetVersionId": 3,
      "orgScopeId": 7,
      "accountScopeId": 21,
      "actualSnapshotId": 18
    }
  }
}
```

- `maxDepth` 1–10（默认 3）、`topN` 1–100（默认 10）、`direction` 为 `favorable` / `unfavorable` / `all`（默认 `all`，只作用于叶子排行榜）。
- 返回 `byOrg` / `byAccount` 两棵逐层展开树。每个节点带 `budgetCents`、`actualCents`、`varianceCents`（带符号利润方向）、`favorable`、`rate`、`shareOfParent`、`shareOfTotal`、`childrenVarianceCents`、`reconciled`、`hiddenChildCount`、`hiddenVarianceCents`，因此“展示的 + 隐藏的 = 父节点差异”始终可核对。
- `rankedOrgLeaves` / `rankedAccountLeaves` 是按方向筛选后再按 `|差异|` 降序的叶子贡献榜，带 `path` 便于定位。
- `quantityVariances` 单独输出数量型科目差异（`10^4` 缩放整数），不参与金额归因。
- `reconciliation` 给出组织维度与科目维度的根层/叶子合计以及 `matched`、`unreconciledNodeCount`；正常情况下两维度完全相等且 `unreconciledNodeCount = 0`。

### 报告生成

```json
{
  "kind": "monthly_execution",
  "versionId": 3,
  "year": 2026,
  "batchId": 18,
  "targetVersionId": 4,
  "topN": 5,
  "pageContext": {
    "schemaVersion": 2,
    "snapshotId": "example-snapshot",
    "routeInstanceId": "example-route",
    "contextVersion": 1,
    "pageKey": "assistant",
    "scope": {
      "budgetVersionId": 3,
      "year": 2026,
      "targetVersionId": 4,
      "actualSnapshotId": 18
    }
  }
}
```

- `kind` 为 `monthly_execution`（执行月报，需 `versionId`）、`annual_review`（年度复盘，需 `year`）、`budget_discussion`（预算讨论材料，需 `versionId`，可选 `targetVersionId` 做版本对比）；接受 `monthly`、`月报`、`annual-review`、`讨论材料` 等别名。
- 返回 `sections[]`（`key`、`title`、`bullets`、`data`、`citations`）、`facts`、`citations`、`narrative`（Markdown 成稿）、`narrativeSource`（`template` / `model`）、`model`、`suggestions`、`notes`。
- 章节：月报 = 总体执行 / 指标 / 差异归因 / 数量科目 / 异常与质量 / 年内趋势；年度复盘 = 年度结果 / 预算准确率 / 历年对比 / 主要差异归因；讨论材料 = 版本概况 / 预算结构 / 质量与合规 / 与对比版本差异 / 待讨论议题。
- 叙述里的金额按万元两位小数（百元精度）确定性格式化，原值仍是整数分。模型可用时只改写行文，数字、编码、日期与引用不变；模型失败、超时或返回空文本时保留模板叙述并把 `narrativeSource` 记为 `template`。
- 年度未关闭时不编造准确率与历年对比，相关章节如实降级并给出原因。

### 导入辅助

```json
{
  "batchId": 12,
  "errors": [
    {
      "row": 3,
      "field": "orgCode",
      "message": "组织编码不存在: SH1"
    }
  ],
  "suggestionLimit": 3,
  "pageContext": {
    "schemaVersion": 2,
    "snapshotId": "example-snapshot",
    "routeInstanceId": "example-route",
    "contextVersion": 1,
    "pageKey": "assistant",
    "scope": {
      "importBatchId": 12
    }
  }
}
```

- `batchId` 与 `errors` 至少提供一个：`batchId` 读取已持久化批次的 `summary`/`result` 中记录的错误，`errors` 直接接收上传失败时 `IMPORT_VALIDATION_FAILED` 返回的数组。
- `groups[]` 按固化规则分类（`ORG_CODE_UNKNOWN`、`ACCOUNT_CODE_UNKNOWN`、`ORG_NOT_LEAF`、`ACCOUNT_NOT_LEAF`、`DUPLICATE_ROW`、`AMOUNT_FORMAT`、`QUANTITY_FORMAT`、`AMOUNT_OR_QUANTITY_REQUIRED`、`REQUIRED_MISSING`、`DATE_FORMAT`、`DATE_ORDER`、`YEAR_FROZEN`、`YEAR_FORMAT`、`SCOPE_MISMATCH`、`HEADER_UNRECOGNIZED`、`FILE_LEVEL`、`OTHER`），每组含 `label`、`explanation`（含义）、`fix`（处理建议）、`count`、`rows`、`samples`。
- `unmatched.org` / `unmatched.account` 列出未匹配编码及候选建议；候选来自当前组织树/科目树，按整数编辑距离与前缀/包含/名称命中打分（`score` 0–1，`reason` 说明依据，`isLeaf` 标明能否填报），只保留 `score ≥ 0.4` 的前 `suggestionLimit`（1–20，默认 3）条。候选一定是库中真实存在的编码，不会凭空生成。
- `duplicates[]` 给出重复行及解析出的 `firstRow`；`nextSteps[]` 是按严重度排出的处理顺序。

## 预览、确认、取消

所有写入都走：

```text
POST /api/assistant/preview
POST /api/assistant/actions/:id/confirm  {"confirmationToken":"..."}
POST /api/assistant/actions/:id/cancel
```

支持 action：`budget_draft`、`copy_budget`、`bulk_adjustment`、`scenario`、`basis_text`、`export`；类型前缀 `preview_` 也接受。预览令牌有效期 15 分钟，重复 `idempotencyKey`（也可放在 `Idempotency-Key` 请求头）返回原 action。action 状态只按以下方向转换：

```text
pending -> confirmed
pending -> cancelled
pending -> expired
```

确认前会重新检查预览基线、版本状态、绑定树快照、叶子节点、金额/数量范围和幂等状态。任何一行失败都会使业务事务整体回滚；锁定/归档版本不会被助手修改；重复确认不会重复写入。预览基线变化时返回 `CONFLICT`，需重新预览。

### 写操作参数怎么来

`/chat` 响应里的 `action` 是**建议**，不是已执行的操作：

```json
{
  "type": "copy_budget",
  "params": {
    "sourceVersionId": 3,
    "targetYear": 2027,
    "name": "2027 草案",
    "growthRate": 0.05
  },
  "source": "model",
  "previewable": true,
  "reason": "用户要求复制 V2 到 2027 并整体增长 5%"
}
```

- `source=model`：模型按《写操作参数抽取提示词》把自然语言转成参数。模型只能输出白名单字段（每种 action 的字段清单固化在 `PROPOSAL_FIELDS`），不能输出 `bulk_adjustment`（逐格金额必须由用户在表格里给出）。
- `source=rules`：模型不可用或抽参失败时的关键词兜底。基准来源（预算/当前实际/指定快照）、基准年度、目标年度、版本名、导出类型与格式、情景预设与分类增长率都从消息解析，解析不出来才用保守默认值。
- `previewable`：参数已用 `normalizePreview` 做过一次**只读干跑**，确认可以构造出预览。为 `false` 时附 `validationMessage` 说明缺什么，前端引导用户手动补全。

无论哪种来源，落库仍必须走 `POST /assistant/preview` 生成 pending 预览、再由用户携带确认令牌调用 confirm。模型没有任何写工具。

### 预算草案

`params` 示例：

```json
{
  "year": 2027,
  "name": "2027 AI 草案",
  "baseFrom": "budget",
  "baseYear": 2026,
  "growthRate": 0.05
}
```

`baseFrom` 可为 `budget`、`actual` 或 `actual_snapshot`（后者需 `baseSnapshotId`）。预览返回每个适用叶子组织×叶子科目的来源值、建议值、变化额、变化率、来源和原因；零来源组合标记 `hasSource=false`，确认不会把空值伪造成已填报。

### 复制与批量调整

`copy_budget` 支持 `sourceVersionId`、`targetYear`、`name`、`note`、`growthRate`，复制沿用源版本绑定树快照。`bulk_adjustment` 的金额输入可用界面元字符串 `amount`、存储分整数 `amountCents` 或万元 `amountWan`；数量科目只能填 `quantity`，不会进入金额汇总。

### 情景、依据和导出

情景支持 `conservative`、`baseline`、`aggressive` 或自定义收入/成本/费用增长率，以及 `targetProfitCents`（反推费用上限）。后端先计算利润影响，数量科目隔离。依据文本保存到 `ai_insight` 并标记 `draft=true`，不得把未提供的合同、人数或价格写成事实。

导出 `kind` 支持 `budget_detail`、`actual_current`、`completion`，`format` 为 `xlsx` 或 `csv`。确认返回 `downloadUrl`，只有 confirmed action 可下载。

## SSE

`POST /api/assistant/chat/stream` 返回 `text/event-stream`，事件顺序为：

```text
event: open      data: {"ok":true}                        # 响应头已发出，连接就绪
event: progress  data: {"stage":"tool","label":"正在计算差异归因","detail":"calculate_attribution"}
event: token     data: {"text":"..."}                     # 正文增量，可能多个
event: error     data: {"code":"...","message":""}        # 仅失败时出现
event: done      data: {...完整结构化响应, "done":true}
```

`progress` 的 `stage` 取值：`context`（已解析提问范围）、`routing`（模型开始选择数据）、
`tool`（正在执行某个只读工具）、`fallback`（模型没调用工具，改用关键词兜底）、
`answer`（事实已取到，正在组织回答）、`template`（未配置模型，走确定性查询）。
存在的原因：模型路由必须先跑完一轮工具调用才会有第一个正文增量，实测首字延迟约 17 秒，
期间界面只有一个转圈；把阶段如实播报出来，等待才有解释。客户端可主动 abort 连接实现「停止生成」；后端会中止 provider 与本轮编排，并且不会写入会话消息或 `ai.chat` 日志。

> 只有 POST 一个流式入口。曾经并存的 `GET /api/assistant/chat/stream` 已删除：它会创建会话、
> 写消息与操作日志并消耗模型额度，却是个 GET——鉴权开启时浏览器 `EventSource` 无法附带
> `x-access-token` 根本用不了，而 `NEWFC_DISABLE_AUTH=1` 的本机模式下任意站点都能用
> `new EventSource(...)` 跨站触发这些副作用（简单 GET 无预检，CORS 只挡读取不挡副作用）。
> 客户端一律用 `fetch` + `ReadableStream` 读 POST 流。

这是**真流式**：响应头先发出，随后把模型的 `delta.content` 逐块转发，不再「等完整回答生成完再按固定长度切片」。首字延迟等于模型第一个增量到达的时间。工具调用轮的正文会被缓冲（因为可能被兜底事实作答覆盖），只有确定是最终作答的那一轮才实时转发；未配置模型时确定性摘要也会分块下发，保证前端观感一致。

请求体校验在写响应头之前完成，因此参数错误仍返回结构化 400。响应头已发出后的异常以 `event: error` 下发，并始终补一个 `event: done`，客户端不会卡在等待 done 的状态。反代场景下服务端会设置 `X-Accel-Buffering: no` 关闭 nginx 缓冲。客户端应以 done 事件中的结构化字段为准。

## 洞察保存

```text
GET    /api/assistant/insights?limit=50
POST   /api/assistant/insights   {"kind":"attribution","params":{...},"title":"..."}
GET    /api/assistant/insights/:id
DELETE /api/assistant/insights/:id
```

## 会话管理

```text
GET    /api/assistant/conversations
GET    /api/assistant/conversations/:id
PATCH  /api/assistant/conversations/:id   {"title":"2026 执行复盘"}
DELETE /api/assistant/conversations/:id
```

标题原来只能取首条消息前缀，长问句在侧栏认不出来，因此补了显式重命名。删除会话会连带删除消息
（`ON DELETE CASCADE`），但**已保存的洞察与已产生的操作只解绑不删除**（`ON DELETE SET NULL`），
因此已确认的写操作、洞察和操作日志仍然可追溯。重命名、删除以及每一轮提问都写入操作日志
（`ai.conversation.rename` / `ai.conversation.delete` / `ai.insight.delete` / `ai.chat`）。

`kind` 可为 `execution`、`attribution`、`report`、`anomalies`、`trend`、`accuracy`、`version_variance`、`historical_comparison`、`budget_quality`。后端只接受参数并按当前口径**重新计算**，不接受前端传入的数字；保存的是有界摘要 + 结构化引用，不是数据库副本。`kind=report` 时用 `params.reportKind` 指定报告类型（缺省 `monthly_execution`）。

## 错误与审计

常见错误码：`VALIDATION_FAILED`（参数/格式）、`NOT_FOUND`（版本/快照/action）、`CONFLICT`（令牌、过期、锁定或预览基线冲突）、`UNAUTHORIZED`。预览、确认、取消分别写入 `operation_log` 的 `ai.preview`、`ai.confirm`、`ai.cancel`，保存洞察写入 `ai.insight`。只读分析接口不写审计日志（不改变任何业务数据）。

完整 OpenAPI 契约见 [`assistant-openapi.json`](./assistant-openapi.json)，示例响应见 [`assistant-mock.json`](./assistant-mock.json)，可直接用 curl 完成全流程：

```bash
curl -H 'content-type: application/json' -b 'newfc_session=SESSION' -H 'x-csrf-token: CSRF' \
  -d '{"message":"列出2026年预算版本","pageContext":{"schemaVersion":2,"snapshotId":"example-snapshot","routeInstanceId":"example-route","contextVersion":1,"pageKey":"assistant","scope":{"year":2026}}}' \
  http://127.0.0.1:3760/api/assistant/chat

# 差异归因:逐层展开 + 方向排序
curl -H 'content-type: application/json' -b 'newfc_session=SESSION' -H 'x-csrf-token: CSRF' \
  -d '{"versionId":3,"maxDepth":3,"topN":10,"direction":"unfavorable","pageContext":{"schemaVersion":2,"snapshotId":"example-snapshot","routeInstanceId":"example-route","contextVersion":1,"pageKey":"assistant","scope":{"budgetVersionId":3}}}' \
  http://127.0.0.1:3760/api/assistant/attribution

# 报告生成:执行月报 / 年度复盘 / 预算讨论材料
curl -H 'content-type: application/json' -b 'newfc_session=SESSION' -H 'x-csrf-token: CSRF' \
  -d '{"kind":"monthly_execution","versionId":3}' \
  http://127.0.0.1:3760/api/assistant/report

# 导入辅助:解释错误 + 匹配建议 + 未匹配与重复清单
curl -H 'content-type: application/json' -b 'newfc_session=SESSION' -H 'x-csrf-token: CSRF' \
  -d '{"errors":[{"row":3,"field":"orgCode","message":"组织编码不存在: SH1"}]}' \
  http://127.0.0.1:3760/api/assistant/import-help

curl -H 'content-type: application/json' -b 'newfc_session=SESSION' -H 'x-csrf-token: CSRF' \
  -d '{"type":"copy_budget","params":{"sourceVersionId":3,"targetYear":2027,"name":"AI草案","growthRate":0.05,"idempotencyKey":"demo-1"}}' \
  http://127.0.0.1:3760/api/assistant/preview

curl -X POST -H 'content-type: application/json' -b 'newfc_session=SESSION' -H 'x-csrf-token: CSRF' \
  -d '{"confirmationToken":"PREVIEW返回的confirmationToken"}' \
  http://127.0.0.1:3760/api/assistant/actions/1/confirm
```
